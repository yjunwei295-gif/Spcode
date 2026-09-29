namespace MemWatch;

/// <summary>多线程下载管理：手动链接 + 剪贴板自动检测可下载 URL。</summary>
public sealed class DownloadManagerForm : Form
{
    private readonly LevelConfig _levels;
    private readonly TextBox _txtUrl = new();
    private readonly Label _lblUrl = new();
    private readonly Label _lblDir = new();
    private readonly TextBox _txtDir = new();
    private readonly Button _btnBrowse = new();
    private readonly Label _lblThreads = new();
    private readonly NumericUpDown _numThreads = new();
    private readonly CheckBox _chkAutoClip = new();
    private readonly Button _btnAdd = new();
    private readonly Button _btnStart = new();
    private readonly Button _btnCancel = new();
    private readonly Button _btnCancelAll = new();
    private readonly Button _btnOpenDir = new();
    private readonly Button _btnClose = new();
    private readonly Label _lblStatus = new();
    private readonly Label _lblHint = new();
    private readonly ListView _list = new();
    private readonly System.Windows.Forms.Timer _clipTimer = new();
    private readonly System.Windows.Forms.Timer _uiTimer = new();
    private static readonly Color DefaultBack = UiTheme.Back;
    private Button? _btnSkin;

    private string _lastClip = "";
    private DateTime _lastClipUtc = DateTime.MinValue;
    private bool _busyProbe;
    private int _listDirty;

    public DownloadManagerForm(LevelConfig levels)
    {
        _levels = levels;
        BuildUi();
        TopMost = false;
        ApplyLanguage();
        L.Changed += OnLanguageChanged;
        DownloadService.Instance.Changed += OnServiceChanged;
        FormClosed += (_, _) =>
        {
            L.Changed -= OnLanguageChanged;
            DownloadService.Instance.Changed -= OnServiceChanged;
            _clipTimer.Stop();
            _uiTimer.Stop();
            // 不取消下载：关闭窗口后继续后台任务，仅主窗口退出时 Shutdown
        };
        WindowSkin.Apply(this, _levels, WindowSkin.KeyDiskHealth, DefaultBack);

        _txtDir.Text = DownloadService.Instance.SaveDirectory;
        _numThreads.Value = Math.Clamp(DownloadService.Instance.ThreadCount, 1, 16);

        _clipTimer.Interval = 800;
        _clipTimer.Tick += async (_, _) => await PollClipboardAsync();

        _uiTimer.Interval = 300;
        _uiTimer.Tick += (_, _) =>
        {
            if (Interlocked.Exchange(ref _listDirty, 0) == 1)
                RefreshList();
        };
        _uiTimer.Start();

        Shown += (_, _) =>
        {
            RefreshList();
            // 打开窗口时先吞掉当前剪贴板，避免把「已有内容」当成新链接反复下
            SeedClipboardBaseline();
            if (_chkAutoClip.Checked)
                _clipTimer.Start();
            var n = DownloadService.Instance.ActiveCount;
            if (n > 0)
            {
                _lblStatus.Text = L.T(
                    $"后台已有 {n} 个下载任务进行中（关闭本窗口不会停止）。",
                    $"{n} download(s) running in background (closing this window will not stop them).");
            }
        };
    }

    private void SeedClipboardBaseline()
    {
        try
        {
            if (Clipboard.ContainsText())
            {
                _lastClip = Clipboard.GetText() ?? "";
                _lastClipUtc = DateTime.UtcNow;
            }
            else
            {
                _lastClip = "";
            }
        }
        catch
        {
            _lastClip = "";
        }
    }

    private void OnServiceChanged()
    {
        Interlocked.Exchange(ref _listDirty, 1);
    }

    private void OnLanguageChanged()
    {
        if (IsDisposed)
            return;
        if (InvokeRequired)
        {
            BeginInvoke(OnLanguageChanged);
            return;
        }

        ApplyLanguage();
        RefreshList();
    }

    private void ApplyLanguage()
    {
        Text = L.T("多线程下载", "Multi-thread Download");
        _lblUrl.Text = L.T("下载链接", "URL");
        _lblDir.Text = L.T("保存目录", "Save folder");
        _btnBrowse.Text = L.T("浏览…", "Browse…");
        _lblThreads.Text = L.T("线程数", "Threads");
        _chkAutoClip.Text = L.T("自动检测剪贴板可下载链接（浏览器复制链接时）", "Auto-detect downloadable clipboard URLs");
        _btnAdd.Text = L.T("添加任务", "Add");
        _btnStart.Text = L.T("开始排队", "Start queued");
        _btnCancel.Text = L.T("中止选中", "Stop selected");
        _btnCancelAll.Text = L.T("中止全部", "Stop all");
        _btnOpenDir.Text = L.T("打开目录", "Open folder");
        _btnClose.Text = L.T("关闭", "Close");
        if (_btnSkin is not null)
            _btnSkin.Text = L.T("皮肤", "Skin");

        _lblHint.Text = L.T(
            "关闭本窗口后下载会在后台继续，只有退出主程序才会停止。右上角红色按钮可中止任务。",
            "Closing this window keeps downloads running; only exiting the main app stops them. Use the red Stop buttons to abort.");

        if (_list.Columns.Count >= 5)
        {
            _list.Columns[0].Text = L.T("文件名", "Name");
            _list.Columns[1].Text = L.T("进度", "Progress");
            _list.Columns[2].Text = L.T("速度", "Speed");
            _list.Columns[3].Text = L.T("状态", "Status");
            _list.Columns[4].Text = L.T("来源", "Source");
        }
    }

    private void BuildUi()
    {
        Text = L.T("多线程下载", "Multi-thread Download");
        FormBorderStyle = FormBorderStyle.Sizable;
        MaximizeBox = true;
        MinimizeBox = true;
        ShowInTaskbar = true;
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Segoe UI", 9f);
        BackColor = DefaultBack;
        DoubleBuffered = true;
        MinimumSize = new Size(720, 480);
        ClientSize = new Size(860, 560);

        const int pad = 8;
        var top = new Panel
        {
            Dock = DockStyle.Top,
            Height = 148,
            BackColor = DefaultBack,
            Padding = new Padding(pad)
        };

        _lblUrl.AutoSize = true;
        _lblUrl.Location = new Point(pad, 10);
        _txtUrl.Location = new Point(pad + 70, 6);
        _txtUrl.Size = new Size(560, 24);
        _txtUrl.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;

        _btnAdd.Size = new Size(90, 26);
        _btnAdd.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        _btnAdd.Click += (_, _) => AddFromUrlBox(autoStart: true);

        _btnCancel.Size = new Size(90, 26);
        _btnCancel.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        UiTheme.FlattenButton(_btnCancel, UiTheme.Danger);
        _btnCancel.Click += (_, _) => AbortJobs(selectedOnly: true);

        _btnCancelAll.Size = new Size(90, 26);
        _btnCancelAll.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        UiTheme.FlattenButton(_btnCancelAll, UiTheme.Whale);
        _btnCancelAll.Click += (_, _) => AbortJobs(selectedOnly: false);

        _lblDir.AutoSize = true;
        _lblDir.Location = new Point(pad, 42);
        _txtDir.Location = new Point(pad + 70, 38);
        _txtDir.Size = new Size(480, 24);
        _txtDir.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        _txtDir.Text = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");

        _btnBrowse.Size = new Size(70, 26);
        _btnBrowse.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        _btnBrowse.Click += (_, _) =>
        {
            using var dlg = new FolderBrowserDialog
            {
                SelectedPath = Directory.Exists(_txtDir.Text) ? _txtDir.Text : ""
            };
            if (dlg.ShowDialog(this) == DialogResult.OK)
                _txtDir.Text = dlg.SelectedPath;
        };

        _lblThreads.AutoSize = true;
        _lblThreads.Location = new Point(pad, 74);
        _numThreads.Minimum = 1;
        _numThreads.Maximum = 16;
        _numThreads.Value = 8;
        _numThreads.Location = new Point(pad + 70, 70);
        _numThreads.Size = new Size(60, 24);

        _chkAutoClip.AutoSize = true;
        _chkAutoClip.Location = new Point(pad + 150, 74);
        _chkAutoClip.Checked = false;
        _chkAutoClip.CheckedChanged += (_, _) =>
        {
            if (_chkAutoClip.Checked)
            {
                SeedClipboardBaseline();
                _clipTimer.Start();
            }
            else
                _clipTimer.Stop();
        };

        _btnSkin = WindowSkin.CreateButton(this, _levels, WindowSkin.KeyDiskHealth, DefaultBack);
        _btnSkin.Size = new Size(56, 26);
        _btnSkin.Anchor = AnchorStyles.Top | AnchorStyles.Right;

        _lblStatus.AutoSize = false;
        _lblStatus.Location = new Point(pad, 104);
        _lblStatus.Size = new Size(700, 20);
        _lblStatus.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        _lblStatus.ForeColor = Color.DimGray;
        _lblStatus.Text = L.T("就绪", "Ready");

        top.Controls.AddRange(new Control[]
        {
            _lblUrl, _txtUrl, _btnAdd, _btnCancel, _btnCancelAll,
            _lblDir, _txtDir, _btnBrowse,
            _lblThreads, _numThreads, _chkAutoClip, _btnSkin, _lblStatus
        });
        top.Resize += (_, _) => LayoutTop(top, pad);
        LayoutTop(top, pad);

        var mid = new Panel { Dock = DockStyle.Fill, Padding = new Padding(pad, 0, pad, 0) };
        _lblHint.Dock = DockStyle.Top;
        _lblHint.Height = 48;
        _lblHint.ForeColor = Color.FromArgb(100, 60, 20);

        _list.Dock = DockStyle.Fill;
        _list.View = View.Details;
        _list.FullRowSelect = true;
        _list.GridLines = true;
        _list.HideSelection = false;
        _list.MultiSelect = true;
        _list.Columns.Add("Name", 200);
        _list.Columns.Add("Progress", 160);
        _list.Columns.Add("Speed", 100);
        _list.Columns.Add("Status", 180);
        _list.Columns.Add("Source", 90);
        _list.KeyDown += (_, e) =>
        {
            if (e.Control && e.KeyCode == Keys.A)
            {
                foreach (ListViewItem it in _list.Items)
                    it.Selected = true;
                e.Handled = true;
                e.SuppressKeyPress = true;
            }
            else if (e.KeyCode == Keys.Delete)
            {
                AbortJobs(selectedOnly: true);
                e.Handled = true;
                e.SuppressKeyPress = true;
            }
        };

        mid.Controls.Add(_list);
        mid.Controls.Add(_lblHint);

        var bottom = new Panel
        {
            Dock = DockStyle.Bottom,
            Height = 48,
            BackColor = DefaultBack,
            Padding = new Padding(pad)
        };

        _btnStart.Size = new Size(110, 28);
        _btnStart.Location = new Point(pad, 10);
        _btnStart.Click += (_, _) => StartQueued();

        _btnOpenDir.Size = new Size(100, 28);
        _btnOpenDir.Click += (_, _) =>
        {
            try
            {
                var dir = _txtDir.Text.Trim();
                if (!Directory.Exists(dir))
                    Directory.CreateDirectory(dir);
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
                {
                    FileName = dir,
                    UseShellExecute = true
                });
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, ex.Message, L.T("错误", "Error"),
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        };
        _btnClose.Size = new Size(80, 28);
        _btnClose.Click += (_, _) => Close();

        // 中止按钮只放在顶部（红色），不要再 Add 到底部，否则会从顶部被挪走看不见
        bottom.Controls.AddRange(new Control[] { _btnStart, _btnOpenDir, _btnClose });
        void LayoutBottom()
        {
            _btnClose.Location = new Point(bottom.ClientSize.Width - _btnClose.Width - pad, 10);
            _btnOpenDir.Location = new Point(_btnClose.Left - 8 - _btnOpenDir.Width, 10);
            _btnStart.Location = new Point(pad, 10);
        }
        bottom.Resize += (_, _) => LayoutBottom();
        LayoutBottom();

        Controls.Add(mid);
        Controls.Add(bottom);
        Controls.Add(top);
        UiTheme.StyleTree(this);
        EchoChrome.Attach(this, canResize: true, showMin: true);
    }

    private void LayoutTop(Panel top, int pad)
    {
        var right = top.ClientSize.Width - pad;
        _btnCancelAll.Location = new Point(right - _btnCancelAll.Width, 6);
        right = _btnCancelAll.Left - 6;
        _btnCancel.Location = new Point(right - _btnCancel.Width, 6);
        right = _btnCancel.Left - 6;
        _btnAdd.Location = new Point(right - _btnAdd.Width, 6);

        if (_btnSkin is not null)
            _btnSkin.Location = new Point(top.ClientSize.Width - _btnSkin.Width - pad, 70);
        _btnBrowse.Location = new Point((_btnSkin?.Left ?? top.ClientSize.Width) - 8 - _btnBrowse.Width, 38);
        _txtUrl.Width = Math.Max(120, _btnAdd.Left - _txtUrl.Left - 8);
        _txtDir.Width = Math.Max(120, _btnBrowse.Left - _txtDir.Left - 8);
        _lblStatus.Width = Math.Max(200, top.ClientSize.Width - pad * 2);

        // 保证红色中止按钮在最前
        _btnCancel.BringToFront();
        _btnCancelAll.BringToFront();
        _btnAdd.BringToFront();
    }

    private async Task PollClipboardAsync()
    {
        if (!_chkAutoClip.Checked || _busyProbe || IsDisposed)
            return;

        string clip;
        try
        {
            if (!Clipboard.ContainsText())
                return;
            clip = Clipboard.GetText() ?? "";
        }
        catch
        {
            return;
        }

        if (string.IsNullOrWhiteSpace(clip))
            return;

        // 同一剪贴板内容短时间防抖；允许之后再次下载同一链接
        if (clip == _lastClip && (DateTime.UtcNow - _lastClipUtc).TotalSeconds < 2)
            return;
        _lastClip = clip;
        _lastClipUtc = DateTime.UtcNow;

        if (!MultiThreadDownloader.TryExtractUrl(clip, out var url))
            return;

        _busyProbe = true;
        _lblStatus.Text = L.T("检测到链接，正在解析真实下载地址…", "URL detected, resolving real download URL…");
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(45));
            var probe = await MultiThreadDownloader.ProbeAsync(url, cts.Token);
            if (!probe.Downloadable)
            {
                _lblStatus.Text = L.T($"已忽略（{probe.Reason}）：{Short(url)}", $"Ignored ({probe.Reason}): {Short(url)}");
                return;
            }

            await AddJobAsync(url, probe.RealUrl, probe.FileName ?? "", fromAuto: true, autoStart: true);
            ClearClipboardAfterAutoDownload();
            _lblStatus.Text = L.T(
                $"已自动添加：{probe.FileName}（{probe.Reason}）",
                $"Auto-added: {probe.FileName} ({probe.Reason})");
        }
        catch (Exception ex)
        {
            _lblStatus.Text = L.T($"自动检测失败：{ex.Message}", $"Auto-detect failed: {ex.Message}");
        }
        finally
        {
            _busyProbe = false;
        }
    }

    private void ClearClipboardAfterAutoDownload()
    {
        try
        {
            Clipboard.Clear();
        }
        catch
        {
            try { Clipboard.SetText(" "); } catch { /* ignore */ }
        }

        _lastClip = "";
        _lastClipUtc = DateTime.UtcNow;
    }

    private void AddFromUrlBox(bool autoStart)
    {
        var text = _txtUrl.Text;
        if (!MultiThreadDownloader.TryExtractUrl(text, out var url))
        {
            MessageBox.Show(this,
                L.T("请输入有效的 http(s) 下载链接。", "Enter a valid http(s) download URL."),
                L.T("多线程下载", "Multi-thread Download"),
                MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        _ = AddJobAsync(url, resolvedUrl: "", fileName: "", fromAuto: false, autoStart: autoStart);
    }

    private async Task AddJobAsync(string url, string resolvedUrl, string fileName, bool fromAuto, bool autoStart)
    {
        DownloadService.Instance.SaveDirectory = _txtDir.Text.Trim();
        DownloadService.Instance.ThreadCount = (int)_numThreads.Value;

        if (!DownloadService.Instance.TryAddJob(url, resolvedUrl, fileName, fromAuto, autoStart, out _, out var message))
        {
            _lblStatus.Text = message;
            return;
        }

        if (!fromAuto)
            _txtUrl.Clear();

        RefreshList();
        await Task.CompletedTask;
    }

    private void StartQueued()
    {
        DownloadService.Instance.SaveDirectory = _txtDir.Text.Trim();
        DownloadService.Instance.ThreadCount = (int)_numThreads.Value;
        DownloadService.Instance.StartQueued();
        RefreshList();
    }

    private void AbortJobs(bool selectedOnly)
    {
        List<DownloadJob> targets;
        var allJobs = DownloadService.Instance.GetJobsSnapshot();

        if (selectedOnly)
        {
            targets = _list.SelectedItems.Cast<ListViewItem>()
                .Select(x => x.Tag)
                .OfType<DownloadJob>()
                .ToList();

            if (targets.Count == 0)
            {
                targets = allJobs.Where(j =>
                    j.State is DownloadJobState.Queued or DownloadJobState.Probing or DownloadJobState.Running)
                    .ToList();
                if (targets.Count == 0)
                {
                    _lblStatus.Text = L.T("没有可中止的任务。", "No task to stop.");
                    return;
                }

                _lblStatus.Text = L.T(
                    $"未选中项，已中止 {targets.Count} 个进行中的任务。",
                    $"Nothing selected; stopped {targets.Count} active task(s).");
            }
        }
        else
        {
            targets = allJobs.Where(j =>
                    j.State is DownloadJobState.Queued or DownloadJobState.Probing or DownloadJobState.Running)
                .ToList();
            if (targets.Count == 0)
            {
                _lblStatus.Text = L.T("没有可中止的任务。", "No task to stop.");
                return;
            }

            _lblStatus.Text = L.T(
                $"已请求中止全部 {targets.Count} 个任务…",
                $"Stop requested for all {targets.Count} task(s)…");
        }

        if (selectedOnly && _list.SelectedItems.Count > 0)
        {
            _lblStatus.Text = L.T(
                $"已请求中止 {targets.Count} 个任务…",
                $"Stop requested for {targets.Count} task(s)…");
        }

        DownloadService.Instance.Abort(targets);
        RefreshList();
    }

    private void RefreshList()
    {
        if (IsDisposed || !_list.IsHandleCreated)
            return;

        if (InvokeRequired)
        {
            BeginInvoke(RefreshList);
            return;
        }

        var jobs = DownloadService.Instance.GetJobsSnapshot();

        if (_list.Items.Count == jobs.Count)
        {
            var byId = _list.Items.Cast<ListViewItem>()
                .Where(x => x.Tag is DownloadJob)
                .ToDictionary(x => ((DownloadJob)x.Tag!).Id, x => x);

            if (byId.Count == jobs.Count && jobs.All(j => byId.ContainsKey(j.Id)))
            {
                foreach (var job in jobs)
                {
                    var row = byId[job.Id];
                    if (row.Text != job.FileName)
                        row.Text = job.FileName;
                    SetSub(row, 1, FormatProgress(job));
                    SetSub(row, 2, FormatSpeed(job.SpeedBytesPerSec));
                    SetSub(row, 3, $"{StateText(job.State)} · {job.Message}");
                    SetSub(row, 4, job.FromAutoDetect ? L.T("自动", "Auto") : L.T("手动", "Manual"));
                }

                return;
            }
        }

        _list.BeginUpdate();
        try
        {
            var selectedIds = _list.SelectedItems.Cast<ListViewItem>()
                .Select(x => (x.Tag as DownloadJob)?.Id)
                .Where(x => x != null)
                .ToHashSet();

            _list.Items.Clear();
            foreach (var job in jobs)
            {
                var row = new ListViewItem(job.FileName) { Tag = job };
                row.SubItems.Add(FormatProgress(job));
                row.SubItems.Add(FormatSpeed(job.SpeedBytesPerSec));
                row.SubItems.Add($"{StateText(job.State)} · {job.Message}");
                row.SubItems.Add(job.FromAutoDetect
                    ? L.T("自动", "Auto")
                    : L.T("手动", "Manual"));
                row.ToolTipText = job.Url
                    + (string.IsNullOrWhiteSpace(job.ResolvedUrl) || string.Equals(job.Url, job.ResolvedUrl, StringComparison.OrdinalIgnoreCase)
                        ? ""
                        : "\n→ " + job.ResolvedUrl)
                    + "\n" + job.SavePath;
                if (selectedIds.Contains(job.Id))
                    row.Selected = true;
                _list.Items.Add(row);
            }
        }
        finally
        {
            _list.EndUpdate();
        }
    }

    private static void SetSub(ListViewItem row, int index, string text)
    {
        if (row.SubItems.Count > index && row.SubItems[index].Text != text)
            row.SubItems[index].Text = text;
    }

    private static string FormatProgress(DownloadJob job)
    {
        if (job.TotalBytes > 0)
            return $"{FormatSize(job.DownloadedBytes)} / {FormatSize(job.TotalBytes)} ({job.Progress01 * 100:0.0}%)";
        if (job.DownloadedBytes > 0)
            return FormatSize(job.DownloadedBytes);
        return "-";
    }

    private static string FormatSpeed(double bps)
    {
        if (bps <= 0)
            return "-";
        return FormatSize((long)bps) + "/s";
    }

    private static string FormatSize(long bytes)
    {
        if (bytes < 1024)
            return $"{bytes} B";
        if (bytes < 1024 * 1024)
            return $"{bytes / 1024.0:0.#} KB";
        if (bytes < 1024L * 1024 * 1024)
            return $"{bytes / (1024.0 * 1024):0.##} MB";
        return $"{bytes / (1024.0 * 1024 * 1024):0.##} GB";
    }

    private static string StateText(DownloadJobState s) => s switch
    {
        DownloadJobState.Queued => L.T("排队", "Queued"),
        DownloadJobState.Probing => L.T("探测", "Probing"),
        DownloadJobState.Running => L.T("下载中", "Running"),
        DownloadJobState.Paused => L.T("暂停", "Paused"),
        DownloadJobState.Completed => L.T("完成", "Done"),
        DownloadJobState.Failed => L.T("失败", "Failed"),
        DownloadJobState.Cancelled => L.T("取消", "Cancelled"),
        _ => s.ToString()
    };

    private static string Short(string url) =>
        url.Length <= 64 ? url : url[..61] + "…";
}
