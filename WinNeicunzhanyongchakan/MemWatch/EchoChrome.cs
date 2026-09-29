using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace MemWatch;

/// <summary>
/// 自定义漂流木顶栏，替换系统窗口栏；可拖动，可选缩放。
/// </summary>
internal static class EchoChrome
{
    public const int BarHeight = 36;
    public const int Frame = 10;
    public const string BarTag = "echo-chrome";

    private const int WM_NCLBUTTONDOWN = 0xA1;
    private const int WM_NCHITTEST = 0x84;
    private const int HTCAPTION = 2;
    private const int HTLEFT = 10;
    private const int HTRIGHT = 11;
    private const int HTTOP = 12;
    private const int HTTOPLEFT = 13;
    private const int HTTOPRIGHT = 14;
    private const int HTBOTTOM = 15;
    private const int HTBOTTOMLEFT = 16;
    private const int HTBOTTOMRIGHT = 17;
    private const int Grip = 10;

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, int wParam, int lParam);

    public static void Attach(Form form, bool canResize, bool showMin, Action? onMinimize = null)
    {
        form.FormBorderStyle = FormBorderStyle.None;
        form.Padding = new Padding(0, BarHeight, 0, Frame);
        form.Paint -= Form_PaintBorder;
        form.Paint += Form_PaintBorder;

        // 已挂过则只更新标题
        foreach (Control c in form.Controls)
        {
            if (c.Tag as string == BarTag)
            {
                UpdateTitle(form);
                return;
            }
        }

        var bar = new BeachBar
        {
            Tag = BarTag,
            Dock = DockStyle.None,
            Height = BarHeight,
            TitleText = form.Text,
            Font = new Font("Microsoft YaHei UI", 11f, FontStyle.Bold)
        };

        var close = MakeBeachChromeBtn("×");
        close.Click += (_, _) => form.Close();

        Button? min = null;
        if (showMin)
        {
            min = MakeBeachChromeBtn("–");
            min.Click += (_, _) =>
            {
                if (onMinimize is not null)
                    onMinimize();
                else
                    form.WindowState = FormWindowState.Minimized;
            };
        }

        void BeginDrag()
        {
            if (form.WindowState == FormWindowState.Maximized)
                return;
            ReleaseCapture();
            SendMessage(form.Handle, WM_NCLBUTTONDOWN, HTCAPTION, 0);
        }

        bar.MouseDown += (_, e) =>
        {
            if (e.Button == MouseButtons.Left)
                BeginDrag();
        };

        if (min is not null)
            bar.Controls.Add(min);
        bar.Controls.Add(close);
        PlaceBeachChromeBtns(bar, min, close);
        bar.Resize += (_, _) => PlaceBeachChromeBtns(bar, min, close);

        form.Controls.Add(bar);
        foreach (Control c in form.Controls)
        {
            if (c.Dock == DockStyle.Fill)
                c.Margin = new Padding(Frame, 0, Frame, 0);
        }
        LayoutBar(form, bar);
        form.Resize += (_, _) =>
        {
            LayoutBar(form, bar);
            form.Invalidate();
        };
        form.PerformLayout();

        form.TextChanged += (_, _) => UpdateTitle(form);

        if (canResize)
            form.Load += (_, _) => ResizeHook.Install(form);
    }

    public static void SetVisible(Form form, bool visible)
    {
        foreach (Control c in form.Controls)
        {
            if (c.Tag as string != BarTag)
                continue;
            c.Visible = visible;
            form.Padding = visible ? new Padding(0, BarHeight, 0, Frame) : Padding.Empty;
            if (visible)
            {
                LayoutBar(form, c);
                form.PerformLayout();
            }
            break;
        }
    }

    public static void UpdateTitle(Form form)
    {
        foreach (Control c in form.Controls)
        {
            if (c.Tag as string != BarTag)
                continue;
            if (c is BeachBar beach)
            {
                beach.TitleText = form.Text;
                beach.Invalidate();
            }
            break;
        }
    }

    private static void Form_PaintBorder(object? sender, PaintEventArgs e)
    {
        if (sender is not Form form || form.Padding.All == 0)
            return;

        var r = form.ClientRectangle;
        var t = BarHeight;
        var b = form.Padding.Bottom;
        var l = Frame;
        var ri = Frame;
        if (b > 0)
            FarmSkin.PaintFrame(e.Graphics, new Rectangle(0, r.Height - b, r.Width, b));
        FarmSkin.PaintFrame(e.Graphics, new Rectangle(0, t, l, Math.Max(0, r.Height - t - b)));
        FarmSkin.PaintFrame(e.Graphics, new Rectangle(r.Width - ri, t, ri, Math.Max(0, r.Height - t - b)));

        using var edge = new Pen(Color.FromArgb(90, 30, 18, 8), 1);
        e.Graphics.DrawRectangle(edge, 0, 0, r.Width - 1, r.Height - 1);
    }

    internal static void EnableResize(Form form) => ResizeHook.Install(form);

    private static void LayoutBar(Form form, Control bar)
    {
        bar.SetBounds(0, 0, form.ClientSize.Width, BarHeight);
        bar.BringToFront();
        PlaceBeachChromeBtns(
            bar,
            bar.Controls.OfType<Button>().FirstOrDefault(b => b.Text == "–"),
            bar.Controls.OfType<Button>().First(b => b.Text == "×"));
    }

    internal static Button MakeBeachChromeBtn(string text)
    {
        var b = new Button
        {
            Text = text,
            Size = new Size(28, 22),
            FlatStyle = FlatStyle.Flat,
            Font = new Font("Segoe UI", 11f),
            ForeColor = UiTheme.Ink,
            BackColor = UiTheme.Back,
            UseVisualStyleBackColor = false,
            TabStop = false
        };
        b.FlatAppearance.BorderSize = 0;
        b.FlatAppearance.MouseOverBackColor = Color.FromArgb(0xE0, 0xE0, 0xE0);
        b.FlatAppearance.MouseDownBackColor = Color.FromArgb(0xC8, 0xC8, 0xC8);
        return b;
    }

    internal static void PlaceBeachChromeBtns(Control bar, Button? min, Button close)
    {
        var y = Math.Max(2, (bar.ClientSize.Height - 22) / 2);
        close.Size = new Size(28, 22);
        close.Location = new Point(Math.Max(4, bar.ClientSize.Width - close.Width - 6), y);
        if (min is null)
            return;
        min.Size = new Size(28, 22);
        min.Location = new Point(close.Left - min.Width - 2, y);
    }

    private sealed class ResizeHook : NativeWindow
    {
        private readonly Form _form;
        private static readonly ConditionalWeakTable<Form, ResizeHook> Hooks = new();

        private ResizeHook(Form form) => _form = form;

        public static void Install(Form form)
        {
            if (Hooks.TryGetValue(form, out _))
                return;
            var hook = new ResizeHook(form);
            if (form.IsHandleCreated)
                hook.AssignHandle(form.Handle);
            form.HandleCreated += (_, _) =>
            {
                try { hook.AssignHandle(form.Handle); } catch { /* ignore */ }
            };
            form.HandleDestroyed += (_, _) =>
            {
                try { hook.ReleaseHandle(); } catch { /* ignore */ }
            };
            Hooks.Add(form, hook);
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_NCHITTEST)
            {
                base.WndProc(ref m);
                var lp = m.LParam.ToInt64();
                var screen = new Point(unchecked((short)lp), unchecked((short)(lp >> 16)));
                var pt = _form.PointToClient(screen);
                var w = _form.ClientSize.Width;
                var h = _form.ClientSize.Height;
                var left = pt.X <= Grip;
                var right = pt.X >= w - Grip;
                var top = pt.Y <= Grip;
                var bottom = pt.Y >= h - Grip;
                if (top && left) { m.Result = (IntPtr)HTTOPLEFT; return; }
                if (top && right) { m.Result = (IntPtr)HTTOPRIGHT; return; }
                if (bottom && left) { m.Result = (IntPtr)HTBOTTOMLEFT; return; }
                if (bottom && right) { m.Result = (IntPtr)HTBOTTOMRIGHT; return; }
                if (left) { m.Result = (IntPtr)HTLEFT; return; }
                if (right) { m.Result = (IntPtr)HTRIGHT; return; }
                if (top) { m.Result = (IntPtr)HTTOP; return; }
                if (bottom) { m.Result = (IntPtr)HTBOTTOM; return; }
                return;
            }

            base.WndProc(ref m);
        }
    }
}

/// <summary>米色顶栏，标题居中，可拖动窗口。</summary>
internal sealed class BeachBar : Panel
{
    private string _title = "";

    public BeachBar()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.UserPaint, true);
        DoubleBuffered = true;
        Height = EchoChrome.BarHeight;
        Cursor = Cursors.SizeAll;
    }

    public string TitleText
    {
        get => _title;
        set
        {
            _title = value ?? "";
            Invalidate();
        }
    }

    protected override void OnPaintBackground(PaintEventArgs e)
    {
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        FarmSkin.PaintTitleBar(e.Graphics, ClientSize);
        var rc = new Rectangle(8, 2, Math.Max(8, Width - 80), Height - 4);
        TextRenderer.DrawText(
            e.Graphics,
            TitleText,
            Font,
            rc,
            UiTheme.Ink,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
    }
}

/// <summary>按控件当前宽高绘制底栏。</summary>
internal sealed class FooterBar : Panel
{
    public FooterBar()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.UserPaint, true);
        DoubleBuffered = true;
        Height = OceanChrome.FootH;
    }

    protected override void OnPaintBackground(PaintEventArgs e)
    {
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        FarmSkin.PaintFooter(e.Graphics, ClientSize);
    }
}
