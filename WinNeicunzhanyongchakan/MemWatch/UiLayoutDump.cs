using System.Text;

namespace MemWatch;

/// <summary>把窗口树的宽高、字体、颜色打成文本，供按实际尺寸绘制贴图。</summary>
internal static class UiLayoutDump
{
    public static string Capture(Form root)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"窗 {root.Text}  Client={root.ClientSize.Width}x{root.ClientSize.Height}  Outer={root.Width}x{root.Height}  Font={FmtFont(root.Font)}  Back={FmtColor(root.BackColor)}  Fore={FmtColor(root.ForeColor)}");
        Walk(root, sb, 0);
        return sb.ToString();
    }

    private static void Walk(Control c, StringBuilder sb, int depth)
    {
        var pad = new string(' ', depth * 2);
        var name = string.IsNullOrEmpty(c.Name) ? c.GetType().Name : c.Name;
        var text = (c.Text ?? "").Replace('\n', ' ');
        if (text.Length > 24)
            text = text[..24] + "…";
        sb.AppendLine($"{pad}{c.GetType().Name} {name}  {c.Width}x{c.Height} @({c.Left},{c.Top})  font={FmtFont(c.Font)}  back={FmtColor(c.BackColor)}  fore={FmtColor(c.ForeColor)}  text={text}");
        foreach (Control child in c.Controls)
            Walk(child, sb, depth + 1);
    }

    private static string FmtFont(Font? f)
    {
        if (f is null) return "-";
        return $"{f.Name} {f.SizeInPoints:0.#} {(f.Bold ? "B" : "")}".Trim();
    }

    private static string FmtColor(Color c) => $"#{c.R:X2}{c.G:X2}{c.B:X2}";
}
