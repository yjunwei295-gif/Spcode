using System.Drawing.Drawing2D;
using System.Drawing.Imaging;

namespace MemWatch;

/// <summary>
/// 黑白贴图：按控件实测尺寸画灰板按钮，避免整窗大图硬拉。
/// </summary>
internal static class FarmSkin
{
    private static readonly Dictionary<string, Bitmap> Cache = new();
    private static readonly Dictionary<string, Image> Files = new(StringComparer.OrdinalIgnoreCase);
    private static bool _filesLoaded;

    public static Image WoodBar(Size size) => Get($"titlebar:{size.Width}x{size.Height}", size, g =>
    {
        PaintTitleBar(g, size);
    });

    /// <summary>米色顶栏，不画海、不画鱼。</summary>
    public static void PaintTitleBar(Graphics g, Size size)
    {
        if (size.Width < 2 || size.Height < 2)
            return;
        using var bg = new SolidBrush(UiTheme.Back);
        g.FillRectangle(bg, 0, 0, size.Width, size.Height);
        using var line = new Pen(UiTheme.Line);
        g.DrawLine(line, 0, size.Height - 1, size.Width, size.Height - 1);
    }

    /// <summary>兼容旧调用，等同米色顶栏。</summary>
    public static void PaintBeach(Graphics g, Size size) => PaintTitleBar(g, size);

    /// <summary>按当前宽高画底栏灰板，不拉伸位图。</summary>
    public static void PaintFooter(Graphics g, Size size)
    {
        if (size.Width < 2 || size.Height < 2)
            return;
        FillWood(g, new Rectangle(0, 0, size.Width, size.Height), Color.FromArgb(0x3A, 0x3A, 0x3A), true);
    }

    /// <summary>窗框灰边按矩形实画。</summary>
    public static void PaintFrame(Graphics g, Rectangle r)
    {
        FillWood(g, r, Color.FromArgb(0x3A, 0x3A, 0x3A), true);
    }

    public static Image WoodButton(Size size, bool danger) => WoodButton(size, danger ? ButtonKind.Danger : ButtonKind.Normal);

    public static Image WoodButton(Size size, ButtonKind kind)
    {
        var fill = kind switch
        {
            ButtonKind.Danger => Color.FromArgb(0x3A, 0x3A, 0x3A),
            ButtonKind.Accent => Color.FromArgb(0x52, 0x52, 0x52),
            _ => Color.FromArgb(0xE8, 0xE8, 0xE8)
        };
        return Get($"plank:{(int)kind}:{size.Width}x{size.Height}", size, g =>
        {
            var r = new Rectangle(0, 0, size.Width - 1, size.Height - 1);
            FillWood(g, r, fill, false);
            using var top = new Pen(Color.FromArgb(70, 255, 255, 255));
            using var bot = new Pen(Color.FromArgb(70, 40, 24, 8));
            g.DrawLine(top, 2, 1, r.Width - 2, 1);
            g.DrawLine(bot, 2, r.Height - 1, r.Width - 2, r.Height - 1);
            using var edge = new Pen(Color.FromArgb(0x6A, 0x6A, 0x6A));
            g.DrawRectangle(edge, r);
        });
    }

    public static Image? Pic(string file)
    {
        EnsureFiles();
        return Files.GetValueOrDefault(file);
    }

    public static Image ParchmentTile()
    {
        EnsureFiles();
        if (Files.TryGetValue("paper.png", out var paper))
            return paper;
        return Get("paper:64x64", new Size(64, 64), g =>
        {
            using var bg = new SolidBrush(UiTheme.Back);
            g.FillRectangle(bg, 0, 0, 64, 64);
        });
    }

    public static Image WoodTile()
    {
        return Get("tile:32x32", new Size(32, 32), g =>
        {
            FillWood(g, new Rectangle(0, 0, 32, 32), Color.FromArgb(0x3A, 0x3A, 0x3A), true);
        });
    }

    public static void PaintMeter(Graphics g, Rectangle r, int value, int maximum, bool showThumb)
    {
        if (r.Width < 2 || r.Height < 2)
            return;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        using (var bg = new SolidBrush(UiTheme.Back))
            g.FillRectangle(bg, r);

        var max = Math.Max(1, maximum);
        var pct = Math.Clamp(value / (float)max, 0f, 1f);
        var y = r.Y + r.Height / 2;
        var x0 = r.X + 8;
        var x1 = r.Right - (showThumb ? 28 : 8);

        using (var rope = new Pen(Color.FromArgb(0x6A, 0x6A, 0x6A), Math.Max(6, r.Height / 3))
        {
            StartCap = LineCap.Round,
            EndCap = LineCap.Round
        })
            g.DrawLine(rope, x0, y, x1, y);
        using (var highlight = new Pen(Color.FromArgb(0xC8, 0xC8, 0xC8), 2))
        {
            g.DrawLine(highlight, x0, y - 2, x1, y - 2);
            var step = 10;
            using var twist = new Pen(Color.FromArgb(90, 0, 0, 0), 1.5f);
            for (var x = x0; x < x1; x += step)
                g.DrawLine(twist, x, y - 3, x + 6, y + 3);
        }

        if (!showThumb)
        {
            var fillW = (int)Math.Round((x1 - x0) * pct);
            if (fillW > 0)
            {
                using var water = new Pen(Color.FromArgb(220, 0x22, 0x22, 0x22), Math.Max(4, r.Height / 4))
                {
                    StartCap = LineCap.Round,
                    EndCap = LineCap.Round
                };
                g.DrawLine(water, x0, y, x0 + fillW, y);
            }
        }

        if (showThumb)
        {
            var tx = x0 + (int)Math.Round((x1 - x0) * pct) - 7;
            var dest = new Rectangle(tx, y - 9, 14, 18);
            using var stone = new SolidBrush(Color.FromArgb(0x4A, 0x4A, 0x52));
            g.FillRectangle(stone, dest);
            using var edge = new Pen(Color.FromArgb(0x2A, 0x2A, 0x30));
            g.DrawRectangle(edge, dest);
        }
    }

    private static Image Sized(string file, string cacheKey, Size size, int margin, Action<Graphics> fallback)
    {
        if (size.Width < 2 || size.Height < 2)
            size = new Size(Math.Max(2, size.Width), Math.Max(2, size.Height));
        if (Cache.TryGetValue(cacheKey, out var hit))
            return hit;
        EnsureFiles();
        var bmp = new Bitmap(size.Width, size.Height, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.CompositingMode = CompositingMode.SourceCopy;
            g.Clear(Color.Transparent);
            g.CompositingMode = CompositingMode.SourceOver;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            if (Files.TryGetValue(file, out var src))
                NineSlice(g, src, new Rectangle(0, 0, size.Width, size.Height), margin);
            else
                fallback(g);
        }
        Cache[cacheKey] = bmp;
        return bmp;
    }

    private static void NineSlice(Graphics g, Image src, Rectangle dest, int m)
    {
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        var sw = src.Width;
        var sh = src.Height;
        m = Math.Max(4, Math.Min(m, Math.Min(sw, sh) / 3));
        m = Math.Min(m, Math.Min(dest.Width, dest.Height) / 3);
        if (m < 2)
        {
            g.DrawImage(src, dest);
            return;
        }

        void Part(int sx, int sy, int swid, int shei, int dx, int dy, int dw, int dh)
        {
            if (dw < 1 || dh < 1 || swid < 1 || shei < 1)
                return;
            g.DrawImage(src, new Rectangle(dx, dy, dw, dh), new Rectangle(sx, sy, swid, shei), GraphicsUnit.Pixel);
        }

        var dw = dest.Width;
        var dh = dest.Height;
        var dx = dest.X;
        var dy = dest.Y;
        var cw = sw - m * 2;
        var ch = sh - m * 2;
        var dcw = dw - m * 2;
        var dch = dh - m * 2;

        Part(0, 0, m, m, dx, dy, m, m);
        Part(sw - m, 0, m, m, dx + dw - m, dy, m, m);
        Part(0, sh - m, m, m, dx, dy + dh - m, m, m);
        Part(sw - m, sh - m, m, m, dx + dw - m, dy + dh - m, m, m);
        Part(m, 0, cw, m, dx + m, dy, dcw, m);
        Part(m, sh - m, cw, m, dx + m, dy + dh - m, dcw, m);
        Part(0, m, m, ch, dx, dy + m, m, dch);
        Part(sw - m, m, m, ch, dx + dw - m, dy + m, m, dch);
        Part(m, m, cw, ch, dx + m, dy + m, dcw, dch);
    }

    private static void DrawStretched(Graphics g, Image img, Rectangle dest)
    {
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.DrawImage(img, dest);
    }

    private static void EnsureFiles()
    {
        if (_filesLoaded)
            return;
        _filesLoaded = true;
        var dir = Path.Combine(AppContext.BaseDirectory, "Assets", "Ocean");
        if (!Directory.Exists(dir))
            return;
        foreach (var path in Directory.GetFiles(dir, "*.png"))
        {
            try
            {
                using var fs = File.OpenRead(path);
                using var tmp = Image.FromStream(fs);
                Files[Path.GetFileName(path)] = new Bitmap(tmp);
            }
            catch
            {
                // 缺图时走矢量回退
            }
        }
    }

    private static Image Get(string key, Size size, Action<Graphics> paint)
    {
        if (size.Width < 2 || size.Height < 2)
            size = new Size(Math.Max(2, size.Width), Math.Max(2, size.Height));
        if (Cache.TryGetValue(key, out var hit))
            return hit;
        var bmp = new Bitmap(size.Width, size.Height, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(bmp))
        {
            g.CompositingMode = CompositingMode.SourceCopy;
            g.Clear(Color.Transparent);
            g.CompositingMode = CompositingMode.SourceOver;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            paint(g);
        }
        Cache[key] = bmp;
        return bmp;
    }

    private static void FillWood(Graphics g, Rectangle r, Color baseColor, bool dark)
    {
        using var bg = new SolidBrush(baseColor);
        g.FillRectangle(bg, r);
        var step = dark ? 3 : 4;
        using var grain = new Pen(Color.FromArgb(28, 0, 0, 0));
        for (var y = r.Y + 2; y < r.Bottom; y += step)
            g.DrawLine(grain, r.X, y, r.Right, y);
        using var grain2 = new Pen(Color.FromArgb(18, 255, 255, 255));
        for (var y = r.Y + 3; y < r.Bottom; y += step * 2)
            g.DrawLine(grain2, r.X, y, r.Right, y);
    }
}

internal enum ButtonKind
{
    Normal,
    Danger,
    Accent
}
