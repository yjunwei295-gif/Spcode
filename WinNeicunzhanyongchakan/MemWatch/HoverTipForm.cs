namespace MemWatch;

/// <summary>
/// 不抢焦点的置顶提示层。系统 ToolTip 在主窗 TopMost 时会被挡住，故单独浮层显示。
/// </summary>
internal sealed class HoverTipForm : Form
{
    private readonly Label _label = new();

    public HoverTipForm()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        TopMost = true;
        BackColor = UiTheme.Surface;
        Padding = new Padding(1);
        Controls.Add(_label);

        _label.Dock = DockStyle.Fill;
        _label.AutoSize = false;
        _label.BackColor = UiTheme.Surface;
        _label.ForeColor = UiTheme.Ink;
        _label.Font = new Font("Segoe UI", 8.5f);
        _label.Padding = new Padding(8, 6, 8, 6);
    }

    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            const int wsExTopmost = 0x00000008;
            const int wsExNoActivate = 0x08000000;
            const int wsExToolWindow = 0x00000080;
            var cp = base.CreateParams;
            cp.ExStyle |= wsExTopmost | wsExNoActivate | wsExToolWindow;
            return cp;
        }
    }

    public void ShowTip(string text, Point screenPoint)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            HideTip();
            return;
        }

        _label.Text = text;
        var maxWidth = 320;
        var size = TextRenderer.MeasureText(
            text,
            _label.Font,
            new Size(maxWidth, int.MaxValue),
            TextFormatFlags.WordBreak | TextFormatFlags.TextBoxControl);

        var w = Math.Min(maxWidth, Math.Max(180, size.Width + 20));
        var h = Math.Min(420, Math.Max(40, size.Height + 16));
        ClientSize = new Size(w, h);

        var wa = Screen.FromPoint(screenPoint).WorkingArea;
        var x = screenPoint.X + 16;
        var y = screenPoint.Y + 18;
        if (x + Width > wa.Right)
            x = Math.Max(wa.Left, screenPoint.X - Width - 8);
        if (y + Height > wa.Bottom)
            y = Math.Max(wa.Top, screenPoint.Y - Height - 8);

        Location = new Point(x, y);

        if (!Visible)
            Show();
        else
            Invalidate();
    }

    public void HideTip()
    {
        if (Visible)
            Hide();
    }
}
