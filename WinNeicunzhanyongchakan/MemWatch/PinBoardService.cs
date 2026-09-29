namespace MemWatch;

/// <summary>贴图分组与置顶窗口管理（F1~F12 / Shift+F1~F12）。</summary>
internal sealed class PinBoardService
{
    public const int GroupCount = 12;
    public static PinBoardService Instance { get; } = new();

    private readonly object _gate = new();
    private readonly List<PinStickerForm> _stickers = new();
    private int _activeGroup;
    private PinStickerForm? _selected;
    private string[] _groupNames = CreateDefaultNames();

    public event Action? Changed;

    public int ActiveGroup
    {
        get { lock (_gate) return _activeGroup; }
    }

    public IReadOnlyList<string> GetGroupNames()
    {
        lock (_gate) return _groupNames.ToArray();
    }

    public void LoadFromConfig(LevelConfig cfg)
    {
        lock (_gate)
        {
            _activeGroup = Math.Clamp(cfg.ActivePinGroup, 0, GroupCount - 1);
            if (cfg.PinGroupNames is { Length: > 0 })
            {
                for (var i = 0; i < GroupCount; i++)
                {
                    if (i < cfg.PinGroupNames.Length && !string.IsNullOrWhiteSpace(cfg.PinGroupNames[i]))
                        _groupNames[i] = cfg.PinGroupNames[i].Trim();
                }
            }
        }
        ApplyVisibility();
        RaiseChanged();
    }

    public void SaveToConfig(LevelConfig cfg)
    {
        lock (_gate)
        {
            cfg.ActivePinGroup = _activeGroup;
            cfg.PinGroupNames = _groupNames.ToArray();
        }
    }

    public void SetGroupName(int index, string name)
    {
        if (index is < 0 or >= GroupCount) return;
        lock (_gate)
            _groupNames[index] = string.IsNullOrWhiteSpace(name)
                ? DefaultName(index)
                : name.Trim();
        RaiseChanged();
    }

    public void SetActiveGroup(int index)
    {
        index = Math.Clamp(index, 0, GroupCount - 1);
        lock (_gate)
        {
            if (_activeGroup == index) return;
            _activeGroup = index;
        }
        ApplyVisibility();
        RaiseChanged();
    }

    public void AddSticker(Bitmap image, Point screenLocation)
    {
        int group;
        lock (_gate) group = _activeGroup;

        var form = new PinStickerForm(image, group, screenLocation);
        form.Selected += OnStickerSelected;
        form.ClosedByUser += OnStickerClosed;
        form.FormClosed += (_, _) =>
        {
            lock (_gate)
            {
                _stickers.Remove(form);
                if (_selected == form) _selected = null;
            }
            RaiseChanged();
        };

        lock (_gate)
            _stickers.Add(form);

        form.Show();
        form.SetGroupVisible(true);
        Select(form);
        RaiseChanged();
    }

    public int CountInActiveGroup()
    {
        lock (_gate)
            return _stickers.Count(s => s.GroupIndex == _activeGroup && !s.IsDisposed);
    }

    public void ClearActiveGroup()
    {
        List<PinStickerForm> targets;
        lock (_gate)
            targets = _stickers.Where(s => s.GroupIndex == _activeGroup).ToList();
        foreach (var s in targets)
        {
            try { s.Close(); } catch { /* ignore */ }
        }
        RaiseChanged();
    }

    public void CloseAll()
    {
        List<PinStickerForm> all;
        lock (_gate) all = _stickers.ToList();
        foreach (var s in all)
        {
            try { s.Close(); } catch { /* ignore */ }
        }
        RaiseChanged();
    }

    public void Shutdown() => CloseAll();

    private void OnStickerSelected(PinStickerForm form) => Select(form);

    private void OnStickerClosed(PinStickerForm form)
    {
        lock (_gate)
        {
            if (_selected == form) _selected = null;
        }
    }

    private void Select(PinStickerForm form)
    {
        lock (_gate)
        {
            foreach (var s in _stickers)
            {
                if (s.IsDisposed) continue;
                s.SetSelected(s == form);
            }
            _selected = form;
        }
    }

    private void ApplyVisibility()
    {
        int g;
        List<PinStickerForm> list;
        lock (_gate)
        {
            g = _activeGroup;
            list = _stickers.ToList();
        }

        foreach (var s in list)
        {
            if (s.IsDisposed) continue;
            s.SetGroupVisible(s.GroupIndex == g);
        }
    }

    private void RaiseChanged()
    {
        try { Changed?.Invoke(); } catch { /* ignore */ }
    }

    private static string[] CreateDefaultNames()
    {
        var arr = new string[GroupCount];
        for (var i = 0; i < GroupCount; i++)
            arr[i] = DefaultName(i);
        return arr;
    }

    private static string DefaultName(int i) => $"F{i + 1}";
}
