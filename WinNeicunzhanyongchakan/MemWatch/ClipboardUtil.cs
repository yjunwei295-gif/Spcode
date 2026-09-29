using System.Drawing.Drawing2D;
using System.Drawing.Imaging;

namespace MemWatch;

internal static class ClipboardUtil
{
    /// <summary>
    /// 写入系统剪贴板（标准位图）。
    /// 不额外注册 PNG 格式：部分看图软件会优先读 PNG，格式异常时会报「不支持此文件格式」。
    /// 透明图会按系统规则扁平化（透明处通常为黑），历史记录里仍保存完整 PNG。
    /// </summary>
    public static void SetImage(Bitmap bmp)
    {
        using var clone = ToClipboardBitmap(bmp);
        Clipboard.SetImage(clone);
    }

    /// <summary>生成可安全 Save/SetImage 的 32 位副本。</summary>
    public static Bitmap ToClipboardBitmap(Bitmap src)
    {
        var bmp = new Bitmap(src.Width, src.Height, PixelFormat.Format32bppArgb);
        using var g = Graphics.FromImage(bmp);
        g.CompositingMode = CompositingMode.SourceCopy;
        g.DrawImageUnscaled(src, 0, 0);
        return bmp;
    }

    /// <summary>保存为确认为 PNG 头的文件。</summary>
    public static void SavePng(Bitmap src, string path)
    {
        using var bmp = ToClipboardBitmap(src);
        using var ms = new MemoryStream();
        bmp.Save(ms, ImageFormat.Png);
        var bytes = ms.ToArray();
        if (bytes.Length < 8 || bytes[0] != 0x89 || bytes[1] != 0x50 || bytes[2] != 0x4E || bytes[3] != 0x47)
            throw new InvalidOperationException("PNG encode failed");
        File.WriteAllBytes(path, bytes);
    }
}
