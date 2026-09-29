namespace MemWatch;

/// <summary>
/// 全局下载服务：窗口关闭后任务继续；仅主程序退出时 Shutdown。
/// </summary>
internal sealed class DownloadService
{
    public static DownloadService Instance { get; } = new();

    private readonly object _gate = new();
    private readonly List<DownloadJob> _jobs = new();
    private readonly HashSet<string> _runningIds = new(StringComparer.Ordinal);
    private int _changedFlag;
    private int _shuttingDown;

    public string SaveDirectory { get; set; } =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");

    public int ThreadCount { get; set; } = 8;

    /// <summary>任务列表或进度有变化（可能来自后台线程）。</summary>
    public event Action? Changed;

    public int ActiveCount
    {
        get
        {
            lock (_gate)
            {
                return _jobs.Count(j =>
                    j.State is DownloadJobState.Queued or DownloadJobState.Probing or DownloadJobState.Running);
            }
        }
    }

    public List<DownloadJob> GetJobsSnapshot()
    {
        lock (_gate)
            return _jobs.ToList();
    }

    public bool ContainsUrl(string url)
    {
        // 允许重复下载同一链接
        return false;
    }

    public bool TryAddJob(string url, string resolvedUrl, string fileName, bool fromAuto, bool autoStart, out DownloadJob? job, out string message)
    {
        job = null;
        message = "";

        if (_shuttingDown != 0)
        {
            message = L.T("程序正在退出，无法添加下载。", "App is exiting; cannot add downloads.");
            return false;
        }

        var dir = string.IsNullOrWhiteSpace(SaveDirectory)
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads")
            : SaveDirectory;

        if (string.IsNullOrWhiteSpace(fileName))
        {
            fileName = MultiThreadDownloader.GuessFileName(
                string.IsNullOrWhiteSpace(resolvedUrl) ? url : resolvedUrl, null);
        }

        var created = new DownloadJob
        {
            Url = url,
            ResolvedUrl = resolvedUrl ?? "",
            FileName = fileName,
            SavePath = MultiThreadDownloader.UniquePath(dir, fileName),
            ThreadCount = Math.Clamp(ThreadCount, 1, 16),
            FromAutoDetect = fromAuto,
            State = DownloadJobState.Queued,
            Message = string.IsNullOrWhiteSpace(resolvedUrl)
                ? L.T("排队中（将解析直链）", "Queued (will resolve)")
                : L.T("排队中（已解析直链）", "Queued (resolved)"),
            Cts = new CancellationTokenSource()
        };
        created.FileName = Path.GetFileName(created.SavePath);

        lock (_gate)
            _jobs.Insert(0, created);

        job = created;
        RaiseChanged();

        if (autoStart)
            StartJob(created);

        return true;
    }

    public void StartQueued()
    {
        List<DownloadJob> queued;
        lock (_gate)
            queued = _jobs.Where(j => j.State == DownloadJobState.Queued).ToList();

        foreach (var j in queued)
            StartJob(j);
    }

    public void StartJob(DownloadJob job)
    {
        if (_shuttingDown != 0)
            return;

        lock (_gate)
        {
            if (job.State is DownloadJobState.Running or DownloadJobState.Probing or DownloadJobState.Completed)
                return;
            if (!_runningIds.Add(job.Id))
                return;
        }

        if (job.Cts is null || job.Cts.IsCancellationRequested)
        {
            try { job.Cts?.Dispose(); } catch { /* ignore */ }
            job.Cts = new CancellationTokenSource();
        }

        if (job.State == DownloadJobState.Cancelled)
            job.State = DownloadJobState.Queued;

        var token = job.Cts.Token;
        _ = Task.Run(async () =>
        {
            try
            {
                var progress = new Progress<DownloadJob>(_ => RaiseChanged());
                await MultiThreadDownloader.RunAsync(job, progress, token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                if (job.State is DownloadJobState.Running or DownloadJobState.Probing or DownloadJobState.Queued)
                {
                    job.State = DownloadJobState.Cancelled;
                    job.Message = L.T("已中止", "Stopped");
                }
            }
            finally
            {
                lock (_gate)
                    _runningIds.Remove(job.Id);

                // 完成或中止后移出列表，避免一直占着
                if (job.State is DownloadJobState.Completed or DownloadJobState.Cancelled or DownloadJobState.Failed)
                    RemoveJob(job);

                RaiseChanged();
            }
        });
    }

    private void RemoveJob(DownloadJob job)
    {
        lock (_gate)
            _jobs.RemoveAll(j => j.Id == job.Id);
        try { job.Cts?.Dispose(); } catch { /* ignore */ }
        job.Cts = null;
    }

    public void Abort(IEnumerable<DownloadJob> jobs)
    {
        foreach (var job in jobs)
            RequestAbort(job);
        RaiseChanged();
    }

    public void AbortActive(bool all)
    {
        List<DownloadJob> targets;
        lock (_gate)
        {
            targets = _jobs.Where(j =>
                j.State is DownloadJobState.Queued or DownloadJobState.Probing or DownloadJobState.Running)
                .ToList();
        }

        if (!all)
        {
            // all=false 由 UI 传入选中项；这里仅「全部进行中」
        }

        Abort(targets);
    }

    public static void RequestAbort(DownloadJob job)
    {
        if (job.State is not (DownloadJobState.Queued or DownloadJobState.Probing or DownloadJobState.Running))
            return;

        job.Message = L.T("正在中止…", "Stopping…");
        try { job.Cts?.Cancel(); } catch { /* ignore */ }

        if (job.State == DownloadJobState.Queued)
        {
            job.State = DownloadJobState.Cancelled;
            job.Message = L.T("已中止", "Stopped");
        }
    }

    /// <summary>主窗口退出时调用：中止全部下载。</summary>
    public void Shutdown()
    {
        if (Interlocked.Exchange(ref _shuttingDown, 1) != 0)
            return;

        List<DownloadJob> all;
        lock (_gate)
            all = _jobs.ToList();

        foreach (var job in all)
        {
            try { job.Cts?.Cancel(); } catch { /* ignore */ }
        }

        lock (_gate)
        {
            foreach (var job in _jobs)
            {
                try { job.Cts?.Dispose(); } catch { /* ignore */ }
                job.Cts = null;
            }

            _jobs.Clear();
            _runningIds.Clear();
        }

        RaiseChanged();
    }

    private void RaiseChanged()
    {
        Interlocked.Exchange(ref _changedFlag, 1);
        try { Changed?.Invoke(); } catch { /* ignore UI disposed */ }
    }
}
