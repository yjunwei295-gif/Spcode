using System.Diagnostics;
using System.Runtime.InteropServices;

namespace MemWatch;

/// <summary>大文件扫描：选盘、按大小筛选、图标/来源、多选删除。</summary>
public sealed class LargeFileScannerForm : Form
{
    private readonly LevelConfig _levels;

    private readonly ComboBox _cboDrive = new();
    private readonly NumericUpDown _numMinMb = new();
    private readonly Button _btnScan = new();
    private readonly Button _btnCancelScan = new();
    private readonly Label _lblStatus = new();
    private readonly Label _lblHint = new();
    private readonly Label _lblDrive = new();
    private readonly Label _lblMin = new();
    private readonly Label _lblMb = new();
    private readonly TabControl _tabs = new();
    private readonly TabPage _pageFiles = new();
    private readonly TabPage _pageSoftware = new();
    private readonly ListView _list = new();
    private readonly ListView _softList = new();
    private readonly Button _btnDelete = new();
    private readonly Button _btnForceDelete = new();
    private readonly Button _btnRefreshSoftware = new();
    private readonly Button _btnUninstall = new();
    private readonly Button _btnClose = new();
    private readonly Button _btnSkin = new();
    private static readonly Color DefaultBack = UiTheme.Back;
    private readonly ImageList _icons = new();
    private readonly Dictionary<int, int> _sysIconMap = new();
    private readonly ContextMenuStrip _itemMenu = new();
    private readonly ToolStripMenuItem _menuDelete = new();
    private readonly ToolStripMenuItem _menuForceDelete = new();
    private readonly ToolStripMenuItem _menuOpenFolder = new();
    private readonly ContextMenuStrip _softMenu = new();
    private readonly ToolStripMenuItem _menuSoftUninstall = new();
    private readonly ToolStripMenuItem _menuSoftOpenFolder = new();

    private CancellationTokenSource? _scanCts;
    private bool _scanning;
    private bool _loadingSoftware;
    private int _softSortCol = 1;
    private bool _softSortAsc;

    public LargeFileScannerForm(LevelConfig levels)
    {
        _levels = levels;
        BuildUi();
        LoadDrives();
        ApplyLanguage();
        L.Changed += OnLanguageChanged;
        FormClosed += (_, _) =>
        {
            L.Changed -= OnLanguageChanged;
            try { _scanCts?.Cancel(); } catch { /* ignore */ }
            try { _scanCts?.Dispose(); } catch { /* ignore */ }
            _scanCts = null;
            try
            {
                _list.SmallImageList = null;
                _icons.Dispose();
            }
            catch { /* ignore */ }
        };

        KeyPreview = true;
        KeyDown += Form_KeyDown;

        if (_levels.LargeFileMinMb is >= 1 and <= 1048576)
            _numMinMb.Value = _levels.LargeFileMinMb;
        else
            _numMinMb.Value = 100;

        if (!string.IsNullOrWhiteSpace(_levels.LargeFileDrive))
        {
            for (var i = 0; i < _cboDrive.Items.Count; i++)
            {
                if (_cboDrive.Items[i] is DriveItem d &&
                    string.Equals(d.Root, _levels.LargeFileDrive, StringComparison.OrdinalIgnoreCase))
                {
                    _cboDrive.SelectedIndex = i;
                    break;
                }
            }
        }

        TopMost = false;

        FormClosing += (_, _) =>
        {
            if (_scanning)
                _scanCts?.Cancel();
            PersistScannerSettings();
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

        var selectedRoot = _cboDrive.SelectedItem is DriveItem sel ? sel.Root : null;
        ApplyLanguage();
        LoadDrives();
        if (!string.IsNullOrWhiteSpace(selectedRoot))
        {
            for (var i = 0; i < _cboDrive.Items.Count; i++)
            {
                if (_cboDrive.Items[i] is DriveItem d &&
                    string.Equals(d.Root, selectedRoot, StringComparison.OrdinalIgnoreCase))
                {
                    _cboDrive.SelectedIndex = i;
                    break;
                }
            }
        }

        // 列表内标签/来源为扫描时语言；切换语言后仅更新外壳，需重新扫描才刷新条目
        if (!_scanning)
            RefreshListAfterDelete();
    }

    private void ApplyLanguage()
    {
        Text = L.T("大文件扫描器", "Large File Scanner");
        _lblDrive.Text = L.T("硬盘", "Drive");
        _lblMin.Text = L.T("大于", "Over");
        _lblMb.Text = "MB";
        _btnScan.Text = L.T("扫描", "Scan");
        _btnCancelScan.Text = L.T("停止", "Stop");
        _btnDelete.Text = L.T("删除选中", "Delete selected");
        _btnForceDelete.Text = L.T("强制删除", "Force delete");
        _btnRefreshSoftware.Text = L.T("刷新软件列表", "Refresh software");
        _btnUninstall.Text = L.T("强力卸载", "Force uninstall");
        _btnClose.Text = L.T("关闭", "Close");
        _btnSkin.Text = L.T("皮肤", "Skin");
        _pageFiles.Text = L.T("大文件", "Large files");
        _pageSoftware.Text = L.T("已安装软件", "Installed software");
        _menuOpenFolder.Text = L.T("打开文件目录", "Open folder");
        _menuDelete.Text = L.T("删除", "Delete");
        _menuForceDelete.Text = L.T("强制删除", "Force delete");
        _menuSoftOpenFolder.Text = L.T("打开安装目录", "Open install folder");
        _menuSoftUninstall.Text = L.T("强力卸载", "Force uninstall");

        if (_list.Columns.Count >= 4)
        {
            _list.Columns[0].Text = L.T("文件", "File");
            _list.Columns[1].Text = L.T("大小", "Size");
            _list.Columns[2].Text = L.T("来源", "Source");
            _list.Columns[3].Text = L.T("路径", "Path");
        }

        if (_softList.Columns.Count >= 5)
        {
            _softList.Columns[0].Text = L.T("软件名称", "Name");
            _softList.Columns[1].Text = L.T("占用", "Size");
            _softList.Columns[2].Text = L.T("版本", "Version");
            _softList.Columns[3].Text = L.T("发布者", "Publisher");
            _softList.Columns[4].Text = L.T("安装位置", "Install location");
        }

        UpdateStatusForActiveTab();
    }

    private void UpdateStatusForActiveTab()
    {
        if (_scanning) return;
        if (_tabs.SelectedTab == _pageSoftware)
        {
            _lblStatus.Text = L.T(
                "选择硬盘后点「刷新软件列表」，列出该盘已安装软件 · 可强力卸载",
                "Pick a drive, refresh to list installed software · force uninstall available");
            _lblHint.Text = L.T("已安装软件（按当前盘筛选）", "Installed software (filtered by drive)");
        }
        else
        {
            _lblStatus.Text = L.T(
                "选择硬盘后点击扫描（已排除 Windows / 系统应用）· F5 刷新",
                "Pick a drive and scan (Windows / system apps excluded) · F5 refresh");
            if (_list.Items.Count == 0)
                _lblHint.Text = L.T("大文件列表", "Large files");
        }
    }

    private void PersistScannerSettings()
    {
        _levels.LargeFileMinMb = (int)_numMinMb.Value;
        if (_cboDrive.SelectedItem is DriveItem d)
            _levels.LargeFileDrive = d.Root;
        _levels.Save();
    }

    private void BuildUi()
    {
        Text = L.T("大文件扫描器", "Large File Scanner");
        FormBorderStyle = FormBorderStyle.Sizable;
        MaximizeBox = true;
        MinimizeBox = true;
        ShowInTaskbar = true;
        StartPosition = FormStartPosition.CenterParent;
        Font = new Font("Segoe UI", 9f);
        BackColor = DefaultBack;
        DoubleBuffered = true;
        MinimumSize = new Size(640, 420);
        ClientSize = new Size(900, 560);

        const int pad = 8;
        const int topH = 78;
        const int bottomH = 48;

        var top = new Panel
        {
            Dock = DockStyle.Top,
            Height = topH,
            BackColor = Color.Transparent
        };
        var bottom = new Panel
        {
            Dock = DockStyle.Bottom,
            Height = bottomH,
            BackColor = Color.Transparent
        };

        _lblDrive.Text = L.T("硬盘", "Drive");
        _lblDrive.Location = new Point(pad, 10);
        _lblDrive.Size = new Size(36, 22);
        _lblDrive.TextAlign = ContentAlignment.MiddleLeft;

        _cboDrive.DropDownStyle = ComboBoxStyle.DropDownList;
        _cboDrive.Location = new Point(44, 8);
        _cboDrive.Size = new Size(220, 24);

        _lblMin.Text = L.T("大于", "Over");
        _lblMin.Location = new Point(274, 10);
        _lblMin.Size = new Size(36, 22);
        _lblMin.TextAlign = ContentAlignment.MiddleLeft;

        _numMinMb.Minimum = 1;
        _numMinMb.Maximum = 1048576;
        _numMinMb.Increment = 50;
        _numMinMb.Value = 100;
        _numMinMb.Location = new Point(310, 8);
        _numMinMb.Size = new Size(70, 22);

        _lblMb.Text = "MB";
        _lblMb.Location = new Point(382, 10);
        _lblMb.Size = new Size(28, 22);
        _lblMb.TextAlign = ContentAlignment.MiddleLeft;

        _btnScan.Text = L.T("扫描", "Scan");
        _btnScan.Location = new Point(414, 6);
        _btnScan.Size = new Size(66, 26);
        _btnScan.Click += async (_, _) => await StartScanAsync();

        _btnCancelScan.Text = L.T("停止", "Stop");
        _btnCancelScan.Location = new Point(414, 6);
        _btnCancelScan.Size = new Size(66, 26);
        _btnCancelScan.Visible = false;
        _btnCancelScan.Click += (_, _) => _scanCts?.Cancel();

        _lblStatus.AutoSize = false;
        _lblStatus.Location = new Point(pad, 36);
        _lblStatus.Size = new Size(ClientSize.Width - pad * 2, 18);
        _lblStatus.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        _lblStatus.ForeColor = Color.DimGray;
        _lblStatus.Font = new Font("Segoe UI", 8f);
        _lblStatus.Text = L.T(
            "选择硬盘后点击扫描（已排除 Windows / 系统应用）· F5 刷新",
            "Pick a drive and scan (Windows / system apps excluded) · F5 refresh");

        _lblHint.AutoSize = false;
        _lblHint.Location = new Point(pad, 54);
        _lblHint.Size = new Size(ClientSize.Width - pad * 2, 18);
        _lblHint.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        _lblHint.ForeColor = Color.DimGray;
        _lblHint.Font = new Font("Segoe UI", 8f);
        _lblHint.Text = L.T("大文件列表", "Large files");

        ResetIconList();

        _tabs.Dock = DockStyle.Fill;
        _pageFiles.Text = L.T("大文件", "Large files");
        _pageSoftware.Text = L.T("已安装软件", "Installed software");
        _tabs.TabPages.Add(_pageFiles);
        _tabs.TabPages.Add(_pageSoftware);
        _tabs.SelectedIndexChanged += (_, _) => OnTabChanged();

        // —— 大文件页 ——
        _list.Dock = DockStyle.Fill;
        _list.View = View.Details;
        _list.FullRowSelect = true;
        _list.MultiSelect = true;
        _list.GridLines = false;
        _list.BorderStyle = BorderStyle.FixedSingle;
        _list.HeaderStyle = ColumnHeaderStyle.Clickable;
        _list.HideSelection = false;
        _list.SmallImageList = _icons;
        _list.Scrollable = true;
        _list.Columns.Add(L.T("文件", "File"), 280);
        _list.Columns.Add(L.T("大小", "Size"), 90);
        _list.Columns.Add(L.T("来源", "Source"), 180);
        _list.Columns.Add(L.T("路径", "Path"), 400);
        _list.KeyDown += List_KeyDown;
        _list.ShowItemToolTips = true;
        _list.Resize += (_, _) => FitPathColumn();
        _list.MouseUp += List_MouseUp;

        _menuOpenFolder.Text = L.T("打开文件目录", "Open folder");
        _menuOpenFolder.Click += (_, _) => OpenSelectedFolder();
        _menuDelete.Text = L.T("删除", "Delete");
        _menuDelete.Click += (_, _) => DeleteSelected(force: false);
        _menuForceDelete.Text = L.T("强制删除", "Force delete");
        _menuForceDelete.Click += (_, _) => DeleteSelected(force: true);
        _itemMenu.Items.AddRange(new ToolStripItem[] { _menuOpenFolder, _menuDelete, _menuForceDelete });
        _itemMenu.Opening += (_, e) =>
        {
            if (_list.SelectedItems.Count == 0)
                e.Cancel = true;
        };
        _list.ContextMenuStrip = _itemMenu;

        var filesBar = new Panel { Dock = DockStyle.Bottom, Height = 40 };
        _btnDelete.Text = L.T("删除选中", "Delete selected");
        _btnDelete.Size = new Size(90, 28);
        _btnDelete.Location = new Point(8, 6);
        _btnDelete.Click += (_, _) => DeleteSelected(force: false);
        _btnForceDelete.Text = L.T("强制删除", "Force delete");
        _btnForceDelete.Size = new Size(90, 28);
        _btnForceDelete.Location = new Point(104, 6);
        UiTheme.FlattenButton(_btnForceDelete, UiTheme.Danger);
        _btnForceDelete.Click += (_, _) => DeleteSelected(force: true);
        filesBar.Controls.Add(_btnDelete);
        filesBar.Controls.Add(_btnForceDelete);
        _pageFiles.Controls.Add(_list);
        _pageFiles.Controls.Add(filesBar);

        // —— 已安装软件页 ——
        _softList.Dock = DockStyle.Fill;
        _softList.View = View.Details;
        _softList.FullRowSelect = true;
        _softList.MultiSelect = true;
        _softList.GridLines = false;
        _softList.BorderStyle = BorderStyle.FixedSingle;
        _softList.HeaderStyle = ColumnHeaderStyle.Clickable;
        _softList.HideSelection = false;
        _softList.Scrollable = true;
        _softList.Columns.Add(L.T("软件名称", "Name"), 220);
        _softList.Columns.Add(L.T("占用", "Size"), 90);
        _softList.Columns.Add(L.T("版本", "Version"), 90);
        _softList.Columns.Add(L.T("发布者", "Publisher"), 140);
        _softList.Columns.Add(L.T("安装位置", "Install location"), 320);
        _softList.ShowItemToolTips = true;
        _softList.ColumnClick += SoftList_ColumnClick;

        _menuSoftOpenFolder.Text = L.T("打开安装目录", "Open install folder");
        _menuSoftOpenFolder.Click += (_, _) => OpenSelectedSoftwareFolder();
        _menuSoftUninstall.Text = L.T("强力卸载", "Force uninstall");
        _menuSoftUninstall.Click += (_, _) => UninstallSelectedSoftware();
        _softMenu.Items.AddRange(new ToolStripItem[] { _menuSoftOpenFolder, _menuSoftUninstall });
        _softMenu.Opening += (_, e) =>
        {
            if (_softList.SelectedItems.Count == 0)
                e.Cancel = true;
        };
        _softList.ContextMenuStrip = _softMenu;
        _softList.DoubleClick += (_, _) => UninstallSelectedSoftware();

        var softBar = new Panel { Dock = DockStyle.Bottom, Height = 40 };
        _btnRefreshSoftware.Text = L.T("刷新软件列表", "Refresh software");
        _btnRefreshSoftware.Size = new Size(110, 28);
        _btnRefreshSoftware.Location = new Point(8, 6);
        _btnRefreshSoftware.Click += (_, _) => LoadSoftwareForSelectedDrive();
        _btnUninstall.Text = L.T("强力卸载", "Force uninstall");
        _btnUninstall.Size = new Size(90, 28);
        _btnUninstall.Location = new Point(124, 6);
        UiTheme.FlattenButton(_btnUninstall, UiTheme.Warn);
        _btnUninstall.Click += (_, _) => UninstallSelectedSoftware();
        softBar.Controls.Add(_btnRefreshSoftware);
        softBar.Controls.Add(_btnUninstall);
        _pageSoftware.Controls.Add(_softList);
        _pageSoftware.Controls.Add(softBar);

        _btnClose.Text = L.T("关闭", "Close");
        _btnClose.Size = new Size(70, 28);
        _btnClose.Anchor = AnchorStyles.Bottom | AnchorStyles.Right;
        _btnClose.Location = new Point(8, 10);
        _btnClose.Click += (_, _) => Close();

        _btnSkin.Text = L.T("皮肤", "Skin");
        _btnSkin.Size = new Size(56, 28);
        _btnSkin.Anchor = AnchorStyles.Bottom | AnchorStyles.Right;
        _btnSkin.Location = new Point(8, 10);
        _btnSkin.Click += (_, _) =>
            WindowSkin.ShowPicker(this, _levels, WindowSkin.KeyLargeFiles, DefaultBack, _btnSkin);

        _cboDrive.SelectedIndexChanged += (_, _) =>
        {
            if (_tabs.SelectedTab == _pageSoftware)
                LoadSoftwareForSelectedDrive();
        };

        top.Controls.AddRange(new Control[]
        {
            _lblDrive, _cboDrive, _lblMin, _numMinMb, _lblMb,
            _btnScan, _btnCancelScan, _lblStatus, _lblHint
        });
        bottom.Controls.Add(_btnSkin);
        bottom.Controls.Add(_btnClose);
        Controls.Add(_tabs);
        Controls.Add(top);
        Controls.Add(bottom);

        void LayoutTop()
        {
            var w = top.ClientSize.Width;
            var right = w - pad;
            _btnScan.Left = right - _btnScan.Width;
            _btnCancelScan.Left = _btnScan.Left;
            _lblMb.Left = _btnScan.Left - 8 - _lblMb.Width;
            _numMinMb.Left = _lblMb.Left - 4 - _numMinMb.Width;
            _lblMin.Left = _numMinMb.Left - 4 - _lblMin.Width;
            _cboDrive.Width = Math.Max(120, _lblMin.Left - 12 - _cboDrive.Left);

            _btnClose.Location = new Point(bottom.ClientSize.Width - pad - _btnClose.Width, 10);
            _btnSkin.Location = new Point(_btnClose.Left - 8 - _btnSkin.Width, 10);
            UpdateTopToolsVisibility();
        }

        LayoutTop();
        top.Resize += (_, _) => LayoutTop();
        bottom.Resize += (_, _) => LayoutTop();

        UiTheme.StyleTree(this);
        EchoChrome.Attach(this, canResize: true, showMin: true);
        WindowSkin.Apply(this, _levels, WindowSkin.KeyLargeFiles, DefaultBack);
    }

    private void OnTabChanged()
    {
        UpdateTopToolsVisibility();
        UpdateStatusForActiveTab();
        if (_tabs.SelectedTab == _pageSoftware && _softList.Items.Count == 0)
            LoadSoftwareForSelectedDrive();
    }

    private void UpdateTopToolsVisibility()
    {
        var files = _tabs.SelectedTab == _pageFiles;
        _lblMin.Visible = files;
        _numMinMb.Visible = files;
        _lblMb.Visible = files;
        _btnScan.Visible = files && !_scanning;
        _btnCancelScan.Visible = files && _scanning;
    }

    private void LoadDrives()
    {
        _cboDrive.Items.Clear();
        foreach (var drive in DriveInfo.GetDrives())
        {
            try
            {
                if (!drive.IsReady || drive.DriveType is not (DriveType.Fixed or DriveType.Removable))
                    continue;

                var label = string.IsNullOrWhiteSpace(drive.VolumeLabel)
                    ? L.T("本地磁盘", "Local Disk")
                    : drive.VolumeLabel;
                var freeGb = drive.AvailableFreeSpace / (1024d * 1024d * 1024d);
                var totalGb = drive.TotalSize / (1024d * 1024d * 1024d);
                _cboDrive.Items.Add(new DriveItem(drive.Name, $"{drive.Name} {label} ({freeGb:0.0}/{totalGb:0.0} GB)"));
            }
            catch
            {
                // 跳过不可读磁盘
            }
        }

        if (_cboDrive.Items.Count > 0)
            _cboDrive.SelectedIndex = 0;
    }

    private async Task StartScanAsync()
    {
        if (_scanning)
            return;

        if (_cboDrive.SelectedItem is not DriveItem drive)
        {
            MessageBox.Show(this,
                L.T("请先选择硬盘。", "Select a drive first."),
                L.T("提示", "Notice"),
                MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        var minMb = (int)_numMinMb.Value;
        var minBytes = minMb * 1024L * 1024L;

        PersistScannerSettings();

        _scanning = true;
        _btnScan.Visible = false;
        _btnCancelScan.Visible = true;
        _btnDelete.Enabled = false;
        _btnForceDelete.Enabled = false;
        _btnRefreshSoftware.Enabled = false;
        _btnUninstall.Enabled = false;
        _cboDrive.Enabled = false;
        _numMinMb.Enabled = false;
        UpdateTopToolsVisibility();

        // 准备空列表，边扫边追加
        _list.SmallImageList = null;
        ResetIconList();
        _list.Items.Clear();
        _list.SmallImageList = _icons;

        _lblHint.Text = L.T("正在扫描…已找到 0 个", "Scanning… found 0");
        _lblStatus.Text = L.T(
            $"扫描 {drive.Root}，大于 {minMb} MB…",
            $"Scanning {drive.Root}, over {minMb} MB…");

        _scanCts = new CancellationTokenSource();
        var token = _scanCts.Token;
        var foundCount = 0;
        var scanned = 0;
        string? currentDir = null;

        try
        {
            await Task.Run(() =>
            {
                var batch = new List<FileInfoItem>(24);
                var lastFlush = Stopwatch.StartNew();

                void FlushBatch(bool force)
                {
                    if (batch.Count == 0)
                        return;
                    if (!force && batch.Count < 16 && lastFlush.ElapsedMilliseconds < 120)
                        return;

                    var toFlush = batch.ToArray();
                    batch.Clear();
                    lastFlush.Restart();
                    var count = Volatile.Read(ref foundCount);
                    BeginInvoke(() =>
                    {
                        if (IsDisposed)
                            return;
                        _list.BeginUpdate();
                        try
                        {
                            foreach (var f in toFlush)
                                AppendFileItem(f);
                        }
                        finally
                        {
                            _list.EndUpdate();
                        }

                        _lblHint.Text = L.T($"正在扫描…已找到 {count} 个", $"Scanning… found {count}");
                    });
                }

                foreach (var (path, size) in EnumerateLargeFiles(drive.Root, minBytes, token,
                             dir =>
                             {
                                 currentDir = dir;
                                 var snapCount = Interlocked.Increment(ref scanned);
                                 if (snapCount % 40 == 0)
                                 {
                                     var snapDir = currentDir;
                                     var snapFound = Volatile.Read(ref foundCount);
                                     BeginInvoke(() =>
                                     {
                                         if (IsDisposed || !_scanning)
                                             return;
                                         _lblStatus.Text = L.T(
                                             $"已扫 {snapCount} 个目录，找到 {snapFound} 个 · {Truncate(snapDir, 48)}",
                                             $"Scanned {snapCount} folders, found {snapFound} · {Truncate(snapDir, 48)}");
                                     });
                                 }
                             }))
                {
                    var source = ResolveSource(path);
                    var tag = ResolveTag(path);
                    var info = new FileInfoItem(path, size, source, tag);
                    Interlocked.Increment(ref foundCount);
                    batch.Add(info);
                    FlushBatch(force: false);
                }

                FlushBatch(force: true);
            }, token);

            var total = Volatile.Read(ref foundCount);
            _lblStatus.Text = token.IsCancellationRequested
                ? L.T($"已停止。共找到 {total} 个大文件", $"Stopped. Found {total} large file(s)")
                : L.T($"扫描完成。共找到 {total} 个大文件（≥ {minMb} MB）",
                    $"Done. Found {total} large file(s) (≥ {minMb} MB)");
            _lblHint.Text = total == 0
                ? L.T("未找到符合条件的大文件", "No matching large files")
                : L.T($"共 {total} 个大文件", $"{total} large file(s)");
            BeginInvoke(AutoSizeColumns);
        }
        catch (OperationCanceledException)
        {
            var total = Volatile.Read(ref foundCount);
            _lblStatus.Text = L.T($"已停止。共找到 {total} 个大文件", $"Stopped. Found {total} large file(s)");
            _lblHint.Text = total == 0
                ? L.T("未找到符合条件的大文件", "No matching large files")
                : L.T($"共 {total} 个大文件", $"{total} large file(s)");
            BeginInvoke(AutoSizeColumns);
        }
        catch (Exception ex)
        {
            _lblStatus.Text = L.T($"扫描出错：{ex.Message}", $"Scan error: {ex.Message}");
            MessageBox.Show(this,
                L.T($"扫描失败：{ex.Message}", $"Scan failed: {ex.Message}"),
                L.T("错误", "Error"),
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        finally
        {
            _scanning = false;
            _btnCancelScan.Visible = false;
            _btnScan.Visible = true;
            _btnDelete.Enabled = true;
            _btnForceDelete.Enabled = true;
            _btnRefreshSoftware.Enabled = true;
            _btnUninstall.Enabled = true;
            _cboDrive.Enabled = true;
            _numMinMb.Enabled = true;
            UpdateTopToolsVisibility();
            UpdateStatusForActiveTab();
            _scanCts?.Dispose();
            _scanCts = null;
        }
    }

    /// <summary>将单个结果按大小插入列表（降序）。</summary>
    private void AppendFileItem(FileInfoItem f)
    {
        var name = Path.GetFileName(f.Path);
        if (string.IsNullOrEmpty(name))
            name = f.Path;

        var iconIdx = GetFileIconIndex(f.Path);
        var item = new ListViewItem($"[{f.Tag}] {name}")
        {
            ImageIndex = iconIdx,
            Tag = (f.Path, f.SizeBytes),
            ToolTipText = BuildItemToolTip(f)
        };
        item.SubItems.Add(FormatSize(f.SizeBytes));
        item.SubItems.Add(f.Source);
        item.SubItems.Add(f.Path);

        var insertAt = _list.Items.Count;
        for (var i = 0; i < _list.Items.Count; i++)
        {
            if (_list.Items[i].Tag is not (string _, long otherSize))
                continue;
            if (f.SizeBytes > otherSize)
            {
                insertAt = i;
                break;
            }
        }

        _list.Items.Insert(insertAt, item);
    }

    private void FillList(List<FileInfoItem> files)
    {
        // 先断开 ListView，重建合法图标列表（避免已释放位图导致 CreateHandle 崩溃）
        _list.SmallImageList = null;
        ResetIconList();

        var iconIndexes = new int[files.Count];
        for (var i = 0; i < files.Count; i++)
            iconIndexes[i] = GetFileIconIndex(files[i].Path);

        _list.BeginUpdate();
        try
        {
            _list.Items.Clear();

            for (var i = 0; i < files.Count; i++)
            {
                var f = files[i];
                var name = Path.GetFileName(f.Path);
                if (string.IsNullOrEmpty(name))
                    name = f.Path;

                var item = new ListViewItem($"[{f.Tag}] {name}")
                {
                    ImageIndex = iconIndexes[i],
                    Tag = (f.Path, f.SizeBytes),
                    ToolTipText = BuildItemToolTip(f)
                };
                item.SubItems.Add(FormatSize(f.SizeBytes));
                item.SubItems.Add(f.Source);
                item.SubItems.Add(f.Path);
                _list.Items.Add(item);
            }
        }
        finally
        {
            _list.EndUpdate();
        }

        _list.SmallImageList = _icons;
        _list.Invalidate();

        BeginInvoke(AutoSizeColumns);

        _lblHint.Text = files.Count == 0
            ? L.T("未找到符合条件的大文件", "No matching large files")
            : L.T($"共 {files.Count} 个大文件", $"{files.Count} large file(s)");
    }

    /// <summary>重建 ImageList，占位图不 Dispose（ImageList 会长期引用）。</summary>
    private void ResetIconList()
    {
        _sysIconMap.Clear();
        try
        {
            _icons.Images.Clear();
        }
        catch
        {
            // handle 异常时忽略
        }

        _icons.ColorDepth = ColorDepth.Depth32Bit;
        _icons.ImageSize = new Size(16, 16);

        var placeholder = new Bitmap(16, 16);
        using (var g = Graphics.FromImage(placeholder))
        {
            g.Clear(UiTheme.Surface);
            using var pen = new Pen(UiTheme.Line);
            g.DrawRectangle(pen, 0, 0, 15, 15);
        }

        _icons.Images.Add(placeholder);
    }

    private int GetFileIconIndex(string path)
    {
        try
        {
            var shfi = new SHFILEINFO();
            var flags = SHGFI_ICON | SHGFI_SMALLICON | SHGFI_SYSICONINDEX;
            var himl = SHGetFileInfo(path, 0, ref shfi, (uint)Marshal.SizeOf<SHFILEINFO>(), flags);
            if (himl == IntPtr.Zero || shfi.hIcon == IntPtr.Zero)
                return 0;

            if (_sysIconMap.TryGetValue(shfi.iIcon, out var existing))
            {
                DestroyIcon(shfi.hIcon);
                return existing;
            }

            // FromHandle 不拥有句柄：先 Clone 再 Destroy，再用 Add(Icon)（内部会再 Clone）
            using var temp = Icon.FromHandle(shfi.hIcon);
            using var owned = (Icon)temp.Clone();
            DestroyIcon(shfi.hIcon);

            var idx = _icons.Images.Count;
            _icons.Images.Add(owned);
            _sysIconMap[shfi.iIcon] = idx;
            return idx;
        }
        catch
        {
            return 0;
        }
    }

    /// <summary>按内容撑开列宽；路径过长可横向滚动。</summary>
    private void AutoSizeColumns()
    {
        if (_list.IsDisposed || _list.Columns.Count < 4 || _list.ClientSize.Width <= 0)
            return;

        try
        {
            using var g = _list.CreateGraphics();
            var font = _list.Font;

            float maxName = TextRenderer.MeasureText(g, L.T("文件", "File"), font).Width + 28;
            float maxSize = TextRenderer.MeasureText(g, L.T("大小", "Size"), font).Width + 16;
            float maxSource = TextRenderer.MeasureText(g, L.T("来源", "Source"), font).Width + 16;
            float maxPath = TextRenderer.MeasureText(g, L.T("路径", "Path"), font).Width + 16;

            foreach (ListViewItem item in _list.Items)
            {
                maxName = Math.Max(maxName, TextRenderer.MeasureText(g, item.Text, font).Width + 28);
                if (item.SubItems.Count > 1)
                    maxSize = Math.Max(maxSize, TextRenderer.MeasureText(g, item.SubItems[1].Text, font).Width + 16);
                if (item.SubItems.Count > 2)
                    maxSource = Math.Max(maxSource, TextRenderer.MeasureText(g, item.SubItems[2].Text, font).Width + 16);
                if (item.SubItems.Count > 3)
                    maxPath = Math.Max(maxPath, TextRenderer.MeasureText(g, item.SubItems[3].Text, font).Width + 16);
            }

            _list.Columns[0].Width = Math.Clamp((int)Math.Ceiling(maxName), 120, 360);
            _list.Columns[1].Width = Math.Clamp((int)Math.Ceiling(maxSize), 70, 100);
            _list.Columns[2].Width = Math.Clamp((int)Math.Ceiling(maxSource), 80, 280);
            _list.Columns[3].Width = Math.Max(200, (int)Math.Ceiling(maxPath));

            FitPathColumn();
        }
        catch
        {
            // 忽略量宽失败
        }
    }

    private void FitPathColumn()
    {
        if (_list.Columns.Count < 4 || _list.ClientSize.Width <= 0)
            return;

        var used = _list.Columns[0].Width + _list.Columns[1].Width + _list.Columns[2].Width;
        var remain = _list.ClientSize.Width - used - SystemInformation.VerticalScrollBarWidth - 8;
        if (remain > _list.Columns[3].Width)
            _list.Columns[3].Width = remain;
    }

    private void RefreshListAfterDelete()
    {
        _lblHint.Text = _list.Items.Count == 0
            ? L.T("未找到符合条件的大文件", "No matching large files")
            : L.T($"共 {_list.Items.Count} 个大文件", $"{_list.Items.Count} large file(s)");
    }

    private static string BuildItemToolTip(FileInfoItem f)
    {
        var impact = ResolveDeleteImpact(f.Path, f.Tag);
        return L.T(
            $"路径：{f.Path}\n来源：{f.Source}\n类型：{f.Tag}\n\n删除影响：\n{impact}",
            $"Path: {f.Path}\nSource: {f.Source}\nType: {f.Tag}\n\nDelete impact:\n{impact}");
    }

    /// <summary>根据类型与路径，生成删除后果说明（仅用于悬停提示）。</summary>
    private static string ResolveDeleteImpact(string path, string tag)
    {
        var name = Path.GetFileName(path) ?? "";
        var nameLower = name.ToLowerInvariant();
        var dir = Path.GetDirectoryName(path) ?? "";
        var dirLower = dir.ToLowerInvariant();

        // 匹配中英标签键
        if (TagIs(tag, "安装程序", "Installer"))
            return L.T(
                "一般可删。删除后仍可从官网重新下载安装包；若这是你唯一的离线安装包，删了就得重新下载。",
                "Usually safe. You can re-download the installer; if this was your only offline copy, you'll need to download again.");

        if (TagIs(tag, "压缩包", "Archive"))
            return L.T(
                "通常可删（确认已解压或不再需要）。删除后压缩包内文件无法再从此处恢复（除非回收站还原）。",
                "Usually safe if already extracted. Contents can't be recovered from here (except Recycle Bin).");

        if (TagIs(tag, "光盘镜像", "Disk image"))
            return L.T(
                "删除后无法再挂载/刻录该镜像。若系统或软件靠它安装，删了可能要重新下载。",
                "You won't be able to mount/burn this image. Re-download if installers depended on it.");

        if (TagIs(tag, "虚拟磁盘", "Virtual disk"))
            return L.T(
                "高风险：可能是虚拟机磁盘或系统映像。删除会导致虚拟机无法启动或备份丢失。",
                "High risk: may be a VM disk or system image. Deleting can break VMs or lose backups.");

        if (TagIs(tag, "视频", "Video") || TagIs(tag, "音频", "Audio") || TagIs(tag, "图片", "Image"))
            return L.T(
                "删除后媒体文件本身会丢失。若无其它备份，内容不可恢复（回收站可暂缓）。",
                "Media content will be lost without other backups (Recycle Bin may help briefly).");

        if (TagIs(tag, "设计稿", "Design") || TagIs(tag, "三维模型", "3D model"))
            return L.T(
                "删除后工程/素材丢失，相关项目可能打不开或缺资源。建议先确认已备份。",
                "Project assets may be lost. Back up first.");

        if (TagIs(tag, "文档", "Document"))
            return L.T(
                "删除后文档内容丢失。若被业务/作业使用，可能影响后续查阅。",
                "Document content will be lost and may affect later access.");

        if (TagIs(tag, "游戏资源", "Game asset"))
            return L.T(
                "删除后对应游戏可能缺资源、无法启动或需 Steam/启动器校验修复（重新下载）。",
                "Game may fail or need Steam/launcher repair (re-download).");

        if (TagIs(tag, "数据库", "Database"))
            return L.T(
                "高风险：可能是软件本地数据库。删除后软件设置、历史记录或工程数据可能丢失。",
                "High risk: may be a local DB. Settings/history/project data may be lost.");

        if (TagIs(tag, "模型权重", "Model weights"))
            return L.T(
                "删除后 AI/本地模型需重新下载，相关应用可能无法推理。",
                "AI/local models must be re-downloaded; apps may stop working.");

        if (TagIs(tag, "崩溃转储", "Crash dump"))
            return L.T(
                "一般可删，仅用于排查崩溃。删除不影响日常使用，但以后无法再用它分析这次崩溃。",
                "Usually safe; only for crash analysis. You won't be able to diagnose this dump later.");

        if (TagIs(tag, "备份", "Backup"))
            return L.T(
                "删除后失去该备份还原点。确认已有更新备份或不需要再还原后再删。",
                "You lose this restore point. Keep a newer backup if you still need one.");

        if (TagIs(tag, "程序", "Program"))
            return path.Contains(@"\Program Files", StringComparison.OrdinalIgnoreCase) ||
                   path.Contains(@"\AppData\", StringComparison.OrdinalIgnoreCase)
                ? L.T(
                    "可能影响该软件运行。建议优先用「卸载程序」卸载，而不是直接删单个 exe。",
                    "May break the app. Prefer uninstall instead of deleting a single exe.")
                : L.T(
                    "删除后该程序可能无法启动。若只是安装包/绿色版拷贝，通常可再下载。",
                    "The program may not start. Portable/installer copies can usually be re-downloaded.");

        if (TagIs(tag, "动态库", "DLL"))
            return L.T(
                "高风险：删除 DLL 常导致软件/游戏报错无法启动，不建议手动删除。",
                "High risk: deleting DLLs often breaks apps/games.");

        return GuessGenericImpact(path, nameLower, dirLower);
    }

    private static bool TagIs(string tag, string zh, string en) =>
        string.Equals(tag, zh, StringComparison.Ordinal) ||
        string.Equals(tag, en, StringComparison.OrdinalIgnoreCase);

    private static string GuessGenericImpact(string path, string nameLower, string dirLower)
    {
        if (dirLower.Contains(@"\temp") || dirLower.Contains(@"\tmp") || nameLower.EndsWith(".tmp"))
            return L.T(
                "多为临时文件，删除通常安全；个别安装程序正在使用时可能删不掉。",
                "Usually temp files; safe to delete unless an installer is using them.");

        if (dirLower.Contains(@"\downloads") || dirLower.Contains(@"\下载"))
            return L.T(
                "下载目录文件，删了一般只是少了这个下载项，需要时再下即可。",
                "Downloads folder item; re-download if needed.");

        if (dirLower.Contains(@"\appdata\local") || dirLower.Contains(@"\appdata\roaming"))
            return L.T(
                "可能是软件缓存或用户数据。删缓存通常可腾空间；删数据可能导致登录态/设置丢失。",
                "May be cache or user data. Cache is usually safe; data may lose logins/settings.");

        if (dirLower.Contains(@"\steamapps\"))
            return L.T(
                "Steam 游戏相关文件，删除后游戏可能损坏，需校验完整性重新下载。",
                "Steam game files; may need integrity check / re-download.");

        if (nameLower.EndsWith(".log"))
            return L.T(
                "日志文件，删除通常不影响功能，只是少了历史排查信息。",
                "Log file; usually safe, but you lose history for troubleshooting.");

        return L.T(
            "删除会释放磁盘空间，但该文件将不可用。不确定用途时建议先移到回收站观察几天。",
            "Frees space but the file becomes unavailable. Prefer Recycle Bin if unsure.");
    }

    /// <summary>根据扩展名与文件名推断类型标签。</summary>
    private static string ResolveTag(string path)
    {
        var name = Path.GetFileName(path) ?? "";
        var nameLower = name.ToLowerInvariant();
        var ext = Path.GetExtension(path).ToLowerInvariant();

        // 安装程序（优先于普通 exe）
        if (ext is ".msi" or ".msix" or ".appx" or ".appxbundle")
            return L.T("安装程序", "Installer");
        if (ext == ".exe" && IsInstallerName(nameLower))
            return L.T("安装程序", "Installer");

        if (ext is ".zip" or ".rar" or ".7z" or ".tar" or ".gz" or ".tgz" or ".bz2" or ".xz" or ".cab" or ".lz4")
            return L.T("压缩包", "Archive");

        if (ext is ".iso" or ".img" or ".dmg" or ".nrg")
            return L.T("光盘镜像", "Disk image");

        if (ext is ".vhd" or ".vhdx" or ".vmdk" or ".wim" or ".esd")
            return L.T("虚拟磁盘", "Virtual disk");

        if (ext is ".mp4" or ".mkv" or ".avi" or ".mov" or ".wmv" or ".flv" or ".webm" or ".m4v"
            or ".rmvb" or ".ts" or ".m2ts" or ".mpeg" or ".mpg")
            return L.T("视频", "Video");

        if (ext is ".mp3" or ".flac" or ".wav" or ".aac" or ".m4a" or ".wma" or ".ape" or ".ogg" or ".opus")
            return L.T("音频", "Audio");

        if (ext is ".psd" or ".psb" or ".ai" or ".sketch" or ".xd" or ".fig")
            return L.T("设计稿", "Design");

        if (ext is ".jpg" or ".jpeg" or ".png" or ".gif" or ".bmp" or ".webp" or ".tif" or ".tiff"
            or ".raw" or ".cr2" or ".nef" or ".heic")
            return L.T("图片", "Image");

        if (ext is ".c4d" or ".blend" or ".max" or ".ma" or ".mb" or ".fbx" or ".obj" or ".stl" or ".3ds")
            return L.T("三维模型", "3D model");

        if (ext is ".pdf" or ".doc" or ".docx" or ".ppt" or ".pptx" or ".xls" or ".xlsx" or ".csv" or ".rtf")
            return L.T("文档", "Document");

        if (ext is ".ba2" or ".bsa" or ".pak" or ".vpk" or ".arc" or ".assets" or ".bundle" or ".unity3d" or ".rpak")
            return L.T("游戏资源", "Game asset");

        if (path.Contains(@"\steamapps\common\", StringComparison.OrdinalIgnoreCase) &&
            ext is not (".exe" or ".dll"))
            return L.T("游戏资源", "Game asset");

        if (ext is ".db" or ".sqlite" or ".sqlite3" or ".vscdb" or ".mdb" or ".accdb")
            return L.T("数据库", "Database");

        if (ext is ".pt" or ".pth" or ".onnx" or ".ckpt" or ".safetensors" ||
            nameLower.Contains("weights") ||
            (ext == ".bin" && (nameLower.Contains("weight") || nameLower.Contains("model"))))
            return L.T("模型权重", "Model weights");

        if (ext is ".dmp" || nameLower.Contains("minidump"))
            return L.T("崩溃转储", "Crash dump");

        if (ext is ".bak" or ".old" || nameLower.Contains("backup"))
            return L.T("备份", "Backup");

        if (ext == ".exe")
            return L.T("程序", "Program");
        if (ext == ".dll")
            return L.T("动态库", "DLL");

        return L.T("其他", "Other");
    }

    private static bool IsInstallerName(string nameLower)
    {
        return nameLower.Contains("setup") ||
               nameLower.Contains("install") ||
               nameLower.Contains("installer") ||
               nameLower.StartsWith("unitysetup") ||
               nameLower.Contains("_setup") ||
               nameLower.Contains("-setup") ||
               nameLower.EndsWith("setup.exe") ||
               nameLower.Contains("patch_setup") ||
               nameLower.Contains("offline_installer");
    }

    /// <summary>推断文件来源：公司/产品名，或路径中的应用/用户目录。</summary>
    private static string ResolveSource(string path)
    {
        try
        {
            var fromVersion = TryVersionSource(path);
            if (!string.IsNullOrEmpty(fromVersion))
                return fromVersion;

            // 同目录找 exe，取其产品信息
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir))
            {
                try
                {
                    foreach (var exe in Directory.EnumerateFiles(dir, "*.exe"))
                    {
                        var s = TryVersionSource(exe);
                        if (!string.IsNullOrEmpty(s))
                            return s;
                    }
                }
                catch
                {
                    // ignore
                }
            }

            var parts = path.Split(new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar },
                StringSplitOptions.RemoveEmptyEntries);

            for (var i = 0; i < parts.Length; i++)
            {
                if (parts[i].Equals("steamapps", StringComparison.OrdinalIgnoreCase) &&
                    i + 2 < parts.Length &&
                    parts[i + 1].Equals("common", StringComparison.OrdinalIgnoreCase))
                    return $"Steam · {parts[i + 2]}";

                if ((parts[i].Equals("Program Files", StringComparison.OrdinalIgnoreCase) ||
                     parts[i].Equals("Program Files (x86)", StringComparison.OrdinalIgnoreCase)) &&
                    i + 1 < parts.Length)
                    return parts[i + 1];

                if (parts[i].Equals("Users", StringComparison.OrdinalIgnoreCase) && i + 2 < parts.Length)
                {
                    var user = parts[i + 1];
                    var folder = parts[i + 2];
                    if (folder.Equals("Downloads", StringComparison.OrdinalIgnoreCase))
                        return L.T($"{user} · 下载", $"{user} · Downloads");
                    if (folder.Equals("Desktop", StringComparison.OrdinalIgnoreCase))
                        return L.T($"{user} · 桌面", $"{user} · Desktop");
                    if (folder.Equals("Documents", StringComparison.OrdinalIgnoreCase))
                        return L.T($"{user} · 文档", $"{user} · Documents");
                    if (folder.Equals("Videos", StringComparison.OrdinalIgnoreCase))
                        return L.T($"{user} · 视频", $"{user} · Videos");
                    if (folder.Equals("Music", StringComparison.OrdinalIgnoreCase))
                        return L.T($"{user} · 音乐", $"{user} · Music");
                    if (folder.Equals("Pictures", StringComparison.OrdinalIgnoreCase))
                        return L.T($"{user} · 图片", $"{user} · Pictures");
                    if (folder.Equals("AppData", StringComparison.OrdinalIgnoreCase) && i + 4 < parts.Length)
                        return L.T($"应用数据 · {parts[i + 4]}", $"AppData · {parts[i + 4]}");
                    return $"{user} · {folder}";
                }
            }

            var parent = Path.GetFileName(Path.GetDirectoryName(path) ?? "");
            return string.IsNullOrEmpty(parent) ? L.T("未知", "Unknown") : parent;
        }
        catch
        {
            return L.T("未知", "Unknown");
        }
    }

    private static string? TryVersionSource(string path)
    {
        try
        {
            var ext = Path.GetExtension(path);
            if (ext is not (".exe" or ".dll" or ".msi" or ".sys" or ".ocx" or ".scr" or ".cpl"))
                return null;

            var vi = FileVersionInfo.GetVersionInfo(path);
            var company = vi.CompanyName?.Trim();
            var product = vi.ProductName?.Trim();
            if (string.IsNullOrEmpty(company) && string.IsNullOrEmpty(product))
                return null;
            if (!string.IsNullOrEmpty(company) && !string.IsNullOrEmpty(product) &&
                !string.Equals(company, product, StringComparison.OrdinalIgnoreCase))
                return $"{company} · {product}";
            return !string.IsNullOrEmpty(product) ? product : company;
        }
        catch
        {
            return null;
        }
    }

    private static string FormatSize(long bytes)
    {
        if (bytes >= 1024L * 1024L * 1024L)
            return $"{bytes / (1024d * 1024d * 1024d):0.00} GB";
        return $"{bytes / (1024d * 1024d):0} MB";
    }

    private static string Truncate(string? s, int max)
    {
        if (string.IsNullOrEmpty(s))
            return "";
        return s.Length <= max ? s : "…" + s[^Math.Min(max - 1, s.Length)..];
    }

    private static IEnumerable<(string Path, long Size)> EnumerateLargeFiles(
        string root,
        long minBytes,
        CancellationToken token,
        Action<string>? onDir)
    {
        var stack = new Stack<string>();
        stack.Push(root);

        while (stack.Count > 0)
        {
            token.ThrowIfCancellationRequested();
            var dir = stack.Pop();
            if (IsProtectedSystemPath(dir))
                continue;

            onDir?.Invoke(dir);

            IEnumerable<string> files;
            try
            {
                files = Directory.EnumerateFiles(dir);
            }
            catch
            {
                files = Array.Empty<string>();
            }

            foreach (var file in files)
            {
                token.ThrowIfCancellationRequested();
                if (IsProtectedSystemPath(file))
                    continue;

                long len;
                try
                {
                    len = new FileInfo(file).Length;
                }
                catch
                {
                    continue;
                }

                if (len >= minBytes)
                    yield return (file, len);
            }

            IEnumerable<string> subDirs;
            try
            {
                subDirs = Directory.EnumerateDirectories(dir);
            }
            catch
            {
                continue;
            }

            foreach (var sub in subDirs)
            {
                if (ShouldSkipDirectory(sub))
                    continue;
                stack.Push(sub);
            }
        }
    }

    private static bool ShouldSkipDirectory(string dir)
    {
        if (IsProtectedSystemPath(dir))
            return true;

        var name = Path.GetFileName(dir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        if (string.IsNullOrEmpty(name))
            return false;

        if (IsDriveRootChild(dir) && RootSkipNames.Contains(name))
            return true;

        return false;
    }

    private static bool IsDriveRootChild(string path)
    {
        try
        {
            var full = Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            var parent = Path.GetDirectoryName(full);
            return parent is not null && string.Equals(
                Path.GetPathRoot(full)?.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                parent.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    private static bool IsProtectedSystemPath(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
            return true;

        string full;
        try
        {
            full = Path.GetFullPath(path);
        }
        catch
        {
            return true;
        }

        var norm = full.Replace(Path.AltDirectorySeparatorChar, Path.DirectorySeparatorChar);
        if (!norm.EndsWith(Path.DirectorySeparatorChar))
            norm += Path.DirectorySeparatorChar;

        if (ContainsPathSegment(norm, @"\Windows\"))
            return true;

        var fileName = Path.GetFileName(full.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        if (fileName is not null && RootSystemFileNames.Contains(fileName))
            return true;

        if (ContainsPathSegment(norm, @"\$Recycle.Bin\") ||
            ContainsPathSegment(norm, @"\System Volume Information\") ||
            ContainsPathSegment(norm, @"\Recovery\") ||
            ContainsPathSegment(norm, @"\$WinREAgent\") ||
            ContainsPathSegment(norm, @"\Boot\") ||
            ContainsPathSegment(norm, @"\EFI\") ||
            ContainsPathSegment(norm, @"\PerfLogs\"))
            return true;

        if (ContainsPathSegment(norm, @"\WindowsApps\") ||
            ContainsPathSegment(norm, @"\ModifiableWindowsApps\") ||
            ContainsPathSegment(norm, @"\Windows Defender\") ||
            ContainsPathSegment(norm, @"\Windows Defender Advanced Threat Protection\") ||
            ContainsPathSegment(norm, @"\Windows Mail\") ||
            ContainsPathSegment(norm, @"\Windows Media Player\") ||
            ContainsPathSegment(norm, @"\Windows NT\") ||
            ContainsPathSegment(norm, @"\Windows Photo Viewer\") ||
            ContainsPathSegment(norm, @"\WindowsPowerShell\") ||
            ContainsPathSegment(norm, @"\Windows Security\") ||
            ContainsPathSegment(norm, @"\Windows Sidebar\") ||
            ContainsPathSegment(norm, @"\Microsoft Update Health Tools\") ||
            ContainsPathSegment(norm, @"\Microsoft.NET\"))
            return true;

        if (ContainsPathSegment(norm, @"\Program Files\WindowsApps\") ||
            ContainsPathSegment(norm, @"\Program Files (x86)\WindowsApps\") ||
            ContainsPathSegment(norm, @"\Program Files\Common Files\Microsoft Shared\Ink\") ||
            ContainsPathSegment(norm, @"\Program Files\Common Files\System\") ||
            ContainsPathSegment(norm, @"\Program Files (x86)\Common Files\System\"))
            return true;

        if (ContainsPathSegment(norm, @"\ProgramData\Microsoft\") ||
            ContainsPathSegment(norm, @"\ProgramData\Packages\") ||
            ContainsPathSegment(norm, @"\ProgramData\Package Cache\"))
            return true;

        if (ContainsPathSegment(norm, @"\AppData\Local\Microsoft\WindowsApps\") ||
            ContainsPathSegment(norm, @"\AppData\Local\Packages\Microsoft.Windows") ||
            ContainsPathSegment(norm, @"\AppData\Local\Packages\Microsoft.WindowsStore") ||
            ContainsPathSegment(norm, @"\AppData\Local\Packages\Microsoft.UI.") ||
            ContainsPathSegment(norm, @"\AppData\Local\Packages\windows."))
            return true;

        return false;
    }

    private static bool ContainsPathSegment(string normalizedPathWithSlash, string segment)
    {
        return normalizedPathWithSlash.IndexOf(segment, StringComparison.OrdinalIgnoreCase) >= 0;
    }

    private static readonly HashSet<string> RootSkipNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "Windows",
        "$Recycle.Bin",
        "System Volume Information",
        "Recovery",
        "$WinREAgent",
        "Boot",
        "EFI",
        "PerfLogs",
        "Documents and Settings",
    };

    private static readonly HashSet<string> RootSystemFileNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "pagefile.sys",
        "swapfile.sys",
        "hiberfil.sys",
        "DumpStack.log.tmp",
    };

    private void Form_KeyDown(object? sender, KeyEventArgs e)
    {
        if (e.KeyCode != Keys.F5)
            return;

        e.Handled = true;
        e.SuppressKeyPress = true;
        if (_tabs.SelectedTab == _pageSoftware)
            LoadSoftwareForSelectedDrive();
        else if (!_scanning)
            _ = StartScanAsync();
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
        else if (e.KeyCode == Keys.Delete)
        {
            DeleteSelected(force: e.Shift);
            e.Handled = true;
        }
        else if (e.KeyCode == Keys.F5)
        {
            e.Handled = true;
            e.SuppressKeyPress = true;
            if (!_scanning)
                _ = StartScanAsync();
        }
    }

    private void List_MouseUp(object? sender, MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Right)
            return;

        var hit = _list.HitTest(e.Location);
        if (hit.Item is null)
            return;

        // 右键未选中项时，先选中该项
        if (!hit.Item.Selected)
        {
            _list.SelectedItems.Clear();
            hit.Item.Selected = true;
            hit.Item.Focused = true;
        }
    }

    private void OpenSelectedFolder()
    {
        if (_list.SelectedItems.Count == 0)
        {
            MessageBox.Show(this,
                L.T("请先选择一个文件。", "Select a file first."),
                L.T("提示", "Notice"),
                MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        // 单选：打开目录并选中文件；多选：每个不重复目录只开一次
        if (_list.SelectedItems.Count == 1 && _list.SelectedItems[0].Tag is (string onePath, long _))
        {
            try
            {
                if (File.Exists(onePath))
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = "explorer.exe",
                        Arguments = $"/select,\"{onePath}\"",
                        UseShellExecute = true
                    });
                    return;
                }

                var dir = Path.GetDirectoryName(onePath);
                if (!string.IsNullOrEmpty(dir) && Directory.Exists(dir))
                {
                    Process.Start(new ProcessStartInfo { FileName = dir, UseShellExecute = true });
                    return;
                }

                MessageBox.Show(this,
                    L.T("文件或目录不存在。", "File or folder not found."),
                    L.T("提示", "Notice"),
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                MessageBox.Show(this,
                    L.T($"无法打开目录：{ex.Message}", $"Could not open folder: {ex.Message}"),
                    L.T("失败", "Failed"),
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }

            return;
        }

        var dirs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (ListViewItem item in _list.SelectedItems)
        {
            if (item.Tag is not (string path, long _))
                continue;
            var dir = File.Exists(path) ? Path.GetDirectoryName(path) : path;
            if (!string.IsNullOrEmpty(dir) && Directory.Exists(dir))
                dirs.Add(dir);
        }

        foreach (var dir in dirs)
        {
            try
            {
                Process.Start(new ProcessStartInfo { FileName = dir, UseShellExecute = true });
            }
            catch
            {
                // ignore
            }
        }
    }

    private void LoadSoftwareForSelectedDrive()
    {
        if (_loadingSoftware) return;
        if (_cboDrive.SelectedItem is not DriveItem drive)
        {
            MessageBox.Show(this,
                L.T("请先选择硬盘。", "Pick a drive first."),
                L.T("提示", "Notice"),
                MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        _loadingSoftware = true;
        _btnRefreshSoftware.Enabled = false;
        _btnUninstall.Enabled = false;
        _lblStatus.Text = L.T($"正在读取 {drive.Root} 上的已安装软件并统计占用…",
            $"Reading software on {drive.Root} and measuring size…");
        var root = drive.Root;
        _ = Task.Run(() =>
        {
            List<InstalledSoftware> apps;
            try
            {
                apps = SoftwareUninstaller.FindByDrive(root);
                SoftwareUninstaller.FillSizes(apps);
                apps = apps
                    .OrderByDescending(a => a.SizeBytes ?? -1)
                    .ThenBy(a => a.DisplayName, StringComparer.CurrentCultureIgnoreCase)
                    .ToList();
            }
            catch { apps = []; }

            if (IsDisposed) return;
            try
            {
                BeginInvoke(() =>
                {
                    if (IsDisposed) return;
                    _softSortCol = 1;
                    _softSortAsc = false;
                    _softList.BeginUpdate();
                    try
                    {
                        _softList.Items.Clear();
                        foreach (var app in apps)
                        {
                            var row = new ListViewItem(app.DisplayName) { Tag = app };
                            row.SubItems.Add(SoftwareUninstaller.FormatSize(app.SizeBytes));
                            row.SubItems.Add(app.DisplayVersion ?? "-");
                            row.SubItems.Add(app.Publisher ?? "-");
                            row.SubItems.Add(string.IsNullOrWhiteSpace(app.InstallLocation) ? "-" : app.InstallLocation);
                            row.ToolTipText = app.UninstallString ?? app.QuietUninstallString ?? "";
                            _softList.Items.Add(row);
                        }
                    }
                    finally
                    {
                        _softList.EndUpdate();
                    }

                    var totalText = SoftwareUninstaller.FormatSize(apps.Sum(a => a.SizeBytes ?? 0));
                    _lblHint.Text = L.T(
                        $"已安装软件 · {apps.Count} 个（{root}）· 合计约 {totalText}",
                        $"Installed software · {apps.Count} ({root}) · ~{totalText} total");
                    _lblStatus.Text = L.T(
                        $"共 {apps.Count} 个 · 合计约 {totalText} · 选中后可强力卸载（占用优先统计安装目录）",
                        $"{apps.Count} apps · ~{totalText} · select to force uninstall (folder size preferred)");
                    _btnRefreshSoftware.Enabled = true;
                    _btnUninstall.Enabled = true;
                    _loadingSoftware = false;
                });
            }
            catch { _loadingSoftware = false; }
        });
    }

    private void SoftList_ColumnClick(object? sender, ColumnClickEventArgs e)
    {
        if (_softList.Items.Count == 0) return;
        if (_softSortCol == e.Column)
            _softSortAsc = !_softSortAsc;
        else
        {
            _softSortCol = e.Column;
            _softSortAsc = e.Column != 1; // 占用列默认从大到小
        }

        var items = _softList.Items.Cast<ListViewItem>().ToList();
        items.Sort((a, b) =>
        {
            int cmp;
            if (e.Column == 1)
            {
                var sa = a.Tag is InstalledSoftware xa ? xa.SizeBytes ?? -1 : -1;
                var sb = b.Tag is InstalledSoftware xb ? xb.SizeBytes ?? -1 : -1;
                cmp = sa.CompareTo(sb);
            }
            else
            {
                var ta = e.Column < a.SubItems.Count ? a.SubItems[e.Column].Text : "";
                var tb = e.Column < b.SubItems.Count ? b.SubItems[e.Column].Text : "";
                cmp = string.Compare(ta, tb, StringComparison.CurrentCultureIgnoreCase);
            }

            return _softSortAsc ? cmp : -cmp;
        });

        _softList.BeginUpdate();
        try
        {
            _softList.Items.Clear();
            _softList.Items.AddRange(items.ToArray());
        }
        finally
        {
            _softList.EndUpdate();
        }
    }

    private void OpenSelectedSoftwareFolder()
    {
        if (_softList.SelectedItems.Count == 0) return;
        if (_softList.SelectedItems[0].Tag is not InstalledSoftware app) return;
        var loc = app.InstallLocation?.Trim().Trim('"');
        if (string.IsNullOrWhiteSpace(loc) || !Directory.Exists(loc))
        {
            MessageBox.Show(this,
                L.T("没有有效的安装目录。", "No valid install folder."),
                L.T("提示", "Notice"),
                MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = "explorer.exe",
                Arguments = $"\"{loc}\"",
                UseShellExecute = true
            });
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, ex.Message, L.T("打开失败", "Open failed"),
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private void UninstallSelectedSoftware()
    {
        if (_softList.SelectedItems.Count == 0)
        {
            MessageBox.Show(this,
                L.T("请先在「已安装软件」列表中选择软件。", "Select software in the Installed software tab first."),
                L.T("提示", "Notice"),
                MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        var apps = new List<InstalledSoftware>();
        foreach (ListViewItem item in _softList.SelectedItems)
        {
            if (item.Tag is InstalledSoftware app)
                apps.Add(app);
        }

        if (apps.Count == 0)
            return;

        string message;
        if (apps.Count == 1)
        {
            var app = apps[0];
            message = L.T(
                $"【强力卸载】将申请管理员权限卸载：\n\n{app.DisplayName}\n{app.Publisher}\n安装位置：{app.InstallLocation ?? "-"}\n\n并尝试清理安装目录（不可恢复）。确定？",
                $"FORCE UNINSTALL with admin rights:\n\n{app.DisplayName}\n{app.Publisher}\nInstall: {app.InstallLocation ?? "-"}\n\nWill try clean install folder (irreversible). Continue?");
        }
        else
        {
            var preview = string.Join("\n", apps.Take(8).Select(a => $"· {a.DisplayName}"));
            if (apps.Count > 8)
                preview += L.T($"\n· …等共 {apps.Count} 个", $"\n· … {apps.Count} total");
            message = L.T(
                $"【强力卸载】将依次提权卸载这 {apps.Count} 个软件：\n\n{preview}\n\n并尝试清理安装目录。确定？",
                $"FORCE UNINSTALL these {apps.Count} apps with admin:\n\n{preview}\n\nWill try clean folders. Continue?");
        }

        var confirm = MessageBox.Show(this, message,
            L.T("确认强力卸载", "Confirm force uninstall"),
            MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
        if (confirm != DialogResult.Yes)
            return;

        _btnUninstall.Enabled = false;
        _btnRefreshSoftware.Enabled = false;
        var copy = apps;
        _ = Task.Run(() =>
        {
            var notes = new List<string>();
            var okCount = 0;
            foreach (var app in copy)
            {
                var (ok, msg) = SoftwareUninstaller.ForceUninstall(app, alsoDeleteFolder: true);
                if (ok) okCount++;
                notes.Add($"{app.DisplayName}: {msg}");
            }

            if (IsDisposed) return;
            try
            {
                BeginInvoke(() =>
                {
                    if (IsDisposed) return;
                    _btnUninstall.Enabled = true;
                    _btnRefreshSoftware.Enabled = true;
                    var detail = string.Join("\n\n", notes.Take(6));
                    if (notes.Count > 6)
                        detail += L.T($"\n\n…等共 {notes.Count} 项", $"\n\n… {notes.Count} total");
                    MessageBox.Show(this, detail,
                        okCount > 0 ? L.T("卸载已执行", "Uninstall started") : L.T("卸载失败", "Uninstall failed"),
                        MessageBoxButtons.OK,
                        okCount > 0 ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
                    LoadSoftwareForSelectedDrive();
                });
            }
            catch { /* disposing */ }
        });
    }

    private void DeleteSelected(bool force)
    {
        if (_list.SelectedItems.Count == 0)
        {
            MessageBox.Show(this,
                L.T(
                    "请先在列表中选择要删除的文件。\n\n提示：按住 Ctrl 点选多个，或 Ctrl+A 全选。",
                    "Select files to delete in the list.\n\nTip: Ctrl+click multi-select, or Ctrl+A to select all."),
                L.T("提示", "Notice"),
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
            return;
        }

        var targets = new List<string>(_list.SelectedItems.Count);
        var blocked = new List<string>();
        foreach (ListViewItem item in _list.SelectedItems)
        {
            if (item.Tag is not (string path, long _))
                continue;
            // 普通删除：沿用扫描级保护；强制删除：只拦能稳定认定的系统核心
            if (force ? IsCoreSystemFile(path) : IsProtectedSystemPath(path))
                blocked.Add(path);
            else
                targets.Add(path);
        }

        if (blocked.Count > 0 && targets.Count == 0)
        {
            MessageBox.Show(this,
                force
                    ? L.T(
                        "所选文件属于可稳定认定的系统核心（如 System32 / 页面文件 / EFI），已禁止强制删除，以免系统无法启动。",
                        "Selected files are verified OS core (System32 / pagefile / EFI); force delete blocked.")
                    : L.T(
                        "所选文件属于系统/受保护路径，已禁止删除，以免破坏系统。",
                        "Selected files are system/protected paths; delete blocked."),
                L.T("已拦截", "Blocked"),
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
            return;
        }

        if (targets.Count == 0)
            return;

        string message;
        if (force)
        {
            if (targets.Count == 1)
            {
                message = L.T(
                    $"【强制删除】将永久删除（不进回收站），并尝试清除只读/系统属性。\n\n{targets[0]}\n\n可能影响正在运行的程序；无法恢复。确定继续？",
                    $"FORCE DELETE permanently (no Recycle Bin), clearing read-only/system attrs.\n\n{targets[0]}\n\nMay break running apps; irreversible. Continue?");
            }
            else
            {
                var preview = string.Join("\n", targets.Take(8).Select(t => $"· {Path.GetFileName(t)}"));
                if (targets.Count > 8)
                    preview += L.T($"\n· …等共 {targets.Count} 个", $"\n· … {targets.Count} total");
                message = L.T(
                    $"【强制删除】将永久删除这 {targets.Count} 个文件（不进回收站）。\n\n{preview}\n\n无法恢复。确定继续？",
                    $"FORCE DELETE these {targets.Count} files permanently (no Recycle Bin).\n\n{preview}\n\nIrreversible. Continue?");
            }
        }
        else if (targets.Count == 1)
        {
            message = L.T(
                $"确定要删除该文件？\n\n{targets[0]}\n\n文件将进入回收站（若系统支持）。",
                $"Delete this file?\n\n{targets[0]}\n\nIt will go to the Recycle Bin if supported.");
        }
        else
        {
            var preview = string.Join("\n", targets.Take(8).Select(t => $"· {Path.GetFileName(t)}"));
            if (targets.Count > 8)
                preview += L.T($"\n· …等共 {targets.Count} 个", $"\n· … {targets.Count} total");
            message = L.T(
                $"确定要批量删除这 {targets.Count} 个文件？\n\n{preview}\n\n文件将进入回收站（若系统支持）。",
                $"Delete these {targets.Count} files?\n\n{preview}\n\nThey will go to the Recycle Bin if supported.");
        }

        if (blocked.Count > 0)
            message += L.T(
                $"\n\n另有 {blocked.Count} 个系统核心/受保护文件已自动跳过。",
                $"\n\n{blocked.Count} core/protected file(s) were skipped.");

        var confirm = MessageBox.Show(this, message,
            force ? L.T("确认强制删除", "Confirm force delete") : L.T("确认删除", "Confirm delete"),
            MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
        if (confirm != DialogResult.Yes)
            return;

        var failed = new List<string>();
        var rebootPending = new List<string>();
        foreach (var path in targets)
        {
            try
            {
                if (force)
                {
                    var result = TryForceDelete(path);
                    if (result == ForceDeleteResult.Failed)
                        failed.Add(Path.GetFileName(path) ?? path);
                    else if (result == ForceDeleteResult.ScheduledReboot)
                        rebootPending.Add(Path.GetFileName(path) ?? path);
                }
                else
                {
                    if (!TryDeleteToRecycleBin(path))
                        File.Delete(path);
                }
            }
            catch (Exception ex)
            {
                failed.Add($"{Path.GetFileName(path)}：{ex.Message}");
            }
        }

        _list.BeginUpdate();
        for (var i = _list.Items.Count - 1; i >= 0; i--)
        {
            if (_list.Items[i].Tag is (string p, long _) && targets.Contains(p) && !File.Exists(p))
                _list.Items.RemoveAt(i);
        }
        _list.EndUpdate();
        RefreshListAfterDelete();

        if (rebootPending.Count > 0)
        {
            var detail = string.Join("\n", rebootPending.Take(6));
            if (rebootPending.Count > 6)
                detail += L.T($"\n…等共 {rebootPending.Count} 个", $"\n… {rebootPending.Count} total");
            MessageBox.Show(this,
                L.T($"以下文件当前被占用，已安排重启后删除：\n\n{detail}",
                    $"These files are locked; scheduled for delete on reboot:\n\n{detail}"),
                L.T("重启后删除", "Delete on reboot"),
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }

        if (failed.Count > 0)
        {
            var detail = string.Join("\n", failed.Take(6));
            if (failed.Count > 6)
                detail += L.T($"\n…等共 {failed.Count} 个失败", $"\n… {failed.Count} failed total");
            MessageBox.Show(this,
                L.T($"部分文件未能删除：\n\n{detail}", $"Some files could not be deleted:\n\n{detail}"),
                L.T("部分失败", "Partial failure"),
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
    }

    private enum ForceDeleteResult { Ok, ScheduledReboot, Failed }

    /// <summary>
    /// 强制删除：清属性 → 永久删除 → 仍失败则登记重启后删。
    /// </summary>
    private static ForceDeleteResult TryForceDelete(string path)
    {
        if (!File.Exists(path) && !Directory.Exists(path))
            return ForceDeleteResult.Ok;

        try
        {
            if (File.Exists(path))
                File.SetAttributes(path, FileAttributes.Normal);
            else
                File.SetAttributes(path, FileAttributes.Normal);
        }
        catch { /* 继续尝试删除 */ }

        try
        {
            if (TryPermanentDelete(path))
                return ForceDeleteResult.Ok;
        }
        catch { /* ignore */ }

        try
        {
            if (File.Exists(path))
                File.Delete(path);
            else if (Directory.Exists(path))
                Directory.Delete(path, recursive: true);

            if (!File.Exists(path) && !Directory.Exists(path))
                return ForceDeleteResult.Ok;
        }
        catch { /* ignore */ }

        // 仍删不掉：安排重启后删除（对付占用/顽固权限）
        try
        {
            if (MoveFileEx(path, null, MoveFileDelayUntilReboot))
                return ForceDeleteResult.ScheduledReboot;
        }
        catch { /* ignore */ }

        return ForceDeleteResult.Failed;
    }

    /// <summary>永久删除（不进回收站）。</summary>
    private static bool TryPermanentDelete(string path)
    {
        try
        {
            var fs = new SHFILEOPSTRUCT
            {
                hwnd = IntPtr.Zero,
                wFunc = FO_DELETE,
                pFrom = path + "\0\0",
                pTo = null,
                fFlags = FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT, // 无 FOF_ALLOWUNDO
                fAnyOperationsAborted = false,
                hNameMappings = IntPtr.Zero,
                lpszProgressTitle = null
            };
            return SHFileOperation(ref fs) == 0 && !fs.fAnyOperationsAborted
                   && !File.Exists(path) && !Directory.Exists(path);
        }
        catch
        {
            return false;
        }
    }

    private static bool TryDeleteToRecycleBin(string path)
    {
        try
        {
            var fs = new SHFILEOPSTRUCT
            {
                hwnd = IntPtr.Zero,
                wFunc = FO_DELETE,
                pFrom = path + "\0\0",
                pTo = null,
                fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT,
                fAnyOperationsAborted = false,
                hNameMappings = IntPtr.Zero,
                lpszProgressTitle = null
            };
            return SHFileOperation(ref fs) == 0 && !fs.fAnyOperationsAborted;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// 仅拦截能稳定认定的系统核心，避免误伤；流氓软件伪装路径应允许强制删。
    /// </summary>
    private static bool IsCoreSystemFile(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
            return true;

        string full;
        try { full = Path.GetFullPath(path); }
        catch { return true; }

        var norm = full.Replace(Path.AltDirectorySeparatorChar, Path.DirectorySeparatorChar);
        if (!norm.EndsWith(Path.DirectorySeparatorChar))
            norm += Path.DirectorySeparatorChar;

        var fileName = Path.GetFileName(full.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        if (fileName is not null && RootSystemFileNames.Contains(fileName))
            return true;
        if (string.Equals(fileName, "bootmgr", StringComparison.OrdinalIgnoreCase))
            return true;

        // 卷元数据 / 启动分区
        if (ContainsPathSegment(norm, @"\System Volume Information\") ||
            ContainsPathSegment(norm, @"\$Recycle.Bin\") ||
            ContainsPathSegment(norm, @"\Recovery\") ||
            ContainsPathSegment(norm, @"\$WinREAgent\") ||
            ContainsPathSegment(norm, @"\Boot\") ||
            ContainsPathSegment(norm, @"\EFI\"))
            return true;

        // Windows 下仅核心目录（不拦整个 \Windows\，以便删掉流氓放进 Windows 的文件）
        if (ContainsPathSegment(norm, @"\Windows\System32\") ||
            ContainsPathSegment(norm, @"\Windows\SysWOW64\") ||
            ContainsPathSegment(norm, @"\Windows\WinSxS\") ||
            ContainsPathSegment(norm, @"\Windows\Boot\") ||
            ContainsPathSegment(norm, @"\Windows\Fonts\") ||
            ContainsPathSegment(norm, @"\Windows\System\") ||
            ContainsPathSegment(norm, @"\Windows\servicing\") ||
            ContainsPathSegment(norm, @"\Windows\drivers\") ||
            ContainsPathSegment(norm, @"\Windows\DriverStore\"))
            return true;

        return false;
    }

    private const int FO_DELETE = 0x0003;
    private const ushort FOF_ALLOWUNDO = 0x0040;
    private const ushort FOF_NOCONFIRMATION = 0x0010;
    private const ushort FOF_NOERRORUI = 0x0400;
    private const ushort FOF_SILENT = 0x0004;
    private const int MoveFileDelayUntilReboot = 0x4;

    private const uint SHGFI_ICON = 0x000000100;
    private const uint SHGFI_SMALLICON = 0x000000001;
    private const uint SHGFI_SYSICONINDEX = 0x000004000;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SHFILEINFO
    {
        public IntPtr hIcon;
        public int iIcon;
        public uint dwAttributes;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szDisplayName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)]
        public string szTypeName;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SHGetFileInfo(
        string pszPath,
        uint dwFileAttributes,
        ref SHFILEINFO psfi,
        uint cbFileInfo,
        uint uFlags);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyIcon(IntPtr hIcon);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SHFILEOPSTRUCT
    {
        public IntPtr hwnd;
        public uint wFunc;
        public string pFrom;
        public string? pTo;
        public ushort fFlags;
        public bool fAnyOperationsAborted;
        public IntPtr hNameMappings;
        public string? lpszProgressTitle;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHFileOperation(ref SHFILEOPSTRUCT FileOp);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool MoveFileEx(string lpExistingFileName, string? lpNewFileName, int dwFlags);

    private readonly record struct DriveItem(string Root, string Display)
    {
        public override string ToString() => Display;
    }

    private readonly record struct FileInfoItem(string Path, long SizeBytes, string Source, string Tag);
}
