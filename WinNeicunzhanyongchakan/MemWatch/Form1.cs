using System.Diagnostics;
using System.Runtime.InteropServices;

namespace MemWatch;

public sealed class Form1 : Form
{
    private const int UiPad = 12;
    private const int RefreshMs = 2000;

    private Size _fullClientSize = new(352, 500);
    private static readonly Size MiniSize = new(148, 34);
    private static readonly Color DefaultBack = UiTheme.Back;
    private readonly Panel _scrollHost = new();
    private readonly Panel _content = new();
    private bool _suppressResizePersist;
    private bool _relayoutBusy;

    private readonly Label _lblMem = new();
    private readonly ThemedMeter _barMem = new();
    private readonly Label _lblHint = new();
    private readonly ListView _list = new();
    private readonly Label _lblLevelTitle = new();
    private readonly NumericUpDown _numMouse = new();
    private readonly NumericUpDown _numCat = new();
    private readonly NumericUpDown _numDog = new();
    private readonly NumericUpDown _numElephant = new();
        private readonly NumericUpDown _numWhale = new();
    private readonly PictureBox _icoMouse = new();
    private readonly PictureBox _icoCat = new();
    private readonly PictureBox _icoDog = new();
    private readonly PictureBox _icoElephant = new();
    private readonly PictureBox _icoWhaleIco = new();
    private readonly PictureBox _icoStar = new();
    private readonly Label _lblListHead = new();
    private readonly Panel _pnlMore = new();
    private readonly Button _btnKill = new();
    private readonly Button _btnForceKill = new();
    private readonly Button _btnRefresh = new();
    private readonly Button _btnShrink = new();
    private readonly Button _btnLargeFiles = new();
    private readonly Button _btnDiskHealth = new();
    private readonly Button _btnDataRecovery = new();
    private readonly Button _btnDownload = new();
    private readonly Button _btnFileShare = new();
    private readonly Button _btnSysInfo = new();
    private readonly Button _btnSkin = new();
    private readonly Button _btnLang = new();
    private readonly Label _lblShot = new();
    private readonly Button _btnShotKey = new();
    private readonly Label _lblShotCount = new();
    private readonly NumericUpDown _numShotCount = new();
    private readonly Label _lblPinGroup = new();
    private readonly ComboBox _cboPinGroup = new();
    private readonly Button _btnPinRename = new();
    private readonly Button _btnPinClear = new();
    private readonly Button _btnClipboard = new();
    private readonly Label _lblPinHint = new();
    private readonly CheckBox _chkAutoStart = new();
    private readonly Label _lblCpuTempInterval = new();
    private readonly NumericUpDown _numCpuTempInterval = new();
    private readonly CheckBox _chkAhab = new();
    private readonly Label _lblAhabTip = new();
    private readonly Label _lblAhabKills = new();
    private readonly CheckBox _chkHunt = new();
    private readonly Label _lblHuntTip = new();
    private readonly Label _lblHuntThreshold = new();
    private readonly RopeSlider _trackHunt = new();
    private readonly Label _lblMini = new();
    private readonly System.Windows.Forms.Timer _timer = new();
    private readonly ContextMenuStrip _listMenu = new();
    private readonly ToolStripMenuItem _menuKillRoot = new();
    private readonly ToolStripMenuItem _menuKillSelected = new();
    private readonly ToolStripMenuItem _menuKillTree = new();
    private readonly ToolStripMenuItem _menuForceKill = new();
    private readonly NotifyIcon _notifyIcon = new();
    private readonly ContextMenuStrip _trayMenu = new();
    private readonly ToolStripMenuItem _menuTrayRestore = new();
    private readonly ToolStripMenuItem _menuTrayExit = new();
    private readonly HoverTipForm _procTip = new();
    private int _procTipPid = -1;
    private bool _capturingShotKey;
    private bool _suppressShotCountEvent;
    private bool _suppressPinGroupEvent;

    private readonly int _selfPid;
    private readonly LevelConfig _levels;
    private bool _compact;
    /// <summary>托盘「退出」或关闭确认选了关闭后，允许真正退出。</summary>
    private bool _forceClose;
    private bool _suppressAhabEvent;
    private bool _suppressHuntEvent;
    private bool _suppressAutoStartEvent;
    private bool _suppressLevelEvent;
    /// <summary>猎杀确认弹过之后，内存降到阈值以下前不再弹（避免每 2 秒刷屏）。</summary>
    private volatile bool _huntSnoozeUntilBelow;
    private int _ahabKillCount;
    private Point _fullLocation;
    private Point _miniLocation;
    private bool _hasMiniLocation;
    private Point _dragOffset;
    private bool _dragging;
    private double _lastPct;
    private float? _lastCpuTemp;
    private DateTime _lastCpuTempUtc = DateTime.MinValue;
    private int _cpuTempReadBusy; // 0/1，避免并发读温
    private int _killBusy; // 0/1，自动击杀流水线放后台
    private LargeFileScannerForm? _scannerForm;
    private DiskHealthForm? _diskHealthForm;
    private DataRecoveryForm? _dataRecoveryForm;
    private DownloadManagerForm? _downloadForm;
    private FileShareForm? _fileShareForm;
    private SystemInfoForm? _sysInfoForm;
    private ClipboardHistoryForm? _clipboardForm;

    public Form1()
    {
        _selfPid = Environment.ProcessId;
        _levels = LevelConfig.Load();
        L.Init(_levels.UiLanguage);
        _ahabKillCount = _levels.AhabKillCount;
        CpuTempReader.SetCpuTempCacheSeconds(_levels.CpuTempRefreshSec);
        BuildUi();
        ApplyLanguage();
        L.Changed += OnLanguageChanged;
        FormClosed += (_, _) => L.Changed -= OnLanguageChanged;
        SyncLevelInputs();
        ApplySavedLayout();
        _timer.Interval = RefreshMs;
        _timer.Tick += (_, _) => RefreshData();
        Shown += (_, _) =>
        {
            RefreshData();
            _timer.Start();
            if (_levels.StartInCompact)
                SetCompact(true);
            UpdateAhabKillLabel();
            RelayoutForScroll();
            ScreenshotService.Instance.Start(_levels, SynchronizationContext.Current);
            RefreshPinGroupUi();
            PinBoardService.Instance.Changed += OnPinBoardChanged;
        };
        FormClosing += OnMainFormClosing;
        Move += (_, _) =>
        {
            if (!_compact)
                _fullLocation = Location;
        };
        Resize += (_, _) =>
        {
            if (_compact || _suppressResizePersist || WindowState == FormWindowState.Minimized)
                return;
            _fullClientSize = ClientSize;
            _levels.FullHeight = ClientSize.Height;
            // 节流：拖动结束时 Persist 也会写；这里只更新内存字段，避免狂写磁盘
        };
    }

    private void ApplySavedLayout()
    {
        if (_levels.FullX is int fx && _levels.FullY is int fy)
        {
            _fullLocation = ClampToScreen(new Point(fx, fy));
            Location = _fullLocation;
        }

        if (_levels.MiniX is int mx && _levels.MiniY is int my)
        {
            _miniLocation = new Point(mx, my);
            _hasMiniLocation = true;
        }

        TopMost = _compact;

        if (_levels.AhabEnabled)
        {
            _suppressAhabEvent = true;
            _chkAhab.Checked = true;
            _suppressAhabEvent = false;
        }

        _suppressHuntEvent = true;
        _chkHunt.Checked = _levels.HuntEnabled;
        _trackHunt.Value = Math.Clamp(_levels.HuntThresholdPct, _trackHunt.Minimum, _trackHunt.Maximum);
        UpdateHuntThresholdLabel();
        _suppressHuntEvent = false;

        _suppressAutoStartEvent = true;
        _chkAutoStart.Checked = AutoStart.IsEnabled();
        _suppressAutoStartEvent = false;

        UpdateAhabKillLabel();
    }

    private void PersistSettings()
    {
        if (_compact)
        {
            _miniLocation = Location;
            _hasMiniLocation = true;
        }
        else
        {
            _fullLocation = Location;
        }

        _levels.FullX = _fullLocation.X;
        _levels.FullY = _fullLocation.Y;
        if (!_compact)
            _levels.FullHeight = ClientSize.Height;
        if (_hasMiniLocation)
        {
            _levels.MiniX = _miniLocation.X;
            _levels.MiniY = _miniLocation.Y;
        }

        _levels.StartInCompact = _compact;
        _levels.AhabKillCount = _ahabKillCount;
        _levels.AhabEnabled = _chkAhab.Checked;
        _levels.HuntEnabled = _chkHunt.Checked;
        _levels.HuntThresholdPct = _trackHunt.Value;
        _levels.AutoStart = _chkAutoStart.Checked;
        _levels.CpuTempRefreshSec = LevelConfig.ClampCpuTempRefreshSec((int)_numCpuTempInterval.Value);
        _levels.UiLanguage = L.Code;
        _levels.ClipboardHistoryMax = LevelConfig.ClampClipboardHistoryMax(_levels.ClipboardHistoryMax);
        PinBoardService.Instance.SaveToConfig(_levels);
        _levels.Save();
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
        if (!_compact)
            RefreshData();
        else
            UpdateMiniLabel(_lastPct, _lastCpuTemp);
    }

    private void ToggleLanguage()
    {
        L.Toggle();
        _levels.UiLanguage = L.Code;
        _levels.Save();
    }

    private void ApplyLanguage()
    {
        Text = L.T("内存监控", "MemWatch");
        if (_list.Columns.Count >= 2)
        {
            _list.Columns[0].Text = L.T("进程", "Process");
            _list.Columns[1].Text = L.T("内存", "Memory");
        }

        _lblHint.Text = L.T("高占用进程", "High memory processes");
        _lblLevelTitle.Text = L.T("警戒门槛 MB", "Threshold MB");
        _lblListHead.Text = L.T("进程列表", "Process list");
        _btnSkin.Text = L.T("皮肤", "Skin");
        _chkAhab.Text = L.T("聘请亚哈船长", "Hire Captain Ahab");
        _lblAhabTip.Text = L.T("亚哈船长会击杀所有鲸鱼(需管理员权限)", "Ahab kills all Whale apps (admin required)");
        UpdateAhabKillLabel();
        _chkHunt.Text = L.T("猎杀模式", "Hunt mode");
        UpdateHuntThresholdLabel();
        _lblHuntThreshold.Location = new Point(Math.Max(100, _chkHunt.Right + 6), _chkHunt.Top + 2);
        _lblHuntTip.Text = L.T(
            "达阈值先弹窗确认；默认只勾选低活动（低 CPU+低内存），保护开发中的项目",
            "Confirm before hunt; defaults to low-activity only (low CPU+memory), protects active dev work");
        _chkAutoStart.Text = L.T("开机自启", "Start with Windows");
        _btnKill.Text = L.T("结束选中", "End selected");
        _btnForceKill.Text = L.T("强制结束", "Force end");
        _btnRefresh.Text = L.T("刷新", "Refresh");
        _btnShrink.Text = L.T("缩小", "Mini");
        _btnLargeFiles.Text = L.T("大文件扫描器", "Large file scanner");
        _btnDiskHealth.Text = L.T("检测硬盘", "Disk health");
        _btnDataRecovery.Text = L.T("数据恢复", "Data recovery");
        _btnDownload.Text = L.T("多线程下载", "Multi-thread download");
        _btnFileShare.Text = L.T("文件分享", "File share");
        _btnSysInfo.Text = L.T("查看电脑配置详情", "System information");
        _lblCpuTempInterval.Text = L.T("CPU温度刷新(秒)", "CPU temp interval (s)");
        _btnSkin.Text = L.T("皮肤", "Skin");
        // 按钮显示「可切换到的语言」
        _btnLang.Text = L.T("English", "中文");
        _lblShot.Text = L.T("截图（连按触发，键与次数可自定义）", "Screenshot (multi-tap, key & count customizable)");
        _lblShotCount.Text = L.T("连按次数", "Tap count");
        _lblPinGroup.Text = L.T("贴图分组", "Pin group");
        _btnPinRename.Text = L.T("改名", "Rename");
        _btnPinClear.Text = L.T("清空本组", "Clear group");
        _lblPinHint.Text = L.T(
            "Shift+F1~F12 切组 · 截图：移入窗口/拖动框选 · 选区后点涂鸦标注 · F2 涂抹 · F3 图钉",
            "Shift+F1~F12 groups · screenshot: select, then Mark, F2 smear, F3 pin");
        _btnClipboard.Text = L.T("剪切板历史", "Clipboard history");
        UpdateShotKeyButtonText();
        RefreshPinGroupUi();

        _menuKillRoot.Text = L.T("结束进程", "End process");
        _menuKillSelected.Text = L.T("结束选中进程", "End selected process");
        _menuKillTree.Text = L.T("结束进程树（含子进程）", "End process tree");
        _menuForceKill.Text = L.T("强制结束（提权）", "Force end (elevate)");
        _menuTrayRestore.Text = L.T("还原窗口", "Restore");
        _menuTrayExit.Text = L.T("退出", "Exit");
        _notifyIcon.Text = L.T("内存监控", "MemWatch");
    }

    private void BuildUi()
    {
        Text = L.T("内存监控", "MemWatch");
        FormBorderStyle = FormBorderStyle.SizableToolWindow;
        MaximizeBox = false;
        MinimizeBox = true;
        ShowInTaskbar = true;
        TopMost = false;
        StartPosition = FormStartPosition.Manual;
        Font = new Font("Segoe UI", 9f);
        BackColor = DefaultBack;
        DoubleBuffered = true;

        const int w = 376;
        const int pad = 12;
        const int contentW = 400;

        _scrollHost.Dock = DockStyle.Fill;
        _scrollHost.AutoScroll = true;
        _scrollHost.BackColor = DefaultBack;
        _scrollHost.Resize += (_, _) => RelayoutForScroll();
        NativeUi.UseClassicWhenReady(_scrollHost);

        _content.Location = Point.Empty;
        _content.BackColor = Color.Transparent;
        _content.AutoSize = false;

        _lblMem.AutoSize = false;
        _lblMem.Location = new Point(pad, 8);
        _lblMem.Size = new Size(w, 26);
        _lblMem.Font = new Font("Segoe UI Emoji", 10.5f, FontStyle.Bold);
        _lblMem.Text = "🐭 --";

        _barMem.Location = new Point(pad, 36);
        _barMem.Size = new Size(w, 16);
        _barMem.Maximum = 100;

        _lblListHead.AutoSize = false;
        _lblListHead.Location = new Point(pad, 54);
        _lblListHead.Size = new Size(w, 20);
        _lblListHead.Font = new Font("Microsoft YaHei UI", 9.5f, FontStyle.Bold);
        _lblListHead.ForeColor = UiTheme.Ink;

        _list.Location = new Point(pad, 76);
        _list.Size = new Size(w, 124);
        _list.View = View.Details;
        _list.FullRowSelect = true;
        _list.MultiSelect = true;
        _list.GridLines = false;
        _list.HeaderStyle = ColumnHeaderStyle.Nonclickable;
        _list.Columns.Add("Process", 160);
        _list.Columns.Add("Memory", 88);
        _list.Columns.Add("PID", 64);
        _list.HideSelection = false;
        _list.ShowItemToolTips = false;
        _list.KeyDown += List_KeyDown;
        _list.MouseDown += List_MouseDown;
        _list.MouseMove += List_MouseMoveTip;
        _list.MouseLeave += (_, _) => HideProcTip();
        BuildListContextMenu();
        _list.ContextMenuStrip = _listMenu;

        _lblHint.AutoSize = false;
        _lblHint.Location = new Point(pad, 202);
        _lblHint.Size = new Size(w, 18);
        _lblHint.ForeColor = Color.DimGray;
        _lblHint.Font = new Font("Segoe UI", 8f);

        _lblLevelTitle.AutoSize = false;
        _lblLevelTitle.Location = new Point(pad, 222);
        _lblLevelTitle.Size = new Size(w, 16);
        _lblLevelTitle.ForeColor = Color.DimGray;
        _lblLevelTitle.Font = new Font("Segoe UI", 8f);

        WireCreature(_icoMouse, "🐭");
        WireCreature(_icoCat, "🐱");
        WireCreature(_icoDog, "🐶");
        WireCreature(_icoElephant, "🐘");
        WireCreature(_icoWhaleIco, "🐋");
        BindLevelNum(_numMouse, 50, 65536);
        BindLevelNum(_numCat, 51, 65536);
        BindLevelNum(_numDog, 52, 65536);
        BindLevelNum(_numElephant, 53, 65536);
        BindLevelNum(_numWhale, LevelConfig.WhaleMinMb, 65536);
        PlaceCreatureRow(pad, w, 242);

        var y = 318;

        _chkAhab.AutoSize = true;
        _chkAhab.Location = new Point(pad, y);
        _chkAhab.CheckedChanged += (_, _) => OnAhabCheckedChanged();
        y += 22;

        _lblAhabTip.AutoSize = false;
        _lblAhabTip.Location = new Point(pad, y);
        _lblAhabTip.Size = new Size(w, 16);
        _lblAhabTip.Font = new Font("Segoe UI", 7.5f);
        _lblAhabTip.ForeColor = Color.Gray;
        y += 16;

        _lblAhabKills.AutoSize = false;
        _lblAhabKills.Location = new Point(pad, y);
        _lblAhabKills.Size = new Size(w, 16);
        _lblAhabKills.ForeColor = UiTheme.Whale;
        _lblAhabKills.Font = new Font("Segoe UI", 8f, FontStyle.Bold);
        _lblAhabKills.Visible = false;
        y += 18;

        _chkHunt.AutoSize = true;
        _chkHunt.Location = new Point(pad, y);
        _chkHunt.CheckedChanged += (_, _) => OnHuntCheckedChanged();

        _lblHuntThreshold.AutoSize = true;
        _lblHuntThreshold.Location = new Point(pad + 108, y + 2);
        _lblHuntThreshold.Font = new Font("Segoe UI", 8.5f, FontStyle.Bold);
        _lblHuntThreshold.ForeColor = UiTheme.Warn;
        y += 20;

        _lblHuntTip.AutoSize = false;
        _lblHuntTip.Location = new Point(pad, y);
        _lblHuntTip.Size = new Size(w, 16);
        _lblHuntTip.Font = new Font("Segoe UI", 7.5f);
        _lblHuntTip.ForeColor = Color.Gray;
        y += 16;

        _trackHunt.Minimum = 80;
        _trackHunt.Maximum = 100;
        _trackHunt.Value = 85;
        _trackHunt.Location = new Point(pad, y);
        _trackHunt.Size = new Size(w - 28, 28);
        _trackHunt.ValueChanged += (_, _) =>
        {
            UpdateHuntThresholdLabel();
            if (_suppressHuntEvent)
                return;
            _levels.HuntThresholdPct = _trackHunt.Value;
            _levels.Save();
            _huntSnoozeUntilBelow = false;
        };
        _icoStar.Size = new Size(22, 22);
        _icoStar.SizeMode = PictureBoxSizeMode.Zoom;
        _icoStar.BackColor = Color.Transparent;
        _icoStar.Image = FarmSkin.Pic("star.png");
        _icoStar.Location = new Point(pad + w - 24, y + 3);
        y += 36;

        var gap = 6;
        var btnW = (w - gap * 3) / 4;
        _btnKill.Location = new Point(pad, y);
        _btnKill.Size = new Size(btnW, 32);
        _btnKill.Click += (_, _) => KillSelected(entireProcessTree: true);

        _btnForceKill.Location = new Point(pad + btnW + gap, y);
        _btnForceKill.Size = new Size(btnW, 32);
        UiTheme.FlattenButton(_btnForceKill, UiTheme.Danger);
        _btnForceKill.Click += (_, _) => ForceKillSelected();

        _btnRefresh.Location = new Point(_btnForceKill.Right + gap, y);
        _btnRefresh.Size = new Size(btnW, 32);
        _btnRefresh.Click += (_, _) => RefreshData();

        _btnShrink.Location = new Point(pad + w - btnW, y);
        _btnShrink.Size = new Size(btnW, 32);
        _btnShrink.Click += (_, _) => SetCompact(true);
        y += 40;

        var colW = (w - 8) / 2;
        void Feature(Button b, int col, int row, EventHandler click)
        {
            b.Location = new Point(pad + col * (colW + 8), y + row * 36);
            b.Size = new Size(colW, 32);
            b.Click += click;
        }
        Feature(_btnLargeFiles, 0, 0, (_, _) => OpenLargeFileScanner());
        Feature(_btnDiskHealth, 1, 0, (_, _) => OpenDiskHealth());
        Feature(_btnDataRecovery, 1, 1, (_, _) => OpenDataRecovery());
        Feature(_btnDownload, 0, 1, (_, _) => OpenDownloadManager());
        Feature(_btnFileShare, 1, 2, (_, _) => OpenFileShare());
        Feature(_btnSysInfo, 0, 2, (_, _) => OpenSystemInfo());
        y += 36 * 3 + 8;

        _pnlMore.Location = new Point(0, y);
        _pnlMore.Size = new Size(contentW, 280);
        _pnlMore.BackColor = Color.Transparent;
        _pnlMore.Visible = true;

        _chkAutoStart.AutoSize = true;
        _chkAutoStart.Location = new Point(pad, 4);
        _chkAutoStart.CheckedChanged += (_, _) => OnAutoStartCheckedChanged();

        _lblShot.AutoSize = false;
        _lblShot.Location = new Point(pad, 30);
        _lblShot.Size = new Size(w, 16);
        _lblShot.ForeColor = Color.DimGray;
        _lblShot.Font = new Font("Segoe UI", 7.5f);

        _btnShotKey.Location = new Point(pad, 48);
        _btnShotKey.Size = new Size(w, 26);
        _btnShotKey.Click += (_, _) => BeginCaptureShotKey();
        UpdateShotKeyButtonText();

        _lblShotCount.AutoSize = true;
        _lblShotCount.Location = new Point(pad, 80);
        _lblShotCount.ForeColor = Color.DimGray;

        _numShotCount.Minimum = 1;
        _numShotCount.Maximum = 10;
        _suppressShotCountEvent = true;
        _numShotCount.Value = LevelConfig.ClampScreenshotPressCount(_levels.ScreenshotPressCount);
        _suppressShotCountEvent = false;
        _numShotCount.Location = new Point(pad + 80, 76);
        _numShotCount.Size = new Size(52, 24);
        _numShotCount.ValueChanged += (_, _) => OnShotCountChanged();

        _lblPinGroup.AutoSize = false;
        _lblPinGroup.Location = new Point(pad, 104);
        _lblPinGroup.Size = new Size(w, 16);
        _lblPinGroup.ForeColor = Color.DimGray;
        _lblPinGroup.Font = new Font("Segoe UI", 7.5f);

        _cboPinGroup.DropDownStyle = ComboBoxStyle.DropDownList;
        _cboPinGroup.Location = new Point(pad, 122);
        _cboPinGroup.Size = new Size(150, 24);
        _cboPinGroup.SelectedIndexChanged += (_, _) => OnPinGroupComboChanged();

        _btnPinRename.Location = new Point(pad + 168, 122);
        _btnPinRename.Size = new Size(72, 26);
        _btnPinRename.Click += (_, _) => RenameActivePinGroup();

        _btnPinClear.Location = new Point(pad + 244, 122);
        _btnPinClear.Size = new Size(92, 26);
        _btnPinClear.Click += (_, _) =>
        {
            PinBoardService.Instance.ClearActiveGroup();
            RefreshPinGroupUi();
        };

        _lblPinHint.AutoSize = false;
        _lblPinHint.Location = new Point(pad, 152);
        _lblPinHint.Size = new Size(w, 36);
        _lblPinHint.ForeColor = Color.Gray;
        _lblPinHint.Font = new Font("Segoe UI", 7.5f);

        _btnClipboard.Location = new Point(pad, 190);
        _btnClipboard.Size = new Size(w, 30);
        _btnClipboard.Click += (_, _) => OpenClipboardHistory();

        _lblCpuTempInterval.AutoSize = false;
        _lblCpuTempInterval.Location = new Point(pad, 226);
        _lblCpuTempInterval.Size = new Size(140, 20);
        _lblCpuTempInterval.ForeColor = Color.DimGray;

        _numCpuTempInterval.Minimum = 2;
        _numCpuTempInterval.Maximum = 600;
        _numCpuTempInterval.Value = LevelConfig.ClampCpuTempRefreshSec(_levels.CpuTempRefreshSec);
        _numCpuTempInterval.Location = new Point(pad + 148, 222);
        _numCpuTempInterval.Size = new Size(70, 24);
        _numCpuTempInterval.ValueChanged += (_, _) => OnCpuTempIntervalChanged();

        _btnLang.Location = new Point(pad, 256);
        _btnLang.Size = new Size(w, 28);
        _btnLang.Click += (_, _) => ToggleLanguage();
        _pnlMore.Height = 294;

        _btnSkin.Click += (_, _) =>
            WindowSkin.ShowPicker(this, _levels, WindowSkin.KeyMain, DefaultBack, _btnSkin);

        _pnlMore.Controls.AddRange(new Control[]
        {
            _chkAutoStart,
            _lblShot, _btnShotKey, _lblShotCount, _numShotCount,
            _lblPinGroup, _cboPinGroup, _btnPinRename, _btnPinClear, _lblPinHint,
            _btnClipboard, _lblCpuTempInterval, _numCpuTempInterval, _btnLang
        });

        var contentH = _pnlMore.Bottom + 8;
        _content.Size = new Size(contentW, contentH);

        // 默认高度：内容全高或不超过工作区 85%；可手动拖矮后滚动

        var wa = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1280, 720);
        var defaultH = Math.Min(contentH, Math.Max(360, (int)(wa.Height * 0.85)));
        if (_levels.FullHeight is int savedH && savedH >= 280)
            defaultH = Math.Clamp(savedH, 280, Math.Max(280, wa.Height));

        _fullClientSize = new Size(contentW + SystemInformation.VerticalScrollBarWidth, defaultH);
        _suppressResizePersist = true;
        ClientSize = _fullClientSize;
        // 锁定宽度，只允许调高度
        var outerW = Width;
        MinimumSize = new Size(outerW, 280);
        MaximumSize = new Size(outerW, 8000);
        _suppressResizePersist = false;

        Location = new Point(wa.Right - Width - 16, wa.Bottom - Height - 16);
        _fullLocation = Location;

        _lblMini.Text = "🐭 --%  --°C";
        _lblMini.TextAlign = ContentAlignment.MiddleCenter;
        _lblMini.Dock = DockStyle.Fill;
        _lblMini.Font = new Font("Segoe UI Emoji", 10f, FontStyle.Bold);
        _lblMini.ForeColor = UiTheme.OnSolid;
        _lblMini.BackColor = UiTheme.Accent;
        _lblMini.Cursor = Cursors.SizeAll;
        _lblMini.Visible = false;
        _lblMini.Click += (_, _) =>
        {
            if (!_dragging)
                SetCompact(false);
        };
        _lblMini.MouseDown += Mini_MouseDown;
        _lblMini.MouseMove += Mini_MouseMove;
        _lblMini.MouseUp += Mini_MouseUp;

        _content.Controls.AddRange(new Control[]
        {
            _lblMem, _barMem, _lblListHead, _list, _lblHint,
            _lblLevelTitle, _icoMouse, _icoCat, _icoDog, _icoElephant, _icoWhaleIco,
            _numMouse, _numCat, _numDog, _numElephant, _numWhale, _icoStar,
            _chkAhab, _lblAhabTip, _lblAhabKills,
            _chkHunt, _lblHuntThreshold, _lblHuntTip, _trackHunt,
            _btnKill, _btnForceKill, _btnRefresh, _btnShrink,
            _btnLargeFiles, _btnDiskHealth, _btnDataRecovery, _btnDownload, _btnFileShare, _btnSysInfo,
            _pnlMore
        });
        _scrollHost.Controls.Add(_content);
        Controls.Add(_scrollHost);
        Controls.Add(_lblMini);

        KeyPreview = true;
        KeyDown += Form1_KeyDown;

        BuildTray();
        UiTheme.StyleTree(this);
        OceanChrome.Attach(this, () => SetCompact(true), _btnSkin);
        _scrollHost.Margin = new Padding(OceanChrome.Left, 0, OceanChrome.Right, 0);
        _scrollHost.Padding = new Padding(OceanChrome.Left, 0, OceanChrome.Right, 0);
        _suppressResizePersist = true;
        ClientSize = new Size(ClientSize.Width, Math.Clamp(ClientSize.Height + OceanChrome.BeachH + OceanChrome.FootH, 420, Math.Max(420, wa.Height)));
        _fullClientSize = ClientSize;
        var lockW = Width;
        MinimumSize = new Size(lockW, 320);
        MaximumSize = new Size(lockW, 8000);
        _suppressResizePersist = false;
        WindowSkin.Apply(this, _levels, WindowSkin.KeyMain, DefaultBack);
        RelayoutForScroll();
    }

    /// <summary>滚动条出现后按可视宽度重排，避免按钮被挡住、右侧留白槽。</summary>
    private void RelayoutForScroll()
    {
        if (_compact || _relayoutBusy || _scrollHost.Width < 40)
            return;
        _relayoutBusy = true;
        try
        {
            var pad = UiPad;
            var cw = Math.Max(300, _scrollHost.ClientSize.Width);
            _content.Width = cw;
            var inner = Math.Max(260, cw - pad * 2);

            void Stretch(Control c) => c.Width = inner;

            Stretch(_lblMem);
            Stretch(_barMem);
            Stretch(_lblListHead);
            Stretch(_lblHint);
            Stretch(_list);
            Stretch(_lblLevelTitle);
            Stretch(_lblAhabTip);
            Stretch(_lblAhabKills);
            Stretch(_lblHuntTip);
            _trackHunt.Width = Math.Max(80, inner - 28);
            _icoStar.Left = pad + inner - 24;

            PlaceCreatureRow(pad, inner, _icoMouse.Top);

            if (_list.Columns.Count >= 3)
            {
                var pidCol = 56;
                var memCol = 82;
                _list.Columns[2].Width = pidCol;
                _list.Columns[1].Width = memCol;
                _list.Columns[0].Width = Math.Max(90, inner - pidCol - memCol - 24);
            }

            var gap = 6;
            var btnW = (inner - gap * 3) / 4;
            _btnKill.Location = new Point(pad, _btnKill.Top);
            _btnKill.Size = new Size(btnW, 32);
            _btnForceKill.Location = new Point(pad + btnW + gap, _btnForceKill.Top);
            _btnForceKill.Size = new Size(btnW, 32);
            _btnRefresh.Location = new Point(_btnForceKill.Right + gap, _btnRefresh.Top);
            _btnRefresh.Size = new Size(btnW, 32);
            _btnShrink.Size = new Size(btnW, 32);
            _btnShrink.Location = new Point(pad + inner - btnW, _btnShrink.Top);

            var colW = (inner - 8) / 2;
            var rowY = _btnLargeFiles.Top;
            _btnLargeFiles.Location = new Point(pad, rowY);
            _btnLargeFiles.Size = new Size(colW, 32);
            _btnDiskHealth.Location = new Point(pad + colW + 8, rowY);
            _btnDiskHealth.Size = new Size(colW, 32);
            _btnDownload.Location = new Point(pad, rowY + 36);
            _btnDownload.Size = new Size(colW, 32);
            _btnDataRecovery.Location = new Point(pad + colW + 8, rowY + 36);
            _btnDataRecovery.Size = new Size(colW, 32);
            _btnSysInfo.Location = new Point(pad, rowY + 72);
            _btnSysInfo.Size = new Size(colW, 32);
            _btnFileShare.Location = new Point(pad + colW + 8, rowY + 72);
            _btnFileShare.Size = new Size(colW, 32);

            _pnlMore.Top = _btnFileShare.Bottom + 8;
            _pnlMore.Width = cw;
            _content.Height = _pnlMore.Bottom + 8;
            _btnClipboard.Width = inner;
            _btnShotKey.Width = inner;
            _lblShot.Width = inner;
            _lblPinHint.Width = inner;
            _btnLang.Width = inner;

            _cboPinGroup.Width = Math.Min(150, Math.Max(90, inner - 180));
            _btnPinRename.Location = new Point(_cboPinGroup.Right + 8, _btnPinRename.Top);
            _btnPinClear.Location = new Point(_btnPinRename.Right + 8, _btnPinClear.Top);

            UiTheme.FlattenButton(_btnKill);
            UiTheme.FlattenButton(_btnForceKill, UiTheme.Danger);
            UiTheme.FlattenButton(_btnRefresh);
            UiTheme.FlattenButton(_btnShrink);
            UiTheme.FlattenButton(_btnLargeFiles);
            UiTheme.FlattenButton(_btnDiskHealth);
            UiTheme.FlattenButton(_btnDataRecovery);
            UiTheme.FlattenButton(_btnDownload);
            UiTheme.FlattenButton(_btnFileShare);
            UiTheme.FlattenButton(_btnSysInfo);
            UiTheme.FlattenButton(_btnShotKey);
            UiTheme.FlattenButton(_btnPinRename);
            UiTheme.FlattenButton(_btnPinClear);
            UiTheme.FlattenButton(_btnClipboard);
            UiTheme.FlattenButton(_btnLang);
            UiTheme.FlattenButton(_btnSkin);

            NativeUi.UseClassicTheme(_scrollHost.IsHandleCreated ? _scrollHost.Handle : IntPtr.Zero);
        }
        finally
        {
            _relayoutBusy = false;
        }
    }

    private void BuildTray()
    {
        var trayIcon = LoadAppIcon();
        Icon = (Icon)trayIcon.Clone();

        _menuTrayRestore.Text = L.T("还原窗口", "Restore");
        _menuTrayRestore.Click += (_, _) => RestoreFromTray();
        _menuTrayExit.Text = L.T("退出", "Exit");
        _menuTrayExit.Click += (_, _) => ExitFromTray();
        _trayMenu.Items.AddRange(new ToolStripItem[] { _menuTrayRestore, _menuTrayExit });

        _notifyIcon.Icon = trayIcon;
        _notifyIcon.Text = L.T("内存监控", "MemWatch");
        _notifyIcon.Visible = false;
        _notifyIcon.ContextMenuStrip = _trayMenu;
        _notifyIcon.MouseClick += (_, e) =>
        {
            if (e.Button == MouseButtons.Left)
                RestoreFromTray();
        };
    }

    /// <summary>优先用内嵌/旁路 app.ico，保证托盘与窗口图标一致且可见。</summary>
    private static Icon LoadAppIcon()
    {
        try
        {
            var asm = typeof(Form1).Assembly;
            using var stream = asm.GetManifestResourceStream("MemWatch.app.ico");
            if (stream is not null)
                return new Icon(stream);
        }
        catch { /* fall through */ }

        try
        {
            var beside = Path.Combine(AppContext.BaseDirectory, "app.ico");
            if (File.Exists(beside))
                return new Icon(beside);
        }
        catch { /* fall through */ }

        try
        {
            var extracted = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            if (extracted is not null)
                return extracted;
        }
        catch { /* fall through */ }

        return (Icon)SystemIcons.Application.Clone();
    }

    private void RestoreFromTray()
    {
        if (_compact)
            SetCompact(false);
        if (WindowState == FormWindowState.Minimized)
            WindowState = FormWindowState.Normal;
        Show();
        Activate();
        BringToFront();
    }

    private void ExitFromTray()
    {
        _forceClose = true;
        Close();
    }

    private void OnMainFormClosing(object? sender, FormClosingEventArgs e)
    {
        var systemClose = e.CloseReason is CloseReason.WindowsShutDown
            or CloseReason.TaskManagerClosing
            or CloseReason.ApplicationExitCall;
        if (!_forceClose && !systemClose && e.CloseReason == CloseReason.UserClosing)
        {
            e.Cancel = true;
            var choice = ResolveCloseChoice();
            if (choice == CloseChoice.Exit)
            {
                _forceClose = true;
                BeginInvoke(Close);
            }
            else if (choice == CloseChoice.Shrink)
            {
                SetCompact(true);
            }

            return;
        }

        _notifyIcon.Visible = false;
        _notifyIcon.Dispose();
        _timer.Stop();
        PersistSettings();
        CpuTempReader.Shutdown();
        DownloadService.Instance.Shutdown();
        FileShareService.Instance.Shutdown();
        PinBoardService.Instance.Changed -= OnPinBoardChanged;
        PinBoardService.Instance.SaveToConfig(_levels);
        ScreenshotService.Instance.Dispose();
        _procTip.HideTip();
        _procTip.Dispose();
    }

    private enum CloseChoice { Cancel, Shrink, Exit }

    /// <summary>已记住则直接用第一次选择；否则弹窗并写入配置。</summary>
    private CloseChoice ResolveCloseChoice()
    {
        var remembered = LevelConfig.NormalizeCloseOnX(_levels.CloseOnX);
        if (remembered == LevelConfig.CloseExit)
            return CloseChoice.Exit;
        if (remembered == LevelConfig.CloseShrink)
            return CloseChoice.Shrink;

        var choice = AskCloseOrShrink();
        if (choice == CloseChoice.Exit)
        {
            _levels.CloseOnX = LevelConfig.CloseExit;
            _levels.Save();
        }
        else if (choice == CloseChoice.Shrink)
        {
            _levels.CloseOnX = LevelConfig.CloseShrink;
            _levels.Save();
        }

        return choice;
    }

    /// <summary>关闭确认：缩小（浮窗+托盘）或真正退出。</summary>
    private CloseChoice AskCloseOrShrink()
    {
        var shrink = new TaskDialogButton(L.T("缩小", "Mini"));
        var exit = new TaskDialogButton(L.T("关闭", "Exit"));
        var page = new TaskDialogPage
        {
            Caption = L.T("关闭内存监控", "Close MemWatch"),
            Heading = L.T("要缩小到托盘，还是关闭程序？", "Minimize to tray, or exit?"),
            Text = L.T("缩小后浮动小窗仍在，也可从右下角托盘图标还原。",
                "Mini keeps the floating widget; restore from the tray icon too."),
            Buttons = { shrink, exit, TaskDialogButton.Cancel },
            DefaultButton = shrink,
            Icon = TaskDialogIcon.Information,
            AllowCancel = true
        };
        var result = TaskDialog.ShowDialog(this, page);
        if (result == shrink) return CloseChoice.Shrink;
        if (result == exit) return CloseChoice.Exit;
        return CloseChoice.Cancel;
    }

    private void OnPinBoardChanged()
    {
        if (IsDisposed) return;
        if (InvokeRequired) { BeginInvoke(OnPinBoardChanged); return; }
        RefreshPinGroupUi();
    }

    private void RefreshPinGroupUi()
    {
        if (_cboPinGroup.IsDisposed) return;
        _suppressPinGroupEvent = true;
        try
        {
            var names = PinBoardService.Instance.GetGroupNames();
            var active = PinBoardService.Instance.ActiveGroup;
            _cboPinGroup.Items.Clear();
            for (var i = 0; i < names.Count; i++)
            {
                _cboPinGroup.Items.Add($"Shift+F{i + 1} · {names[i]}");
            }

            if (active >= 0 && active < _cboPinGroup.Items.Count)
                _cboPinGroup.SelectedIndex = active;
            var n = PinBoardService.Instance.CountInActiveGroup();
            _lblPinGroup.Text = L.T($"贴图分组（本组 {n} 张）", $"Pin group ({n} in group)");
        }
        finally
        {
            _suppressPinGroupEvent = false;
        }
    }

    private void OnPinGroupComboChanged()
    {
        if (_suppressPinGroupEvent) return;
        if (_cboPinGroup.SelectedIndex < 0) return;
        PinBoardService.Instance.SetActiveGroup(_cboPinGroup.SelectedIndex);
        _levels.ActivePinGroup = _cboPinGroup.SelectedIndex;
        _levels.Save();
        RefreshPinGroupUi();
    }

    private void RenameActivePinGroup()
    {
        var idx = PinBoardService.Instance.ActiveGroup;
        var names = PinBoardService.Instance.GetGroupNames();
        var cur = names[idx];
        using var dlg = new Form
        {
            Text = L.T("贴图分组", "Pin group"),
            FormBorderStyle = FormBorderStyle.FixedDialog,
            StartPosition = FormStartPosition.CenterParent,
            ClientSize = new Size(320, 110),
            MaximizeBox = false,
            MinimizeBox = false,
            ShowInTaskbar = false
        };
        var lbl = new Label
        {
            Text = L.T("输入分组名称", "Group name"),
            Location = new Point(12, 12),
            AutoSize = true
        };
        var txt = new TextBox
        {
            Text = cur,
            Location = new Point(12, 36),
            Width = 296
        };
        var ok = new Button
        {
            Text = L.T("确定", "OK"),
            DialogResult = DialogResult.OK,
            Location = new Point(152, 70),
            Size = new Size(75, 28)
        };
        var cancel = new Button
        {
            Text = L.T("取消", "Cancel"),
            DialogResult = DialogResult.Cancel,
            Location = new Point(233, 70),
            Size = new Size(75, 28)
        };
        dlg.Controls.AddRange(new Control[] { lbl, txt, ok, cancel });
        dlg.AcceptButton = ok;
        dlg.CancelButton = cancel;
        if (dlg.ShowDialog(this) != DialogResult.OK) return;
        PinBoardService.Instance.SetGroupName(idx, txt.Text);
        PinBoardService.Instance.SaveToConfig(_levels);
        _levels.Save();
        RefreshPinGroupUi();
    }

    private void OnShotCountChanged()
    {
        if (_suppressShotCountEvent) return;
        _levels.ScreenshotPressCount = LevelConfig.ClampScreenshotPressCount((int)_numShotCount.Value);
        _levels.Save();
        ScreenshotService.Instance.ApplySettings(_levels);
    }

    private void BeginCaptureShotKey()
    {
        _capturingShotKey = true;
        ScreenshotService.Instance.SetPaused(true);
        _btnShotKey.Text = L.T("请按下要用作截图的键…", "Press the screenshot key…");
        _btnShotKey.BackColor = UiTheme.Yellow;
    }

    private void EndCaptureShotKey(bool saved)
    {
        _capturingShotKey = false;
        ScreenshotService.Instance.SetPaused(false);
        _btnShotKey.BackColor = UiTheme.Surface;
        UpdateShotKeyButtonText();
        if (saved)
            ScreenshotService.Instance.ApplySettings(_levels);
    }

    private void Form1_KeyDown(object? sender, KeyEventArgs e)
    {
        if (!_capturingShotKey) return;
        e.Handled = true;
        e.SuppressKeyPress = true;

        if (e.KeyCode is Keys.Escape)
        {
            EndCaptureShotKey(saved: false);
            return;
        }

        var key = e.KeyCode;
        if (!IsUsableScreenshotKey(key))
        {
            MessageBox.Show(this,
                L.T("请使用普通按键（不要用 Ctrl/Shift/Alt/Win 单独作为触发键）。",
                    "Use a normal key (not Ctrl/Shift/Alt/Win alone)."),
                L.T("截图快捷键", "Screenshot key"),
                MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        _levels.ScreenshotKey = (int)key;
        _levels.Save();
        EndCaptureShotKey(saved: true);
    }

    private void UpdateShotKeyButtonText()
    {
        if (_capturingShotKey) return;
        var keyName = FormatScreenshotKey(_levels.ScreenshotKey);
        _btnShotKey.Text = L.T($"触发键：{keyName}（点击自定义）", $"Key: {keyName} (click to set)");
    }

    private static string FormatScreenshotKey(int keyCode)
    {
        try
        {
            var k = (Keys)keyCode;
            if (k == Keys.None) return "F2";
            return k.ToString();
        }
        catch
        {
            return "F2";
        }
    }

    private static bool IsUsableScreenshotKey(Keys key)
    {
        key &= Keys.KeyCode;
        return key is not (
            Keys.None or Keys.ControlKey or Keys.ShiftKey or Keys.Menu or
            Keys.LWin or Keys.RWin or Keys.Apps or Keys.ProcessKey or
            Keys.Packet or Keys.Attn or Keys.EraseEof);
    }

    private void OnCpuTempIntervalChanged()
    {
        var sec = LevelConfig.ClampCpuTempRefreshSec((int)_numCpuTempInterval.Value);
        if (_numCpuTempInterval.Value != sec)
            _numCpuTempInterval.Value = sec;

        _levels.CpuTempRefreshSec = sec;
        _levels.Save();
        CpuTempReader.SetCpuTempCacheSeconds(sec);
        // 立刻按新间隔允许再读一次
        _lastCpuTempUtc = DateTime.MinValue;
    }

    private void OpenLargeFileScanner()
    {
        if (_scannerForm is { IsDisposed: false })
        {
            if (_scannerForm.WindowState == FormWindowState.Minimized)
                _scannerForm.WindowState = FormWindowState.Normal;
            _scannerForm.TopMost = false;
            _scannerForm.BringToFront();
            _scannerForm.Activate();
            return;
        }

        // 不传 Owner，避免主窗口置顶时把子窗也顶起来
        _scannerForm = new LargeFileScannerForm(_levels);
        _scannerForm.TopMost = false;
        _scannerForm.FormClosed += (_, _) => _scannerForm = null;
        _scannerForm.Show();
    }

    private void OpenDiskHealth()
    {
        if (_diskHealthForm is { IsDisposed: false })
        {
            if (_diskHealthForm.WindowState == FormWindowState.Minimized)
                _diskHealthForm.WindowState = FormWindowState.Normal;
            _diskHealthForm.TopMost = false;
            _diskHealthForm.BringToFront();
            _diskHealthForm.Activate();
            return;
        }

        _diskHealthForm = new DiskHealthForm(_levels);
        _diskHealthForm.TopMost = false;
        _diskHealthForm.FormClosed += (_, _) => _diskHealthForm = null;
        _diskHealthForm.Show();
    }

    private void OpenDataRecovery()
    {
        if (_dataRecoveryForm is { IsDisposed: false })
        {
            if (_dataRecoveryForm.WindowState == FormWindowState.Minimized)
                _dataRecoveryForm.WindowState = FormWindowState.Normal;
            _dataRecoveryForm.TopMost = false;
            _dataRecoveryForm.BringToFront();
            _dataRecoveryForm.Activate();
            return;
        }

        _dataRecoveryForm = new DataRecoveryForm(_levels);
        _dataRecoveryForm.TopMost = false;
        _dataRecoveryForm.FormClosed += (_, _) => _dataRecoveryForm = null;
        _dataRecoveryForm.Show();
    }

    private void OpenDownloadManager()
    {
        if (_downloadForm is { IsDisposed: false })
        {
            if (_downloadForm.WindowState == FormWindowState.Minimized)
                _downloadForm.WindowState = FormWindowState.Normal;
            _downloadForm.TopMost = false;
            _downloadForm.BringToFront();
            _downloadForm.Activate();
            return;
        }

        _downloadForm = new DownloadManagerForm(_levels);
        _downloadForm.TopMost = false;
        _downloadForm.FormClosed += (_, _) => _downloadForm = null;
        _downloadForm.Show();
    }

    private void OpenFileShare()
    {
        if (_fileShareForm is { IsDisposed: false })
        {
            if (_fileShareForm.WindowState == FormWindowState.Minimized)
                _fileShareForm.WindowState = FormWindowState.Normal;
            _fileShareForm.TopMost = false;
            _fileShareForm.BringToFront();
            _fileShareForm.Activate();
            return;
        }

        _fileShareForm = new FileShareForm(_levels);
        _fileShareForm.TopMost = false;
        _fileShareForm.FormClosed += (_, _) => _fileShareForm = null;
        _fileShareForm.Show();
    }

    private void OpenSystemInfo()
    {
        if (_sysInfoForm is { IsDisposed: false })
        {
            if (_sysInfoForm.WindowState == FormWindowState.Minimized)
                _sysInfoForm.WindowState = FormWindowState.Normal;
            _sysInfoForm.TopMost = false;
            _sysInfoForm.BringToFront();
            _sysInfoForm.Activate();
            return;
        }

        _sysInfoForm = new SystemInfoForm(_levels);
        _sysInfoForm.TopMost = false;
        _sysInfoForm.FormClosed += (_, _) => _sysInfoForm = null;
        _sysInfoForm.Show();
    }

    private void OpenClipboardHistory()
    {
        if (_clipboardForm is { IsDisposed: false })
        {
            if (_clipboardForm.WindowState == FormWindowState.Minimized)
                _clipboardForm.WindowState = FormWindowState.Normal;
            _clipboardForm.BringToFront();
            _clipboardForm.Activate();
            return;
        }

        _clipboardForm = new ClipboardHistoryForm(_levels);
        _clipboardForm.TopMost = false;
        _clipboardForm.FormClosed += (_, _) => _clipboardForm = null;
        _clipboardForm.Show();
    }

    private void EnsureOtherWindowsNotTopMost()
    {
        if (_scannerForm is { IsDisposed: false })
            _scannerForm.TopMost = false;
        if (_diskHealthForm is { IsDisposed: false })
            _diskHealthForm.TopMost = false;
        if (_dataRecoveryForm is { IsDisposed: false })
            _dataRecoveryForm.TopMost = false;
        if (_downloadForm is { IsDisposed: false })
            _downloadForm.TopMost = false;
        if (_fileShareForm is { IsDisposed: false })
            _fileShareForm.TopMost = false;
        if (_sysInfoForm is { IsDisposed: false })
            _sysInfoForm.TopMost = false;
        if (_clipboardForm is { IsDisposed: false })
            _clipboardForm.TopMost = false;
    }

    private void OnAutoStartCheckedChanged()
    {
        if (_suppressAutoStartEvent)
            return;

        try
        {
            AutoStart.SetEnabled(_chkAutoStart.Checked);
            _levels.AutoStart = _chkAutoStart.Checked;
            _levels.Save();
        }
        catch (Exception ex)
        {
            _suppressAutoStartEvent = true;
            _chkAutoStart.Checked = AutoStart.IsEnabled();
            _suppressAutoStartEvent = false;
            MessageBox.Show(this,
                L.T($"无法设置开机自启动：{ex.Message}", $"Failed to set startup with Windows: {ex.Message}"),
                L.T("失败", "Failed"),
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
    }

    private static void WireCreature(PictureBox pb, string emoji)
    {
        pb.Size = new Size(40, 40);
        pb.SizeMode = PictureBoxSizeMode.CenterImage;
        pb.BackColor = Color.Transparent;
        var bmp = new Bitmap(40, 40);
        using (var g = Graphics.FromImage(bmp))
        {
            g.Clear(Color.Transparent);
            TextRenderer.DrawText(
                g,
                emoji,
                new Font("Segoe UI Emoji", 16f),
                new Rectangle(0, 0, 40, 40),
                Color.Black,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
        }
        pb.Image = bmp;
    }

    private void BindLevelNum(NumericUpDown num, int min, int max)
    {
        num.Minimum = min;
        num.Maximum = max;
        num.Increment = 50;
        num.Size = new Size(58, 22);
        num.Font = new Font("Segoe UI", 8f);
        num.ValueChanged += (_, _) => OnLevelInputsChanged();
    }

    private void PlaceCreatureRow(int pad, int inner, int iconTop)
    {
        var icons = new[] { _icoMouse, _icoCat, _icoDog, _icoElephant, _icoWhaleIco };
        var nums = new[] { _numMouse, _numCat, _numDog, _numElephant, _numWhale };
        var col = inner / 5;
        for (var i = 0; i < 5; i++)
        {
            var x = pad + i * col;
            icons[i].Location = new Point(x + Math.Max(0, (col - 40) / 2), iconTop);
            nums[i].Location = new Point(x + Math.Max(0, (col - 58) / 2), iconTop + 42);
        }
    }

    private void SyncLevelInputs()
    {
        _suppressLevelEvent = true;
        _levels.Normalize();

        _numWhale.Minimum = LevelConfig.WhaleMinMb;
        _numWhale.Maximum = 65536;
        _numWhale.Value = Math.Clamp(_levels.WhaleMb, LevelConfig.WhaleMinMb, 65536);

        _numElephant.Minimum = 50;
        _numElephant.Maximum = _numWhale.Value;
        _numElephant.Value = Math.Clamp(_levels.ElephantMb, 50, _numWhale.Value);

        _numDog.Minimum = 50;
        _numDog.Maximum = _numElephant.Value;
        _numDog.Value = Math.Clamp(_levels.DogMb, 50, _numElephant.Value);

        _numCat.Minimum = 50;
        _numCat.Maximum = _numDog.Value;
        _numCat.Value = Math.Clamp(_levels.CatMb, 50, _numDog.Value);

        _numMouse.Minimum = 50;
        _numMouse.Maximum = _numCat.Value;
        _numMouse.Value = Math.Clamp(_levels.MouseMb, 50, _numCat.Value);

        _suppressLevelEvent = false;
    }

    private void OnLevelInputsChanged()
    {
        if (_suppressLevelEvent)
            return;

        _suppressLevelEvent = true;
        try
        {
            // 鲸鱼不能低于 2000
            if (_numWhale.Value < LevelConfig.WhaleMinMb)
                _numWhale.Value = LevelConfig.WhaleMinMb;

            // 不能逾越：老鼠 ≤ 猫 ≤ 狗 ≤ 大象 ≤ 鲸鱼（从大往小压）
            if (_numElephant.Value > _numWhale.Value)
                _numElephant.Value = _numWhale.Value;
            if (_numDog.Value > _numElephant.Value)
                _numDog.Value = _numElephant.Value;
            if (_numCat.Value > _numDog.Value)
                _numCat.Value = _numDog.Value;
            if (_numMouse.Value > _numCat.Value)
                _numMouse.Value = _numCat.Value;

            // 同步各框可调上限，避免旋钮越级
            _numElephant.Maximum = _numWhale.Value;
            _numDog.Maximum = _numElephant.Value;
            _numCat.Maximum = _numDog.Value;
            _numMouse.Maximum = _numCat.Value;

            _numCat.Minimum = _numMouse.Minimum;
            _numDog.Minimum = _numMouse.Minimum;
            _numElephant.Minimum = _numMouse.Minimum;

            _levels.MouseMb = (int)_numMouse.Value;
            _levels.CatMb = (int)_numCat.Value;
            _levels.DogMb = (int)_numDog.Value;
            _levels.ElephantMb = (int)_numElephant.Value;
            _levels.WhaleMb = (int)_numWhale.Value;
            _levels.Save();
        }
        finally
        {
            _suppressLevelEvent = false;
        }

        RefreshData();
    }

    private void OnHuntCheckedChanged()
    {
        if (_suppressHuntEvent)
            return;

        _levels.HuntEnabled = _chkHunt.Checked;
        _levels.HuntThresholdPct = _trackHunt.Value;
        _levels.Save();

        if (_chkHunt.Checked)
        {
            _huntSnoozeUntilBelow = false;
            ScheduleAutoKillPipeline(CollectHighMemoryProcesses());
        }
        else
        {
            _huntSnoozeUntilBelow = false;
        }
    }

    private void UpdateHuntThresholdLabel()
    {
        _lblHuntThreshold.Text = L.T($"阈值 {_trackHunt.Value}%", $"Threshold {_trackHunt.Value}%");
    }

    /// <summary>
    /// 自动击杀流水线：先亚哈清鲸鱼，再判断猎杀。
    /// 放到后台，避免 UI 线程 WaitForExit / 重复枚举进程导致卡顿。
    /// </summary>
    private void ScheduleAutoKillPipeline(List<ProcInfo> snapshot)
    {
        if (Interlocked.CompareExchange(ref _killBusy, 1, 0) != 0)
            return;

        var ahab = _chkAhab.Checked;
        var hunt = _chkHunt.Checked;
        var threshold = _trackHunt.Value;
        var whaleMb = _levels.WhaleMb;
        var selfPid = _selfPid;
        var snap = snapshot;

        _ = Task.Run(() =>
        {
            var postedUi = false;
            try
            {
                var killedList = new List<ProcInfo>();
                if (ahab)
                    killedList = HuntWhalesCore(snap, whaleMb, selfPid);

                if (hunt)
                    RunHuntModeCore(snap, threshold, skipWhales: ahab, whaleMb, selfPid);

                if (killedList.Count == 0 || IsDisposed)
                    return;

                try
                {
                    var report = killedList;
                    var reportWhaleMb = whaleMb;
                    BeginInvoke(() =>
                    {
                        try
                        {
                            if (IsDisposed)
                                return;
                            _ahabKillCount += report.Count;
                            _levels.AhabKillCount = _ahabKillCount;
                            _levels.Save();
                            UpdateAhabKillLabel();
                            ShowAhabKillReport(report, reportWhaleMb);
                        }
                        finally
                        {
                            Interlocked.Exchange(ref _killBusy, 0);
                        }
                    });
                    postedUi = true;
                }
                catch
                {
                    // disposing
                }
            }
            finally
            {
                if (!postedUi)
                    Interlocked.Exchange(ref _killBusy, 0);
            }
        });
    }

    /// <summary>
    /// 猎杀模式：达阈值后先弹窗确认（可排除/整次取消，仅本次），
    /// 再按勾选顺序从大到小击杀，直到低于阈值。
    /// </summary>
    private void RunHuntModeCore(
        IReadOnlyList<ProcInfo> snapshot,
        int threshold,
        bool skipWhales,
        int whaleMb,
        int selfPid)
    {
        var (pct, _, _) = GetSystemMemory();
        if (pct < threshold)
        {
            _huntSnoozeUntilBelow = false;
            return;
        }

        if (_huntSnoozeUntilBelow)
            return;

        var rawCandidates = new List<(int Pid, string Name, long MemMb)>();
        foreach (var p in snapshot)
        {
            if (p.Pid == 0 || p.Pid == 4 || p.Pid == selfPid)
                continue;
            if (skipWhales && p.MemMb >= whaleMb)
                continue;
            rawCandidates.Add((p.Pid, p.Name, p.MemMb));
        }

        if (rawCandidates.Count == 0)
            return;

        var cpuMap = ProcessActivitySampler.SampleMany(rawCandidates.Select(c => c.Pid).ToList());
        var foregroundPid = ProcessActivitySampler.TryGetForegroundPid();
        var lowMemMb = _levels.CatMb;
        var lowCpuPct = _levels.HuntLowActivityCpuPct;
        var autoLow = _levels.HuntAutoSelectLowActivity;

        var candidates = rawCandidates
            .Select(c => new HuntCandidate(
                c.Pid,
                c.Name,
                c.MemMb,
                cpuMap.TryGetValue(c.Pid, out var cpu) ? cpu : null))
            .ToList();

        List<(int Pid, string Name, long MemMb)>? approved = null;
        try
        {
            if (IsDisposed || !IsHandleCreated)
                return;

            Invoke(() =>
            {
                if (IsDisposed)
                    return;

                using var dlg = new HuntConfirmForm(
                    candidates, threshold, pct, lowCpuPct, lowMemMb, foregroundPid, autoLow);
                var result = dlg.ShowDialog(this);
                // 无论确认还是取消：本轮已问过，等内存降到阈值下再允许下次弹窗
                _huntSnoozeUntilBelow = true;
                if (_levels.HuntAutoSelectLowActivity != dlg.AutoSelectLowActivity)
                {
                    _levels.HuntAutoSelectLowActivity = dlg.AutoSelectLowActivity;
                    _levels.Save();
                }

                if (result == DialogResult.OK)
                    approved = dlg.GetSelected();
            });
        }
        catch
        {
            return;
        }

        if (approved is null || approved.Count == 0)
            return;

        foreach (var target in approved)
        {
            (pct, _, _) = GetSystemMemory();
            if (pct < threshold)
                break;

            try
            {
                using var p = Process.GetProcessById(target.Pid);
                p.Kill(entireProcessTree: true);
                p.WaitForExit(800);
            }
            catch
            {
                // 无权限或已退出则跳过
            }
        }
    }

    private void OnAhabCheckedChanged()
    {
        if (_suppressAhabEvent)
            return;

        if (_chkAhab.Checked)
        {
            var result = MessageBox.Show(this,
                L.T("亚哈船长会击杀所有鲸鱼级应用程序.", "Captain Ahab will kill all Whale-level apps."),
                L.T("是否聘请亚哈船长", "Hire Captain Ahab?"),
                MessageBoxButtons.OKCancel,
                MessageBoxIcon.Warning);

            if (result != DialogResult.OK)
            {
                _suppressAhabEvent = true;
                _chkAhab.Checked = false;
                _suppressAhabEvent = false;
                return;
            }

            _levels.AhabEnabled = true;
            _levels.Save();

            var snap = CollectHighMemoryProcesses();
            var whaleMb = _levels.WhaleMb;
            var selfPid = _selfPid;
            _ = Task.Run(() =>
            {
                var killedList = HuntWhalesCore(snap, whaleMb, selfPid);
                if (IsDisposed)
                    return;
                try
                {
                    BeginInvoke(() =>
                    {
                        if (IsDisposed)
                            return;
                        if (killedList.Count > 0)
                        {
                            _ahabKillCount += killedList.Count;
                            _levels.AhabKillCount = _ahabKillCount;
                            _levels.Save();
                        }

                        UpdateAhabKillLabel();
                        if (killedList.Count > 0)
                            ShowAhabKillReport(killedList, whaleMb);
                        else
                        {
                            MessageBox.Show(this,
                                L.T(
                                    $"当前没有达到鲸鱼门槛（{whaleMb} MB）的进程。\n\n" +
                                    "之后若出现鲸鱼级进程，亚哈船长会自动出击。\n" +
                                    "可在上方调整「🐋 鲸鱼」门槛，决定哪些进程算鲸鱼。",
                                    $"No processes currently meet the Whale threshold ({whaleMb} MB).\n\n" +
                                    "Ahab will strike automatically when Whale-level apps appear.\n" +
                                    "Adjust the 🐋 Whale threshold above to control what counts as a whale."),
                                L.T("亚哈船长", "Captain Ahab"),
                                MessageBoxButtons.OK,
                                MessageBoxIcon.Information);
                        }

                        RefreshData();
                    });
                }
                catch
                {
                    // disposing
                }
            });
        }
        else
        {
            _lblAhabKills.Visible = false;
            _levels.AhabEnabled = false;
            _levels.Save();
            MessageBox.Show(this,
                L.T("亚哈船长已经离开", "Captain Ahab has left."),
                L.T("提示", "Notice"),
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }
    }

    private void SetCompact(bool compact)
    {
        if (_compact == compact)
            return;

        _compact = compact;
        HideProcTip();

        if (compact)
        {
            _fullLocation = Location;
            _fullClientSize = ClientSize;
            _levels.FullHeight = ClientSize.Height;

            _suppressResizePersist = true;
            MaximumSize = Size.Empty;
            MinimumSize = Size.Empty;

            _scrollHost.Visible = false;
            OceanChrome.SetVisible(this, false);
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            Opacity = 0.82;
            ClientSize = MiniSize;
            TopMost = true;
            _lblMini.Visible = true;
            _lblMini.BringToFront();
            _suppressResizePersist = false;

            if (_hasMiniLocation)
            {
                Location = ClampToScreen(_miniLocation);
            }
            else
            {
                var wa = Screen.FromControl(this).WorkingArea;
                Location = new Point(wa.Right - MiniSize.Width - 8, wa.Top + 8);
            }

            UpdateMiniLabel(_lastPct, _lastCpuTemp);
            UpdateTrayVisible();
            PersistSettings();
        }
        else
        {
            _miniLocation = Location;
            _hasMiniLocation = true;

            _lblMini.Visible = false;
            _suppressResizePersist = true;
            OceanChrome.SetVisible(this, true);
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = true;
            Opacity = 1.0;
            ClientSize = _fullClientSize;
            TopMost = false;
            var outerW = Width;
            MinimumSize = new Size(outerW, 280);
            MaximumSize = new Size(outerW, 8000);
            _scrollHost.Visible = true;
            _suppressResizePersist = false;
            Location = ClampToScreen(_fullLocation);

            foreach (Control c in _content.Controls)
            {
                if (c == _lblAhabKills)
                {
                    c.Visible = _chkAhab.Checked;
                    continue;
                }
                c.Visible = true;
            }

            UpdateTrayVisible();
            PersistSettings();
            RefreshData();
            RelayoutForScroll();
        }
    }

    private void UpdateTrayVisible()
    {
        try
        {
            if (_compact)
            {
                // 先关再开，强制刷新 shell 托盘图标（Win11 有时不刷）
                _notifyIcon.Visible = false;
                if (_notifyIcon.Icon is null)
                    _notifyIcon.Icon = LoadAppIcon();
                var tip = _lblMini.Text.Length > 0 ? _lblMini.Text : L.T("内存监控", "MemWatch");
                _notifyIcon.Text = tip.Length <= 63 ? tip : tip[..63];
                _notifyIcon.Visible = true;
            }
            else
            {
                _notifyIcon.Visible = false;
            }
        }
        catch
        {
            // 托盘失败不阻断缩小
        }
    }

    private void Mini_MouseDown(object? sender, MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left)
            return;
        _dragging = false;
        _dragOffset = e.Location;
        _lblMini.Capture = true;
    }

    private void Mini_MouseMove(object? sender, MouseEventArgs e)
    {
        if (!_lblMini.Capture || e.Button != MouseButtons.Left)
            return;

        var dx = e.X - _dragOffset.X;
        var dy = e.Y - _dragOffset.Y;
        if (!_dragging && (Math.Abs(dx) > 3 || Math.Abs(dy) > 3))
            _dragging = true;

        if (_dragging)
            Location = ClampToScreen(new Point(Left + dx, Top + dy));
    }

    private void Mini_MouseUp(object? sender, MouseEventArgs e)
    {
        _lblMini.Capture = false;
        if (_dragging)
        {
            _miniLocation = Location;
            _hasMiniLocation = true;
            PersistSettings();
            BeginInvoke(() => _dragging = false);
        }
    }

    private Point ClampToScreen(Point p)
    {
        var wa = Screen.FromPoint(p).WorkingArea;
        var x = Math.Max(wa.Left, Math.Min(p.X, wa.Right - Width));
        var y = Math.Max(wa.Top, Math.Min(p.Y, wa.Bottom - Height));
        return new Point(x, y);
    }

    private static MemLevel GetMemLevel(double pct)
    {
        if (pct >= 90) return new MemLevel("🐋", L.T("鲸鱼", "Whale"), L.T("极高", "Critical"), UiTheme.Whale);
        if (pct >= 75) return new MemLevel("🐘", L.T("大象", "Elephant"), L.T("很高", "Very high"), UiTheme.Elephant);
        if (pct >= 60) return new MemLevel("🐶", L.T("狗", "Dog"), L.T("偏高", "High"), UiTheme.Dog);
        if (pct >= 40) return new MemLevel("🐱", L.T("猫", "Cat"), L.T("中等", "Medium"), UiTheme.Cat);
        return new MemLevel("🐭", L.T("老鼠", "Mouse"), L.T("较低", "Low"), UiTheme.Accent);
    }

    private MemLevel GetProcessLevel(long memMb)
    {
        if (memMb >= _levels.WhaleMb) return new MemLevel("🐋", L.T("鲸鱼", "Whale"), L.T("极大", "Huge"), Color.Empty);
        if (memMb >= _levels.ElephantMb) return new MemLevel("🐘", L.T("大象", "Elephant"), L.T("很大", "Very large"), Color.Empty);
        if (memMb >= _levels.DogMb) return new MemLevel("🐶", L.T("狗", "Dog"), L.T("较大", "Large"), Color.Empty);
        if (memMb >= _levels.CatMb) return new MemLevel("🐱", L.T("猫", "Cat"), L.T("中等", "Medium"), Color.Empty);
        return new MemLevel("🐭", L.T("老鼠", "Mouse"), L.T("偏高", "Elevated"), Color.Empty);
    }

    private static List<ProcInfo> HuntWhalesCore(IReadOnlyList<ProcInfo> snapshot, int whaleMb, int selfPid)
    {
        var killed = new List<ProcInfo>();
        foreach (var info in snapshot)
        {
            if (info.Pid == 0 || info.Pid == 4 || info.Pid == selfPid)
                continue;
            if (info.MemMb < whaleMb)
                continue;

            try
            {
                using var proc = Process.GetProcessById(info.Pid);
                proc.Kill(entireProcessTree: true);
                killed.Add(info);
            }
            catch
            {
                // 无权限时静默跳过
            }
        }

        return killed;
    }

    private void ShowAhabKillReport(IReadOnlyList<ProcInfo> killed, int whaleMb)
    {
        if (killed.Count == 0)
            return;

        var lines = killed.Take(12)
            .Select(p => $"· {p.Name}  (PID {p.Pid}, {p.MemMb:N0} MB)");
        var body = string.Join("\n", lines);
        if (killed.Count > 12)
            body += L.T($"\n· …等共 {killed.Count} 个", $"\n· …and {killed.Count} total");

        var tip = L.T(
            $"\n\n当前鲸鱼门槛：{whaleMb} MB。\n" +
            "若不想再次击杀某个程序，请在上方手动提高「🐋 鲸鱼」门槛，" +
            "使其高于该程序的内存占用；或先结束该程序后再调高门槛。",
            $"\n\nCurrent Whale threshold: {whaleMb} MB.\n" +
            "To avoid killing an app again, raise the 🐋 Whale threshold above " +
            "that app’s memory usage, or close it first and then raise the threshold.");

        MessageBox.Show(this,
            L.T(
                $"亚哈船长击杀了以下鲸鱼级进程：\n\n{body}{tip}",
                $"Captain Ahab ended these Whale-level processes:\n\n{body}{tip}"),
            L.T("亚哈船长出击", "Captain Ahab struck"),
            MessageBoxButtons.OK,
            MessageBoxIcon.Information);
    }

    private void UpdateAhabKillLabel()
    {
        _lblAhabKills.Text = L.T(
            $"亚哈船长已经击杀了{_ahabKillCount}只鲸鱼",
            $"Captain Ahab has killed {_ahabKillCount} whale(s)");
        _lblAhabKills.Visible = !_compact && _chkAhab.Checked;
    }

    private static string FormatAnimalCount(int whale, int elephant, int dog, int cat, int mouse)
    {
        var parts = new List<string>(5);
        if (whale > 0)
            parts.Add(L.T($"{whale}只鲸鱼", $"{whale} whale(s)"));
        if (elephant > 0)
            parts.Add(L.T($"{elephant}只大象", $"{elephant} elephant(s)"));
        if (dog > 0)
            parts.Add(L.T($"{dog}只狗", $"{dog} dog(s)"));
        if (cat > 0)
            parts.Add(L.T($"{cat}只猫", $"{cat} cat(s)"));
        if (mouse > 0)
            parts.Add(L.T($"{mouse}只老鼠", $"{mouse} mouse"));
        return parts.Count == 0 ? L.T("无", "none") : string.Join(" ", parts);
    }

    private void UpdateMiniLabel(double pct, float? cpuTemp)
    {
        var lv = GetMemLevel(pct);
        var tempText = cpuTemp.HasValue ? $"{cpuTemp.Value:0}°C" : "--°C";
        _lblMini.Text = $"{lv.Emoji} {pct:0.0}%  {tempText}";
        _lblMini.BackColor = lv.Color;
        if (_compact)
        {
            var tip = $"{lv.Emoji} {pct:0.0}%  {tempText}";
            _notifyIcon.Text = tip.Length <= 63 ? tip : tip[..63];
        }
    }

    /// <summary>CPU 温度按用户设定间隔刷新，放到后台线程，避免卡住 UI。</summary>
    private void ScheduleCpuTempRefreshIfDue()
    {
        var intervalMs = LevelConfig.ClampCpuTempRefreshSec(_levels.CpuTempRefreshSec) * 1000;
        var now = DateTime.UtcNow;
        if (_lastCpuTempUtc != DateTime.MinValue &&
            now - _lastCpuTempUtc < TimeSpan.FromMilliseconds(intervalMs))
            return;
        if (Interlocked.CompareExchange(ref _cpuTempReadBusy, 1, 0) != 0)
            return;

        _ = Task.Run(() =>
        {
            float? temp = null;
            try
            {
                temp = CpuTempReader.TryReadCelsius(forceRefresh: true);
            }
            catch
            {
                // keep previous
            }

            var posted = false;
            try
            {
                if (!IsDisposed)
                {
                    BeginInvoke(() =>
                    {
                        try
                        {
                            if (IsDisposed)
                                return;
                            _lastCpuTemp = temp;
                            _lastCpuTempUtc = DateTime.UtcNow;
                            if (_compact)
                                UpdateMiniLabel(_lastPct, _lastCpuTemp);
                        }
                        finally
                        {
                            Interlocked.Exchange(ref _cpuTempReadBusy, 0);
                        }
                    });
                    posted = true;
                }
            }
            catch
            {
                // disposing / no handle
            }

            if (!posted)
                Interlocked.Exchange(ref _cpuTempReadBusy, 0);
        });
    }

    private void RefreshData()
    {
        try
        {
            var (usedPct, usedMb, totalMb) = GetSystemMemory();
            _lastPct = usedPct;
            ScheduleCpuTempRefreshIfDue();

            // 每个周期最多枚举一次进程：列表与自动击杀共用
            List<ProcInfo>? highs = null;
            var needProcs = _chkAhab.Checked || _chkHunt.Checked || !_compact;
            if (needProcs)
                highs = CollectHighMemoryProcesses();

            if ((_chkAhab.Checked || _chkHunt.Checked) && highs is not null)
                ScheduleAutoKillPipeline(highs);

            if (_compact)
            {
                UpdateMiniLabel(usedPct, _lastCpuTemp);
                return;
            }

            highs ??= CollectHighMemoryProcesses();

            var lv = GetMemLevel(usedPct);
            _lblMem.Text = L.T(
                $"{lv.Emoji} 系统内存：{usedPct:0.0}%  ({usedMb:N0}/{totalMb:N0} MB)  {lv.Name}·{lv.Desc}",
                $"{lv.Emoji} Memory: {usedPct:0.0}%  ({usedMb:N0}/{totalMb:N0} MB)  {lv.Name}·{lv.Desc}");
            _barMem.Value = Math.Clamp((int)Math.Round(usedPct), 0, 100);

            var selectedPids = new HashSet<int>();
            foreach (ListViewItem sel in _list.SelectedItems)
            {
                if (TryItemPid(sel.Tag, out var selPid, out _))
                    selectedPids.Add(selPid);
            }

            // 记住当前滚动位置
            var topIndex = 0;
            int? topPid = null;
            try
            {
                if (_list.TopItem != null)
                {
                    topIndex = _list.TopItem.Index;
                    if (TryItemPid(_list.TopItem.Tag, out var tpid, out _))
                        topPid = tpid;
                }
            }
            catch
            {
                // ignore
            }

            _list.BeginUpdate();
            _list.Items.Clear();
            int whale = 0, elephant = 0, dog = 0, cat = 0, mouse = 0;
            ListViewItem? restoreTop = null;
            foreach (var p in highs)
            {
                var pl = GetProcessLevel(p.MemMb);
                switch (pl.Emoji)
                {
                    case "🐋": whale++; break;
                    case "🐘": elephant++; break;
                    case "🐶": dog++; break;
                    case "🐱": cat++; break;
                    default: mouse++; break;
                }

                var item = new ListViewItem($"{pl.Emoji} {p.Name}");
                item.SubItems.Add($"{p.MemMb:N0} MB");
                item.SubItems.Add(p.Pid.ToString());
                item.Tag = (p.Pid, p.MemMb);
                item.ToolTipText = ProcessExplain.BuildToolTip(p.Name, p.Pid, p.MemMb, pl.Name);
                _list.Items.Add(item);
                if (topPid.HasValue && p.Pid == topPid.Value)
                    restoreTop = item;
            }

            // 先恢复选中，再在 EndUpdate 后强制还原滚动（避免选中把视图拉走）
            foreach (ListViewItem item in _list.Items)
            {
                if (TryItemPid(item.Tag, out var pid, out _) && selectedPids.Contains(pid))
                    item.Selected = true;
            }
            _list.EndUpdate();

            RestoreListScroll(restoreTop, topIndex);

            _lblHint.Text = highs.Count == 0
                ? L.T("动物园很安静，没有大动物在吃内存", "The zoo is quiet — no big animals eating memory")
                : L.T(
                    $"动物园里有 {FormatAnimalCount(whale, elephant, dog, cat, mouse)}在吃内存",
                    $"The zoo has {FormatAnimalCount(whale, elephant, dog, cat, mouse)} eating memory");
        }
        catch
        {
            // 刷新失败时保持上一帧
        }
    }

    private void RestoreListScroll(ListViewItem? restoreTop, int topIndex)
    {
        void Apply()
        {
            if (_list.Items.Count == 0)
                return;

            try
            {
                if (restoreTop != null && restoreTop.ListView == _list)
                {
                    _list.TopItem = restoreTop;
                    return;
                }

                var idx = Math.Clamp(topIndex, 0, _list.Items.Count - 1);
                _list.TopItem = _list.Items[idx];
            }
            catch
            {
                // 布局未就绪时忽略
            }
        }

        Apply();
        // 选中变化可能再次带动滚动，下一帧再钉一次
        BeginInvoke(Apply);
    }

    private List<ProcInfo> CollectHighMemoryProcesses()
    {
        var result = new List<ProcInfo>(16);
        Process[] processes;
        try
        {
            processes = Process.GetProcesses();
        }
        catch
        {
            return result;
        }

        // 列表筛选基础：老鼠门槛（默认 200 MB）
        var minMb = _levels.MouseMb;
        foreach (var proc in processes)
        {
            try
            {
                if (proc.Id == 0 || proc.Id == 4 || proc.Id == _selfPid)
                    continue;

                long ws;
                try
                {
                    ws = proc.WorkingSet64;
                }
                catch
                {
                    continue;
                }

                var mb = ws / (1024L * 1024L);
                if (mb < minMb)
                    continue;

                string name;
                try
                {
                    name = string.IsNullOrEmpty(proc.ProcessName) ? "?" : proc.ProcessName;
                }
                catch
                {
                    name = "?";
                }

                result.Add(new ProcInfo(proc.Id, name, mb));
            }
            finally
            {
                proc.Dispose();
            }
        }

        result.Sort((a, b) => b.MemMb.CompareTo(a.MemMb));
        return result;
    }

    private void BuildListContextMenu()
    {
        _menuKillSelected.Click += (_, _) => KillSelected(entireProcessTree: false);
        _menuKillTree.Click += (_, _) => KillSelected(entireProcessTree: true);
        _menuForceKill.Click += (_, _) => ForceKillSelected();
        _menuKillRoot.DropDownItems.Add(_menuKillSelected);
        _menuKillRoot.DropDownItems.Add(_menuKillTree);
        _menuKillRoot.DropDownItems.Add(new ToolStripSeparator());
        _menuKillRoot.DropDownItems.Add(_menuForceKill);
        _listMenu.Items.Add(_menuKillRoot);
        _listMenu.Opening += (_, e) =>
        {
            if (_list.SelectedItems.Count == 0)
                e.Cancel = true;
            else
            {
                _menuKillRoot.Enabled = true;
                _menuKillSelected.Enabled = true;
                _menuKillTree.Enabled = true;
                _menuForceKill.Enabled = true;
            }
        };
    }

    private void List_MouseDown(object? sender, MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Right)
            return;

        HideProcTip();
        var hit = _list.HitTest(e.Location);
        if (hit.Item is null)
            return;

        // 右键点到未选中项时，改为只选中该项，便于直接结束
        if (!hit.Item.Selected)
        {
            _list.SelectedItems.Clear();
            hit.Item.Selected = true;
        }

        hit.Item.Focused = true;
    }

    private void List_MouseMoveTip(object? sender, MouseEventArgs e)
    {
        if (_compact)
        {
            HideProcTip();
            return;
        }

        var hit = _list.HitTest(e.Location);
        if (hit.Item is null || string.IsNullOrWhiteSpace(hit.Item.ToolTipText))
        {
            HideProcTip();
            return;
        }

        var pid = TryItemPid(hit.Item.Tag, out var p, out _) ? p : -1;
        var screen = _list.PointToScreen(e.Location);
        if (pid == _procTipPid && _procTip.Visible)
        {
            // 同项跟随鼠标微调位置
            _procTip.ShowTip(hit.Item.ToolTipText, screen);
            return;
        }

        _procTipPid = pid;
        _procTip.ShowTip(hit.Item.ToolTipText, screen);
    }

    private void HideProcTip()
    {
        _procTipPid = -1;
        _procTip.HideTip();
    }

    private void List_KeyDown(object? sender, KeyEventArgs e)
    {
        if (e.Control && e.KeyCode == Keys.A)
        {
            foreach (ListViewItem item in _list.Items)
                item.Selected = true;
            e.Handled = true;
            e.SuppressKeyPress = true;
        }
    }

    private void KillSelected(bool entireProcessTree = true)
    {
        if (_list.SelectedItems.Count == 0)
        {
            MessageBox.Show(this,
                L.T(
                    "请先在列表中选择要结束的进程。\n\n提示：按住 Ctrl 点选多个，或 Ctrl+A 全选。",
                    "Select one or more processes first.\n\nTip: Ctrl+click to multi-select, or Ctrl+A to select all."),
                L.T("提示", "Notice"),
                MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        var targets = new List<(int Pid, string Name, long MemMb)>(_list.SelectedItems.Count);
        foreach (ListViewItem item in _list.SelectedItems)
        {
            if (TryItemPid(item.Tag, out var pid, out var mem))
                targets.Add((pid, item.Text, mem));
        }

        if (targets.Count == 0)
            return;

        string message;
        var modeHint = entireProcessTree
            ? L.T("（将结束进程树，含子进程）", "(process tree, including children)")
            : L.T("（仅结束选中进程本身）", "(selected process only)");
        if (targets.Count == 1)
        {
            message = L.T(
                $"确定要结束进程？{modeHint}\n\n{targets[0].Name}  (PID {targets[0].Pid})",
                $"End this process? {modeHint}\n\n{targets[0].Name}  (PID {targets[0].Pid})");
        }
        else
        {
            var preview = string.Join("\n", targets.Take(8).Select(t => $"· {t.Name}  (PID {t.Pid})"));
            if (targets.Count > 8)
                preview += L.T($"\n· …等共 {targets.Count} 个", $"\n· …and {targets.Count} total");
            message = L.T(
                $"确定要批量结束这 {targets.Count} 个进程？{modeHint}\n\n{preview}",
                $"End these {targets.Count} processes? {modeHint}\n\n{preview}");
        }

        var confirm = MessageBox.Show(this, message, L.T("确认结束", "Confirm end"),
            MessageBoxButtons.YesNo, MessageBoxIcon.Warning);

        if (confirm != DialogResult.Yes)
            return;

        _btnKill.Enabled = false;
        var targetsCopy = targets;
        var killTree = entireProcessTree;
        _ = Task.Run(() =>
        {
            var failed = new List<string>();
            foreach (var (pid, name, memMb) in targetsCopy)
            {
                try
                {
                    using var p = Process.GetProcessById(pid);
                    p.Kill(entireProcessTree: killTree);
                    p.WaitForExit(1200);
                }
                catch (Exception ex)
                {
                    failed.Add($"{name}：{ex.Message}");
                }
            }

            if (IsDisposed)
                return;
            try
            {
                BeginInvoke(() =>
                {
                    if (IsDisposed)
                        return;
                    _btnKill.Enabled = true;
                    if (failed.Count > 0)
                    {
                        var detail = string.Join("\n", failed.Take(6));
                        if (failed.Count > 6)
                            detail += L.T($"\n…等共 {failed.Count} 个失败", $"\n…and {failed.Count} failures total");
                        MessageBox.Show(this,
                            L.T(
                                $"部分进程未能结束：\n\n{detail}\n\n可尝试以管理员身份运行本工具。",
                                $"Some processes could not be ended:\n\n{detail}\n\nTry running this tool as administrator."),
                            L.T("部分失败", "Partial failure"),
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Warning);
                    }

                    RefreshData();
                });
            }
            catch
            {
                // disposing
            }
        });
    }

    private void ForceKillSelected()
    {
        if (_list.SelectedItems.Count == 0)
        {
            MessageBox.Show(this,
                L.T(
                    "请先在列表中选择要强制结束的进程。\n\n提示：按住 Ctrl 点选多个，或 Ctrl+A 全选。",
                    "Select processes to force-end first.\n\nTip: Ctrl+click multi-select, or Ctrl+A."),
                L.T("提示", "Notice"),
                MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        var targets = new List<(int Pid, string Name, long MemMb)>();
        foreach (ListViewItem item in _list.SelectedItems)
        {
            if (TryItemPid(item.Tag, out var pid, out var mem))
                targets.Add((pid, item.Text, mem));
        }

        if (targets.Count == 0)
            return;

        var preview = targets.Count == 1
            ? $"{targets[0].Name}  (PID {targets[0].Pid})"
            : string.Join("\n", targets.Take(8).Select(t => $"· {t.Name}  (PID {t.Pid})"))
              + (targets.Count > 8 ? L.T($"\n· …等共 {targets.Count} 个", $"\n· … {targets.Count} total") : "");

        var confirm = MessageBox.Show(this,
            L.T(
                $"【强制结束】将强杀进程树；若权限不足会申请管理员权限。\n\n{preview}\n\n确定继续？",
                $"FORCE END process tree; will request admin if access denied.\n\n{preview}\n\nContinue?"),
            L.T("确认强制结束", "Confirm force end"),
            MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
        if (confirm != DialogResult.Yes)
            return;

        _btnKill.Enabled = false;
        _btnForceKill.Enabled = false;
        var copy = targets;
        _ = Task.Run(() =>
        {
            var killTargets = copy.Select(t => (t.Pid, t.Name)).ToList();
            var (_, failed, elevated) = ElevationUtil.ForceKill(killTargets);
            if (IsDisposed) return;
            try
            {
                BeginInvoke(() =>
                {
                    if (IsDisposed) return;
                    _btnKill.Enabled = true;
                    _btnForceKill.Enabled = true;
                    if (failed.Count > 0)
                    {
                        var detail = string.Join("\n", failed.Take(8));
                        MessageBox.Show(this,
                            L.T($"强制结束后仍有失败：\n\n{detail}",
                                $"Force end still failed:\n\n{detail}"),
                            L.T("部分失败", "Partial failure"),
                            MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    }
                    else if (elevated)
                    {
                        MessageBox.Show(this,
                            L.T("已通过管理员权限强制结束。", "Force-ended with administrator rights."),
                            L.T("完成", "Done"),
                            MessageBoxButtons.OK, MessageBoxIcon.Information);
                    }

                    RefreshData();
                });
            }
            catch { /* disposing */ }
        });
    }

    private static (double usedPct, long usedMb, long totalMb) GetSystemMemory()
    {
        var status = new MEMORYSTATUSEX();
        status.dwLength = (uint)Marshal.SizeOf<MEMORYSTATUSEX>();
        if (!GlobalMemoryStatusEx(ref status))
            return (0, 0, 0);

        var total = (long)(status.ullTotalPhys / (1024UL * 1024UL));
        var avail = (long)(status.ullAvailPhys / (1024UL * 1024UL));
        var used = total - avail;
        var pct = total > 0 ? used * 100.0 / total : 0;
        return (pct, used, total);
    }

    private static bool TryItemPid(object? tag, out int pid, out long memMb)
    {
        switch (tag)
        {
            case ValueTuple<int, long> t:
                pid = t.Item1;
                memMb = t.Item2;
                return true;
            case int i:
                pid = i;
                memMb = 0;
                return true;
            default:
                pid = 0;
                memMb = 0;
                return false;
        }
    }

    private readonly record struct ProcInfo(int Pid, string Name, long MemMb);
    private readonly record struct MemLevel(string Emoji, string Name, string Desc, Color Color);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    private struct MEMORYSTATUSEX
    {
        public uint dwLength;
        public uint dwMemoryLoad;
        public ulong ullTotalPhys;
        public ulong ullAvailPhys;
        public ulong ullTotalPageFile;
        public ulong ullAvailPageFile;
        public ulong ullTotalVirtual;
        public ulong ullAvailVirtual;
        public ulong ullAvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX lpBuffer);
}
