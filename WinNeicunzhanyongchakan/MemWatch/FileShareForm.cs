namespace MemWatch;

/// <summary>
/// 直连文件分享：分享方复制分享串 → 接收方粘贴后直连下载。
/// 不经中继/网页；连不上则提示用户自行调整网络。
/// </summary>
public sealed class FileShareForm : Form
{
    private readonly LevelConfig _levels;
    private readonly TabControl _tabs = new();
    private readonly TabPage _tabShare = new();
    private readonly TabPage _tabRecv = new();

    // —— 分享 ——
    private readonly CheckBox _chkAllow = new();
    private readonly Button _btnAdd = new();
    private readonly Button _btnClear = new();
    private readonly Button _btnStart = new();
    private readonly Button _btnStop = new();
    private readonly Button _btnCopyToken = new();
    private readonly Button _btnRegen = new();
    private readonly Label _lblCode = new();
    private readonly Label _lblToken = new();
    private readonly Label _lblShareHint = new();
    private readonly Label _lblShareStatus = new();
    private readonly ListView _shareList = new();
    private readonly NumericUpDown _numPort = new();
    private readonly Label _lblPort = new();
    private readonly TextBox _txtTokenPreview = new();

    // —— 接收 ——
    private readonly TextBox _txtPaste = new();
    private readonly Button _btnConnect = new();
    private readonly Button _btnPickFolder = new();
    private readonly Button _btnDownload = new();
    private readonly Label _lblPaste = new();
    private readonly Label _lblSaveDir = new();
    private readonly Label _lblRecvHint = new();
    private readonly Label _lblRecvStatus = new();
    private readonly ThemedMeter _progress = new();
    private readonly ListView _recvList = new();

    private readonly Button _btnClose = new();
    private readonly System.Windows.Forms.Timer _uiTimer = new();
    private static readonly Color DefaultBack = UiTheme.Back;
    private Button? _btnSkin;
    private int _dirty;

    private string? _connectedBaseUrl;
    private string? _connectedCode;
    private List<RemoteShareFile> _remoteFiles = new();
    private string _saveDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
    private CancellationTokenSource? _recvCts;

    public FileShareForm(LevelConfig levels)
    {
        _levels = levels;
        BuildUi();
        TopMost = false;
        ApplyLanguage();
        SyncShareUi();
        UpdateSaveDirLabel();
        L.Changed += OnLanguageChanged;
        FileShareService.Instance.Changed += OnShareServiceChanged;
        FormClosed += (_, _) =>
        {
            L.Changed -= OnLanguageChanged;
            FileShareService.Instance.Changed -= OnShareServiceChanged;
            _uiTimer.Stop();
            _uiTimer.Dispose();
            try { _recvCts?.Cancel(); } catch { /* ignore */ }
            try { _recvCts?.Dispose(); } catch { /* ignore */ }
            _recvCts = null;
        };
        WindowSkin.Apply(this, _levels, WindowSkin.KeyDiskHealth, DefaultBack);

        _uiTimer.Interval = 400;
        _uiTimer.Tick += (_, _) =>
        {
            if (Interlocked.Exchange(ref _dirty, 0) == 1)
                SyncShareUi();
        };
        _uiTimer.Start();
    }

    private void OnShareServiceChanged() => Interlocked.Exchange(ref _dirty, 1);

    private void OnLanguageChanged()
    {
        if (IsDisposed) return;
        if (InvokeRequired) { BeginInvoke(OnLanguageChanged); return; }
        ApplyLanguage();
        SyncShareUi();
        UpdateSaveDirLabel();
    }

    private void ApplyLanguage()
    {
        Text = L.T("文件分享", "File Share");
        _tabShare.Text = L.T("我要分享", "Share");
        _tabRecv.Text = L.T("我要接收", "Receive");
        _chkAllow.Text = L.T("允许别人下载（总开关）", "Allow others to download");
        _btnAdd.Text = L.T("添加文件…", "Add files…");
        _btnClear.Text = L.T("清空列表", "Clear list");
        _btnStart.Text = L.T("一键开始并复制", "Start & copy");
        _btnStop.Text = L.T("停止分享", "Stop share");
        _btnCopyToken.Text = L.T("再复制分享串", "Copy again");
        _btnRegen.Text = L.T("换验证码", "New code");
        _btnClose.Text = L.T("关闭", "Close");
        _lblPort.Text = L.T("端口", "Port");
        _btnConnect.Text = L.T("一键下载全部", "Download all");
        _btnPickFolder.Text = L.T("保存目录…", "Save folder…");
        _btnDownload.Text = L.T("下载选中", "Download selected");
        _lblPaste.Text = L.T("粘贴分享串", "Paste share token");
        if (_btnSkin is not null) _btnSkin.Text = L.T("皮肤", "Skin");

        _lblShareHint.Text = L.T(
            "添加文件后点「一键开始并复制」：自动开防火墙、尝试开通外网端口，并复制分享串。把串发给对方即可。对方不必进你的局域网设置，只要网络能通到你（同一 Wi‑Fi，或路由器开了 UPnP）。",
            "Add files, then Start & copy: opens firewall, tries UPnP WAN map, copies the token. Peer pastes it — no manual LAN setup if same Wi‑Fi or UPnP works.");

        _lblRecvHint.Text = L.T(
            "粘贴分享串后点「一键下载全部」即可。连不上会弹窗说明原因。",
            "Paste the token and click Download all. Failures show a clear dialog.");

        if (_shareList.Columns.Count >= 3)
        {
            _shareList.Columns[0].Text = L.T("文件名", "Name");
            _shareList.Columns[1].Text = L.T("大小", "Size");
            _shareList.Columns[2].Text = L.T("路径", "Path");
        }

        if (_recvList.Columns.Count >= 2)
        {
            _recvList.Columns[0].Text = L.T("文件名", "Name");
            _recvList.Columns[1].Text = L.T("大小", "Size");
        }
    }

    private void BuildUi()
    {
        Text = L.T("文件分享", "File Share");
        FormBorderStyle = FormBorderStyle.Sizable;
        MaximizeBox = true;
        MinimizeBox = true;
        ShowInTaskbar = true;
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Segoe UI", 9f);
        BackColor = DefaultBack;
        DoubleBuffered = true;
        MinimumSize = new Size(780, 580);
        ClientSize = new Size(900, 640);

        const int pad = 8;

        var header = new Panel { Dock = DockStyle.Top, Height = 40, BackColor = DefaultBack, Padding = new Padding(pad) };
        _btnSkin = WindowSkin.CreateButton(this, _levels, WindowSkin.KeyDiskHealth, DefaultBack);
        _btnSkin.Size = new Size(56, 26);
        _btnSkin.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        header.Controls.Add(_btnSkin);
        header.Resize += (_, _) =>
            _btnSkin.Location = new Point(header.ClientSize.Width - _btnSkin.Width - pad, 6);

        BuildShareTab(pad);
        BuildRecvTab(pad);

        _tabs.Dock = DockStyle.Fill;
        _tabs.SizeMode = TabSizeMode.Fixed;
        _tabs.ItemSize = new Size(140, 32);
        _tabs.Font = new Font("Segoe UI", 10f, FontStyle.Bold);
        _tabs.Padding = new Point(18, 6);
        _tabs.TabPages.Add(_tabShare);
        _tabs.TabPages.Add(_tabRecv);

        var bottom = new Panel { Dock = DockStyle.Bottom, Height = 48, BackColor = DefaultBack };
        _btnClose.Size = new Size(80, 28);
        _btnClose.Click += (_, _) => Close();
        bottom.Controls.Add(_btnClose);
        bottom.Resize += (_, _) =>
            _btnClose.Location = new Point(bottom.ClientSize.Width - _btnClose.Width - pad, 10);

        Controls.Add(_tabs);
        Controls.Add(bottom);
        Controls.Add(header);
        UiTheme.StyleTree(this);
        EchoChrome.Attach(this, canResize: true, showMin: true);
    }

    private void BuildShareTab(int pad)
    {
        _tabShare.BackColor = DefaultBack;
        _tabShare.Padding = new Padding(pad);

        var top = new Panel { Dock = DockStyle.Top, Height = 210, BackColor = DefaultBack };

        _chkAllow.AutoSize = true;
        _chkAllow.Location = new Point(0, 4);
        _chkAllow.Checked = true;
        _chkAllow.CheckedChanged += (_, _) =>
        {
            FileShareService.Instance.AllowDownload = _chkAllow.Checked;
            SyncShareUi();
        };

        _lblPort.AutoSize = true;
        _lblPort.Location = new Point(0, 36);
        _numPort.Minimum = 1024;
        _numPort.Maximum = 65535;
        _numPort.Value = 18765;
        _numPort.Location = new Point(48, 32);
        _numPort.Size = new Size(70, 24);

        _btnAdd.Size = new Size(100, 28);
        _btnAdd.Location = new Point(0, 66);
        _btnAdd.Click += (_, _) => AddFiles();

        _btnClear.Size = new Size(90, 28);
        _btnClear.Location = new Point(108, 66);
        _btnClear.Click += (_, _) => { FileShareService.Instance.ClearFiles(); SyncShareUi(); };

        _btnStart.Size = new Size(140, 28);
        _btnStart.Location = new Point(206, 66);
        UiTheme.FlattenButton(_btnStart, UiTheme.Accent);
        _btnStart.Click += async (_, _) => await StartShareAndCopyAsync();

        _btnStop.Size = new Size(100, 28);
        _btnStop.Location = new Point(354, 66);
        UiTheme.FlattenButton(_btnStop, UiTheme.Danger);
        _btnStop.Click += (_, _) => { FileShareService.Instance.Stop(); SyncShareUi(); };

        _btnRegen.Size = new Size(90, 28);
        _btnRegen.Location = new Point(462, 66);
        _btnRegen.Click += (_, _) => { FileShareService.Instance.RegenerateCode(); SyncShareUi(); };

        _btnCopyToken.Size = new Size(120, 28);
        _btnCopyToken.Location = new Point(560, 66);
        _btnCopyToken.Click += (_, _) => CopyToken();

        _lblCode.AutoSize = false;
        _lblCode.Location = new Point(0, 104);
        _lblCode.Size = new Size(860, 22);
        _lblCode.Font = new Font("Segoe UI", 11f, FontStyle.Bold);

        _lblToken.AutoSize = true;
        _lblToken.Location = new Point(0, 132);
        _lblToken.Text = "Token";

        _txtTokenPreview.Location = new Point(0, 152);
        _txtTokenPreview.Size = new Size(860, 24);
        _txtTokenPreview.ReadOnly = true;
        _txtTokenPreview.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;

        _lblShareStatus.AutoSize = false;
        _lblShareStatus.Location = new Point(0, 182);
        _lblShareStatus.Size = new Size(860, 20);
        _lblShareStatus.ForeColor = Color.DimGray;
        _lblShareStatus.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;

        top.Controls.AddRange(new Control[]
        {
            _chkAllow, _lblPort, _numPort,
            _btnAdd, _btnClear, _btnStart, _btnStop, _btnRegen, _btnCopyToken,
            _lblCode, _lblToken, _txtTokenPreview, _lblShareStatus
        });
        top.Resize += (_, _) =>
        {
            var w = Math.Max(200, top.ClientSize.Width - 4);
            _lblCode.Width = w;
            _txtTokenPreview.Width = w;
            _lblShareStatus.Width = w;
        };

        _lblShareHint.Dock = DockStyle.Bottom;
        _lblShareHint.Height = 52;
        _lblShareHint.ForeColor = Color.FromArgb(100, 60, 20);

        _shareList.Dock = DockStyle.Fill;
        _shareList.View = View.Details;
        _shareList.FullRowSelect = true;
        _shareList.GridLines = true;
        _shareList.Columns.Add("Name", 220);
        _shareList.Columns.Add("Size", 100);
        _shareList.Columns.Add("Path", 420);
        _shareList.AllowDrop = true;
        _shareList.DragEnter += (_, e) =>
        {
            if (e.Data?.GetDataPresent(DataFormats.FileDrop) == true)
                e.Effect = DragDropEffects.Copy;
        };
        _shareList.DragDrop += (_, e) =>
        {
            if (e.Data?.GetData(DataFormats.FileDrop) is string[] files)
            {
                FileShareService.Instance.AddFiles(files);
                SyncShareUi();
            }
        };

        _tabShare.Controls.Add(_shareList);
        _tabShare.Controls.Add(_lblShareHint);
        _tabShare.Controls.Add(top);
    }

    private void BuildRecvTab(int pad)
    {
        _tabRecv.BackColor = DefaultBack;
        _tabRecv.Padding = new Padding(pad);

        var top = new Panel { Dock = DockStyle.Top, Height = 150, BackColor = DefaultBack };

        _lblPaste.AutoSize = true;
        _lblPaste.Location = new Point(0, 4);

        _txtPaste.Location = new Point(0, 24);
        _txtPaste.Size = new Size(860, 48);
        _txtPaste.Multiline = true;
        _txtPaste.ScrollBars = ScrollBars.Vertical;
        _txtPaste.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        _txtPaste.PlaceholderText = "MWFS1|123456|18765|192.168.1.10,...";

        _btnConnect.Size = new Size(160, 28);
        _btnConnect.Location = new Point(0, 80);
        UiTheme.FlattenButton(_btnConnect, UiTheme.Info);
        _btnConnect.Click += async (_, _) => await OneClickDownloadAllAsync();

        _btnPickFolder.Size = new Size(110, 28);
        _btnPickFolder.Location = new Point(168, 80);
        _btnPickFolder.Click += (_, _) => PickSaveFolder();

        _btnDownload.Size = new Size(110, 28);
        _btnDownload.Location = new Point(286, 80);
        _btnDownload.Enabled = false;
        _btnDownload.Click += async (_, _) => await DownloadSelectedAsync();

        _lblSaveDir.AutoSize = false;
        _lblSaveDir.Location = new Point(0, 114);
        _lblSaveDir.Size = new Size(860, 20);
        _lblSaveDir.ForeColor = Color.DimGray;
        _lblSaveDir.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;

        top.Controls.AddRange(new Control[]
        {
            _lblPaste, _txtPaste, _btnConnect, _btnPickFolder, _btnDownload, _lblSaveDir
        });
        top.Resize += (_, _) =>
        {
            var w = Math.Max(200, top.ClientSize.Width - 4);
            _txtPaste.Width = w;
            _lblSaveDir.Width = w;
        };

        var bottomBar = new Panel { Dock = DockStyle.Bottom, Height = 72, BackColor = DefaultBack };
        _progress.Dock = DockStyle.Top;
        _progress.Height = 18;
        _progress.Minimum = 0;
        _progress.Maximum = 100;
        _lblRecvStatus.Dock = DockStyle.Fill;
        _lblRecvStatus.ForeColor = Color.DimGray;
        _lblRecvHint.Dock = DockStyle.Bottom;
        _lblRecvHint.Height = 36;
        _lblRecvHint.ForeColor = Color.FromArgb(100, 60, 20);
        bottomBar.Controls.Add(_lblRecvStatus);
        bottomBar.Controls.Add(_progress);
        bottomBar.Controls.Add(_lblRecvHint);

        _recvList.Dock = DockStyle.Fill;
        _recvList.View = View.Details;
        _recvList.FullRowSelect = true;
        _recvList.GridLines = true;
        _recvList.MultiSelect = true;
        _recvList.Columns.Add("Name", 420);
        _recvList.Columns.Add("Size", 120);

        _tabRecv.Controls.Add(_recvList);
        _tabRecv.Controls.Add(bottomBar);
        _tabRecv.Controls.Add(top);
    }

    private void AddFiles()
    {
        using var dlg = new OpenFileDialog
        {
            Multiselect = true,
            Title = L.T("选择要分享的文件", "Select files to share")
        };
        if (dlg.ShowDialog(this) != DialogResult.OK) return;
        FileShareService.Instance.AddFiles(dlg.FileNames);
        SyncShareUi();
    }

    private async Task StartShareAndCopyAsync()
    {
        try
        {
            _btnStart.Enabled = false;
            FileShareService.Instance.AllowDownload = _chkAllow.Checked;
            if (!FileShareService.Instance.IsRunning)
                FileShareService.Instance.Start((int)_numPort.Value);
            SyncShareUi();
            _lblShareStatus.Text = L.T("正在一键开通网络（防火墙 + 外网端口）…",
                "Preparing network (firewall + WAN port)…");
            try
            {
                using var wait = new CancellationTokenSource(TimeSpan.FromSeconds(12));
                await FileShareService.Instance.WaitNetworkReadyAsync(wait.Token).ConfigureAwait(true);
            }
            catch (OperationCanceledException)
            {
                /* 超时也继续复制，局域网仍可用 */
            }

            SyncShareUi();
            CopyToken();
            var svc = FileShareService.Instance;
            var net = string.IsNullOrEmpty(svc.NetworkStatus) ? "" : "\n" + svc.NetworkStatus;
            MessageBox.Show(this,
                L.T("分享串已复制到剪贴板，发给对方即可。" + net,
                    "Share token copied — send it to the peer." + net),
                L.T("一键分享", "One-click share"),
                MessageBoxButtons.OK,
                svc.WanMapped ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, ex.Message, L.T("文件分享", "File Share"),
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        finally
        {
            SyncShareUi();
        }
    }

    private void CopyToken()
    {
        var svc = FileShareService.Instance;
        if (!svc.IsRunning)
        {
            MessageBox.Show(this, L.T("请先开始分享。", "Start sharing first."),
                L.T("文件分享", "File Share"), MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        var token = svc.BuildShareToken();
        if (string.IsNullOrEmpty(token))
        {
            MessageBox.Show(this, L.T("分享串为空。", "Empty share token."),
                L.T("文件分享", "File Share"), MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        var text = L.T(
            $"【MemWatch 文件分享】\n请用 MemWatch → 文件分享 → 我要接收，粘贴后点「一键下载全部」：\n{token}\n",
            $"[MemWatch File Share]\nPaste in MemWatch → File Share → Receive, then Download all:\n{token}\n");
        try
        {
            Clipboard.SetText(text);
            _lblShareStatus.Text = L.T("已复制分享串，发给对方即可。", "Share token copied — send it to the peer.")
                + (string.IsNullOrEmpty(svc.NetworkStatus) ? "" : " · " + svc.NetworkStatus);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, ex.Message, L.T("错误", "Error"), MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private void SyncShareUi()
    {
        if (IsDisposed) return;
        if (InvokeRequired) { BeginInvoke(SyncShareUi); return; }

        var svc = FileShareService.Instance;
        if (_chkAllow.Checked != svc.AllowDownload)
            _chkAllow.Checked = svc.AllowDownload;

        _numPort.Enabled = !svc.IsRunning;
        _btnStart.Enabled = !svc.IsRunning;
        _btnStop.Enabled = svc.IsRunning;
        _btnRegen.Enabled = svc.IsRunning;
        _btnCopyToken.Enabled = svc.IsRunning;

        _lblCode.Text = svc.IsRunning
            ? L.T($"验证码：{svc.ShareCode}（已含在分享串里）",
                $"Code: {svc.ShareCode} (inside token)")
            : L.T("验证码：未开始分享", "Code: not sharing");

        var token = svc.IsRunning ? svc.BuildShareToken() : "";
        _txtTokenPreview.Text = token;
        _lblToken.Text = svc.IsRunning
            ? L.T("分享串（发给对方）", "Share token (send to peer)")
            : L.T("分享串", "Share token");

        var files = svc.GetFiles();
        _shareList.BeginUpdate();
        try
        {
            _shareList.Items.Clear();
            foreach (var f in files)
            {
                var row = new ListViewItem(f.Name);
                row.SubItems.Add(FormatSize(f.Size));
                row.SubItems.Add(f.Path);
                _shareList.Items.Add(row);
            }
        }
        finally { _shareList.EndUpdate(); }

        var allow = svc.AllowDownload ? L.T("允许：开", "Allow: ON") : L.T("允许：关", "Allow: OFF");
        var wan = !svc.IsRunning
            ? ""
            : svc.WanMapped
                ? L.T("外网：已自动开通", "WAN: mapped")
                : L.T("外网：未开通(仅局域网/同WiFi)", "WAN: off (LAN/same Wi‑Fi only)");
        var run = svc.IsRunning
            ? L.T($"分享中 · 端口 {svc.Port} · 传输 {svc.ActiveTransfers}",
                $"Sharing · port {svc.Port} · transfers {svc.ActiveTransfers}")
            : L.T("未分享", "Not sharing");
        var ips = svc.IsRunning
            ? string.Join(", ", svc.GetCandidateIps())
            : "—";
        _lblShareStatus.Text = L.T(
            $"{run} · {allow} · {wan} · 地址 {ips} · 文件 {files.Count}",
            $"{run} · {allow} · {wan} · IPs {ips} · {files.Count} file(s)");
        if (svc.IsRunning && !string.IsNullOrEmpty(svc.NetworkStatus))
            _lblShareStatus.Text += " · " + svc.NetworkStatus;
    }

    private void UpdateSaveDirLabel()
    {
        _lblSaveDir.Text = L.T($"保存到：{_saveDir}", $"Save to: {_saveDir}");
    }

    private void PickSaveFolder()
    {
        using var dlg = new FolderBrowserDialog
        {
            Description = L.T("选择下载保存目录", "Choose download folder"),
            SelectedPath = Directory.Exists(_saveDir) ? _saveDir : ""
        };
        if (dlg.ShowDialog(this) != DialogResult.OK) return;
        _saveDir = dlg.SelectedPath;
        UpdateSaveDirLabel();
    }

    private async Task OneClickDownloadAllAsync()
    {
        var token = _txtPaste.Text.Trim();
        if (string.IsNullOrEmpty(token))
        {
            MessageBox.Show(this,
                L.T("请先粘贴对方发来的分享串。", "Paste the share token first."),
                L.T("文件分享", "File Share"), MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        _btnConnect.Enabled = false;
        _btnDownload.Enabled = false;
        _lblRecvStatus.Text = L.T("正在连接并下载…", "Connecting and downloading…");
        _progress.Value = 0;
        _recvList.Items.Clear();
        _connectedBaseUrl = null;
        _connectedCode = null;
        _remoteFiles = new List<RemoteShareFile>();

        ReplaceRecvCts();
        var ct = _recvCts!.Token;

        try
        {
            var (baseUrl, code, files) = await FileShareService.ConnectAndListAsync(token, ct)
                .ConfigureAwait(true);
            _connectedBaseUrl = baseUrl;
            _connectedCode = code;
            _remoteFiles = files;

            _recvList.BeginUpdate();
            try
            {
                _recvList.Items.Clear();
                foreach (var f in files)
                {
                    var row = new ListViewItem(f.Name) { Tag = f };
                    row.SubItems.Add(FormatSize(f.Size));
                    _recvList.Items.Add(row);
                    row.Selected = true;
                }
            }
            finally { _recvList.EndUpdate(); }

            if (files.Count == 0)
            {
                _lblRecvStatus.Text = L.T("已连接，但对方没有可下载文件。", "Connected, but no files.");
                return;
            }

            Directory.CreateDirectory(_saveDir);
            for (var i = 0; i < files.Count; i++)
            {
                ct.ThrowIfCancellationRequested();
                var file = files[i];
                var dest = UniquePath(Path.Combine(_saveDir, file.Name));
                _lblRecvStatus.Text = L.T(
                    $"正在下载 ({i + 1}/{files.Count})：{file.Name}",
                    $"Downloading ({i + 1}/{files.Count}): {file.Name}");
                _progress.Value = 0;
                var progress = new Progress<double>(p =>
                {
                    if (IsDisposed) return;
                    _progress.Value = (int)Math.Clamp(p * 100, 0, 100);
                });
                await FileShareService.DownloadFileAsync(baseUrl, code, file, dest, progress, ct)
                    .ConfigureAwait(true);
            }

            _progress.Value = 100;
            _btnDownload.Enabled = true;
            _lblRecvStatus.Text = L.T(
                $"下载完成，已保存到 {_saveDir}",
                $"Done. Saved to {_saveDir}");
            MessageBox.Show(this,
                L.T($"已下载 {files.Count} 个文件到：\n{_saveDir}",
                    $"Downloaded {files.Count} file(s) to:\n{_saveDir}"),
                L.T("完成", "Done"), MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            _lblRecvStatus.Text = L.T("已取消。", "Cancelled.");
        }
        catch (Exception ex)
        {
            _lblRecvStatus.Text = L.T("失败（见弹窗说明）。", "Failed (see dialog).");
            MessageBox.Show(this, ex.Message, L.T("无法下载", "Cannot download"),
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        finally
        {
            _btnConnect.Enabled = true;
            _btnDownload.Enabled = _remoteFiles.Count > 0;
        }
    }

    private async Task DownloadSelectedAsync()
    {
        if (string.IsNullOrEmpty(_connectedBaseUrl) || string.IsNullOrEmpty(_connectedCode))
        {
            MessageBox.Show(this,
                L.T("请先点「一键下载全部」，或先粘贴分享串。", "Use Download all first."),
                L.T("文件分享", "File Share"), MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        var selected = _recvList.SelectedItems.Cast<ListViewItem>()
            .Select(i => i.Tag as RemoteShareFile)
            .Where(f => f is not null)
            .Cast<RemoteShareFile>()
            .ToList();
        if (selected.Count == 0)
            selected = _remoteFiles.ToList();
        if (selected.Count == 0) return;

        Directory.CreateDirectory(_saveDir);
        _btnDownload.Enabled = false;
        _btnConnect.Enabled = false;
        ReplaceRecvCts();
        var ct = _recvCts!.Token;

        try
        {
            for (var i = 0; i < selected.Count; i++)
            {
                ct.ThrowIfCancellationRequested();
                var file = selected[i];
                var dest = UniquePath(Path.Combine(_saveDir, file.Name));
                _lblRecvStatus.Text = L.T(
                    $"正在下载 ({i + 1}/{selected.Count})：{file.Name}",
                    $"Downloading ({i + 1}/{selected.Count}): {file.Name}");
                _progress.Value = 0;

                var progress = new Progress<double>(p =>
                {
                    if (IsDisposed) return;
                    _progress.Value = (int)Math.Clamp(p * 100, 0, 100);
                });

                await FileShareService.DownloadFileAsync(
                    _connectedBaseUrl, _connectedCode, file, dest, progress, ct)
                    .ConfigureAwait(true);
            }

            _progress.Value = 100;
            _lblRecvStatus.Text = L.T(
                $"下载完成，已保存到 {_saveDir}",
                $"Done. Saved to {_saveDir}");
            MessageBox.Show(this,
                L.T($"已下载 {selected.Count} 个文件到：\n{_saveDir}",
                    $"Downloaded {selected.Count} file(s) to:\n{_saveDir}"),
                L.T("完成", "Done"), MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            _lblRecvStatus.Text = L.T("下载已取消。", "Download cancelled.");
        }
        catch (Exception ex)
        {
            _lblRecvStatus.Text = L.T("下载失败（见弹窗说明）。", "Download failed (see dialog).");
            MessageBox.Show(this, ex.Message, L.T("下载失败", "Download failed"),
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        finally
        {
            _btnDownload.Enabled = _remoteFiles.Count > 0;
            _btnConnect.Enabled = true;
        }
    }

    private void ReplaceRecvCts()
    {
        try { _recvCts?.Cancel(); } catch { /* ignore */ }
        try { _recvCts?.Dispose(); } catch { /* ignore */ }
        _recvCts = new CancellationTokenSource();
    }

    private static string UniquePath(string path)
    {
        if (!File.Exists(path)) return path;
        var dir = Path.GetDirectoryName(path) ?? "";
        var name = Path.GetFileNameWithoutExtension(path);
        var ext = Path.GetExtension(path);
        for (var i = 1; i < 10_000; i++)
        {
            var p = Path.Combine(dir, $"{name} ({i}){ext}");
            if (!File.Exists(p)) return p;
        }
        return path;
    }

    private static string FormatSize(long bytes)
    {
        if (bytes < 1024) return $"{bytes} B";
        if (bytes < 1024 * 1024) return $"{bytes / 1024.0:0.#} KB";
        if (bytes < 1024L * 1024 * 1024) return $"{bytes / (1024.0 * 1024):0.##} MB";
        return $"{bytes / (1024.0 * 1024 * 1024):0.##} GB";
    }
}
