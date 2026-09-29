using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace MemWatch;

/// <summary>
/// 矩形框选 / 窗口识别 / 涂抹选区 / 选区确定后涂鸦标注。
/// 涂抹：按住拖动刷选区，松开后可继续改（加涂/右键擦除/清空），点完成才截图；F2 切换模式。
/// </summary>
internal sealed class ScreenshotOverlayForm : Form
{
    private enum ShapeMode { Rect, Smear }
    private enum Phase { Idle, Creating, Adjusting }
    private enum Hit { None, Move, N, S, E, W, NE, NW, SE, SW }

    private const int HandleSize = 8;
    private const int MinSize = 4;
    private const int BrushRadius = 28; // 涂抹笔刷半径
    private const int DragSelectThreshold = 5; // 拖动超过此像素视为手动画框，否则点选窗口

    private readonly Bitmap _screen;
    private readonly Point _virtualOrigin;
    private readonly IReadOnlyList<WindowCaptureHelper.WindowHit> _windowHits;
    private ShapeMode _shape = ShapeMode.Rect;
    private Phase _phase = Phase.Idle;

    private Rectangle _sel;
    private Point _createStart;
    private Hit _activeHit = Hit.None;
    private Point _dragOrigin;
    private Rectangle _selAtDragStart;
    private bool _mouseDown;
    private bool _pendingWindowSelect;
    private Rectangle _pendingWindowRect = Rectangle.Empty;

    // 涂抹遮罩：非透明像素 = 选中；veil = 半透明遮罩，涂抹处打孔透出原图
    private Bitmap? _mask;
    private Graphics? _maskG;
    private Bitmap? _veil;
    private Graphics? _veilG;
    private Point _lastBrush;
    private Rectangle _maskBounds;
    private bool _hasMask;
    private Bitmap? _maskAtDragStart;
    private Bitmap? _veilAtDragStart;
    private Point _maskOriginAtDrag;
    private Rectangle _maskBoundsAtDragStart;

    private bool _erasing;

    private Rectangle _hoverWindow = Rectangle.Empty;
    private string _hoverTitle = "";
    private bool _hasHoverWindow;

    private bool _doodleActive;
    private bool _markCreating;
    private Point _markStart;
    private Rectangle _markPreview = Rectangle.Empty;
    private readonly List<MarkItem> _markItems = new();
    private Color _markColor = Color.FromArgb(230, 255, 80, 0);

    private static readonly Color VeilColor = Color.FromArgb(120, 0, 0, 0);
    private static readonly Color DefaultMarkColor = Color.FromArgb(230, 255, 80, 0);
    private static readonly Color WindowHoverColor = Color.FromArgb(255, 7, 193, 96);

    private readonly Panel _modeBar = new();
    private readonly Button _btnRect = new();
    private readonly Button _btnSmear = new();
    private readonly Panel _actionBar = new();
    private readonly Button _btnOk = new();
    private readonly Button _btnSaveAs = new();
    private readonly Button _btnPin = new();
    private readonly Button _btnClear = new();
    private readonly Button _btnDoodle = new();
    private readonly Button _btnMarkColor = new();
    private readonly Button _btnCancel = new();
    private readonly System.Windows.Forms.Timer _hoverTimer = new() { Interval = 30 };
    private Point _cursorPos = Point.Empty;
    private static string? _lastSaveDir;
    private bool _mousePassthrough;
    private bool _prevLeftDown;
    private bool _prevRightDown;

    private const int GwlExStyle = -20;
    private const int WsExTransparent = 0x00000020;
    private const uint SwpNoMove = 0x0002;
    private const uint SwpNoSize = 0x0001;
    private const uint SwpNoZOrder = 0x0004;
    private const uint SwpFrameChanged = 0x0020;

    private const int LoupeZoom = 9;
    private const int LoupePixelSize = 9;
    private const int LoupePanelW = 154;
    private const int LoupePanelH = 132;

    private bool IsRectLike => _shape == ShapeMode.Rect;
    private bool CanDetectWindow => _shape == ShapeMode.Rect && _phase == Phase.Idle;

    private sealed class MarkItem(Rectangle bounds, Color color)
    {
        public Rectangle Bounds { get; } = bounds;
        public Color Color { get; } = color;
    }

    private ScreenshotOverlayForm(Bitmap screen, Rectangle virtualBounds, IReadOnlyList<WindowCaptureHelper.WindowHit> windowHits)
    {
        _screen = screen;
        _virtualOrigin = virtualBounds.Location;
        _windowHits = windowHits;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        Bounds = virtualBounds;
        DoubleBuffered = true;
        Cursor = Cursors.Cross;
        KeyPreview = true;
        BackColor = Color.Black;

        BuildBars();
        MouseDown += OnMouseDown;
        MouseMove += OnMouseMove;
        MouseUp += OnMouseUp;
        MouseDoubleClick += OnMouseDoubleClick;
        KeyDown += OnKeyDown;
        Paint += OnPaint;

        // 避免工具栏按钮抢到默认按钮，误触回车就「完成」
        _btnOk.TabStop = false;
        _btnSaveAs.TabStop = false;
        _btnPin.TabStop = false;
        _btnClear.TabStop = false;
        _btnDoodle.TabStop = false;
        _btnMarkColor.TabStop = false;
        _btnCancel.TabStop = false;
        AcceptButton = null;
        CancelButton = null;

        try
        {
            var cfg = LevelConfig.Load();
            _markColor = Color.FromArgb(cfg.ScreenshotMarkColorArgb);
        }
        catch
        {
            _markColor = DefaultMarkColor;
        }

        UpdateMarkColorButton();

        _hoverTimer.Tick += (_, _) =>
        {
            try
            {
                if (IsDisposed || !IsHandleCreated)
                    return;

                var clientPt = PointToClient(Cursor.Position);
                _cursorPos = clientPt;

                if (_mousePassthrough)
                    PollMouseButtons(clientPt);

                if (!CanDetectWindow || _mouseDown)
                {
                    if (IsRectLike && ClientRectangle.Contains(clientPt))
                        Invalidate();
                    return;
                }

                if (!ClientRectangle.Contains(clientPt))
                    return;

                UpdateHoverWindow(clientPt);
                UpdateCursor(clientPt);
                if (IsRectLike)
                    Invalidate();
            }
            catch
            {
                // 悬停检测失败时不影响截图
            }
        };
        Shown += (_, _) =>
        {
            Activate();
            Focus();
            SyncHoverTimer();
            SyncMousePassthrough();
        };
    }

    [DllImport("user32.dll", EntryPoint = "GetWindowLong")]
    private static extern int GetWindowLong32(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtr")]
    private static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "SetWindowLong")]
    private static extern int SetWindowLong32(IntPtr hWnd, int nIndex, int dwNewLong);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtr")]
    private static extern IntPtr SetWindowLongPtr64(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(
        IntPtr hWnd,
        IntPtr hWndInsertAfter,
        int x,
        int y,
        int cx,
        int cy,
        uint uFlags);

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);

    private static IntPtr GetWindowStylePtr(IntPtr hwnd, int index) =>
        IntPtr.Size == 8 ? GetWindowLongPtr64(hwnd, index) : new IntPtr(GetWindowLong32(hwnd, index));

    private static void SetWindowStylePtr(IntPtr hwnd, int index, IntPtr value)
    {
        if (IntPtr.Size == 8)
            SetWindowLongPtr64(hwnd, index, value);
        else
            SetWindowLong32(hwnd, index, value.ToInt32());
    }

    /// <summary>微信式：仅在阶段切换时开关穿透，不在定时器里反复改样式。</summary>
    private void SyncMousePassthrough()
    {
        if (!IsHandleCreated || IsDisposed)
            return;

        var want = CanDetectWindow && !_mouseDown;
        if (want == _mousePassthrough)
            return;

        _mousePassthrough = want;
        var ex = GetWindowStylePtr(Handle, GwlExStyle).ToInt64();
        if (want)
            ex |= WsExTransparent;
        else
            ex &= ~WsExTransparent;

        SetWindowStylePtr(Handle, GwlExStyle, new IntPtr(ex));
        SetWindowPos(Handle, IntPtr.Zero, 0, 0, 0, 0,
            SwpNoMove | SwpNoSize | SwpNoZOrder | SwpFrameChanged);
    }

    private void PollMouseButtons(Point clientPt)
    {
        var left = (GetAsyncKeyState(0x01) & 0x8000) != 0;
        var right = (GetAsyncKeyState(0x02) & 0x8000) != 0;

        if (left && !_prevLeftDown)
            ProcessMouseDown(clientPt, MouseButtons.Left);
        else if (!left && _prevLeftDown)
            ProcessMouseUp(clientPt, MouseButtons.Left);

        if (right && !_prevRightDown)
            ProcessMouseDown(clientPt, MouseButtons.Right);
        else if (!right && _prevRightDown)
            ProcessMouseUp(clientPt, MouseButtons.Right);

        if (_mouseDown && (left || right))
            ProcessMouseMove(clientPt);

        _prevLeftDown = left;
        _prevRightDown = right;
    }

    public static void RunCapture()
    {
        var bounds = SystemInformation.VirtualScreen;
        Bitmap? shot = null;
        try
        {
            shot = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(shot))
                g.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size);

            var windows = WindowCaptureHelper.CollectVisibleWindows(bounds, Environment.ProcessId);
            using var form = new ScreenshotOverlayForm(shot, bounds, windows);
            shot = null;
            form.ShowDialog();
        }
        finally
        {
            shot?.Dispose();
        }
    }

    private void BuildBars()
    {
        _modeBar.Size = new Size(200, 36);
        _modeBar.BackColor = UiTheme.Back;
        _btnRect.Text = L.T("框选", "Select");
        _btnRect.Size = new Size(90, 28);
        _btnRect.Location = new Point(6, 4);
        _btnRect.Click += (_, _) => SetShape(ShapeMode.Rect);
        _btnSmear.Text = L.T("涂抹", "Smear");
        _btnSmear.Size = new Size(90, 28);
        _btnSmear.Location = new Point(102, 4);
        _btnSmear.Click += (_, _) => SetShape(ShapeMode.Smear);
        _modeBar.Controls.Add(_btnRect);
        _modeBar.Controls.Add(_btnSmear);
        Controls.Add(_modeBar);
        LayoutModeBar();
        UpdateModeButtons();

        _actionBar.Size = new Size(512, 36);
        _actionBar.BackColor = UiTheme.Back;
        _actionBar.Visible = false;
        _btnOk.Text = L.T("完成", "Done");
        _btnOk.Size = new Size(70, 28);
        _btnOk.Location = new Point(6, 4);
        UiTheme.FlattenButton(_btnOk, UiTheme.Accent);
        _btnOk.Click += (_, _) => Finish(pin: false, saveAs: false);
        _btnSaveAs.Text = L.T("另存为", "Save As");
        _btnSaveAs.Size = new Size(78, 28);
        _btnSaveAs.Location = new Point(82, 4);
        _btnSaveAs.Click += (_, _) => Finish(pin: false, saveAs: true);
        _btnPin.Text = L.T("图钉(F3)", "Pin(F3)");
        _btnPin.Size = new Size(78, 28);
        _btnPin.Location = new Point(166, 4);
        UiTheme.FlattenButton(_btnPin, UiTheme.Info);
        _btnPin.Click += (_, _) => Finish(pin: true, saveAs: false);
        _btnClear.Text = L.T("清空重涂", "Clear");
        _btnClear.Size = new Size(78, 28);
        _btnClear.Location = new Point(250, 4);
        _btnClear.Click += (_, _) => ClearSmear();
        _btnDoodle.Text = L.T("涂鸦", "Mark");
        _btnDoodle.Size = new Size(64, 28);
        _btnDoodle.Location = new Point(334, 4);
        _btnDoodle.Click += (_, _) => ToggleDoodle();
        _btnMarkColor.Size = new Size(28, 28);
        _btnMarkColor.Location = new Point(402, 4);
        _btnMarkColor.FlatStyle = FlatStyle.Flat;
        _btnMarkColor.Text = "";
        _btnMarkColor.Click += (_, _) => PickMarkColor();
        _btnCancel.Text = L.T("取消", "Cancel");
        _btnCancel.Size = new Size(64, 28);
        _btnCancel.Location = new Point(436, 4);
        _btnCancel.Click += (_, _) => Close();
        _actionBar.Controls.Add(_btnOk);
        _actionBar.Controls.Add(_btnSaveAs);
        _actionBar.Controls.Add(_btnPin);
        _actionBar.Controls.Add(_btnClear);
        _actionBar.Controls.Add(_btnDoodle);
        _actionBar.Controls.Add(_btnMarkColor);
        _actionBar.Controls.Add(_btnCancel);
        Controls.Add(_actionBar);
        UiTheme.StyleTree(_modeBar);
        UiTheme.StyleTree(_actionBar);
        StyleScreenshotActionBar();
    }

    /// <summary>截图工具栏：深底白字、浅底黑字。</summary>
    private void StyleScreenshotActionBar()
    {
        UiTheme.FlattenButton(_btnOk, UiTheme.Accent);
        UiTheme.FlattenButton(_btnPin, UiTheme.Info, UiTheme.Ink);
        UiTheme.FlattenButton(_btnSaveAs, text: UiTheme.Ink);
        UiTheme.FlattenButton(_btnClear, text: UiTheme.Ink);
        UiTheme.FlattenButton(_btnDoodle, text: UiTheme.Ink);
        UiTheme.FlattenButton(_btnCancel, text: UiTheme.Ink);
        UpdateMarkColorButton();
    }

    private void SetShape(ShapeMode mode)
    {
        if (_shape == mode && _phase == Phase.Idle) return;
        ResetSelection();
        _shape = mode;
        UpdateModeButtons();
        Invalidate();
    }

    private void ToggleShape()
    {
        SetShape(_shape == ShapeMode.Rect ? ShapeMode.Smear : ShapeMode.Rect);
    }

    private void ToggleDoodle()
    {
        if (_phase != Phase.Adjusting || _shape == ShapeMode.Smear)
            return;

        _doodleActive = !_doodleActive;
        _markCreating = false;
        _markPreview = Rectangle.Empty;
        UpdateDoodleButton();
        Invalidate();
    }

    private void ResetSelection()
    {
        _mouseDown = false;
        _pendingWindowSelect = false;
        _pendingWindowRect = Rectangle.Empty;
        _activeHit = Hit.None;
        _sel = Rectangle.Empty;
        _hasHoverWindow = false;
        _hoverWindow = Rectangle.Empty;
        _hoverTitle = "";
        _doodleActive = false;
        _markCreating = false;
        _markPreview = Rectangle.Empty;
        _markItems.Clear();
        _maskAtDragStart?.Dispose();
        _maskAtDragStart = null;
        _veilAtDragStart?.Dispose();
        _veilAtDragStart = null;
        if (_mask is not null)
        {
            ReleaseMaskGraphics();
            using (var g = Graphics.FromImage(_mask))
                g.Clear(Color.Transparent);
        }

        ResetVeilFull();
        _hasMask = false;
        _maskBounds = Rectangle.Empty;
        _phase = Phase.Idle;
        HideActionBar();
        SyncHoverTimer();
        SyncMousePassthrough();
    }

    private void SyncHoverTimer()
    {
        if (IsDisposed)
            return;

        if (CanDetectWindow || _mousePassthrough)
        {
            if (!_hoverTimer.Enabled)
                _hoverTimer.Start();
        }
        else if (!_mouseDown)
        {
            _hoverTimer.Stop();
        }

        SyncMousePassthrough();
    }

    private void UpdateModeButtons()
    {
        _btnRect.BackColor = _shape == ShapeMode.Rect ? UiTheme.Panel : UiTheme.Surface;
        _btnSmear.BackColor = _shape == ShapeMode.Smear ? UiTheme.Panel : UiTheme.Surface;
        _btnClear.Visible = _shape == ShapeMode.Smear;
    }

    private void UpdateDoodleButton()
    {
        var show = _phase == Phase.Adjusting && IsRectLike;
        _btnDoodle.Visible = show;
        _btnMarkColor.Visible = show;
        _btnDoodle.BackColor = _doodleActive ? UiTheme.Panel : UiTheme.Surface;
    }

    private void UpdateMarkColorButton()
    {
        _btnMarkColor.BackColor = _markColor;
        _btnMarkColor.FlatAppearance.BorderColor = Color.FromArgb(160, 255, 255, 255);
        _btnMarkColor.FlatAppearance.BorderSize = 1;
        _btnMarkColor.Text = L.T("色", "C");
        _btnMarkColor.ForeColor = GetMarkColorButtonTextColor(_markColor);
        _btnMarkColor.Font = new Font("Segoe UI", 8f, FontStyle.Bold);
    }

    private static Color GetMarkColorButtonTextColor(Color c)
    {
        var lum = c.R * 0.299 + c.G * 0.587 + c.B * 0.114;
        // 仅接近纯黑底用白字，其余一律深字
        return lum < 72 ? UiTheme.OnSolid : UiTheme.Ink;
    }

    private void PickMarkColor()
    {
        var wasTopMost = TopMost;
        var wasOpacity = Opacity;
        try
        {
            TopMost = false;
            Opacity = 0;
            using var dlg = new ColorDialog
            {
                Color = _markColor,
                FullOpen = true,
                AnyColor = true
            };
            if (dlg.ShowDialog(this) != DialogResult.OK)
                return;

            _markColor = Color.FromArgb(230, dlg.Color.R, dlg.Color.G, dlg.Color.B);
            UpdateMarkColorButton();
            try
            {
                var cfg = LevelConfig.Load();
                cfg.ScreenshotMarkColorArgb = _markColor.ToArgb();
                cfg.Save();
            }
            catch
            {
                // 保存失败不影响本次截图
            }

            Invalidate();
        }
        finally
        {
            Opacity = wasOpacity;
            TopMost = wasTopMost;
            BringToFront();
            Activate();
        }
    }

    private void LayoutModeBar()
    {
        _modeBar.Location = new Point(Math.Max(8, (ClientSize.Width - _modeBar.Width) / 2), 16);
        // 微信式：默认不显示顶栏，F2 切到涂抹模式时再提示
        _modeBar.Visible = false;
    }

    private void LayoutActionBar(Rectangle near)
    {
        _ = near;
        var smear = _shape == ShapeMode.Smear;
        _btnClear.Visible = smear;
        UpdateDoodleButton();
        _btnCancel.Location = new Point(436, 4);
        const int barW = 512;
        _actionBar.Width = barW;

        // 框选/涂抹：工具栏固定屏幕底部居中（微信式）
        var x = Math.Max(0, (ClientSize.Width - barW) / 2);
        var y = Math.Max(0, ClientSize.Height - _actionBar.Height - 28);
        if (smear)
        {
            var cursor = PointToClient(Cursor.Position);
            var barRect = new Rectangle(x, y, barW, _actionBar.Height);
            if (barRect.Contains(cursor))
                y = Math.Max(8, cursor.Y - _actionBar.Height - 40);
        }

        _actionBar.Location = new Point(x, y);
        _actionBar.Visible = true;
        _actionBar.BringToFront();
        _modeBar.Visible = false;
        ActiveControl = null;
    }

    private void HideActionBar()
    {
        _actionBar.Visible = false;
        LayoutModeBar();
    }

    private bool OverBars(Point p) =>
        (_modeBar.Visible && _modeBar.Bounds.Contains(p)) ||
        (_actionBar.Visible && _actionBar.Bounds.Contains(p));

    private void EnsureMask()
    {
        if (_mask is not null) return;
        _mask = new Bitmap(_screen.Width, _screen.Height, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(_mask))
            g.Clear(Color.Transparent);
        _hasMask = false;
        _maskBounds = Rectangle.Empty;
        EnsureVeil();
    }

    private void EnsureVeil()
    {
        if (_veil is not null) return;
        _veil = new Bitmap(_screen.Width, _screen.Height, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(_veil))
            g.Clear(VeilColor);
    }

    private void ResetVeilFull()
    {
        ReleaseVeilGraphics();
        if (_veil is null) return;
        using var g = Graphics.FromImage(_veil);
        g.Clear(VeilColor);
    }

    /// <summary>必须先释放绑定到遮罩的 Graphics，再 LockBits/读像素，否则会读到空数据。</summary>
    private void ReleaseMaskGraphics()
    {
        if (_maskG is null) return;
        _maskG.Flush();
        _maskG.Dispose();
        _maskG = null;
    }

    private void ReleaseVeilGraphics()
    {
        if (_veilG is null) return;
        _veilG.Flush();
        _veilG.Dispose();
        _veilG = null;
    }

    private Graphics MaskGraphics()
    {
        EnsureMask();
        if (_maskG is null)
        {
            _maskG = Graphics.FromImage(_mask!);
            _maskG.SmoothingMode = SmoothingMode.None; // 硬边缘，避免白边噪点进结果
            _maskG.PixelOffsetMode = PixelOffsetMode.Half;
            _maskG.CompositingMode = CompositingMode.SourceCopy;
        }

        return _maskG;
    }

    private Graphics VeilGraphics()
    {
        EnsureVeil();
        if (_veilG is null)
        {
            _veilG = Graphics.FromImage(_veil!);
            _veilG.SmoothingMode = SmoothingMode.AntiAlias;
            _veilG.CompositingMode = CompositingMode.SourceCopy;
        }

        return _veilG;
    }

    private void ClearSmear()
    {
        if (_mask is null && _veil is null) return;
        ReleaseMaskGraphics();
        if (_mask is not null)
        {
            using var g = Graphics.FromImage(_mask);
            g.Clear(Color.Transparent);
        }

        ResetVeilFull();
        _hasMask = false;
        _maskBounds = Rectangle.Empty;
        _phase = Phase.Idle;
        HideActionBar();
        Invalidate();
    }

    private void PaintBrush(Point from, Point to, bool erase)
    {
        // 选区 mask + 预览 veil（涂抹处打孔，与框选一样透出原图）
        var mg = MaskGraphics();
        var vg = VeilGraphics();
        var maskColor = erase ? Color.Transparent : Color.White;
        var veilColor = erase ? VeilColor : Color.Transparent;

        void Stroke(Graphics g, Color c)
        {
            using var pen = new Pen(c, BrushRadius * 2f)
            {
                StartCap = LineCap.Round,
                EndCap = LineCap.Round,
                LineJoin = LineJoin.Round
            };
            g.DrawLine(pen, from, to);
            using var brush = new SolidBrush(c);
            g.FillEllipse(brush, to.X - BrushRadius, to.Y - BrushRadius, BrushRadius * 2, BrushRadius * 2);
        }

        Stroke(mg, maskColor);
        Stroke(vg, veilColor);
        mg.Flush();
        vg.Flush();

        ExpandMaskBounds(from, to);
        if (!erase)
            _hasMask = true;
    }

    private void ExpandMaskBounds(Point a, Point b)
    {
        var pad = BrushRadius + 2;
        var r = Rectangle.FromLTRB(
            Math.Min(a.X, b.X) - pad,
            Math.Min(a.Y, b.Y) - pad,
            Math.Max(a.X, b.X) + pad,
            Math.Max(a.Y, b.Y) + pad);
        r.Intersect(new Rectangle(0, 0, _screen.Width, _screen.Height));
        _maskBounds = _maskBounds.IsEmpty ? r : Rectangle.Union(_maskBounds, r);
    }

    private void OnMouseDown(object? sender, MouseEventArgs e) =>
        ProcessMouseDown(e.Location, e.Button);

    private void ProcessMouseDown(Point location, MouseButtons button)
    {
        if (OverBars(location)) return;

        // 右键：取消截图（涂抹已有选区时仍为擦除）
        if (button == MouseButtons.Right)
        {
            if (_shape == ShapeMode.Smear && _hasMask)
            {
                _mouseDown = true;
                _erasing = true;
                _dragOrigin = location;
                BeginOrContinueSmear(location, erase: true);
                SyncMousePassthrough();
                return;
            }

            Close();
            return;
        }

        if (button != MouseButtons.Left) return;

        if (_doodleActive && _phase == Phase.Adjusting && IsRectLike)
        {
            _mouseDown = true;
            _markCreating = true;
            _markStart = location;
            _markPreview = new Rectangle(location, Size.Empty);
            SyncMousePassthrough();
            return;
        }

        if (CanDetectWindow)
        {
            UpdateHoverWindow(location);
            _mouseDown = true;
            _erasing = false;
            _dragOrigin = location;

            if (_hasHoverWindow && _hoverWindow.Width >= MinSize && _hoverWindow.Height >= MinSize)
            {
                // 微信式：短按点选窗口，按住拖动则按轨迹手动画框
                _pendingWindowSelect = true;
                _pendingWindowRect = ClampRect(_hoverWindow);
            }
            else
            {
                BeginRect(location);
            }

            SyncMousePassthrough();
            return;
        }

        _mouseDown = true;
        _erasing = false;
        _dragOrigin = location;

        if (_shape == ShapeMode.Smear)
        {
            // Alt+拖动：移动整块选区；否则继续加涂（松开不会自动截图）
            if (_phase == Phase.Adjusting &&
                (ModifierKeys & Keys.Alt) == Keys.Alt &&
                _hasMask && HitTestMask(location))
            {
                _activeHit = Hit.Move;
                ReleaseMaskGraphics();
                ReleaseVeilGraphics();
                _maskAtDragStart?.Dispose();
                _veilAtDragStart?.Dispose();
                _maskAtDragStart = (Bitmap)_mask!.Clone();
                EnsureVeil();
                _veilAtDragStart = (Bitmap)_veil!.Clone();
                _maskOriginAtDrag = location;
                _maskBoundsAtDragStart = _maskBounds;
                SyncMousePassthrough();
                return;
            }

            BeginOrContinueSmear(location, erase: false);
            SyncMousePassthrough();
            return;
        }

        if (_phase == Phase.Adjusting && IsRectLike)
        {
            var hit = HitTestRect(location);
            if (hit != Hit.None)
            {
                _activeHit = hit;
                _selAtDragStart = _sel;
                SyncMousePassthrough();
                return;
            }

            BeginRect(location);
            SyncMousePassthrough();
            return;
        }

        if (IsRectLike)
        {
            BeginRect(location);
            SyncMousePassthrough();
        }
    }

    private void BeginRect(Point p)
    {
        _phase = Phase.Creating;
        _createStart = p;
        _sel = new Rectangle(p, Size.Empty);
        _activeHit = Hit.None;
        HideActionBar();
        Invalidate();
    }

    private void BeginOrContinueSmear(Point p, bool erase)
    {
        _phase = Phase.Creating;
        _activeHit = Hit.None;
        _erasing = erase;
        var pt = ClampPoint(p);
        _lastBrush = pt;
        PaintBrush(pt, pt, erase);
        HideActionBar();
        Invalidate();
    }

    private void OnMouseMove(object? sender, MouseEventArgs e) =>
        ProcessMouseMove(e.Location);

    private void ProcessMouseMove(Point location)
    {
        _cursorPos = location;

        if (!_mouseDown)
        {
            if (CanDetectWindow)
                UpdateHoverWindow(location);
            UpdateCursor(location);
            if (IsRectLike)
                Invalidate();
            return;
        }

        if (_markCreating && _doodleActive)
        {
            _markPreview = NormalizeRect(_markStart, location);
            Invalidate();
            return;
        }

        if (_pendingWindowSelect && IsRectLike)
        {
            if (Distance(_dragOrigin, location) >= DragSelectThreshold)
            {
                _pendingWindowSelect = false;
                BeginRect(_dragOrigin);
                _sel = NormalizeRect(_createStart, location);
            }

            Invalidate();
            return;
        }

        if (IsRectLike && _phase == Phase.Creating)
        {
            _sel = NormalizeRect(_createStart, location);
            Invalidate();
            return;
        }

        if (IsRectLike)
            Invalidate();

        if (_shape == ShapeMode.Smear && _phase == Phase.Creating)
        {
            var p = ClampPoint(location);
            if (Distance(_lastBrush, p) >= 1)
            {
                var dirty = GetBrushInvalidateRect(_lastBrush, p);
                PaintBrush(_lastBrush, p, _erasing);
                _lastBrush = p;
                Invalidate(dirty);
            }

            return;
        }

        if (_phase == Phase.Adjusting && IsRectLike && _activeHit != Hit.None)
        {
            _sel = ApplyRectHit(_selAtDragStart, _activeHit, _dragOrigin, location);
            _sel = ClampRect(_sel);
            LayoutActionBar(_sel);
            Invalidate();
            return;
        }

        if (_phase == Phase.Adjusting && _shape == ShapeMode.Smear &&
            _activeHit == Hit.Move && _maskAtDragStart is not null && _veilAtDragStart is not null)
        {
            var dx = location.X - _maskOriginAtDrag.X;
            var dy = location.Y - _maskOriginAtDrag.Y;
            ShiftMaskFrom(_maskAtDragStart, _veilAtDragStart, dx, dy);
            LayoutActionBar(_maskBounds);
            Invalidate();
        }
    }

    private void ShiftMaskFrom(Bitmap maskSrc, Bitmap veilSrc, int dx, int dy)
    {
        if (_mask is null) return;
        EnsureVeil();
        ReleaseMaskGraphics();
        ReleaseVeilGraphics();
        using (var g = Graphics.FromImage(_mask))
        {
            g.Clear(Color.Transparent);
            g.CompositingMode = CompositingMode.SourceCopy;
            g.DrawImageUnscaled(maskSrc, dx, dy);
        }

        using (var g = Graphics.FromImage(_veil!))
        {
            g.Clear(VeilColor);
            g.CompositingMode = CompositingMode.SourceCopy;
            g.DrawImageUnscaled(veilSrc, dx, dy);
        }

        if (!_maskBoundsAtDragStart.IsEmpty)
        {
            var b = _maskBoundsAtDragStart;
            b.Offset(dx, dy);
            b.Intersect(new Rectangle(0, 0, _screen.Width, _screen.Height));
            _maskBounds = b;
            _hasMask = !b.IsEmpty;
        }
    }

    private void OnMouseUp(object? sender, MouseEventArgs e) =>
        ProcessMouseUp(e.Location, e.Button);

    private void ProcessMouseUp(Point location, MouseButtons button)
    {
        if (!_mouseDown) return;
        if (button is not (MouseButtons.Left or MouseButtons.Right)) return;
        _mouseDown = false;

        if (_markCreating && _doodleActive && button == MouseButtons.Left)
        {
            _markCreating = false;
            _markPreview = NormalizeRect(_markStart, location);
            if (_markPreview.Width >= MinSize && _markPreview.Height >= MinSize)
                _markItems.Add(new MarkItem(ClampRect(_markPreview), _markColor));
            _markPreview = Rectangle.Empty;
            SyncMousePassthrough();
            Invalidate();
            return;
        }

        if (_pendingWindowSelect && button == MouseButtons.Left)
        {
            _pendingWindowSelect = false;
            SelectWindowRect(_pendingWindowRect);
            SyncMousePassthrough();
            return;
        }

        if (IsRectLike && _phase == Phase.Creating && button == MouseButtons.Left)
        {
            _sel = NormalizeRect(_createStart, location);
            if (_sel.Width < MinSize || _sel.Height < MinSize)
            {
                _phase = Phase.Idle;
                _sel = Rectangle.Empty;
                HideActionBar();
                SyncHoverTimer();
            }
            else
            {
                _phase = Phase.Adjusting;
                LayoutActionBar(_sel);
            }

            _activeHit = Hit.None;
            SyncMousePassthrough();
            Invalidate();
            return;
        }

        if (_shape == ShapeMode.Smear && _phase == Phase.Creating)
        {
            // 松开只是结束这一笔，不会截图；需点「完成」才复制
            _erasing = false;
            ReleaseMaskGraphics();
            ReleaseVeilGraphics();
            // 松手时先清一次残余，预览和最终截图一致
            SealSmearMask();
            RecomputeMaskBounds();
            if (_hasMask && !_maskBounds.IsEmpty)
            {
                _phase = Phase.Adjusting;
                LayoutActionBar(_maskBounds);
            }
            else
            {
                _phase = Phase.Idle;
                HideActionBar();
                SyncHoverTimer();
            }

            _activeHit = Hit.None;
            SyncMousePassthrough();
            Invalidate();
            return;
        }

        if (_phase == Phase.Adjusting)
        {
            _activeHit = Hit.None;
            _erasing = false;
            _maskAtDragStart?.Dispose();
            _maskAtDragStart = null;
            _veilAtDragStart?.Dispose();
            _veilAtDragStart = null;
            if (IsRectLike)
                LayoutActionBar(_sel);
            else if (_hasMask)
            {
                RecomputeMaskBounds();
                LayoutActionBar(_maskBounds);
            }

            SyncMousePassthrough();
            Invalidate();
        }
    }

    private void RecomputeMaskBounds()
    {
        if (_mask is null || !_hasMask)
        {
            _maskBounds = Rectangle.Empty;
            return;
        }

        ReleaseMaskGraphics();

        var search = _maskBounds;
        if (search.IsEmpty)
            search = new Rectangle(0, 0, _mask.Width, _mask.Height);
        else
            search.Inflate(BrushRadius + 4, BrushRadius + 4);
        search.Intersect(new Rectangle(0, 0, _mask.Width, _mask.Height));
        if (search.Width < 1 || search.Height < 1)
        {
            _maskBounds = Rectangle.Empty;
            _hasMask = false;
            return;
        }

        var minX = search.Right;
        var minY = search.Bottom;
        var maxX = search.Left;
        var maxY = search.Top;
        var found = false;

        var data = _mask.LockBits(search, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            var stride = data.Stride;
            for (var y = 0; y < search.Height; y++)
            {
                var rowPtr = IntPtr.Add(data.Scan0, y * stride);
                var row = new byte[search.Width * 4];
                Marshal.Copy(rowPtr, row, 0, row.Length);
                for (var x = 0; x < search.Width; x++)
                {
                    if (row[x * 4 + 3] < 16) continue;
                    found = true;
                    var gx = search.Left + x;
                    var gy = search.Top + y;
                    if (gx < minX) minX = gx;
                    if (gy < minY) minY = gy;
                    if (gx > maxX) maxX = gx;
                    if (gy > maxY) maxY = gy;
                }
            }
        }
        finally
        {
            _mask.UnlockBits(data);
        }

        _maskBounds = found
            ? Rectangle.FromLTRB(minX, minY, maxX + 1, maxY + 1)
            : Rectangle.Empty;
        _hasMask = found;
    }

    private bool HitTestMask(Point p)
    {
        if (_mask is null || !_hasMask || !_maskBounds.Contains(p)) return false;
        ReleaseMaskGraphics();
        return _mask.GetPixel(p.X, p.Y).A >= 16;
    }

    private void OnKeyDown(object? sender, KeyEventArgs e)
    {
        if (e.KeyCode == Keys.Escape)
        {
            e.Handled = true;
            Close();
            return;
        }

        // F2：矩形 ↔ 涂抹
        if (e.KeyCode == Keys.F2)
        {
            e.Handled = true;
            e.SuppressKeyPress = true;
            ToggleShape();
            return;
        }

        if (e.KeyCode == Keys.F3)
        {
            e.Handled = true;
            if (_phase == Phase.Adjusting)
                Finish(pin: true, saveAs: false);
            return;
        }

        if (e.Control && e.KeyCode == Keys.S)
        {
            e.Handled = true;
            e.SuppressKeyPress = true;
            if (_phase == Phase.Adjusting)
                Finish(pin: false, saveAs: true);
            return;
        }

        if (e.Control && e.KeyCode == Keys.Z)
        {
            e.Handled = true;
            e.SuppressKeyPress = true;
            if (UndoLastMark())
                return;
        }

        if (e.Control && e.KeyCode == Keys.C && IsRectLike)
        {
            e.Handled = true;
            e.SuppressKeyPress = true;
            CopyCursorColor();
            return;
        }

        if (e.KeyCode is Keys.Enter or Keys.Return)
        {
            e.Handled = true;
            if (_phase == Phase.Adjusting)
                Finish(pin: false, saveAs: false);
        }
    }

    private bool UndoLastMark()
    {
        if (_markItems.Count == 0)
            return false;

        _markItems.RemoveAt(_markItems.Count - 1);
        Invalidate();
        return true;
    }

    /// <summary>微信式：点击窗口只选中，可调整后再点完成/双击确认。</summary>
    private void SelectWindowRect(Rectangle rect)
    {
        _hasHoverWindow = false;
        _hoverWindow = Rectangle.Empty;
        _hoverTitle = "";
        _sel = rect;
        _phase = Phase.Adjusting;
        SyncHoverTimer();
        LayoutActionBar(_sel);
        Invalidate();
    }

    private void UpdateHoverWindow(Point clientPt)
    {
        try
        {
            var screenPt = PointToScreen(clientPt);
            var found = _mousePassthrough
                ? WindowCaptureHelper.TryHitWindowAtPoint(screenPt, Environment.ProcessId, Handle, out var liveHit)
                : WindowCaptureHelper.TryHitWindow(_windowHits, screenPt, out liveHit);

            if (!found && _mousePassthrough)
                found = WindowCaptureHelper.TryHitWindow(_windowHits, screenPt, out liveHit);

            if (found)
            {
                var clientRect = ClampRect(WindowCaptureHelper.ScreenToClientRect(liveHit.Bounds, _virtualOrigin));
                if (!clientRect.Equals(_hoverWindow) || liveHit.Title != _hoverTitle)
                {
                    _hoverWindow = clientRect;
                    _hoverTitle = liveHit.Title;
                    _hasHoverWindow = clientRect.Width >= MinSize && clientRect.Height >= MinSize;
                    Invalidate();
                }
            }
            else if (_hasHoverWindow)
            {
                _hasHoverWindow = false;
                _hoverWindow = Rectangle.Empty;
                _hoverTitle = "";
                Invalidate();
            }
        }
        catch
        {
            // 忽略悬停检测异常
        }
    }

    private void OnMouseDoubleClick(object? sender, MouseEventArgs e)
    {
        if (OverBars(e.Location))
            return;

        if (e.Button != MouseButtons.Left || _doodleActive)
            return;

        if (_phase == Phase.Adjusting && IsRectLike && _sel.Contains(e.Location))
            Finish(pin: false, saveAs: false);
    }

    private void ApplyMarks(Bitmap bmp, Point cropOrigin)
    {
        if (_markItems.Count == 0)
            return;

        using var g = Graphics.FromImage(bmp);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        foreach (var mark in _markItems)
        {
            var local = mark.Bounds;
            local.Offset(-cropOrigin.X, -cropOrigin.Y);
            local.Intersect(new Rectangle(0, 0, bmp.Width, bmp.Height));
            if (local.Width < 1 || local.Height < 1)
                continue;

            DrawMarkRectangle(g, local, mark.Color);
        }
    }

    private static void DrawMarkRectangle(Graphics g, Rectangle mark, Color color)
    {
        var draw = new Rectangle(mark.X, mark.Y, Math.Max(0, mark.Width - 1), Math.Max(0, mark.Height - 1));
        using var penOuter = new Pen(Color.FromArgb(220, 255, 255, 255), 3f);
        using var penInner = new Pen(color, 2f);
        g.DrawRectangle(penOuter, draw);
        g.DrawRectangle(penInner, draw);
    }

    private void Finish(bool pin, bool saveAs)
    {
        _hoverTimer.Stop();
        Bitmap? result = null;
        Point pinLoc = Point.Empty;
        try
        {
            if (IsRectLike)
            {
                if (_phase != Phase.Adjusting || _sel.Width < MinSize || _sel.Height < MinSize)
                    return;
                var r = ClampRect(_sel);
                r.Intersect(new Rectangle(0, 0, _screen.Width, _screen.Height));
                if (r.Width < 1 || r.Height < 1) return;
                result = _screen.Clone(r, PixelFormat.Format32bppArgb);
                ApplyMarks(result, r.Location);
                pinLoc = PointToScreen(r.Location);
            }
            else
            {
                if (_phase != Phase.Adjusting || !_hasMask || _mask is null)
                    return;
                ReleaseMaskGraphics();
                ReleaseVeilGraphics();
                SealSmearMask(false);
                RecomputeMaskBounds();
                if (!_hasMask || _maskBounds.Width < 1 || _maskBounds.Height < 1)
                    return;
                result = CropByMask(_screen, _mask, _maskBounds);
                pinLoc = PointToScreen(_maskBounds.Location);
            }

            if (saveAs && !TrySaveAs(result))
                return;

            ClipboardHistoryService.Instance.IgnoreNextExternalChange();
            ClipboardUtil.SetImage(result);
            ClipboardHistoryService.Instance.TryAddImage(result);
            if (pin)
                PinBoardService.Instance.AddSticker(result, pinLoc);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this,
                L.T($"截图失败：{ex.Message}", $"Screenshot failed: {ex.Message}"),
                L.T("截图", "Screenshot"),
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }
        finally
        {
            result?.Dispose();
        }

        Close();
    }

    /// <summary>弹出另存为；取消则返回 false，叠层保持打开。</summary>
    private bool TrySaveAs(Bitmap image)
    {
        var wasTopMost = TopMost;
        var wasOpacity = Opacity;
        try
        {
            // 全屏置顶会挡住保存框，先让出焦点
            TopMost = false;
            Opacity = 0;

            var initial = _lastSaveDir;
            if (string.IsNullOrWhiteSpace(initial) || !Directory.Exists(initial))
                initial = Environment.GetFolderPath(Environment.SpecialFolder.MyPictures);

            using var dlg = new SaveFileDialog
            {
                Title = L.T("另存为", "Save As"),
                Filter = "PNG (*.png)|*.png",
                DefaultExt = "png",
                AddExtension = true,
                OverwritePrompt = true,
                FileName = $"MemWatch_{DateTime.Now:yyyyMMdd_HHmmss}.png",
                InitialDirectory = initial
            };

            if (dlg.ShowDialog(this) != DialogResult.OK)
                return false;

            var path = dlg.FileName;
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrWhiteSpace(dir))
                _lastSaveDir = dir;

            image.Save(path, ImageFormat.Png);
            return true;
        }
        catch (Exception ex)
        {
            MessageBox.Show(this,
                L.T($"保存失败：{ex.Message}", $"Save failed: {ex.Message}"),
                L.T("另存为", "Save As"),
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return false;
        }
        finally
        {
            Opacity = wasOpacity;
            TopMost = wasTopMost;
            BringToFront();
            Activate();
        }
    }

    /// <summary>
    /// 去掉涂抹选区内的残余空洞/锯齿缺口：闭运算填缝 + 洪水填充内部孔洞，并同步预览 veil。
    /// </summary>
    private void SealSmearMask(bool morphologicalClose = true)
    {
        if (_mask is null || !_hasMask) return;
        EnsureVeil();

        var b = _maskBounds;
        if (b.IsEmpty)
            b = new Rectangle(0, 0, _mask.Width, _mask.Height);
        else
            b.Inflate(BrushRadius + 8, BrushRadius + 8);
        b.Intersect(new Rectangle(0, 0, _mask.Width, _mask.Height));
        if (b.Width < 2 || b.Height < 2) return;

        var w = b.Width;
        var h = b.Height;
        var n = w * h;
        var sel = new byte[n]; // 0/1

        var data = _mask.LockBits(b, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
        try
        {
            var row = new byte[w * 4];
            for (var y = 0; y < h; y++)
            {
                Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), row, 0, row.Length);
                for (var x = 0; x < w; x++)
                    sel[y * w + x] = row[x * 4 + 3] >= 128 ? (byte)1 : (byte)0;
            }

            if (morphologicalClose)
            {
                const int closeR = 3;
                sel = Dilate(sel, w, h, closeR);
                sel = Erode(sel, w, h, closeR);
            }

            // 填内部孔洞：从工作区边缘洪水标记「外部」，其余透明点视为残余并填上
            var outside = new bool[n];
            var q = new Queue<int>();
            void TrySeed(int i)
            {
                if ((uint)i >= (uint)n || sel[i] != 0 || outside[i]) return;
                outside[i] = true;
                q.Enqueue(i);
            }

            for (var x = 0; x < w; x++)
            {
                TrySeed(x);
                TrySeed((h - 1) * w + x);
            }

            for (var y = 0; y < h; y++)
            {
                TrySeed(y * w);
                TrySeed(y * w + (w - 1));
            }

            while (q.Count > 0)
            {
                var i = q.Dequeue();
                var x = i % w;
                var y = i / w;
                if (x > 0) TrySeed(i - 1);
                if (x + 1 < w) TrySeed(i + 1);
                if (y > 0) TrySeed(i - w);
                if (y + 1 < h) TrySeed(i + w);
            }

            for (var i = 0; i < n; i++)
            {
                if (sel[i] == 0 && !outside[i])
                    sel[i] = 1; // 内部残余 → 选中
            }

            // 写回 mask
            for (var y = 0; y < h; y++)
            {
                Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), row, 0, row.Length);
                for (var x = 0; x < w; x++)
                {
                    var i = x * 4;
                    if (sel[y * w + x] != 0)
                    {
                        row[i] = 255;
                        row[i + 1] = 255;
                        row[i + 2] = 255;
                        row[i + 3] = 255;
                    }
                    else
                    {
                        row[i] = 0;
                        row[i + 1] = 0;
                        row[i + 2] = 0;
                        row[i + 3] = 0;
                    }
                }

                Marshal.Copy(row, 0, IntPtr.Add(data.Scan0, y * data.Stride), row.Length);
            }
        }
        finally
        {
            _mask.UnlockBits(data);
        }

        SyncVeilFromSelection(b, sel, w, h);
    }

    private void SyncVeilFromSelection(Rectangle b, byte[] sel, int w, int h)
    {
        if (_veil is null) return;
        var vData = _veil.LockBits(b, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
        try
        {
            var row = new byte[w * 4];
            var va = VeilColor.A;
            for (var y = 0; y < h; y++)
            {
                for (var x = 0; x < w; x++)
                {
                    var i = x * 4;
                    if (sel[y * w + x] != 0)
                    {
                        row[i] = 0;
                        row[i + 1] = 0;
                        row[i + 2] = 0;
                        row[i + 3] = 0;
                    }
                    else
                    {
                        row[i] = 0;
                        row[i + 1] = 0;
                        row[i + 2] = 0;
                        row[i + 3] = va;
                    }
                }

                Marshal.Copy(row, 0, IntPtr.Add(vData.Scan0, y * vData.Stride), row.Length);
            }
        }
        finally
        {
            _veil.UnlockBits(vData);
        }
    }

    private static byte[] Dilate(byte[] src, int w, int h, int r)
    {
        var dst = new byte[src.Length];
        for (var y = 0; y < h; y++)
        for (var x = 0; x < w; x++)
        {
            byte v = 0;
            for (var dy = -r; dy <= r && v == 0; dy++)
            for (var dx = -r; dx <= r; dx++)
            {
                var nx = x + dx;
                var ny = y + dy;
                if ((uint)nx >= (uint)w || (uint)ny >= (uint)h) continue;
                if (src[ny * w + nx] != 0) { v = 1; break; }
            }

            dst[y * w + x] = v;
        }

        return dst;
    }

    private static byte[] Erode(byte[] src, int w, int h, int r)
    {
        var dst = new byte[src.Length];
        for (var y = 0; y < h; y++)
        for (var x = 0; x < w; x++)
        {
            byte v = 1;
            for (var dy = -r; dy <= r && v != 0; dy++)
            for (var dx = -r; dx <= r; dx++)
            {
                var nx = x + dx;
                var ny = y + dy;
                if ((uint)nx >= (uint)w || (uint)ny >= (uint)h) { v = 0; break; }
                if (src[ny * w + nx] == 0) { v = 0; break; }
            }

            dst[y * w + x] = v;
        }

        return dst;
    }

    private static Bitmap CropByMask(Bitmap screen, Bitmap mask, Rectangle bounds)
    {
        bounds.Intersect(new Rectangle(0, 0, screen.Width, screen.Height));
        if (bounds.Width < 1 || bounds.Height < 1)
            throw new InvalidOperationException("empty");

        // 与框选相同：先完整拷贝屏幕像素，再按遮罩抠掉未涂区域
        var bmp = screen.Clone(bounds, PixelFormat.Format32bppArgb);
        var mData = mask.LockBits(bounds, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        var dData = bmp.LockBits(new Rectangle(0, 0, bounds.Width, bounds.Height),
            ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
        try
        {
            var rowBytes = bounds.Width * 4;
            var mRow = new byte[rowBytes];
            var dRow = new byte[rowBytes];
            for (var y = 0; y < bounds.Height; y++)
            {
                Marshal.Copy(IntPtr.Add(mData.Scan0, y * mData.Stride), mRow, 0, rowBytes);
                Marshal.Copy(IntPtr.Add(dData.Scan0, y * dData.Stride), dRow, 0, rowBytes);
                for (var x = 0; x < bounds.Width; x++)
                {
                    var i = x * 4;
                    if (mRow[i + 3] < 128)
                    {
                        // 未涂抹：全透明
                        dRow[i] = 0;
                        dRow[i + 1] = 0;
                        dRow[i + 2] = 0;
                        dRow[i + 3] = 0;
                    }
                    else
                    {
                        // 已涂抹：保留屏幕颜色，不透明（不要用遮罩的白色）
                        dRow[i + 3] = 255;
                    }
                }

                Marshal.Copy(dRow, 0, IntPtr.Add(dData.Scan0, y * dData.Stride), rowBytes);
            }
        }
        finally
        {
            mask.UnlockBits(mData);
            bmp.UnlockBits(dData);
        }

        return bmp;
    }

    private void UpdateCursor(Point p)
    {
        if (OverBars(p)) { Cursor = Cursors.Default; return; }
        if (_doodleActive && _phase == Phase.Adjusting && IsRectLike)
        {
            Cursor = Cursors.Cross;
            return;
        }

        if (_shape == ShapeMode.Smear)
        {
            Cursor = Cursors.Cross;
            return;
        }

        if (CanDetectWindow)
        {
            Cursor = _hasHoverWindow ? Cursors.Hand : Cursors.Cross;
            return;
        }

        if (_phase != Phase.Adjusting) { Cursor = Cursors.Cross; return; }

        Cursor = HitTestRect(p) switch
        {
            Hit.N or Hit.S => Cursors.SizeNS,
            Hit.E or Hit.W => Cursors.SizeWE,
            Hit.NE or Hit.SW => Cursors.SizeNESW,
            Hit.NW or Hit.SE => Cursors.SizeNWSE,
            Hit.Move => Cursors.SizeAll,
            _ => Cursors.Cross
        };
    }

    private Hit HitTestRect(Point p)
    {
        foreach (var (hit, rect) in GetHandles(_sel))
            if (rect.Contains(p)) return hit;
        return _sel.Contains(p) ? Hit.Move : Hit.None;
    }

    private void OnPaint(object? sender, PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.DrawImageUnscaled(_screen, 0, 0);
        using var dim = new SolidBrush(Color.FromArgb(120, 0, 0, 0));

        if (_phase == Phase.Idle && !_hasMask)
        {
            if (CanDetectWindow && _hasHoverWindow)
            {
                FillOutside(g, dim, _hoverWindow);
                PaintSelectionFrame(g, _hoverWindow, showHandles: true);
            }
            else
                g.FillRectangle(dim, ClientRectangle);

            if (IsRectLike)
                PaintLoupe(g, _cursorPos);
            PaintModeHint(g);
            return;
        }

        if (IsRectLike)
            PaintRect(g, dim);
        else
            PaintSmear(g, dim);

        PaintMarks(g);

        if (IsRectLike)
            PaintLoupe(g, _cursorPos);
        PaintModeHint(g);
    }

    private void PaintModeHint(Graphics g)
    {
        string tip;
        if (_doodleActive && _phase == Phase.Adjusting && IsRectLike)
        {
            tip = L.T("拖动添加标注 · Ctrl+Z 撤销 · 右键取消", "Drag to mark · Ctrl+Z undo · Right to cancel");
        }
        else
        {
            tip = _shape == ShapeMode.Rect
                ? L.T("F2 切换涂抹 · 右键/Esc 取消", "F2 smear · Right/Esc cancel")
                : L.T("F2 切换框选 · 右键/Esc 取消", "F2 select · Right/Esc cancel");
        }

        DrawTip(g, tip);
    }

    private void CopyCursorColor()
    {
        try
        {
            var pt = ClampPoint(_cursorPos);
            var c = _screen.GetPixel(pt.X, pt.Y);
            var hex = $"#{c.R:X2}{c.G:X2}{c.B:X2}";
            ClipboardHistoryService.Instance.IgnoreNextExternalChange();
            Clipboard.SetText(hex);
        }
        catch
        {
            // 复制失败不阻断截图
        }
    }

    private void PaintSelectionFrame(Graphics g, Rectangle sel, bool showHandles)
    {
        if (sel.Width < 1 || sel.Height < 1)
            return;

        var draw = new Rectangle(sel.X, sel.Y, Math.Max(0, sel.Width - 1), Math.Max(0, sel.Height - 1));
        using var pen = new Pen(WindowHoverColor, 1f);
        g.DrawRectangle(pen, draw);

        if (showHandles)
        {
            foreach (var (_, rect) in GetHandles(sel))
            {
                g.FillRectangle(Brushes.White, rect);
                g.DrawRectangle(pen, rect);
            }
        }

        DrawSizeWeChat(g, sel);
    }

    private void PaintLoupe(Graphics g, Point clientPt)
    {
        if (!ClientRectangle.Contains(clientPt))
            return;

        var px = Math.Clamp(clientPt.X, 0, _screen.Width - 1);
        var py = Math.Clamp(clientPt.Y, 0, _screen.Height - 1);
        var color = _screen.GetPixel(px, py);
        var screenPt = PointToScreen(clientPt);
        var hex = $"#{color.R:X2}{color.G:X2}{color.B:X2}";

        var panelX = clientPt.X + 18;
        var panelY = clientPt.Y + 18;
        if (panelX + LoupePanelW > ClientSize.Width - 8)
            panelX = clientPt.X - LoupePanelW - 18;
        if (panelY + LoupePanelH > ClientSize.Height - 8)
            panelY = clientPt.Y - LoupePanelH - 18;
        panelX = Math.Max(8, panelX);
        panelY = Math.Max(8, panelY);

        var panel = new Rectangle(panelX, panelY, LoupePanelW, LoupePanelH);
        using (var path = CreateRoundedRect(panel, 6))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using var fill = new SolidBrush(Color.FromArgb(245, 255, 255, 255));
            using var border = new Pen(Color.FromArgb(220, 200, 200, 200));
            g.FillPath(fill, path);
            g.DrawPath(border, path);
        }

        var grid = LoupePixelSize * LoupeZoom;
        var gridX = panelX + (LoupePanelW - grid) / 2;
        var gridY = panelY + 8;
        var gridRect = new Rectangle(gridX, gridY, grid, grid);

        g.SetClip(gridRect);
        var half = LoupePixelSize / 2;
        for (var dy = -half; dy <= half; dy++)
        for (var dx = -half; dx <= half; dx++)
        {
            var sx = Math.Clamp(px + dx, 0, _screen.Width - 1);
            var sy = Math.Clamp(py + dy, 0, _screen.Height - 1);
            var pixel = _screen.GetPixel(sx, sy);
            using var brush = new SolidBrush(pixel);
            g.FillRectangle(brush,
                gridX + (dx + half) * LoupeZoom,
                gridY + (dy + half) * LoupeZoom,
                LoupeZoom,
                LoupeZoom);
        }

        using var cross = new Pen(WindowHoverColor, 1f);
        var cx = gridX + half * LoupeZoom + LoupeZoom / 2;
        var cy = gridY + half * LoupeZoom + LoupeZoom / 2;
        g.DrawLine(cross, cx, gridY, cx, gridY + grid);
        g.DrawLine(cross, gridX, cy, gridX + grid, cy);
        g.ResetClip();

        using var font = new Font("Segoe UI", 8f);
        using var ink = new SolidBrush(Color.FromArgb(40, 40, 40));
        using var sub = new SolidBrush(Color.FromArgb(110, 110, 110));
        var textY = gridY + grid + 6;
        g.DrawString(L.T($"坐标 {screenPt.X}, {screenPt.Y}", $"Pos {screenPt.X}, {screenPt.Y}"), font, ink, panelX + 8, textY);
        g.DrawString(L.T($"色值 {hex}", $"Color {hex}"), font, ink, panelX + 8, textY + 16);
        g.DrawString(L.T("按 Ctrl+C 复制色值", "Ctrl+C to copy color"), font, sub, panelX + 8, textY + 32);
    }

    private static GraphicsPath CreateRoundedRect(Rectangle bounds, int radius)
    {
        var path = new GraphicsPath();
        var d = radius * 2;
        path.AddArc(bounds.X, bounds.Y, d, d, 180, 90);
        path.AddArc(bounds.Right - d, bounds.Y, d, d, 270, 90);
        path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90);
        path.AddArc(bounds.X, bounds.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    private static void DrawSizeWeChat(Graphics g, Rectangle sel)
    {
        if (sel.Width < 1 || sel.Height < 1)
            return;

        var info = $"{sel.Width} x {sel.Height}";
        using var infoFont = new Font("Segoe UI", 9f, FontStyle.Regular);
        var infoSize = g.MeasureString(info, infoFont);
        var infoRect = new RectangleF(
            sel.Left,
            Math.Max(0, sel.Top - infoSize.Height - 4),
            infoSize.Width + 8,
            infoSize.Height + 2);
        using var bg = new SolidBrush(Color.FromArgb(210, 72, 72, 72));
        using var fg = new SolidBrush(Color.White);
        g.FillRectangle(bg, infoRect);
        g.DrawString(info, infoFont, fg, infoRect.X + 4, infoRect.Y + 1);
    }

    private void PaintMarks(Graphics g)
    {
        foreach (var mark in _markItems)
            DrawMarkRectangle(g, mark.Bounds, mark.Color);

        if (_markCreating && _markPreview.Width >= 1 && _markPreview.Height >= 1)
            DrawMarkRectangle(g, _markPreview, _markColor);
    }

    private void PaintRect(Graphics g, Brush dim)
    {
        var sel = _sel;
        if (sel.Width < 1 || sel.Height < 1)
        {
            g.FillRectangle(dim, ClientRectangle);
            return;
        }

        FillOutside(g, dim, sel);
        PaintSelectionFrame(g, sel, showHandles: _phase == Phase.Adjusting || _phase == Phase.Creating);
    }

    private void PaintSmear(Graphics g, Brush dim)
    {
        // 与框选相同：未选区域变暗，涂抹处“打孔”透出原图
        if (_veil is not null && (_hasMask || _phase != Phase.Idle))
            g.DrawImageUnscaled(_veil, 0, 0);
        else
            g.FillRectangle(dim, ClientRectangle);

        if (!_hasMask || _maskBounds.IsEmpty) return;

        if (_phase == Phase.Adjusting)
        {
            using var edge = new Pen(Color.FromArgb(200, 0, 174, 255), 2f);
            g.DrawRectangle(edge, _maskBounds);
            DrawSize(g, _maskBounds);
        }
    }

    private Rectangle GetBrushInvalidateRect(Point a, Point b)
    {
        var pad = BrushRadius + 4;
        var r = Rectangle.FromLTRB(
            Math.Min(a.X, b.X) - pad,
            Math.Min(a.Y, b.Y) - pad,
            Math.Max(a.X, b.X) + pad,
            Math.Max(a.Y, b.Y) + pad);
        r.Intersect(ClientRectangle);
        return r;
    }

    private void FillOutside(Graphics g, Brush dim, Rectangle sel)
    {
        g.FillRectangle(dim, new Rectangle(0, 0, ClientSize.Width, Math.Max(0, sel.Top)));
        g.FillRectangle(dim, new Rectangle(0, sel.Bottom, ClientSize.Width, Math.Max(0, ClientSize.Height - sel.Bottom)));
        g.FillRectangle(dim, new Rectangle(0, sel.Top, Math.Max(0, sel.Left), sel.Height));
        g.FillRectangle(dim, new Rectangle(sel.Right, sel.Top, Math.Max(0, ClientSize.Width - sel.Right), sel.Height));
    }

    private void DrawTip(Graphics g, string tip)
    {
        using var tipFont = new Font("Segoe UI", 11f, FontStyle.Regular);
        var sz = g.MeasureString(tip, tipFont);
        const float padX = 12f;
        const float padY = 6f;
        var rect = new RectangleF(
            (ClientSize.Width - sz.Width) / 2f - padX,
            12f,
            sz.Width + padX * 2,
            sz.Height + padY * 2);
        using var bg = new SolidBrush(Color.FromArgb(210, 48, 48, 48));
        using var path = CreateRoundedRect(Rectangle.Round(rect), 4);
        g.FillPath(bg, path);
        using var ink = new SolidBrush(Color.White);
        g.DrawString(tip, tipFont, ink, rect.X + padX, rect.Y + padY);
    }

    private static void DrawSize(Graphics g, Rectangle sel)
    {
        if (sel.Width < 1 || sel.Height < 1) return;
        var info = $"{sel.Width} × {sel.Height}";
        using var infoFont = new Font("Segoe UI", 9f, FontStyle.Bold);
        var infoSize = g.MeasureString(info, infoFont);
        var infoRect = new RectangleF(sel.Left, Math.Max(0, sel.Top - infoSize.Height - 4),
            infoSize.Width + 8, infoSize.Height + 2);
        g.FillRectangle(Brushes.Black, infoRect);
        g.DrawString(info, infoFont, Brushes.White, infoRect.X + 4, infoRect.Y + 1);
    }

    private static double Distance(Point a, Point b)
    {
        var dx = a.X - b.X;
        var dy = a.Y - b.Y;
        return Math.Sqrt(dx * dx + dy * dy);
    }

    private Point ClampPoint(Point p) =>
        new(Math.Clamp(p.X, 0, ClientSize.Width - 1), Math.Clamp(p.Y, 0, ClientSize.Height - 1));

    private Rectangle ClampRect(Rectangle r)
    {
        if (r.X < 0) { r.Width += r.X; r.X = 0; }
        if (r.Y < 0) { r.Height += r.Y; r.Y = 0; }
        if (r.Right > ClientSize.Width) r.Width = ClientSize.Width - r.X;
        if (r.Bottom > ClientSize.Height) r.Height = ClientSize.Height - r.Y;
        if (r.Width < 0) r.Width = 0;
        if (r.Height < 0) r.Height = 0;
        return r;
    }

    private static List<(Hit hit, Rectangle rect)> GetHandles(Rectangle sel)
    {
        var hs = HandleSize;
        return
        [
            (Hit.NW, HandleAt(sel.Left, sel.Top, hs)),
            (Hit.N, HandleAt(sel.Left + sel.Width / 2, sel.Top, hs)),
            (Hit.NE, HandleAt(sel.Right, sel.Top, hs)),
            (Hit.E, HandleAt(sel.Right, sel.Top + sel.Height / 2, hs)),
            (Hit.SE, HandleAt(sel.Right, sel.Bottom, hs)),
            (Hit.S, HandleAt(sel.Left + sel.Width / 2, sel.Bottom, hs)),
            (Hit.SW, HandleAt(sel.Left, sel.Bottom, hs)),
            (Hit.W, HandleAt(sel.Left, sel.Top + sel.Height / 2, hs))
        ];
    }

    private static Rectangle HandleAt(int cx, int cy, int size)
    {
        var half = size / 2;
        return new Rectangle(cx - half, cy - half, size, size);
    }

    private static Rectangle ApplyRectHit(Rectangle origin, Hit hit, Point down, Point now)
    {
        var dx = now.X - down.X;
        var dy = now.Y - down.Y;
        var l = origin.Left;
        var t = origin.Top;
        var r = origin.Right;
        var b = origin.Bottom;
        switch (hit)
        {
            case Hit.Move: l += dx; r += dx; t += dy; b += dy; break;
            case Hit.N: t += dy; break;
            case Hit.S: b += dy; break;
            case Hit.W: l += dx; break;
            case Hit.E: r += dx; break;
            case Hit.NW: l += dx; t += dy; break;
            case Hit.NE: r += dx; t += dy; break;
            case Hit.SW: l += dx; b += dy; break;
            case Hit.SE: r += dx; b += dy; break;
        }

        var rect = NormalizeRect(new Point(l, t), new Point(r, b));
        if (rect.Width < MinSize) rect.Width = MinSize;
        if (rect.Height < MinSize) rect.Height = MinSize;
        return rect;
    }

    private static Rectangle NormalizeRect(Point a, Point b) =>
        new(Math.Min(a.X, b.X), Math.Min(a.Y, b.Y), Math.Abs(a.X - b.X), Math.Abs(a.Y - b.Y));

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        LayoutModeBar();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _mousePassthrough = false;
            if (IsHandleCreated)
            {
                var ex = GetWindowStylePtr(Handle, GwlExStyle).ToInt64();
                ex &= ~WsExTransparent;
                SetWindowStylePtr(Handle, GwlExStyle, new IntPtr(ex));
            }

            _hoverTimer.Stop();
            _hoverTimer.Dispose();
            ReleaseMaskGraphics();
            ReleaseVeilGraphics();
            _mask?.Dispose();
            _veil?.Dispose();
            _maskAtDragStart?.Dispose();
            _veilAtDragStart?.Dispose();
            _screen.Dispose();
        }

        base.Dispose(disposing);
    }
}
