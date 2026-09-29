using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace MemWatch;

/// <summary>置顶贴图：滚轮缩放（消抖）、Ctrl+滚轮透明度；右键开关穿透。</summary>
internal sealed class PinStickerForm : Form
{
    private readonly Bitmap _source;
    private float _scale = 1f;
    private double _opacity = 1.0;
    private bool _mouseInteractive = true;
    private bool _selected;
    private bool _dragging;
    private Point _dragOffset;
    private bool _layoutBusy;
    private Bitmap? _layerCache;
    private readonly ContextMenuStrip _menu = new();
    private readonly ToolStripMenuItem _menuInteractive = new();
    private readonly ToolStripMenuItem _menuClose = new();
    private readonly ToolStripMenuItem _menuTop = new();

    public string Id { get; } = Guid.NewGuid().ToString("N");
    public int GroupIndex { get; set; }
    public bool MouseInteractive => _mouseInteractive;

    public event Action<PinStickerForm>? Selected;
    public event Action<PinStickerForm>? ClosedByUser;

    public PinStickerForm(Bitmap image, int groupIndex, Point screenLocation)
    {
        _source = (Bitmap)image.Clone();
        GroupIndex = groupIndex;

        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        BackColor = Color.Magenta;
        DoubleBuffered = true;
        KeyPreview = true;

        var w = Math.Max(16, _source.Width);
        var h = Math.Max(16, _source.Height);
        Size = new Size(w, h);
        Location = screenLocation;

        BuildMenu();

        MouseDown += OnMouseDown;
        MouseMove += OnMouseMove;
        MouseUp += (_, _) => _dragging = false;
        MouseWheel += OnMouseWheel;
        MouseClick += OnMouseClick;
        MouseDoubleClick += OnMouseDoubleClick;
        KeyDown += OnKeyDown;
    }

    private void BuildMenu()
    {
        _menuInteractive.Click += (_, _) => SetMouseInteractive(!_mouseInteractive);
        _menuClose.Click += (_, _) =>
        {
            ClosedByUser?.Invoke(this);
            Close();
        };
        _menuTop.Click += (_, _) =>
        {
            TopMost = !TopMost;
            ApplyLanguageMenu();
        };
        _menu.Items.Add(_menuInteractive);
        _menu.Items.Add(_menuTop);
        _menu.Items.Add(new ToolStripSeparator());
        _menu.Items.Add(_menuClose);
        _menu.Opening += (_, _) => ApplyLanguageMenu();
        ContextMenuStrip = _menu;
    }

    private void ApplyLanguageMenu()
    {
        _menuInteractive.Text = _mouseInteractive
            ? L.T("关闭鼠标交互（穿透）", "Disable mouse (click-through)")
            : L.T("开启鼠标交互", "Enable mouse interaction");
        _menuTop.Text = TopMost
            ? L.T("取消置顶", "Unpin topmost")
            : L.T("窗口置顶", "Keep topmost");
        _menuClose.Text = L.T("关闭此贴图", "Close sticker");
    }

    public void SetSelected(bool selected)
    {
        if (_selected == selected) return;
        _selected = selected;
        InvalidateLayer(rebuild: true);
    }

    public void SetMouseInteractive(bool on)
    {
        _mouseInteractive = on;
        RecreateHandleSafe();
        InvalidateLayer(rebuild: true);
    }

    public void SetGroupVisible(bool visible)
    {
        Visible = visible;
        if (visible)
            InvalidateLayer(rebuild: false);
    }

    private void OnMouseDown(object? sender, MouseEventArgs e)
    {
        if (!_mouseInteractive) return;
        if (e.Button == MouseButtons.Left)
        {
            Selected?.Invoke(this);
            _dragging = true;
            _dragOffset = e.Location;
        }
    }

    private void OnMouseMove(object? sender, MouseEventArgs e)
    {
        if (!_dragging || e.Button != MouseButtons.Left) return;
        var next = new Point(Left + e.X - _dragOffset.X, Top + e.Y - _dragOffset.Y);
        MoveLayer(next.X, next.Y);
    }

    private void OnMouseClick(object? sender, MouseEventArgs e)
    {
        if (!_mouseInteractive) return;
        if (e.Button == MouseButtons.Left)
            Selected?.Invoke(this);
    }

    private void OnMouseDoubleClick(object? sender, MouseEventArgs e)
    {
        if (!_mouseInteractive) return;
        if (e.Button != MouseButtons.Left) return;
        ClosedByUser?.Invoke(this);
        Close();
    }

    private void OnMouseWheel(object? sender, MouseEventArgs e)
    {
        if (!_mouseInteractive || !_selected) return;

        if ((ModifierKeys & Keys.Control) == Keys.Control)
        {
            var delta = e.Delta > 0 ? 0.05 : -0.05;
            var next = Math.Clamp(_opacity + delta, 0.15, 1.0);
            if (Math.Abs(next - _opacity) < 0.0001) return;
            _opacity = next;
            InvalidateLayer(rebuild: true);
            return;
        }

        // 以光标为锚点缩放，避免中心取整来回跳
        var factor = e.Delta > 0 ? 1.08f : 1f / 1.08f;
        var newScale = Math.Clamp(_scale * factor, 0.1f, 8f);
        if (Math.Abs(newScale - _scale) < 0.0001f) return;

        var oldW = Math.Max(1, Width);
        var oldH = Math.Max(1, Height);
        var anchorX = Math.Clamp(e.X, 0, oldW) / (double)oldW;
        var anchorY = Math.Clamp(e.Y, 0, oldH) / (double)oldH;
        var screenAnchorX = Left + e.X;
        var screenAnchorY = Top + e.Y;

        _scale = newScale;
        var nw = Math.Max(16, (int)Math.Round(_source.Width * _scale, MidpointRounding.AwayFromZero));
        var nh = Math.Max(16, (int)Math.Round(_source.Height * _scale, MidpointRounding.AwayFromZero));
        // 偶数尺寸减少 0.5 像素锚点抖动
        if ((nw & 1) != 0) nw++;
        if ((nh & 1) != 0) nh++;

        var nx = (int)Math.Round(screenAnchorX - nw * anchorX, MidpointRounding.AwayFromZero);
        var ny = (int)Math.Round(screenAnchorY - nh * anchorY, MidpointRounding.AwayFromZero);

        _layoutBusy = true;
        try
        {
            SetBounds(nx, ny, nw, nh);
        }
        finally
        {
            _layoutBusy = false;
        }

        InvalidateLayer(rebuild: true);
    }

    private void OnKeyDown(object? sender, KeyEventArgs e)
    {
        if (e.KeyCode == Keys.Delete && _selected)
        {
            ClosedByUser?.Invoke(this);
            Close();
        }
    }

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= 0x00000080; // WS_EX_TOOLWINDOW
            cp.ExStyle |= 0x00080000; // WS_EX_LAYERED
            if (!_mouseInteractive)
                cp.ExStyle |= 0x00000020; // WS_EX_TRANSPARENT
            return cp;
        }
    }

    private void RecreateHandleSafe()
    {
        if (!IsHandleCreated) return;
        var loc = Location;
        var size = Size;
        var vis = Visible;
        _layoutBusy = true;
        try
        {
            RecreateHandle();
            Location = loc;
            Size = size;
            Visible = vis;
        }
        finally
        {
            _layoutBusy = false;
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        InvalidateLayer(rebuild: true);
    }

    protected override void OnLocationChanged(EventArgs e)
    {
        base.OnLocationChanged(e);
        // 拖动/缩放时不在这里整图重绘，避免抖动
        if (_layoutBusy || _dragging) return;
        MoveLayer(Left, Top);
    }

    /// <summary>仅移动分层窗口位置，不重建位图。</summary>
    private void MoveLayer(int x, int y)
    {
        if (!IsHandleCreated) return;
        _layoutBusy = true;
        try
        {
            if (Left != x || Top != y)
                SetBounds(x, y, Width, Height);
        }
        finally
        {
            _layoutBusy = false;
        }

        EnsureLayerCache();
        if (_layerCache is null) return;
        PresentLayer(_layerCache, x, y);
    }

    private void InvalidateLayer(bool rebuild)
    {
        if (!IsHandleCreated) return;
        if (rebuild)
        {
            _layerCache?.Dispose();
            _layerCache = null;
        }

        EnsureLayerCache();
        if (_layerCache is null) return;
        PresentLayer(_layerCache, Left, Top);
    }

    private void EnsureLayerCache()
    {
        var w = Math.Max(1, Width);
        var h = Math.Max(1, Height);
        if (_layerCache is { } c && c.Width == w && c.Height == h)
            return;

        _layerCache?.Dispose();
        var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.Clear(Color.Transparent);
            g.PixelOffsetMode = PixelOffsetMode.Half;
            g.InterpolationMode = InterpolationMode.HighQualityBilinear;
            g.SmoothingMode = SmoothingMode.HighQuality;
            g.DrawImage(_source, new Rectangle(0, 0, w, h));
            if (_selected && _mouseInteractive)
            {
                using var pen = new Pen(Color.FromArgb(0, 174, 255), 2f);
                g.DrawRectangle(pen, 1, 1, w - 3, h - 3);
            }
        }

        _layerCache = bmp;
    }

    private void PresentLayer(Bitmap bitmap, int x, int y)
    {
        var screenDc = GetDC(IntPtr.Zero);
        var memDc = CreateCompatibleDC(screenDc);
        var hBitmap = IntPtr.Zero;
        var oldBitmap = IntPtr.Zero;
        try
        {
            hBitmap = bitmap.GetHbitmap(Color.FromArgb(0));
            oldBitmap = SelectObject(memDc, hBitmap);
            var size = new SIZE { cx = bitmap.Width, cy = bitmap.Height };
            var pointSource = new POINT { x = 0, y = 0 };
            var topPos = new POINT { x = x, y = y };
            var blend = new BLENDFUNCTION
            {
                BlendOp = 0,
                BlendFlags = 0,
                SourceConstantAlpha = (byte)Math.Clamp((int)Math.Round(_opacity * 255), 1, 255),
                AlphaFormat = 1
            };
            UpdateLayeredWindow(Handle, screenDc, ref topPos, ref size, memDc, ref pointSource, 0, ref blend, 2);
        }
        finally
        {
            if (hBitmap != IntPtr.Zero)
            {
                SelectObject(memDc, oldBitmap);
                DeleteObject(hBitmap);
            }

            DeleteDC(memDc);
            ReleaseDC(IntPtr.Zero, screenDc);
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _menu.Dispose();
            _layerCache?.Dispose();
            _source.Dispose();
        }

        base.Dispose(disposing);
    }

    private struct POINT { public int x, y; }
    private struct SIZE { public int cx, cy; }
    private struct BLENDFUNCTION
    {
        public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst, ref SIZE psize,
        IntPtr hdcSrc, ref POINT pptSrc, int crKey, ref BLENDFUNCTION pblend, int dwFlags);

    [DllImport("user32.dll")]
    private static extern IntPtr GetDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDc);

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateCompatibleDC(IntPtr hDc);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteDC(IntPtr hdc);

    [DllImport("gdi32.dll")]
    private static extern IntPtr SelectObject(IntPtr hdc, IntPtr h);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr h);
}
