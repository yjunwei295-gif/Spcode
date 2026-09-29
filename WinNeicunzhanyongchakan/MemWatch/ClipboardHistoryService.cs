using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace MemWatch;

internal enum ClipboardEntryKind { Text, Image }

internal sealed class ClipboardHistoryEntry
{
    public string Id { get; set; } = "";
    public ClipboardEntryKind Kind { get; set; }
    public string Preview { get; set; } = "";
    public bool Favorite { get; set; }
    public DateTime CreatedUtc { get; set; }
    public string? Text { get; set; }
    public string? ImageFile { get; set; }
}

/// <summary>
/// 剪切板历史：默认最多保留 50 条非收藏；收藏项永不被自动清理。
/// </summary>
internal sealed class ClipboardHistoryService : NativeWindow, IDisposable
{
    public static ClipboardHistoryService Instance { get; } = new();

    private const int WmClipboardUpdate = 0x031D;
    private readonly object _gate = new();
    private readonly List<ClipboardHistoryEntry> _items = new();
    private int _maxNonFavorite = 50;
    private bool _started;
    private bool _disposed;
    private bool _ignoreNext; // 自己写入剪贴板时跳过一轮
    private string _lastSig = "";

    public event Action? Changed;

    public int MaxNonFavorite
    {
        get { lock (_gate) return _maxNonFavorite; }
        set
        {
            lock (_gate)
            {
                _maxNonFavorite = LevelConfig.ClampClipboardHistoryMax(value);
                TrimNonFavorites_NoLock();
            }
            SaveIndex();
            RaiseChanged();
        }
    }

    private static string RootDir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "MemWatch", "ClipboardHistory");

    private static string IndexPath => Path.Combine(RootDir, "index.json");
    private static string ImagesDir => Path.Combine(RootDir, "images");

    public void Start(LevelConfig cfg)
    {
        if (_disposed) return;
        _maxNonFavorite = LevelConfig.ClampClipboardHistoryMax(cfg.ClipboardHistoryMax);
        Directory.CreateDirectory(ImagesDir);
        LoadIndex();
        if (_started) return;

        // 隐藏消息窗接收剪贴板通知
        CreateHandle(new CreateParams
        {
            Caption = "MemWatch.ClipboardListener",
            Parent = new IntPtr(-3) // HWND_MESSAGE
        });
        AddClipboardFormatListener(Handle);
        _started = true;
        // 启动时采一次当前剪贴板
        CaptureCurrent();
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        if (_started && Handle != IntPtr.Zero)
        {
            try { RemoveClipboardFormatListener(Handle); } catch { /* ignore */ }
            DestroyHandle();
        }
        SaveIndex();
    }

    public void IgnoreNextExternalChange()
    {
        _ignoreNext = true;
    }

    public List<ClipboardHistoryEntry> GetSnapshot()
    {
        lock (_gate)
            return _items.Select(CloneMeta).ToList();
    }

    public void SetFavorite(string id, bool favorite)
    {
        lock (_gate)
        {
            var item = _items.FirstOrDefault(x => x.Id == id);
            if (item is null) return;
            item.Favorite = favorite;
            if (!favorite)
                TrimNonFavorites_NoLock();
        }
        SaveIndex();
        RaiseChanged();
    }

    public void Remove(string id)
    {
        ClipboardHistoryEntry? removed = null;
        lock (_gate)
        {
            var item = _items.FirstOrDefault(x => x.Id == id);
            if (item is null) return;
            _items.Remove(item);
            removed = item;
        }

        if (removed?.ImageFile is not null)
        {
            try
            {
                var path = Path.Combine(ImagesDir, removed.ImageFile);
                if (File.Exists(path)) File.Delete(path);
            }
            catch { /* ignore */ }
        }

        SaveIndex();
        RaiseChanged();
    }

    public void ClearNonFavorites()
    {
        List<ClipboardHistoryEntry> drop;
        lock (_gate)
        {
            drop = _items.Where(x => !x.Favorite).ToList();
            _items.RemoveAll(x => !x.Favorite);
        }

        foreach (var item in drop)
        {
            if (item.ImageFile is null) continue;
            try
            {
                var path = Path.Combine(ImagesDir, item.ImageFile);
                if (File.Exists(path)) File.Delete(path);
            }
            catch { /* ignore */ }
        }

        SaveIndex();
        RaiseChanged();
    }

    public bool TryCopyToClipboard(string id)
    {
        ClipboardHistoryEntry? item;
        lock (_gate)
            item = _items.FirstOrDefault(x => x.Id == id);
        if (item is null) return false;

        try
        {
            IgnoreNextExternalChange();
            if (item.Kind == ClipboardEntryKind.Text && item.Text is not null)
            {
                Clipboard.SetText(item.Text);
                return true;
            }

            if (item.Kind == ClipboardEntryKind.Image && item.ImageFile is not null)
            {
                var path = Path.Combine(ImagesDir, item.ImageFile);
                if (!File.Exists(path)) return false;
                using var bmp = new Bitmap(path);
                ClipboardUtil.SetImage(bmp);
                return true;
            }
        }
        catch
        {
            return false;
        }

        return false;
    }

    public bool TryPin(string id)
    {
        ClipboardHistoryEntry? item;
        lock (_gate)
            item = _items.FirstOrDefault(x => x.Id == id);
        if (item is null || item.Kind != ClipboardEntryKind.Image || item.ImageFile is null)
            return false;
        var path = Path.Combine(ImagesDir, item.ImageFile);
        if (!File.Exists(path)) return false;
        using var bmp = new Bitmap(path);
        var wa = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(100, 100, 800, 600);
        PinBoardService.Instance.AddSticker(bmp, new Point(wa.Left + 80, wa.Top + 80));
        return true;
    }

    public Image? LoadThumbnail(string id, int maxEdge)
    {
        ClipboardHistoryEntry? item;
        lock (_gate)
            item = _items.FirstOrDefault(x => x.Id == id);
        if (item?.Kind != ClipboardEntryKind.Image || item.ImageFile is null) return null;
        var path = Path.Combine(ImagesDir, item.ImageFile);
        if (!File.Exists(path)) return null;
        try
        {
            using var src = new Bitmap(path);
            var scale = Math.Min(1f, maxEdge / (float)Math.Max(src.Width, src.Height));
            var w = Math.Max(1, (int)(src.Width * scale));
            var h = Math.Max(1, (int)(src.Height * scale));
            return new Bitmap(src, w, h);
        }
        catch
        {
            return null;
        }
    }

    public ClipboardHistoryEntry? TryGetEntry(string id)
    {
        lock (_gate)
        {
            var item = _items.FirstOrDefault(x => x.Id == id);
            return item is null ? null : CloneMeta(item);
        }
    }

    public string? GetImageFilePath(string id)
    {
        lock (_gate)
        {
            var item = _items.FirstOrDefault(x => x.Id == id);
            if (item?.Kind != ClipboardEntryKind.Image || item.ImageFile is null) return null;
            var path = Path.Combine(ImagesDir, item.ImageFile);
            return File.Exists(path) ? path : null;
        }
    }

    /// <summary>拖动用原图（调用方负责 Dispose）。</summary>
    public Bitmap? LoadFullImage(string id)
    {
        var path = GetImageFilePath(id);
        if (path is null) return null;
        try
        {
            return new Bitmap(path);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>构造拖动数据包，不写入系统剪贴板。</summary>
    public DataObject? CreateDragData(string id)
    {
        var item = TryGetEntry(id);
        if (item is null) return null;

        var data = new DataObject();
        if (item.Kind == ClipboardEntryKind.Text && item.Text is not null)
        {
            data.SetText(item.Text, TextDataFormat.UnicodeText);
            data.SetText(item.Text, TextDataFormat.Text);
            return data;
        }

        if (item.Kind == ClipboardEntryKind.Image)
        {
            var path = GetImageFilePath(id);
            if (path is null) return null;
            var bmp = LoadFullImage(id);
            if (bmp is null) return null;
            data.SetData(DataFormats.Bitmap, bmp);
            data.SetData(DataFormats.FileDrop, new[] { path });
            return data;
        }

        return null;
    }

    /// <summary>截图等主动写入时可直接入库（避免等通知）。</summary>
    public void TryAddImage(Bitmap bmp)
    {
        try
        {
            using var clone = (Bitmap)bmp.Clone();
            AddImageEntry(clone);
        }
        catch { /* ignore */ }
    }

    public void PinClipboardImage()
    {
        try
        {
            if (!Clipboard.ContainsImage())
            {
                MessageBox.Show(
                    L.T("剪贴板里没有图片。", "Clipboard has no image."),
                    L.T("图钉置顶", "Pin"),
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            using var img = Clipboard.GetImage();
            if (img is null) return;
            using var bmp = new Bitmap(img);
            var wa = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(100, 100, 800, 600);
            PinBoardService.Instance.AddSticker(bmp, new Point(wa.Left + 80, wa.Top + 80));
            TryAddImage(bmp);
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                L.T($"置顶失败：{ex.Message}", $"Pin failed: {ex.Message}"),
                L.T("图钉置顶", "Pin"),
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WmClipboardUpdate)
            CaptureCurrent();
        base.WndProc(ref m);
    }

    private void CaptureCurrent()
    {
        if (_ignoreNext)
        {
            _ignoreNext = false;
            return;
        }

        try
        {
            if (Clipboard.ContainsImage())
            {
                using var img = Clipboard.GetImage();
                if (img is null) return;
                using var bmp = new Bitmap(img);
                var sig = $"img:{bmp.Width}x{bmp.Height}:{CheapHash(bmp)}";
                if (sig == _lastSig) return;
                _lastSig = sig;
                AddImageEntry(bmp);
                return;
            }

            if (Clipboard.ContainsText())
            {
                var text = Clipboard.GetText();
                if (string.IsNullOrWhiteSpace(text)) return;
                var sig = "txt:" + text.GetHashCode();
                if (sig == _lastSig) return;
                _lastSig = sig;
                AddTextEntry(text);
            }
        }
        catch
        {
            // 剪贴板忙碌等
        }
    }

    private void AddTextEntry(string text)
    {
        var entry = new ClipboardHistoryEntry
        {
            Id = Guid.NewGuid().ToString("N"),
            Kind = ClipboardEntryKind.Text,
            Text = text,
            Preview = text.Length <= 80 ? text : text[..80] + "…",
            CreatedUtc = DateTime.UtcNow
        };
        lock (_gate)
        {
            _items.Insert(0, entry);
            TrimNonFavorites_NoLock();
        }
        SaveIndex();
        RaiseChanged();
    }

    private void AddImageEntry(Bitmap bmp)
    {
        var id = Guid.NewGuid().ToString("N");
        var file = id + ".png";
        var path = Path.Combine(ImagesDir, file);
        ClipboardUtil.SavePng(bmp, path);
        var entry = new ClipboardHistoryEntry
        {
            Id = id,
            Kind = ClipboardEntryKind.Image,
            ImageFile = file,
            Preview = L.T($"图片 {bmp.Width}×{bmp.Height}", $"Image {bmp.Width}×{bmp.Height}"),
            CreatedUtc = DateTime.UtcNow
        };
        lock (_gate)
        {
            _items.Insert(0, entry);
            TrimNonFavorites_NoLock();
        }
        SaveIndex();
        RaiseChanged();
    }

    private void TrimNonFavorites_NoLock()
    {
        var normals = _items.Where(x => !x.Favorite).OrderByDescending(x => x.CreatedUtc).ToList();
        if (normals.Count <= _maxNonFavorite) return;
        var drop = normals.Skip(_maxNonFavorite).ToList();
        foreach (var item in drop)
        {
            _items.Remove(item);
            if (item.ImageFile is null) continue;
            try
            {
                var path = Path.Combine(ImagesDir, item.ImageFile);
                if (File.Exists(path)) File.Delete(path);
            }
            catch { /* ignore */ }
        }
    }

    private void LoadIndex()
    {
        try
        {
            if (!File.Exists(IndexPath)) return;
            var json = File.ReadAllText(IndexPath);
            var list = JsonSerializer.Deserialize<List<ClipboardHistoryEntry>>(json);
            if (list is null) return;
            lock (_gate)
            {
                _items.Clear();
                foreach (var item in list)
                {
                    if (item.Kind == ClipboardEntryKind.Image)
                    {
                        if (string.IsNullOrEmpty(item.ImageFile)) continue;
                        if (!File.Exists(Path.Combine(ImagesDir, item.ImageFile))) continue;
                    }
                    _items.Add(item);
                }
                TrimNonFavorites_NoLock();
            }
        }
        catch { /* ignore */ }
    }

    private void SaveIndex()
    {
        try
        {
            Directory.CreateDirectory(RootDir);
            List<ClipboardHistoryEntry> snap;
            lock (_gate) snap = _items.Select(CloneMeta).ToList();
            var json = JsonSerializer.Serialize(snap, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(IndexPath, json);
        }
        catch { /* ignore */ }
    }

    private static ClipboardHistoryEntry CloneMeta(ClipboardHistoryEntry x) => new()
    {
        Id = x.Id,
        Kind = x.Kind,
        Preview = x.Preview,
        Favorite = x.Favorite,
        CreatedUtc = x.CreatedUtc,
        Text = x.Text,
        ImageFile = x.ImageFile
    };

    private static int CheapHash(Bitmap bmp)
    {
        // 采样几处像素，避免整图哈希太慢
        var w = bmp.Width;
        var h = bmp.Height;
        unchecked
        {
            var hash = 17;
            hash = hash * 31 + w;
            hash = hash * 31 + h;
            for (var i = 0; i < 8; i++)
            {
                var x = (w - 1) * i / 7;
                var y = (h - 1) * ((i * 3) % 8) / 7;
                var c = bmp.GetPixel(x, y);
                hash = hash * 31 + c.ToArgb();
            }
            return hash;
        }
    }

    private void RaiseChanged()
    {
        try { Changed?.Invoke(); } catch { /* ignore */ }
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool AddClipboardFormatListener(IntPtr hwnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RemoveClipboardFormatListener(IntPtr hwnd);
}
