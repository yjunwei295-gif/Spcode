namespace MemWatch;

/// <summary>黑白内存条：灰槽 + 黑填充。</summary>
internal sealed class ThemedMeter : ProgressBar
{
    public ThemedMeter()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        Style = ProgressBarStyle.Continuous;
        Maximum = 100;
        Height = 16;
    }

    public new int Value
    {
        get => base.Value;
        set
        {
            base.Value = Math.Clamp(value, Minimum, Maximum);
            Invalidate();
        }
    }

    protected override void OnPaintBackground(PaintEventArgs pevent)
    {
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        FarmSkin.PaintMeter(e.Graphics, ClientRectangle, Value, Maximum, showThumb: false);
    }
}

/// <summary>猎杀阈值：绳索滑轨 + 石块滑块。</summary>
internal sealed class RopeSlider : Control
{
    private int _min = 80;
    private int _max = 100;
    private int _value = 85;

    public RopeSlider()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.UserPaint, true);
        Height = 28;
        Cursor = Cursors.Hand;
        TabStop = true;
    }

    public int Minimum
    {
        get => _min;
        set { _min = value; Invalidate(); }
    }

    public int Maximum
    {
        get => _max;
        set { _max = Math.Max(_min + 1, value); Invalidate(); }
    }

    public int Value
    {
        get => _value;
        set
        {
            var next = Math.Clamp(value, _min, _max);
            if (next == _value)
                return;
            _value = next;
            Invalidate();
            ValueChanged?.Invoke(this, EventArgs.Empty);
        }
    }

    public event EventHandler? ValueChanged;

    protected override void OnPaint(PaintEventArgs e)
    {
        FarmSkin.PaintMeter(e.Graphics, ClientRectangle, _value - _min, _max - _min, showThumb: true);
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        if (e.Button == MouseButtons.Left)
        {
            Capture = true;
            ApplyMouse(e.X);
        }
        base.OnMouseDown(e);
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        if (Capture && e.Button == MouseButtons.Left)
            ApplyMouse(e.X);
        base.OnMouseMove(e);
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        if (e.Button == MouseButtons.Left)
            Capture = false;
        base.OnMouseUp(e);
    }

    private void ApplyMouse(int x)
    {
        var span = Math.Max(1, Width - 8);
        var t = Math.Clamp((x - 4) / (float)span, 0f, 1f);
        Value = _min + (int)Math.Round(t * (_max - _min));
    }
}
