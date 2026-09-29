namespace MemWatch;

/// <summary>数据恢复弹窗：回收站还原 + NTFS MFT 深度扫描。</summary>
public sealed class DataRecoveryForm : Form
{
    private readonly LevelConfig _levels;
    private readonly RadioButton _rbBin = new();
    private readonly RadioButton _rbDeep = new();
    private readonly Label _lblStatus = new();
    private readonly Label _lblHint = new();
    private readonly ComboBox _cboDrive = new();
    private readonly Label _lblDrive = new();
    private readonly TextBox _txtSearch = new();
    private readonly Label _lblSearch = new();
    private readonly Button _btnRefresh = new();
    private readonly Button _btnScan = new();
    private readonly Button _btnCancel = new();
    private readonly Button _btnRestore = new();
    private readonly Button _btnRestoreAll = new();
    private readonly Button _btnClose = new();
    private readonly ThemedMeter _progress = new();
    private readonly ListView _list = new();
    private readonly Label _lblNote = new();
    private static readonly Color DefaultBack = UiTheme.Back;
    private Button? _btnSkin;

    private List<RecycleBinItem> _binItems = new();
    private List<DeepRecoverItem> _deepItems = new();
    private bool _loading;
    private CancellationTokenSource? _cts;
    private bool IsDeepMode => _rbDeep.Checked;

    public DataRecoveryForm(LevelConfig levels)
    {
        _levels = levels;
        BuildUi();
        TopMost = false;
        ApplyLanguage();
        ApplyModeUi();
        L.Changed += OnLanguageChanged;
        FormClosed += (_, _) =>
        {
            L.Changed -= OnLanguageChanged;
            try { _cts?.Cancel(); } catch { /* ignore */ }
            try { _cts?.Dispose(); } catch { /* ignore */ }
            _cts = null;
            RecycleBinReader.ReleaseItems(_binItems);
            _binItems = new List<RecycleBinItem>();
            _deepItems = new List<DeepRecoverItem>();
        };
        WindowSkin.Apply(this, _levels, WindowSkin.KeyDiskHealth, DefaultBack);
        Shown += async (_, _) =>
        {
            if (!IsDeepMode)
                await LoadBinAsync();
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
        ApplyModeUi();
        _rbDeep.Left = _rbBin.Right + 16;
        RefreshListView();
    }

    private void ApplyLanguage()
    {
        Text = L.T("数据恢复", "Data Recovery");
        _rbBin.Text = L.T("回收站", "Recycle Bin");
        _rbDeep.Text = L.T("深度扫描 (NTFS)", "Deep scan (NTFS)");
        _rbDeep.Left = _rbBin.Right + 16;
        _lblDrive.Text = L.T("盘符", "Drive");
        _lblSearch.Text = L.T("搜索", "Search");
        _btnRefresh.Text = L.T("刷新", "Refresh");
        _btnScan.Text = L.T("开始扫描", "Start scan");
        _btnCancel.Text = L.T("取消", "Cancel");
        _btnClose.Text = L.T("关闭", "Close");
        if (_btnSkin is not null)
            _btnSkin.Text = L.T("皮肤", "Skin");

        UpdateActionButtonsText();
        UpdateHintNote();
        EnsureColumns();
        ReloadDriveCombo(keepSelection: true);
    }

    private void UpdateActionButtonsText()
    {
        if (IsDeepMode)
        {
            _btnRestore.Text = L.T("恢复选中…", "Recover selected…");
            _btnRestoreAll.Text = L.T("恢复当前列表…", "Recover listed…");
        }
        else
        {
            _btnRestore.Text = L.T("还原选中", "Restore selected");
            _btnRestoreAll.Text = L.T("还原当前列表", "Restore listed");
        }
    }

    private void UpdateHintNote()
    {
        if (IsDeepMode)
        {
            _lblHint.Text = L.T(
                "扫描所选 NTFS 卷的 MFT，查找已删除（含 Shift+Delete / 清空回收站）且仍有记录的文件。请恢复到另一块磁盘。",
                "Scan the NTFS MFT for deleted files (incl. Shift+Delete / emptied bin). Recover to a different drive.");
            _lblNote.Text = L.T(
                "仅支持 NTFS。被覆盖的簇无法保证内容正确。压缩/加密文件无法恢复。扫描需管理员权限，耗时取决于磁盘大小。",
                "NTFS only. Overwritten clusters may be corrupt. Compressed/encrypted files unsupported. Needs admin; time depends on disk size.");
        }
        else
        {
            _lblHint.Text = L.T(
                "从回收站还原误删文件。永久删除请改用「深度扫描」。",
                "Restore from Recycle Bin. For permanent deletes, use Deep scan.");
            _lblNote.Text = L.T(
                "提示：还原会把文件放回原路径；若已有同名文件，系统可能提示覆盖或改名。",
                "Tip: Files return to the original path; name conflicts may prompt overwrite/rename.");
        }
    }

    private void BuildUi()
    {
        Text = L.T("数据恢复", "Data Recovery");
        FormBorderStyle = FormBorderStyle.Sizable;
        MaximizeBox = true;
        MinimizeBox = true;
        ShowInTaskbar = true;
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Segoe UI", 9f);
        BackColor = DefaultBack;
        DoubleBuffered = true;
        MinimumSize = new Size(780, 520);
        ClientSize = new Size(920, 600);

        const int pad = 8;

        var top = new Panel
        {
            Dock = DockStyle.Top,
            Height = 108,
            BackColor = DefaultBack,
            Padding = new Padding(pad)
        };

        _rbBin.AutoSize = true;
        _rbBin.Location = new Point(pad, 8);
        _rbBin.Checked = true;
        _rbBin.CheckedChanged += (_, _) =>
        {
            if (_rbBin.Checked)
                OnModeChanged();
        };

        _rbDeep.AutoSize = true;
        _rbDeep.Location = new Point(pad + 110, 8);
        _rbDeep.CheckedChanged += (_, _) =>
        {
            if (_rbDeep.Checked)
                OnModeChanged();
        };

        _lblDrive.AutoSize = true;
        _lblDrive.Location = new Point(pad, 40);
        _cboDrive.DropDownStyle = ComboBoxStyle.DropDownList;
        _cboDrive.Location = new Point(pad + 40, 36);
        _cboDrive.Size = new Size(100, 24);
        _cboDrive.SelectedIndexChanged += (_, _) =>
        {
            if (!IsDeepMode)
                RefreshListView();
        };

        _lblSearch.AutoSize = true;
        _lblSearch.Location = new Point(160, 40);
        _txtSearch.Location = new Point(200, 36);
        _txtSearch.Size = new Size(220, 24);
        _txtSearch.TextChanged += (_, _) => RefreshListView();

        _btnScan.Size = new Size(90, 26);
        _btnScan.Click += async (_, _) => await StartDeepScanAsync();

        _btnCancel.Size = new Size(70, 26);
        _btnCancel.Enabled = false;
        _btnCancel.Click += (_, _) => _cts?.Cancel();

        _btnRefresh.Size = new Size(70, 26);
        _btnRefresh.Click += async (_, _) =>
        {
            if (IsDeepMode)
                await StartDeepScanAsync();
            else
                await LoadBinAsync();
        };

        _btnSkin = WindowSkin.CreateButton(this, _levels, WindowSkin.KeyDiskHealth, DefaultBack);
        _btnSkin.Size = new Size(56, 26);

        _progress.Location = new Point(pad, 70);
        _progress.Size = new Size(400, 16);
        _progress.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        _progress.Minimum = 0;
        _progress.Maximum = 100;
        _progress.Value = 0;
        _progress.Visible = false;

        _lblStatus.AutoSize = false;
        _lblStatus.Location = new Point(pad, 88);
        _lblStatus.Size = new Size(700, 18);
        _lblStatus.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        _lblStatus.ForeColor = Color.DimGray;

        top.Controls.Add(_rbBin);
        top.Controls.Add(_rbDeep);
        top.Controls.Add(_lblDrive);
        top.Controls.Add(_cboDrive);
        top.Controls.Add(_lblSearch);
        top.Controls.Add(_txtSearch);
        top.Controls.Add(_btnScan);
        top.Controls.Add(_btnCancel);
        top.Controls.Add(_btnRefresh);
        top.Controls.Add(_btnSkin);
        top.Controls.Add(_progress);
        top.Controls.Add(_lblStatus);
        top.Resize += (_, _) => LayoutTop(top, pad);

        var mid = new Panel { Dock = DockStyle.Fill, Padding = new Padding(pad, 0, pad, 0) };
        _lblHint.Dock = DockStyle.Top;
        _lblHint.Height = 40;
        _lblHint.ForeColor = Color.FromArgb(100, 60, 20);

        _list.Dock = DockStyle.Fill;
        _list.View = View.Details;
        _list.FullRowSelect = true;
        _list.MultiSelect = true;
        _list.GridLines = true;
        _list.HideSelection = false;
        _list.KeyDown += (_, e) =>
        {
            if (e.Control && e.KeyCode == Keys.A)
            {
                foreach (ListViewItem it in _list.Items)
                    it.Selected = true;
                e.Handled = true;
                e.SuppressKeyPress = true;
            }
        };

        mid.Controls.Add(_list);
        mid.Controls.Add(_lblHint);

        var bottom = new Panel
        {
            Dock = DockStyle.Bottom,
            Height = 78,
            BackColor = DefaultBack,
            Padding = new Padding(pad)
        };

        _lblNote.AutoSize = false;
        _lblNote.Location = new Point(pad, 6);
        _lblNote.Size = new Size(520, 36);
        _lblNote.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        _lblNote.ForeColor = Color.DimGray;
        _lblNote.Font = new Font("Segoe UI", 8f);

        _btnRestore.Size = new Size(120, 28);
        _btnRestore.Anchor = AnchorStyles.Bottom | AnchorStyles.Right;
        _btnRestore.Click += (_, _) => RestoreOrRecoverSelected();

        _btnRestoreAll.Size = new Size(130, 28);
        _btnRestoreAll.Anchor = AnchorStyles.Bottom | AnchorStyles.Right;
        _btnRestoreAll.Click += (_, _) => RestoreOrRecoverListed();

        _btnClose.Size = new Size(80, 28);
        _btnClose.Anchor = AnchorStyles.Bottom | AnchorStyles.Right;
        _btnClose.Click += (_, _) => Close();

        bottom.Controls.Add(_lblNote);
        bottom.Controls.Add(_btnRestore);
        bottom.Controls.Add(_btnRestoreAll);
        bottom.Controls.Add(_btnClose);
        bottom.Resize += (_, _) =>
        {
            _btnClose.Location = new Point(bottom.ClientSize.Width - _btnClose.Width - pad, 42);
            _btnRestoreAll.Location = new Point(_btnClose.Left - 8 - _btnRestoreAll.Width, 42);
            _btnRestore.Location = new Point(_btnRestoreAll.Left - 8 - _btnRestore.Width, 42);
            _lblNote.Width = Math.Max(200, _btnRestore.Left - pad * 2);
        };

        Controls.Add(mid);
        Controls.Add(bottom);
        Controls.Add(top);

        EnsureColumns();
        ReloadDriveCombo(keepSelection: false);
        LayoutTop(top, pad);
        UiTheme.StyleTree(this);
        EchoChrome.Attach(this, canResize: true, showMin: true);
    }

    private void LayoutTop(Panel top, int pad)
    {
        var right = top.ClientSize.Width - pad;
        if (_btnSkin is not null)
        {
            _btnSkin.Location = new Point(right - _btnSkin.Width, 6);
            right = _btnSkin.Left - 6;
        }

        _btnRefresh.Location = new Point(right - _btnRefresh.Width, 34);
        right = _btnRefresh.Left - 6;
        _btnCancel.Location = new Point(right - _btnCancel.Width, 34);
        right = _btnCancel.Left - 6;
        _btnScan.Location = new Point(right - _btnScan.Width, 34);

        _progress.Width = Math.Max(200, top.ClientSize.Width - pad * 2);
        _lblStatus.Width = _progress.Width;
        _txtSearch.Width = Math.Max(120, _btnScan.Left - _txtSearch.Left - 12);
    }

    private void OnModeChanged()
    {
        ApplyModeUi();
        RefreshListView();
        if (!IsDeepMode && _binItems.Count == 0 && !_loading)
            _ = LoadBinAsync();
    }

    private void ApplyModeUi()
    {
        UpdateActionButtonsText();
        UpdateHintNote();
        EnsureColumns();
        ReloadDriveCombo(keepSelection: true);

        _btnScan.Visible = IsDeepMode;
        _btnCancel.Visible = IsDeepMode;
        _btnRefresh.Text = IsDeepMode ? L.T("重新扫描", "Rescan") : L.T("刷新", "Refresh");
        _progress.Visible = IsDeepMode && _loading;
    }

    private void EnsureColumns()
    {
        _list.BeginUpdate();
        try
        {
            _list.Columns.Clear();
            if (IsDeepMode)
            {
                _list.Columns.Add(L.T("名称", "Name"), 160);
                _list.Columns.Add(L.T("原路径", "Original path"), 300);
                _list.Columns.Add(L.T("修改时间", "Modified"), 130);
                _list.Columns.Add(L.T("大小", "Size"), 90);
                _list.Columns.Add(L.T("状态", "Status"), 140);
            }
            else
            {
                _list.Columns.Add(L.T("名称", "Name"), 160);
                _list.Columns.Add(L.T("原路径", "Original path"), 300);
                _list.Columns.Add(L.T("删除时间", "Deleted"), 130);
                _list.Columns.Add(L.T("大小", "Size"), 90);
                _list.Columns.Add(L.T("类型", "Type"), 100);
            }
        }
        finally
        {
            _list.EndUpdate();
        }
    }

    private void ReloadDriveCombo(bool keepSelection)
    {
        var prev = _cboDrive.SelectedItem as string;
        _cboDrive.Items.Clear();

        if (IsDeepMode)
        {
            foreach (var d in NtfsDeepRecovery.ListNtfsDrives())
                _cboDrive.Items.Add(d);

            if (_cboDrive.Items.Count == 0)
            {
                _cboDrive.Items.Add(L.T("(无 NTFS 盘)", "(No NTFS drives)"));
                _cboDrive.SelectedIndex = 0;
                return;
            }

            if (keepSelection && prev is not null)
            {
                var idx = _cboDrive.Items.IndexOf(prev);
                _cboDrive.SelectedIndex = idx >= 0 ? idx : 0;
            }
            else
            {
                _cboDrive.SelectedIndex = 0;
            }
        }
        else
        {
            _cboDrive.Items.Add(L.T("全部", "All"));
            try
            {
                foreach (var d in DriveInfo.GetDrives().Where(x => x.IsReady && x.DriveType == DriveType.Fixed))
                {
                    var root = d.Name.TrimEnd('\\');
                    if (root.Length >= 2)
                        _cboDrive.Items.Add(root.ToUpperInvariant());
                }
            }
            catch
            {
                // ignore
            }

            if (keepSelection && prev is not null)
            {
                var idx = _cboDrive.Items.IndexOf(prev);
                _cboDrive.SelectedIndex = idx >= 0 ? idx : 0;
            }
            else
            {
                _cboDrive.SelectedIndex = 0;
            }
        }
    }

    private async Task LoadBinAsync()
    {
        if (_loading)
            return;

        _loading = true;
        SetBusy(true);
        _lblStatus.Text = L.T("正在读取回收站…", "Reading Recycle Bin…");

        try
        {
            await Task.Yield();
            var items = RecycleBinReader.Enumerate();
            RecycleBinReader.ReleaseItems(_binItems);
            _binItems = items;
            RefreshListView();
            _lblStatus.Text = L.T(
                $"回收站中共 {_binItems.Count} 项 · {DateTime.Now:HH:mm:ss}",
                $"{_binItems.Count} item(s) in Recycle Bin · {DateTime.Now:HH:mm:ss}");
        }
        catch (Exception ex)
        {
            _lblStatus.Text = L.T("读取失败", "Read failed");
            MessageBox.Show(this,
                L.T($"无法读取回收站：{ex.Message}", $"Cannot read Recycle Bin: {ex.Message}"),
                L.T("错误", "Error"),
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        finally
        {
            _loading = false;
            SetBusy(false);
        }
    }

    private async Task StartDeepScanAsync()
    {
        if (_loading)
            return;

        if (_cboDrive.SelectedItem is not string drive || drive.Contains('(', StringComparison.Ordinal))
        {
            MessageBox.Show(this,
                L.T("请选择要扫描的 NTFS 盘符。", "Select an NTFS drive to scan."),
                L.T("深度扫描", "Deep scan"),
                MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        var warn = MessageBox.Show(this,
            L.T(
                $"将对 {drive} 进行 MFT 深度扫描。\n\n请尽量少往该盘写入数据。\n恢复时请选择另一块磁盘作为保存位置。\n\n开始扫描？",
                $"Deep-scan MFT on {drive}.\n\nAvoid writing to this drive.\nRecover to a different disk.\n\nStart scan?"),
            L.T("深度扫描", "Deep scan"),
            MessageBoxButtons.YesNo, MessageBoxIcon.Question);
        if (warn != DialogResult.Yes)
            return;

        _loading = true;
        _cts = new CancellationTokenSource();
        SetBusy(true);
        _progress.Visible = true;
        _progress.Value = 0;
        _deepItems = new List<DeepRecoverItem>();
        RefreshListView();
        _lblStatus.Text = L.T("正在扫描…", "Scanning…");

        var progress = new Progress<(int Percent, string Message)>(p =>
        {
            if (IsDisposed)
                return;
            _progress.Value = Math.Clamp(p.Percent, 0, 100);
            _lblStatus.Text = p.Message;
        });

        try
        {
            var token = _cts.Token;
            var items = await Task.Run(() => NtfsDeepRecovery.Scan(drive, progress, token), token);
            _deepItems = items;
            RefreshListView();
            _lblStatus.Text = L.T(
                $"扫描完成：找到 {_deepItems.Count} 个已删除文件 · {DateTime.Now:HH:mm:ss}",
                $"Done: {_deepItems.Count} deleted file(s) · {DateTime.Now:HH:mm:ss}");
        }
        catch (OperationCanceledException)
        {
            _lblStatus.Text = L.T("扫描已取消", "Scan cancelled");
        }
        catch (Exception ex)
        {
            _lblStatus.Text = L.T("扫描失败", "Scan failed");
            MessageBox.Show(this,
                L.T($"深度扫描失败：{ex.Message}", $"Deep scan failed: {ex.Message}"),
                L.T("错误", "Error"),
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        finally
        {
            _loading = false;
            _cts?.Dispose();
            _cts = null;
            SetBusy(false);
            _progress.Visible = false;
        }
    }

    private void SetBusy(bool busy)
    {
        _btnRefresh.Enabled = !busy;
        _btnScan.Enabled = !busy && IsDeepMode;
        _btnCancel.Enabled = busy && IsDeepMode;
        _btnRestore.Enabled = !busy;
        _btnRestoreAll.Enabled = !busy;
        _rbBin.Enabled = !busy;
        _rbDeep.Enabled = !busy;
        _cboDrive.Enabled = !busy;
    }

    private void RefreshListView()
    {
        if (IsDeepMode)
            FillDeepList(FilterDeep());
        else
            FillBinList(FilterBin());
    }

    private List<RecycleBinItem> FilterBin()
    {
        IEnumerable<RecycleBinItem> q = _binItems;
        if (_cboDrive.SelectedIndex > 0 && _cboDrive.SelectedItem is string drive)
            q = q.Where(x => string.Equals(x.Drive, drive, StringComparison.OrdinalIgnoreCase));

        var key = _txtSearch.Text.Trim();
        if (key.Length > 0)
        {
            q = q.Where(x =>
                x.Name.Contains(key, StringComparison.OrdinalIgnoreCase) ||
                x.OriginalPath.Contains(key, StringComparison.OrdinalIgnoreCase) ||
                x.TypeName.Contains(key, StringComparison.OrdinalIgnoreCase));
        }

        return q.ToList();
    }

    private List<DeepRecoverItem> FilterDeep()
    {
        IEnumerable<DeepRecoverItem> q = _deepItems;
        var key = _txtSearch.Text.Trim();
        if (key.Length > 0)
        {
            q = q.Where(x =>
                x.Name.Contains(key, StringComparison.OrdinalIgnoreCase) ||
                x.RelativePath.Contains(key, StringComparison.OrdinalIgnoreCase) ||
                x.StatusText.Contains(key, StringComparison.OrdinalIgnoreCase));
        }

        return q.ToList();
    }

    private void FillBinList(List<RecycleBinItem> items)
    {
        _list.BeginUpdate();
        try
        {
            _list.Items.Clear();
            foreach (var it in items)
            {
                var row = new ListViewItem(it.Name) { Tag = it };
                row.SubItems.Add(it.OriginalPath);
                row.SubItems.Add(it.DeletedOn);
                row.SubItems.Add(it.SizeText);
                row.SubItems.Add(it.TypeName);
                row.ToolTipText = $"{it.Name}\n{it.OriginalPath}";
                _list.Items.Add(row);
            }
        }
        finally
        {
            _list.EndUpdate();
        }

        _lblStatus.Text = L.T(
            $"显示 {items.Count} / {_binItems.Count} 项",
            $"Showing {items.Count} / {_binItems.Count}");
    }

    private void FillDeepList(List<DeepRecoverItem> items)
    {
        _list.BeginUpdate();
        try
        {
            _list.Items.Clear();
            foreach (var it in items)
            {
                var row = new ListViewItem(it.Name) { Tag = it };
                row.SubItems.Add(it.RelativePath);
                row.SubItems.Add(it.ModifiedUtc is { } t
                    ? t.ToLocalTime().ToString("yyyy-MM-dd HH:mm")
                    : "-");
                row.SubItems.Add(FormatSize(it.SizeBytes));
                row.SubItems.Add(it.StatusText);
                row.ForeColor = it.Recoverability switch
                {
                    DeepRecoverability.Unsupported => Color.Gray,
                    DeepRecoverability.PossiblyIncomplete => Color.FromArgb(140, 90, 20),
                    _ => Color.FromArgb(20, 110, 40)
                };
                row.ToolTipText = $"{it.Name}\n{it.RelativePath}\n{it.StatusText}";
                _list.Items.Add(row);
            }
        }
        finally
        {
            _list.EndUpdate();
        }

        if (!_loading)
        {
            _lblStatus.Text = L.T(
                $"显示 {items.Count} / {_deepItems.Count} 项",
                $"Showing {items.Count} / {_deepItems.Count}");
        }
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

    private void RestoreOrRecoverSelected()
    {
        if (IsDeepMode)
        {
            var selected = _list.SelectedItems.Cast<ListViewItem>()
                .Select(x => x.Tag).OfType<DeepRecoverItem>().ToList();
            if (selected.Count == 0)
            {
                MessageBox.Show(this,
                    L.T("请先选择要恢复的文件。", "Select files to recover first."),
                    L.T("数据恢复", "Data Recovery"),
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            _ = DoDeepRecoverAsync(selected);
        }
        else
        {
            var selected = _list.SelectedItems.Cast<ListViewItem>()
                .Select(x => x.Tag).OfType<RecycleBinItem>().ToList();
            if (selected.Count == 0)
            {
                MessageBox.Show(this,
                    L.T("请先选择要还原的项目。", "Select items to restore first."),
                    L.T("数据恢复", "Data Recovery"),
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            DoBinRestore(selected);
        }
    }

    private void RestoreOrRecoverListed()
    {
        if (IsDeepMode)
        {
            var listed = _list.Items.Cast<ListViewItem>()
                .Select(x => x.Tag).OfType<DeepRecoverItem>().ToList();
            if (listed.Count == 0)
            {
                MessageBox.Show(this,
                    L.T("当前列表为空。", "Current list is empty."),
                    L.T("数据恢复", "Data Recovery"),
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            var confirm = MessageBox.Show(this,
                L.T(
                    $"将恢复当前列表中的 {listed.Count} 个文件，是否继续？",
                    $"Recover all {listed.Count} listed file(s)?"),
                L.T("数据恢复", "Data Recovery"),
                MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (confirm != DialogResult.Yes)
                return;

            _ = DoDeepRecoverAsync(listed);
        }
        else
        {
            var listed = _list.Items.Cast<ListViewItem>()
                .Select(x => x.Tag).OfType<RecycleBinItem>().ToList();
            if (listed.Count == 0)
            {
                MessageBox.Show(this,
                    L.T("当前列表为空。", "Current list is empty."),
                    L.T("数据恢复", "Data Recovery"),
                    MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            var confirm = MessageBox.Show(this,
                L.T(
                    $"将还原当前列表中的 {listed.Count} 项，是否继续？",
                    $"Restore all {listed.Count} listed item(s)?"),
                L.T("数据恢复", "Data Recovery"),
                MessageBoxButtons.YesNo, MessageBoxIcon.Question);
            if (confirm != DialogResult.Yes)
                return;

            DoBinRestore(listed);
        }
    }

    private async void DoBinRestore(List<RecycleBinItem> items)
    {
        _btnRestore.Enabled = false;
        _btnRestoreAll.Enabled = false;
        _btnRefresh.Enabled = false;
        _lblStatus.Text = L.T($"正在还原 {items.Count} 项…", $"Restoring {items.Count} item(s)…");

        try
        {
            await Task.Yield();
            var (ok, fail) = RecycleBinReader.RestoreMany(items, out var errors);

            var msg = L.T(
                $"还原完成：成功 {ok}，失败 {fail}。",
                $"Restore finished: {ok} ok, {fail} failed.");
            if (fail > 0 && errors.Count > 0)
            {
                var detail = string.Join("\n", errors.Take(6));
                if (errors.Count > 6)
                    detail += L.T($"\n…等共 {errors.Count} 条", $"\n…and {errors.Count} total");
                msg += "\n\n" + detail;
            }

            MessageBox.Show(this, msg, L.T("数据恢复", "Data Recovery"),
                MessageBoxButtons.OK,
                fail > 0 ? MessageBoxIcon.Warning : MessageBoxIcon.Information);

            await LoadBinAsync();
        }
        catch (Exception ex)
        {
            MessageBox.Show(this,
                L.T($"还原失败：{ex.Message}", $"Restore failed: {ex.Message}"),
                L.T("错误", "Error"),
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        finally
        {
            _btnRestore.Enabled = true;
            _btnRestoreAll.Enabled = true;
            _btnRefresh.Enabled = true;
        }
    }

    private async Task DoDeepRecoverAsync(List<DeepRecoverItem> items)
    {
        var recoverable = items
            .Where(x => x.Recoverability != DeepRecoverability.Unsupported)
            .ToList();
        if (recoverable.Count == 0)
        {
            MessageBox.Show(this,
                L.T("所选文件均无法恢复（压缩/加密或不支持）。", "None of the selected files can be recovered."),
                L.T("数据恢复", "Data Recovery"),
                MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        var drive = recoverable[0].Drive;
        using var dlg = new FolderBrowserDialog
        {
            Description = L.T(
                $"选择恢复保存目录（强烈建议不要选 {drive} 盘）",
                $"Choose output folder (strongly avoid drive {drive})"),
            UseDescriptionForTitle = true
        };

        if (dlg.ShowDialog(this) != DialogResult.OK)
            return;

        var outDir = dlg.SelectedPath;
        try
        {
            var outRoot = Path.GetPathRoot(outDir)?.TrimEnd('\\');
            if (!string.IsNullOrEmpty(outRoot) &&
                string.Equals(outRoot, drive, StringComparison.OrdinalIgnoreCase))
            {
                var go = MessageBox.Show(this,
                    L.T(
                        $"保存目录与扫描盘 {drive} 相同，可能覆盖尚未恢复的数据。\n仍要继续吗？",
                        $"Output is on the same drive {drive} and may overwrite recoverable data.\nContinue anyway?"),
                    L.T("警告", "Warning"),
                    MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
                if (go != DialogResult.Yes)
                    return;
            }
        }
        catch
        {
            // ignore path checks
        }

        _loading = true;
        _cts = new CancellationTokenSource();
        SetBusy(true);
        _progress.Visible = true;
        _progress.Value = 0;
        _lblStatus.Text = L.T($"正在恢复 {recoverable.Count} 个文件…", $"Recovering {recoverable.Count} file(s)…");

        var progress = new Progress<(int Done, int Total, string Name)>(p =>
        {
            if (IsDisposed)
                return;
            _progress.Value = p.Total <= 0 ? 0 : Math.Clamp(p.Done * 100 / p.Total, 0, 100);
            _lblStatus.Text = L.T(
                $"正在恢复 ({p.Done}/{p.Total})：{p.Name}",
                $"Recovering ({p.Done}/{p.Total}): {p.Name}");
        });

        try
        {
            var token = _cts.Token;
            var result = await Task.Run(() =>
            {
                var (ok, fail) = NtfsDeepRecovery.RecoverMany(drive, recoverable, outDir, progress, token, out var errors);
                return (ok, fail, errors);
            }, token);

            var msg = L.T(
                $"恢复完成：成功 {result.ok}，失败 {result.fail}。\n保存位置：{outDir}",
                $"Recover finished: {result.ok} ok, {result.fail} failed.\nSaved to: {outDir}");
            if (result.fail > 0 && result.errors.Count > 0)
            {
                var detail = string.Join("\n", result.errors.Take(6));
                if (result.errors.Count > 6)
                    detail += L.T($"\n…等共 {result.errors.Count} 条", $"\n…and {result.errors.Count} total");
                msg += "\n\n" + detail;
            }

            MessageBox.Show(this, msg, L.T("数据恢复", "Data Recovery"),
                MessageBoxButtons.OK,
                result.fail > 0 ? MessageBoxIcon.Warning : MessageBoxIcon.Information);

            try
            {
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
                {
                    FileName = outDir,
                    UseShellExecute = true
                });
            }
            catch
            {
                // ignore
            }
        }
        catch (OperationCanceledException)
        {
            _lblStatus.Text = L.T("恢复已取消", "Recover cancelled");
        }
        catch (Exception ex)
        {
            MessageBox.Show(this,
                L.T($"恢复失败：{ex.Message}", $"Recover failed: {ex.Message}"),
                L.T("错误", "Error"),
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        finally
        {
            _loading = false;
            _cts?.Dispose();
            _cts = null;
            SetBusy(false);
            _progress.Visible = false;
        }
    }
}
