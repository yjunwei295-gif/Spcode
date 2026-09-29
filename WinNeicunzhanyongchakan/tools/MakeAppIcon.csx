// 一次性：icons.png 去黑底 → 透明 PNG + 多尺寸 ICO
#r "System.Drawing.dll"

using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

var root = Path.GetFullPath(Path.Combine(Environment.CurrentDirectory));
if (!File.Exists(Path.Combine(root, "MemWatch", "icons.png")))
    root = @"c:\Users\Administrator\Desktop\WinNeicunzhanyongchakan";

var srcPath = Path.Combine(root, "MemWatch", "icons.png");
var outPng = Path.Combine(root, "MemWatch", "appicon.png");
var outIco = Path.Combine(root, "MemWatch", "app.ico");
var outIcoBoot = Path.Combine(root, "MemWatch.Bootstrap", "app.ico");

using var src = new Bitmap(srcPath);
Console.WriteLine($"src {src.Width}x{src.Height} {src.PixelFormat}");

using var transparent = MakeTransparent(src);
transparent.Save(outPng, ImageFormat.Png);
Console.WriteLine($"wrote {outPng}");

WriteIcon(transparent, outIco, new[] { 16, 24, 32, 48, 64, 128, 256 });
File.Copy(outIco, outIcoBoot, overwrite: true);
Console.WriteLine($"wrote {outIco}");
Console.WriteLine($"wrote {outIcoBoot}");

static Bitmap MakeTransparent(Bitmap src)
{
    var bmp = new Bitmap(src.Width, src.Height, PixelFormat.Format32bppArgb);
    for (var y = 0; y < src.Height; y++)
    {
        for (var x = 0; x < src.Width; x++)
        {
            var c = src.GetPixel(x, y);
            // 近黑背景变透明；保留有颜色的像素（含暗蓝细节）
            if (c.R <= 18 && c.G <= 18 && c.B <= 18)
                bmp.SetPixel(x, y, Color.FromArgb(0, 0, 0, 0));
            else
                bmp.SetPixel(x, y, Color.FromArgb(255, c.R, c.G, c.B));
        }
    }
    return bmp;
}

static Bitmap ResizeHighQuality(Bitmap src, int size)
{
    var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
    using var g = Graphics.FromImage(bmp);
    g.Clear(Color.Transparent);
    g.CompositingMode = CompositingMode.SourceCopy;
    g.CompositingQuality = CompositingQuality.HighQuality;
    // 像素风：小尺寸用 NearestNeighbor 更清晰
    g.InterpolationMode = size <= 48 ? InterpolationMode.NearestNeighbor : InterpolationMode.HighQualityBicubic;
    g.PixelOffsetMode = PixelOffsetMode.Half;
    g.SmoothingMode = SmoothingMode.None;
    g.DrawImage(src, new Rectangle(0, 0, size, size));
    return bmp;
}

static void WriteIcon(Bitmap src, string path, int[] sizes)
{
    using var fs = new FileStream(path, FileMode.Create, FileAccess.Write);
    using var bw = new BinaryWriter(fs);

    var images = new List<(int size, byte[] png)>();
    foreach (var size in sizes)
    {
        using var resized = ResizeHighQuality(src, size);
        using var ms = new MemoryStream();
        resized.Save(ms, ImageFormat.Png);
        images.Add((size, ms.ToArray()));
    }

    // ICO header
    bw.Write((ushort)0); // reserved
    bw.Write((ushort)1); // type = icon
    bw.Write((ushort)images.Count);

    var offset = 6 + 16 * images.Count;
    foreach (var (size, png) in images)
    {
        bw.Write((byte)(size >= 256 ? 0 : size)); // width
        bw.Write((byte)(size >= 256 ? 0 : size)); // height
        bw.Write((byte)0); // colors
        bw.Write((byte)0); // reserved
        bw.Write((ushort)1); // planes
        bw.Write((ushort)32); // bit count
        bw.Write(png.Length);
        bw.Write(offset);
        offset += png.Length;
    }

    foreach (var (_, png) in images)
        bw.Write(png);
}
