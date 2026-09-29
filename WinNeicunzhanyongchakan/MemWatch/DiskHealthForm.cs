namespace MemWatch;

/// <summary>硬盘健康检测窗口（参考 CrystalDiskInfo 布局）。</summary>
public sealed class DiskHealthForm : Form
{
    private readonly FlowLayoutPanel _driveBar = new();
    private readonly Label _lblTitle = new();
    private readonly Label _lblStatus = new();
    private readonly Button _btnRefresh = new();
    private readonly Button _btnClose = new();
    private readonly Button _btnSpeedTest = new();
    private readonly Button _btnSpeedCancel = new();
    private readonly Label _lblSpeedResult = new();
    private readonly Panel _healthBadge = new();
    private readonly Label _lblHealth = new();
    private readonly Panel _tempBadge = new();
    private readonly Label _lblTemp = new();
    private readonly ListView _infoLeft = new();
    private readonly ListView _infoRight = new();
    private readonly ListView _smart = new();
    private readonly Label _smartTitle = new();
    private readonly Panel _issueHost = new();
    private readonly Label _lblIssueTitle = new();
    private readonly ListBox _lstIssues = new();
    private readonly Button _btnRepair = new();
    private readonly Button _btnRepairCancel = new();
    private readonly Label _lblRepairProgress = new();

    private readonly LevelConfig _levels;
    private List<DiskDriveInfo> _drives = new();
    private int _selectedIndex = -1;
    private bool _loading;
    private bool _speedTesting;
    private bool _repairing;
    private CancellationTokenSource? _speedCts;
    private CancellationTokenSource? _repairCts;
    private readonly Dictionary<int, DiskSpeedTestResult> _speedResults = new();
    private readonly List<Button> _driveButtons = new();
    private static readonly Color DefaultBack = UiTheme.Back;
    private Button? _btnSkin;
    private Font? _driveChipFont;
    private Font? _smartWarnFont;

    public DiskHealthForm(LevelConfig levels)
    {
        _levels = levels;
        BuildUi();
        _driveChipFont = new Font("Segoe UI", 8.5f);
        _smartWarnFont = new Font(_smart.Font, FontStyle.Bold);
        TopMost = false;
        ApplyLanguage();
        L.Changed += OnLanguageChanged;
        FormClosed += (_, _) =>
        {
            L.Changed -= OnLanguageChanged;
            _driveChipFont?.Dispose();
            _smartWarnFont?.Dispose();
            _driveChipFont = null;
            _smartWarnFont = null;
        };
        WindowSkin.Apply(this, _levels, WindowSkin.KeyDiskHealth, DefaultBack);
        Shown += async (_, _) => await LoadAsync();
        FormClosing += (_, _) =>
        {
            if (_speedTesting)
                _speedCts?.Cancel();
            if (_repairing)
                _repairCts?.Cancel();
        };
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
        if (_drives.Count > 0 && !_loading && !_repairing && !_speedTesting)
            _ = LoadAsync();
        else if (_selectedIndex >= 0 && !_loading)
        {
            var idx = _drives.FindIndex(d => d.Index == _selectedIndex);
            if (idx >= 0)
                SelectDrive(idx);
            else
                ShowSpeedResultForCurrentDrive();
        }
        else
            ShowSpeedResultForCurrentDrive();
    }

    private void ApplyLanguage()
    {
        Text = L.T("硬盘健康检测", "Disk Health");
        _btnRefresh.Text = L.T("刷新", "Refresh");
        _btnClose.Text = L.T("关闭", "Close");
        if (_btnSkin is not null)
            _btnSkin.Text = L.T("皮肤", "Skin");

        _smartTitle.Text = L.T("健康属性（S.M.A.R.T. / NVMe）", "Health attributes (S.M.A.R.T. / NVMe)");
        if (_smart.Columns.Count >= 6)
        {
            _smart.Columns[0].Text = "ID";
            _smart.Columns[1].Text = L.T("属性名", "Attribute");
            _smart.Columns[2].Text = L.T("当前值", "Current");
            _smart.Columns[3].Text = L.T("最差值", "Worst");
            _smart.Columns[4].Text = L.T("阈值", "Threshold");
            _smart.Columns[5].Text = L.T("原始值", "Raw");
        }

        _btnRepair.Text = L.T("修复硬盘", "Repair disk");
        _btnRepairCancel.Text = L.T("停止修复", "Stop repair");
        _btnSpeedTest.Text = L.T("测试读写速度", "Speed test");
        _btnSpeedCancel.Text = L.T("停止测试", "Stop test");

        if (_selectedIndex < 0 && !_loading && _drives.Count == 0)
        {
            _lblTitle.Text = L.T("未选择磁盘", "No disk selected");
            if (!_repairing && !_speedTesting)
                _lblStatus.Text = L.T("正在检测硬盘…", "Checking disks…");
            _lblSpeedResult.Text = L.T(
                "读写速度：尚未测试（将在当前磁盘的盘符上写入约 256 MB 临时文件）",
                "Speed: not tested (writes ~256 MB temp file on this disk)");
        }
    }

    private void BuildUi()
    {
        Text = L.T("硬盘健康检测", "Disk Health");
        FormBorderStyle = FormBorderStyle.Sizable;
        MaximizeBox = true;
        MinimizeBox = true;
        ShowInTaskbar = true;
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Segoe UI", 9f);
        BackColor = DefaultBack;
        ForeColor = Color.FromArgb(30, 30, 30);
        DoubleBuffered = true;
        MinimumSize = new Size(780, 560);
        ClientSize = new Size(900, 640);

        const int pad = 10;

        var top = new Panel
        {
            Dock = DockStyle.Top,
            Height = 40,
            BackColor = DefaultBack,
            Padding = new Padding(pad, 6, pad, 6)
        };

        _lblStatus.AutoSize = false;
        _lblStatus.Dock = DockStyle.Fill;
        _lblStatus.TextAlign = ContentAlignment.MiddleLeft;
        _lblStatus.ForeColor = Color.DimGray;
        _lblStatus.Text = L.T("正在检测硬盘…", "Checking disks…");

        _btnRefresh.Text = L.T("刷新", "Refresh");
        _btnRefresh.Size = new Size(70, 28);
        _btnRefresh.Dock = DockStyle.Right;
        _btnRefresh.Click += async (_, _) => await LoadAsync();

        _btnSkin = WindowSkin.CreateButton(this, _levels, WindowSkin.KeyDiskHealth, DefaultBack);
        _btnSkin.Size = new Size(56, 28);
        _btnSkin.Dock = DockStyle.Right;
        _btnSkin.Margin = new Padding(0, 0, 6, 0);

        top.Controls.Add(_lblStatus);
        top.Controls.Add(_btnSkin);
        top.Controls.Add(_btnRefresh);

        _driveBar.Dock = DockStyle.Top;
        _driveBar.Height = 78;
        _driveBar.AutoScroll = true;
        _driveBar.WrapContents = false;
        _driveBar.FlowDirection = FlowDirection.LeftToRight;
        _driveBar.Padding = new Padding(8, 8, 8, 4);
        _driveBar.BackColor = DefaultBack;

        var detailHost = new Panel
        {
            Dock = DockStyle.Top,
            Height = 210,
            Padding = new Padding(pad, 8, pad, 8),
            BackColor = DefaultBack
        };

        _lblTitle.AutoSize = false;
        _lblTitle.Location = new Point(pad, 4);
        _lblTitle.Size = new Size(560, 28);
        _lblTitle.Font = new Font("Segoe UI Semibold", 14f, FontStyle.Bold);
        _lblTitle.ForeColor = Color.FromArgb(25, 55, 95);
        _lblTitle.Text = L.T("未选择磁盘", "No disk selected");
        _lblTitle.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;

        _healthBadge.Size = new Size(130, 56);
        _healthBadge.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        _healthBadge.BackColor = Color.FromArgb(50, 90, 160);
        _lblHealth.Dock = DockStyle.Fill;
        _lblHealth.TextAlign = ContentAlignment.MiddleCenter;
        _lblHealth.Font = new Font("Segoe UI Semibold", 11f, FontStyle.Bold);
        _lblHealth.ForeColor = Color.White;
        _lblHealth.Text = "—";
        _healthBadge.Controls.Add(_lblHealth);

        _tempBadge.Size = new Size(100, 56);
        _tempBadge.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        _tempBadge.BackColor = Color.FromArgb(40, 120, 90);
        _lblTemp.Dock = DockStyle.Fill;
        _lblTemp.TextAlign = ContentAlignment.MiddleCenter;
        _lblTemp.Font = new Font("Segoe UI Semibold", 12f, FontStyle.Bold);
        _lblTemp.ForeColor = Color.White;
        _lblTemp.Text = "-- °C";
        _tempBadge.Controls.Add(_lblTemp);

        ConfigureInfoList(_infoLeft);
        ConfigureInfoList(_infoRight);
        _infoLeft.Location = new Point(pad, 40);
        _infoRight.Location = new Point(pad + 360, 40);
        _infoLeft.Size = new Size(340, 160);
        _infoRight.Size = new Size(300, 160);
        _infoLeft.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Bottom;
        _infoRight.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;

        detailHost.Controls.Add(_lblTitle);
        detailHost.Controls.Add(_healthBadge);
        detailHost.Controls.Add(_tempBadge);
        detailHost.Controls.Add(_infoLeft);
        detailHost.Controls.Add(_infoRight);
        detailHost.Resize += (_, _) => LayoutDetail(detailHost, pad);

        var smartHost = new Panel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(pad, 0, pad, 0),
            BackColor = DefaultBack
        };

        _smartTitle.Text = L.T("健康属性（S.M.A.R.T. / NVMe）", "Health attributes (S.M.A.R.T. / NVMe)");
        _smartTitle.Dock = DockStyle.Top;
        _smartTitle.Height = 24;
        _smartTitle.ForeColor = Color.FromArgb(30, 90, 160);
        _smartTitle.Font = new Font("Segoe UI Semibold", 9.5f, FontStyle.Bold);

        _smart.Dock = DockStyle.Fill;
        _smart.View = View.Details;
        _smart.FullRowSelect = true;
        _smart.GridLines = true;
        _smart.HeaderStyle = ColumnHeaderStyle.Nonclickable;
        _smart.HideSelection = false;
        _smart.BorderStyle = BorderStyle.FixedSingle;
        _smart.BackColor = Color.White;
        _smart.ForeColor = Color.FromArgb(30, 30, 30);
        _smart.Columns.Add("ID", 50);
        _smart.Columns.Add(L.T("属性名", "Attribute"), 220);
        _smart.Columns.Add(L.T("当前值", "Current"), 70);
        _smart.Columns.Add(L.T("最差值", "Worst"), 70);
        _smart.Columns.Add(L.T("阈值", "Threshold"), 70);
        _smart.Columns.Add(L.T("原始值", "Raw"), 220);

        smartHost.Controls.Add(_smart);
        smartHost.Controls.Add(_smartTitle);

        // 仅在有问题时显示：故障点 + 修复按钮（正常时不提示「硬盘正常」）
        _issueHost.Dock = DockStyle.Bottom;
        _issueHost.Height = 0;
        _issueHost.Visible = false;
        _issueHost.BackColor = Color.FromArgb(255, 244, 230);
        _issueHost.Padding = new Padding(pad, 6, pad, 6);

        _lblIssueTitle.AutoSize = false;
        _lblIssueTitle.Location = new Point(pad, 4);
        _lblIssueTitle.Size = new Size(520, 22);
        _lblIssueTitle.Font = new Font("Segoe UI Semibold", 9.5f, FontStyle.Bold);
        _lblIssueTitle.ForeColor = Color.FromArgb(160, 80, 20);
        _lblIssueTitle.Text = L.T("检测到以下问题", "Issues detected");
        _lblIssueTitle.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;

        _lstIssues.Location = new Point(pad, 28);
        _lstIssues.Size = new Size(620, 72);
        _lstIssues.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
        _lstIssues.BorderStyle = BorderStyle.FixedSingle;
        _lstIssues.BackColor = Color.White;
        _lstIssues.ForeColor = Color.FromArgb(50, 40, 20);
        _lstIssues.IntegralHeight = false;
        _lstIssues.HorizontalScrollbar = true;

        _btnRepair.Text = L.T("修复硬盘", "Repair disk");
        _btnRepair.Size = new Size(100, 30);
        _btnRepair.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        UiTheme.FlattenButton(_btnRepair, UiTheme.Warn);
        _btnRepair.Cursor = Cursors.Hand;
        _btnRepair.Click += async (_, _) => await RunRepairAsync();

        _btnRepairCancel.Text = L.T("停止修复", "Stop repair");
        _btnRepairCancel.Size = new Size(80, 30);
        _btnRepairCancel.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        _btnRepairCancel.Visible = false;
        _btnRepairCancel.Click += (_, _) => _repairCts?.Cancel();

        _lblRepairProgress.AutoSize = false;
        _lblRepairProgress.Size = new Size(200, 40);
        _lblRepairProgress.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        _lblRepairProgress.ForeColor = Color.FromArgb(120, 60, 20);
        _lblRepairProgress.TextAlign = ContentAlignment.TopRight;
        _lblRepairProgress.Text = "";

        _issueHost.Controls.Add(_lblIssueTitle);
        _issueHost.Controls.Add(_lstIssues);
        _issueHost.Controls.Add(_btnRepair);
        _issueHost.Controls.Add(_btnRepairCancel);
        _issueHost.Controls.Add(_lblRepairProgress);
        _issueHost.Resize += (_, _) => LayoutIssueHost(pad);

        var bottom = new Panel
        {
            Dock = DockStyle.Bottom,
            Height = 72,
            BackColor = DefaultBack,
            Padding = new Padding(pad)
        };

        _btnSpeedTest.Text = L.T("测试读写速度", "Speed test");
        _btnSpeedTest.Size = new Size(120, 30);
        _btnSpeedTest.Location = new Point(pad, 9);
        _btnSpeedTest.Click += async (_, _) => await RunSpeedTestAsync();

        _btnSpeedCancel.Text = L.T("停止测试", "Stop test");
        _btnSpeedCancel.Size = new Size(80, 30);
        _btnSpeedCancel.Location = new Point(pad + 128, 9);
        _btnSpeedCancel.Visible = false;
        _btnSpeedCancel.Click += (_, _) => _speedCts?.Cancel();

        _lblSpeedResult.AutoSize = false;
        _lblSpeedResult.Location = new Point(pad, 42);
        _lblSpeedResult.Size = new Size(600, 22);
        _lblSpeedResult.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        _lblSpeedResult.ForeColor = UiTheme.Info;
        _lblSpeedResult.Font = new Font("Segoe UI Semibold", 9f, FontStyle.Bold);
        _lblSpeedResult.Text = L.T(
            "读写速度：尚未测试（将在当前磁盘的盘符上写入约 256 MB 临时文件）",
            "Speed: not tested (writes ~256 MB temp file on this disk)");

        _btnClose.Text = L.T("关闭", "Close");
        _btnClose.Size = new Size(80, 30);
        _btnClose.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        _btnClose.Click += (_, _) => Close();

        bottom.Controls.Add(_btnSpeedTest);
        bottom.Controls.Add(_btnSpeedCancel);
        bottom.Controls.Add(_lblSpeedResult);
        bottom.Controls.Add(_btnClose);
        bottom.Resize += (_, _) =>
        {
            _btnClose.Location = new Point(bottom.ClientSize.Width - _btnClose.Width - pad, 9);
            _lblSpeedResult.Width = Math.Max(200, _btnClose.Left - pad - 8);
        };

        Controls.Add(smartHost);
        Controls.Add(detailHost);
        Controls.Add(_driveBar);
        Controls.Add(_issueHost);
        Controls.Add(bottom);
        Controls.Add(top);
        LayoutIssueHost(pad);

        LayoutDetail(detailHost, pad);
        _btnClose.Location = new Point(bottom.ClientSize.Width - _btnClose.Width - pad, 9);
        _lblSpeedResult.Width = Math.Max(200, _btnClose.Left - pad - 8);
        UiTheme.StyleTree(this);
        EchoChrome.Attach(this, canResize: true, showMin: true);
    }

    private void LayoutDetail(Panel host, int pad)
    {
        _tempBadge.Location = new Point(host.ClientSize.Width - pad - _tempBadge.Width, 4);
        _healthBadge.Location = new Point(_tempBadge.Left - 10 - _healthBadge.Width, 4);
        _lblTitle.Width = Math.Max(120, _healthBadge.Left - pad - 8);

        var gap = 12;
        var totalW = host.ClientSize.Width - pad * 2;
        var leftW = Math.Max(280, (totalW - gap) / 2);
        var rightW = Math.Max(260, totalW - gap - leftW);
        _infoLeft.Location = new Point(pad, 44);
        _infoLeft.Size = new Size(leftW, host.ClientSize.Height - 52);
        _infoRight.Location = new Point(pad + leftW + gap, 44);
        _infoRight.Size = new Size(rightW, host.ClientSize.Height - 52);
    }

    private void LayoutIssueHost(int pad)
    {
        if (!_issueHost.Visible)
            return;

        _btnRepair.Location = new Point(_issueHost.ClientSize.Width - pad - _btnRepair.Width, 4);
        _btnRepairCancel.Location = new Point(_btnRepair.Left - 8 - _btnRepairCancel.Width, 4);
        _lblRepairProgress.Location = new Point(
            Math.Max(pad, _btnRepairCancel.Visible ? _btnRepairCancel.Left : _btnRepair.Left) - 208,
            36);
        _lblRepairProgress.Width = 200;
        _lblIssueTitle.Width = Math.Max(120, _btnRepair.Left - pad - 12);
        _lstIssues.Width = Math.Max(200, _btnRepair.Left - pad - 12);
        _lstIssues.Height = Math.Max(40, _issueHost.ClientSize.Height - 36);
    }

    private static void ConfigureInfoList(ListView lv)
    {
        lv.View = View.Details;
        lv.FullRowSelect = true;
        lv.HeaderStyle = ColumnHeaderStyle.None;
        lv.BorderStyle = BorderStyle.None;
        lv.BackColor = DefaultBack;
        lv.ForeColor = Color.FromArgb(40, 40, 40);
        lv.Scrollable = false;
        lv.Columns.Add("k", 110);
        lv.Columns.Add("v", 200);
    }

    private async Task LoadAsync()
    {
        if (_loading)
            return;

        _loading = true;
        _btnRefresh.Enabled = false;
        _btnRepair.Enabled = false;
        _lblStatus.Text = L.T("正在检测硬盘（S.M.A.R.T. / NVMe）…", "Checking disks (S.M.A.R.T. / NVMe)…");

        try
        {
            var keepIndex = _selectedIndex;
            var drives = await Task.Run(DiskSmartReader.Collect);
            _drives = drives;
            BuildDriveBar();

            if (_drives.Count == 0)
            {
                _selectedIndex = -1;
                ShowEmpty();
                _lblStatus.Text = L.T("未检测到磁盘", "No disks found");
            }
            else
            {
                var pick = _drives.FindIndex(d => d.Index == keepIndex);
                if (pick < 0)
                    pick = 0;
                SelectDrive(pick);
                var problemDisks = _drives.Count(d => d.HasProblems);
                _lblStatus.Text = problemDisks > 0
                    ? L.T(
                        $"已检测 {_drives.Count} 块磁盘，其中 {problemDisks} 块存在问题 · {DateTime.Now:HH:mm:ss}",
                        $"Checked {_drives.Count} disk(s), {problemDisks} with issues · {DateTime.Now:HH:mm:ss}")
                    : L.T(
                        $"已检测 {_drives.Count} 块磁盘 · {DateTime.Now:HH:mm:ss}",
                        $"Checked {_drives.Count} disk(s) · {DateTime.Now:HH:mm:ss}");
            }
        }
        catch (Exception ex)
        {
            _lblStatus.Text = L.T("检测失败", "Check failed");
            MessageBox.Show(this,
                L.T($"无法检测硬盘：{ex.Message}", $"Could not check disks: {ex.Message}"),
                L.T("错误", "Error"),
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        finally
        {
            _loading = false;
            _btnRefresh.Enabled = !_repairing && !_speedTesting;
            var cur = _drives.FirstOrDefault(d => d.Index == _selectedIndex);
            if (cur is not null)
                UpdateIssuePanel(cur);
        }
    }

    private void BuildDriveBar()
    {
        _driveBar.SuspendLayout();
        _driveBar.Controls.Clear();
        _driveButtons.Clear();

        foreach (var drive in _drives)
        {
            var btn = new Button
            {
                Size = new Size(150, 58),
                Margin = new Padding(4, 0, 4, 0),
                FlatStyle = FlatStyle.Flat,
                TextAlign = ContentAlignment.MiddleLeft,
                Padding = new Padding(8, 4, 8, 4),
                Tag = drive.Index,
                Cursor = Cursors.Hand,
                Font = _driveChipFont ?? Font,
                ForeColor = Color.White
            };
            btn.FlatAppearance.BorderSize = 1;
            ApplyDriveButtonStyle(btn, drive, selected: false);
            btn.Click += (_, _) =>
            {
                var idx = _drives.FindIndex(d => d.Index == drive.Index);
                if (idx >= 0)
                    SelectDrive(idx);
            };
            _driveButtons.Add(btn);
            _driveBar.Controls.Add(btn);
        }

        _driveBar.ResumeLayout();
    }

    private void ApplyDriveButtonStyle(Button btn, DiskDriveInfo drive, bool selected)
    {
        var (bg, border) = HealthColors(drive.Health);
        btn.BackColor = selected ? ControlPaint.Light(bg, 0.15f) : bg;
        btn.FlatAppearance.BorderColor = selected ? Color.FromArgb(30, 90, 160) : border;
        var temp = drive.TemperatureC.HasValue ? $"{drive.TemperatureC.Value:0}°C" : "--°C";
        var health = HealthShort(drive.Health);
        var letters = string.IsNullOrWhiteSpace(drive.DriveLetters) || drive.DriveLetters == "-"
            ? L.T($"磁盘 {drive.Index}", $"Disk {drive.Index}")
            : drive.DriveLetters;
        btn.Text = $"{health}  {temp}\n{letters}";
    }

    private void SelectDrive(int listIndex)
    {
        if (listIndex < 0 || listIndex >= _drives.Count)
            return;

        _selectedIndex = _drives[listIndex].Index;
        var drive = _drives[listIndex];

        for (var i = 0; i < _driveButtons.Count; i++)
            ApplyDriveButtonStyle(_driveButtons[i], _drives[i], selected: i == listIndex);

        _lblTitle.Text = $"{drive.Model}  ·  {drive.CapacityText}";

        var (hBg, _) = HealthColors(drive.Health);
        _healthBadge.BackColor = hBg;
        var detail = string.IsNullOrWhiteSpace(drive.HealthDetail)
            ? HealthShort(drive.Health)
            : drive.HealthDetail;
        _lblHealth.Text = L.IsChinese
            ? detail.Replace("（", "\n（")
            : detail.Replace(" (", "\n(");

        if (drive.TemperatureC is float t)
        {
            _lblTemp.Text = $"{t:0} °C";
            _tempBadge.BackColor = t >= 60 ? Color.FromArgb(180, 70, 50)
                : t >= 50 ? Color.FromArgb(180, 120, 40)
                : Color.FromArgb(40, 120, 90);
        }
        else
        {
            _lblTemp.Text = "-- °C";
            _tempBadge.BackColor = Color.FromArgb(120, 130, 140);
        }

        FillInfo(_infoLeft, new[]
        {
            (L.T("固件", "Firmware"), drive.Firmware),
            (L.T("序列号", "Serial"), drive.Serial),
            (L.T("接口", "Interface"), drive.Interface),
            (L.T("传输模式", "Transfer"), drive.TransferMode),
            (L.T("盘符", "Letters"), drive.DriveLetters),
            (L.T("标准", "Standard"), drive.Standard),
            (L.T("特性", "Features"), drive.Features),
            (L.T("介质", "Media"), drive.MediaType),
        });

        FillInfo(_infoRight, new[]
        {
            (L.T("主机写入总量", "Host writes"), drive.HostWrites),
            (L.T("主机读取总量", "Host reads"), drive.HostReads),
            (L.T("转速", "Rotation"), drive.RotationRate),
            (L.T("通电次数", "Power cycles"), drive.PowerOnCount),
            (L.T("通电时间", "Power-on"), drive.PowerOnHours),
            (L.T("已用空间", "Used space"), drive.UsedSpace),
            (L.T("容量", "Capacity"), drive.CapacityText),
            (L.T("磁盘号", "Disk #"), $"PHYSICALDRIVE{drive.Index}"),
        });

        _smart.BeginUpdate();
        _smart.Items.Clear();
        foreach (var a in drive.Attributes)
        {
            var item = new ListViewItem(a.Id);
            item.SubItems.Add(a.Name);
            item.SubItems.Add(a.Current);
            item.SubItems.Add(a.Worst);
            item.SubItems.Add(a.Threshold);
            item.SubItems.Add(a.Raw);
            if (a.IsWarning)
            {
                item.ForeColor = Color.FromArgb(180, 90, 20);
                if (_smartWarnFont is not null)
                    item.Font = _smartWarnFont;
            }

            _smart.Items.Add(item);
        }

        _smart.EndUpdate();

        if (_smart.Columns.Count >= 6 && _smart.ClientSize.Width > 0)
        {
            var used = 50 + 70 + 70 + 70;
            _smart.Columns[1].Width = Math.Max(160, (_smart.ClientSize.Width - used) / 2);
            _smart.Columns[5].Width = Math.Max(160, _smart.ClientSize.Width - used - _smart.Columns[1].Width - 30);
        }

        if (!_speedTesting)
            ShowSpeedResultForCurrentDrive();

        UpdateIssuePanel(drive);
    }

    private void UpdateIssuePanel(DiskDriveInfo? drive)
    {
        _lstIssues.Items.Clear();
        _lblRepairProgress.Text = "";

        if (drive is null || !drive.HasProblems)
        {
            // 无问题：不展示「硬盘正常」，直接隐藏问题区
            _issueHost.Visible = false;
            _issueHost.Height = 0;
            return;
        }

        _lblIssueTitle.Text = drive.Health == DiskHealthLevel.Bad
            ? L.T($"检测到 {drive.Problems.Count} 处问题（不良）",
                $"{drive.Problems.Count} issue(s) detected (Bad)")
            : L.T($"检测到 {drive.Problems.Count} 处问题（注意）",
                $"{drive.Problems.Count} issue(s) detected (Caution)");

        foreach (var p in drive.Problems)
            _lstIssues.Items.Add(p);

        _issueHost.Height = 118;
        _issueHost.Visible = true;
        _issueHost.BackColor = drive.Health == DiskHealthLevel.Bad
            ? Color.FromArgb(255, 236, 232)
            : Color.FromArgb(255, 244, 230);
        _lblIssueTitle.ForeColor = drive.Health == DiskHealthLevel.Bad
            ? Color.FromArgb(150, 40, 30)
            : Color.FromArgb(160, 80, 20);

        _btnRepair.Enabled = !_repairing && !_speedTesting && !_loading;
        LayoutIssueHost(10);
    }

    private async Task RunRepairAsync()
    {
        if (_repairing || _loading || _speedTesting)
            return;

        var drive = _drives.FirstOrDefault(d => d.Index == _selectedIndex);
        if (drive is null)
        {
            MessageBox.Show(this,
                L.T("请先选择一块磁盘。", "Select a disk first."),
                L.T("修复硬盘", "Repair disk"),
                MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        if (!drive.HasProblems)
            return;

        var letters = DiskRepairer.ParseDriveLetters(drive.DriveLetters);
        if (letters.Count == 0)
        {
            MessageBox.Show(this,
                L.T(
                    "该磁盘没有可访问的盘符，无法执行文件系统修复。\n\n" +
                    "若问题来自硬件老化（如重映射扇区、损耗过高），软件无法恢复硬件寿命，建议备份数据并更换硬盘。",
                    "No accessible drive letter; cannot repair the file system.\n\n" +
                    "Hardware wear (reallocated sectors, high wear) cannot be restored by software. Back up and replace the disk."),
                L.T("修复硬盘", "Repair disk"),
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }

        var deep = drive.Health == DiskHealthLevel.Bad ||
                   drive.Problems.Any(DiskRepairer.IsSectorRelatedProblem);

        var sep = L.IsChinese ? "、" : ", ";
        var confirm = MessageBox.Show(this,
            L.T(
                $"将对盘符 {string.Join(sep, letters)} 执行 Windows 磁盘检查修复（chkdsk）。\n\n" +
                $"模式：{(deep ? "深度扫描（修复错误并检查坏扇区，可能较久）" : "标准修复（文件系统错误）")}\n\n" +
                "说明：\n" +
                "· 可修复文件系统错误，并尽量隔离坏扇区\n" +
                "· 无法恢复已老化的闪存/机械盘硬件寿命\n" +
                "· 系统盘可能需要重启后才能完成\n\n" +
                "修复期间请勿强制断电。是否开始？",
                $"Windows disk check (chkdsk) will run on {string.Join(sep, letters)}.\n\n" +
                $"Mode: {(deep ? "Deep scan (fix errors and check bad sectors; may take long)" : "Standard (file system errors)")}\n\n" +
                "Notes:\n" +
                "· Fixes file system errors and tries to isolate bad sectors\n" +
                "· Cannot restore worn flash/HDD hardware life\n" +
                "· System volume may need a reboot to finish\n\n" +
                "Do not force power off during repair. Continue?"),
            L.T("修复硬盘", "Repair disk"),
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning);
        if (confirm != DialogResult.Yes)
            return;

        _repairing = true;
        _repairCts?.Dispose();
        _repairCts = new CancellationTokenSource();
        _btnRepair.Enabled = false;
        _btnRepairCancel.Visible = true;
        _btnRefresh.Enabled = false;
        _btnSpeedTest.Enabled = false;
        _lblRepairProgress.Text = L.T("准备修复…", "Preparing repair…");
        _lblStatus.Text = L.T("正在修复硬盘…", "Repairing disk…");
        LayoutIssueHost(10);

        var progress = new Progress<string>(msg =>
        {
            if (IsDisposed)
                return;
            _lblStatus.Text = msg;
            _lblRepairProgress.Text = msg;
        });

        try
        {
            var result = await DiskRepairer.RepairAsync(drive, progress, _repairCts.Token);
            _lblRepairProgress.Text = result.Success
                ? L.T("修复完成", "Repair complete")
                : L.T("修复未完全成功", "Repair incomplete");
            _lblStatus.Text = result.Summary;

            var icon = result.NeedsReboot
                ? MessageBoxIcon.Information
                : result.Success ? MessageBoxIcon.Information : MessageBoxIcon.Warning;

            MessageBox.Show(this, result.Summary, L.T("修复硬盘", "Repair disk"), MessageBoxButtons.OK, icon);

            // 修复后重新检测，刷新问题列表
            await LoadAsync();
        }
        catch (OperationCanceledException)
        {
            _lblRepairProgress.Text = L.T("已取消", "Cancelled");
            _lblStatus.Text = L.T("修复已取消", "Repair cancelled");
        }
        catch (Exception ex)
        {
            _lblRepairProgress.Text = L.T("修复失败", "Repair failed");
            _lblStatus.Text = L.T("修复失败", "Repair failed");
            MessageBox.Show(this,
                L.T($"修复硬盘失败：{ex.Message}", $"Disk repair failed: {ex.Message}"),
                L.T("错误", "Error"),
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        finally
        {
            _repairing = false;
            _btnRepairCancel.Visible = false;
            _btnRefresh.Enabled = true;
            _btnSpeedTest.Enabled = true;
            _btnRepair.Enabled = true;
            _repairCts?.Dispose();
            _repairCts = null;
            LayoutIssueHost(10);
        }
    }

    private void ShowSpeedResultForCurrentDrive()
    {
        if (_selectedIndex >= 0 && _speedResults.TryGetValue(_selectedIndex, out var r))
        {
            _lblSpeedResult.Text = L.T(
                $"读写速度：写入 {r.WriteMBps:0.0} MB/s · 读取 {r.ReadMBps:0.0} MB/s" +
                $"（{r.TestSizeMb} MB · {r.TargetRoot.TrimEnd('\\')} · 耗时 {r.Elapsed.TotalSeconds:0.0}s）",
                $"Speed: write {r.WriteMBps:0.0} MB/s · read {r.ReadMBps:0.0} MB/s" +
                $" ({r.TestSizeMb} MB · {r.TargetRoot.TrimEnd('\\')} · {r.Elapsed.TotalSeconds:0.0}s)");
            return;
        }

        var drive = _drives.FirstOrDefault(d => d.Index == _selectedIndex);
        var root = DiskSpeedTester.PickTestRoot(drive?.DriveLetters);
        _lblSpeedResult.Text = root is null
            ? L.T("读写速度：尚未测试（当前磁盘无可用盘符，无法测速）",
                "Speed: not tested (no drive letter for this disk)")
            : L.T(
                $"读写速度：尚未测试（将在 {root.TrimEnd('\\')} 写入约 {DiskSpeedTester.DefaultTestSizeMb} MB 临时文件）",
                $"Speed: not tested (will write ~{DiskSpeedTester.DefaultTestSizeMb} MB on {root.TrimEnd('\\')})");
    }

    private async Task RunSpeedTestAsync()
    {
        if (_speedTesting || _loading || _repairing)
            return;

        var drive = _drives.FirstOrDefault(d => d.Index == _selectedIndex);
        if (drive is null)
        {
            MessageBox.Show(this,
                L.T("请先选择一块磁盘。", "Select a disk first."),
                L.T("测速", "Speed test"),
                MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        var root = DiskSpeedTester.PickTestRoot(drive.DriveLetters);
        if (root is null)
        {
            MessageBox.Show(this,
                L.T("该磁盘没有可写入的盘符（可能未分配卷），无法进行读写测速。",
                    "No writable drive letter (volume may be unassigned); cannot run speed test."),
                L.T("测速", "Speed test"),
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }

        var confirm = MessageBox.Show(this,
            L.T(
                $"将在 {root} 写入约 {DiskSpeedTester.DefaultTestSizeMb} MB 临时文件进行顺序读写测试，完成后自动删除。\n\n" +
                "测试期间请尽量不要进行其他大文件读写。是否开始？",
                $"Will write ~{DiskSpeedTester.DefaultTestSizeMb} MB temp file on {root} for sequential R/W test, then delete it.\n\n" +
                "Avoid other heavy disk I/O during the test. Continue?"),
            L.T("读写速度测试", "Disk speed test"),
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Question);
        if (confirm != DialogResult.Yes)
            return;

        _speedTesting = true;
        _speedCts?.Dispose();
        _speedCts = new CancellationTokenSource();
        _btnSpeedTest.Enabled = false;
        _btnSpeedCancel.Visible = true;
        _btnRefresh.Enabled = false;
        _lblSpeedResult.Text = L.T("读写速度：测试准备中…", "Speed: preparing…");

        var progress = new Progress<string>(msg =>
        {
            if (IsDisposed)
                return;
            _lblStatus.Text = msg;
            _lblSpeedResult.Text = L.T($"读写速度：{msg}", $"Speed: {msg}");
        });

        try
        {
            var result = await DiskSpeedTester.RunAsync(
                root,
                DiskSpeedTester.DefaultTestSizeMb,
                progress,
                _speedCts.Token);

            _speedResults[drive.Index] = result;
            ShowSpeedResultForCurrentDrive();
            _lblStatus.Text = L.T(
                $"测速完成 · 写入 {result.WriteMBps:0.0} MB/s · 读取 {result.ReadMBps:0.0} MB/s",
                $"Speed done · write {result.WriteMBps:0.0} MB/s · read {result.ReadMBps:0.0} MB/s");
        }
        catch (OperationCanceledException)
        {
            _lblSpeedResult.Text = L.T("读写速度：测试已取消", "Speed: cancelled");
            _lblStatus.Text = L.T("测速已取消", "Speed test cancelled");
            ShowSpeedResultForCurrentDrive();
        }
        catch (Exception ex)
        {
            _lblSpeedResult.Text = L.T($"读写速度：测试失败 — {ex.Message}", $"Speed: failed — {ex.Message}");
            _lblStatus.Text = L.T("测速失败", "Speed test failed");
            MessageBox.Show(this,
                L.T($"读写测速失败：{ex.Message}", $"Speed test failed: {ex.Message}"),
                L.T("错误", "Error"),
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        finally
        {
            _speedTesting = false;
            _btnSpeedTest.Enabled = true;
            _btnSpeedCancel.Visible = false;
            _btnRefresh.Enabled = true;
            _speedCts?.Dispose();
            _speedCts = null;
        }
    }

    private void ShowEmpty()
    {
        _lblTitle.Text = L.T("未检测到磁盘", "No disks found");
        _lblHealth.Text = "—";
        _lblTemp.Text = "-- °C";
        _infoLeft.Items.Clear();
        _infoRight.Items.Clear();
        _smart.Items.Clear();
        _driveBar.Controls.Clear();
        _driveButtons.Clear();
        _lblSpeedResult.Text = L.T("读写速度：尚未测试", "Speed: not tested");
        UpdateIssuePanel(null);
    }

    private static void FillInfo(ListView lv, (string k, string v)[] rows)
    {
        lv.BeginUpdate();
        lv.Items.Clear();
        foreach (var (k, v) in rows)
        {
            var item = new ListViewItem(k);
            item.SubItems.Add(string.IsNullOrWhiteSpace(v) ? "-" : v);
            item.ForeColor = Color.DimGray;
            item.SubItems[1].ForeColor = Color.FromArgb(30, 30, 30);
            lv.Items.Add(item);
        }

        lv.EndUpdate();
        if (lv.Columns.Count >= 2 && lv.ClientSize.Width > 0)
        {
            lv.Columns[0].Width = 110;
            lv.Columns[1].Width = Math.Max(80, lv.ClientSize.Width - 120);
        }
    }

    private static (Color bg, Color border) HealthColors(DiskHealthLevel level) => level switch
    {
        DiskHealthLevel.Good => (Color.FromArgb(40, 100, 170), Color.FromArgb(80, 140, 210)),
        DiskHealthLevel.Caution => (Color.FromArgb(170, 130, 30), Color.FromArgb(220, 180, 60)),
        DiskHealthLevel.Bad => (Color.FromArgb(160, 50, 50), Color.FromArgb(220, 90, 90)),
        _ => (Color.FromArgb(70, 80, 95), Color.FromArgb(100, 110, 125))
    };

    private static string HealthShort(DiskHealthLevel level) => level switch
    {
        DiskHealthLevel.Good => L.T("良好", "Good"),
        DiskHealthLevel.Caution => L.T("注意", "Caution"),
        DiskHealthLevel.Bad => L.T("不良", "Bad"),
        _ => L.T("未知", "Unknown")
    };
}
