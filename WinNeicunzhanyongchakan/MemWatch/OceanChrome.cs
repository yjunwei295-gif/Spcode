using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;

namespace MemWatch;

/// <summary>主窗大海框：沙滩顶、绳木边、舵轮底栏。其它窗仍用 EchoChrome。</summary>
internal static class OceanChrome
{
    public const string BeachTag = "ocean-beach";
    public const string FootTag = "ocean-foot";
    public const int BeachH = 36;
    public const int FootH = 56;
    public const int Left = 18;
    public const int Right = 12;

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, int wParam, int lParam);

    public static void Attach(Form form, Action onMinimize, Button skinBtn)
    {
        foreach (Control c in form.Controls)
        {
            if (c.Tag as string == BeachTag)
                return;
        }

        form.FormBorderStyle = FormBorderStyle.None;
        // 只上下留白：顶栏才能铺满窗宽；左右用内容 Margin 让开木边
        form.Padding = new Padding(0, BeachH, 0, FootH);
        form.Paint -= Form_Paint;
        form.Paint += Form_Paint;

        var beach = new BeachBar
        {
            Tag = BeachTag,
            Dock = DockStyle.None,
            Height = BeachH,
            TitleText = form.Text,
            Font = new Font("Microsoft YaHei UI", 11f, FontStyle.Bold)
        };

        var close = EchoChrome.MakeBeachChromeBtn("×");
        close.Click += (_, _) => form.Close();
        var min = EchoChrome.MakeBeachChromeBtn("–");
        min.Click += (_, _) => onMinimize();

        void Drag()
        {
            ReleaseCapture();
            SendMessage(form.Handle, 0xA1, 2, 0);
        }
        beach.MouseDown += (_, e) => { if (e.Button == MouseButtons.Left) Drag(); };

        beach.Controls.Add(min);
        beach.Controls.Add(close);
        EchoChrome.PlaceBeachChromeBtns(beach, min, close);
        beach.Resize += (_, _) => EchoChrome.PlaceBeachChromeBtns(beach, min, close);

        var foot = new FooterBar
        {
            Tag = FootTag,
            Dock = DockStyle.None,
            Height = FootH,
            Padding = new Padding(10, 12, 10, 10)
        };

        skinBtn.Text = L.T("皮肤", "Skin");
        skinBtn.Size = new Size(72, 30);
        skinBtn.Anchor = AnchorStyles.Left | AnchorStyles.Top;
        skinBtn.Location = new Point(10, 13);
        foot.Controls.Add(skinBtn);

        var footClose = new Button
        {
            Text = L.T("关闭", "Close"),
            Size = new Size(72, 30),
            Anchor = AnchorStyles.Right | AnchorStyles.Top
        };
        footClose.Click += (_, _) => form.Close();
        foot.Controls.Add(footClose);
        foot.Resize += (_, _) =>
        {
            footClose.Location = new Point(foot.ClientSize.Width - footClose.Width - 10, 13);
            UiTheme.FlattenButton(footClose);
            UiTheme.FlattenButton(skinBtn);
        };

        form.Controls.Add(foot);
        form.Controls.Add(beach);
        foreach (Control c in form.Controls)
        {
            if (c.Dock == DockStyle.Fill)
                c.Margin = new Padding(Left, 0, Right, 0);
        }
        LayoutChrome(form, beach, foot);
        form.Resize += (_, _) =>
        {
            LayoutChrome(form, beach, foot);
            form.Invalidate();
        };
        form.TextChanged += (_, _) =>
        {
            beach.TitleText = form.Text;
        };
        EchoChrome.EnableResize(form);
        form.PerformLayout();
        UiTheme.FlattenButton(skinBtn);
        UiTheme.FlattenButton(footClose);
        footClose.Location = new Point(Math.Max(90, foot.ClientSize.Width - 82), 13);
    }

    public static void SetVisible(Form form, bool visible)
    {
        foreach (Control c in form.Controls)
        {
            if (c.Tag as string is BeachTag or FootTag)
                c.Visible = visible;
        }
        form.Padding = visible ? new Padding(0, BeachH, 0, FootH) : Padding.Empty;
        if (visible)
        {
            form.PerformLayout();
            form.Invalidate();
        }
    }

    private static void LayoutChrome(Form form, Control beach, Control foot)
    {
        var w = form.ClientSize.Width;
        var h = form.ClientSize.Height;
        beach.SetBounds(0, 0, w, BeachH);
        foot.SetBounds(0, Math.Max(BeachH, h - FootH), w, FootH);
        beach.BringToFront();
        foot.BringToFront();
    }

    private static void Form_Paint(object? sender, PaintEventArgs e)
    {
        if (sender is not Form form)
            return;
        var r = form.ClientRectangle;
        FarmSkin.PaintFrame(e.Graphics, new Rectangle(0, BeachH, Left, Math.Max(0, r.Height - BeachH - FootH)));
        FarmSkin.PaintFrame(e.Graphics, new Rectangle(r.Width - Right, BeachH, Right, Math.Max(0, r.Height - BeachH - FootH)));

        using var rope = new Pen(Color.FromArgb(0x6A, 0x6A, 0x6A), 5)
        {
            StartCap = LineCap.Round,
            EndCap = LineCap.Round
        };
        var rx = 8;
        e.Graphics.DrawLine(rope, rx, BeachH, rx, r.Height - FootH);
        using var twist = new Pen(Color.FromArgb(0xC0, 0xC0, 0xC0), 2);
        for (var y = BeachH + 6; y < r.Height - FootH; y += 10)
            e.Graphics.DrawLine(twist, rx - 3, y, rx + 3, y + 5);

        using var edge = new Pen(Color.FromArgb(90, 30, 18, 8));
        e.Graphics.DrawRectangle(edge, 0, 0, r.Width - 1, r.Height - 1);
    }
}
