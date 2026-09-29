namespace MemWatch;

/// <summary>截图功能入口：连按热键 + 框选/涂抹；Shift+F1~F12 切贴图分组。</summary>
internal sealed class ScreenshotService : IDisposable
{
    public static ScreenshotService Instance { get; } = new();

    private readonly ScreenshotHotkeyWatcher _watcher = new();
    private SynchronizationContext? _ui;
    private LevelConfig? _levels;
    private int _busy;
    private bool _started;

    private ScreenshotService()
    {
        _watcher.Triggered += OnTriggered;
        _watcher.PinGroupHotkey += OnPinGroupHotkey;
    }

    public void Start(LevelConfig levels, SynchronizationContext? uiContext)
    {
        _levels = levels;
        _ui = uiContext ?? SynchronizationContext.Current;
        PinBoardService.Instance.LoadFromConfig(levels);
        ClipboardHistoryService.Instance.Start(levels);
        ApplySettings(levels);
        if (_started) return;
        _watcher.Start();
        _started = true;
    }

    public void ApplySettings(LevelConfig levels)
    {
        _levels = levels;
        _watcher.ApplySettings(levels.ScreenshotKey, levels.ScreenshotPressCount, levels.ScreenshotPressGapMs);
        ClipboardHistoryService.Instance.MaxNonFavorite = levels.ClipboardHistoryMax;
    }

    public void SetPaused(bool paused) => _watcher.SetPaused(paused);

    public void Dispose()
    {
        _watcher.Triggered -= OnTriggered;
        _watcher.PinGroupHotkey -= OnPinGroupHotkey;
        _watcher.Dispose();
        if (_levels is not null)
            PinBoardService.Instance.SaveToConfig(_levels);
        PinBoardService.Instance.Shutdown();
        ClipboardHistoryService.Instance.Dispose();
    }

    private void OnPinGroupHotkey(int index)
    {
        void Run()
        {
            PinBoardService.Instance.SetActiveGroup(index);
            if (_levels is not null)
            {
                _levels.ActivePinGroup = index;
                _levels.Save();
            }
        }

        if (_ui is not null)
            _ui.Post(_ => Run(), null);
        else
            Run();
    }

    private void OnTriggered()
    {
        if (Interlocked.Exchange(ref _busy, 1) != 0)
            return;

        void Run()
        {
            try
            {
                _watcher.SetPaused(true);
                ScreenshotOverlayForm.RunCapture();
            }
            catch (Exception ex)
            {
                try
                {
                    MessageBox.Show(
                        L.T($"截图失败：{ex.Message}", $"Screenshot failed: {ex.Message}"),
                        L.T("截图", "Screenshot"),
                        MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
                catch { /* ignore */ }
            }
            finally
            {
                _watcher.SetPaused(false);
                Interlocked.Exchange(ref _busy, 0);
            }
        }

        if (_ui is not null)
            _ui.Post(_ => Run(), null);
        else
            Run();
    }
}
