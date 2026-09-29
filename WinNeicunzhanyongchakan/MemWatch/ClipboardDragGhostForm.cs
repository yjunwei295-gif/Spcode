using System.Runtime.InteropServices;

namespace MemWatch;

/// <summary>拖动时的半透明虚影（预渲染 + 节流移动，避免卡顿）。</summary>
internal sealed class ClipboardDragGhostForm : Form
{
    private const int MoveThreshold = 5;
    private static readonly IntPtr HwndTopMost = new(-1);

    private Point _lastLoc = new(int.MinValue, int.MinValue);

    public ClipboardDragGhostForm(Bitmap composed)
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        Opacity = 0.86;
        Size = composed.Size;

        var pb = new PictureBox
        {
            Dock = DockStyle.Fill,
            Image = composed,
            SizeMode = PictureBoxSizeMode.StretchImage,
            BackColor = Color.Transparent
        };
        Controls.Add(pb);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && Controls.Count > 0 && Controls[0] is PictureBox pb)
            pb.Image?.Dispose();
        base.Dispose(disposing);
    }

    protected override CreateParams CreateParams
    {
        get
        {
            const int wsExToolWindow = 0x00000080;
            const int wsExNoActivate = 0x08000000;
            var cp = base.CreateParams;
            cp.ExStyle |= wsExToolWindow | wsExNoActivate;
            return cp;
        }
    }

    public void Follow(Point screenPos)
    {
        var loc = new Point(screenPos.X + 14, screenPos.Y + 14);
        if (Math.Abs(loc.X - _lastLoc.X) < MoveThreshold &&
            Math.Abs(loc.Y - _lastLoc.Y) < MoveThreshold)
            return;

        _lastLoc = loc;
        if (!Visible)
        {
            Location = loc;
            Show();
            return;
        }

        SetWindowPos(Handle, HwndTopMost, loc.X, loc.Y, 0, 0,
            SwpNoSize | SwpNoActivate | SwpNoZOrder);
    }

    private const uint SwpNoSize = 0x0001;
    private const uint SwpNoZOrder = 0x0004;
    private const uint SwpNoActivate = 0x0010;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter,
        int x, int y, int cx, int cy, uint uFlags);
}
