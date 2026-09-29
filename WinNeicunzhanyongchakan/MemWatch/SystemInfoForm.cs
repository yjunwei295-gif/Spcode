namespace MemWatch;

/// <summary>电脑配置详情窗口。</summary>
public sealed class SystemInfoForm : Form
{
    private readonly ListView _list = new();
    private readonly Label _lblStatus = new();
    private readonly Button _btnRefresh = new();
    private readonly Button _btnClose = new();
    private readonly ContextMenuStrip _itemMenu = new();
    private readonly ToolStripMenuItem _menuCopyValue = new();
    private readonly ToolStripMenuItem _menuCopyName = new();
    private readonly ToolStripMenuItem _menuCopyLine = new();
    private readonly LevelConfig _levels;
    private bool _loading;
    private bool _hasData;
    private static readonly Color DefaultBack = UiTheme.Back;
    private Button? _btnSkin;
    private Font? _headerFont;
    private Font? _boldFont;

    public SystemInfoForm(LevelConfig levels)
    {
        _levels = levels;
        BuildUi();
        _headerFont = new Font(_list.Font, FontStyle.Bold);
        _boldFont = new Font(_list.Font, FontStyle.Bold);
        TopMost = false;
        ApplyLanguage();
        L.Changed += OnLanguageChanged;
        FormClosed += (_, _) =>
        {
            L.Changed -= OnLanguageChanged;
            _headerFont?.Dispose();
            _boldFont?.Dispose();
            _headerFont = null;
            _boldFont = null;
        };
        WindowSkin.Apply(this, _levels, WindowSkin.KeySystemInfo, DefaultBack);
        // 打开时自动读一次，之后只靠手动「刷新」
        Shown += async (_, _) => await LoadAsync();
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
        if (_hasData && !_loading)
            _ = LoadAsync();
    }

    private void ApplyLanguage()
    {
        Text = L.T("电脑配置详情", "System Information");
        _btnRefresh.Text = L.T("刷新", "Refresh");
        _btnClose.Text = L.T("关闭", "Close");
        if (_btnSkin is not null)
            _btnSkin.Text = L.T("皮肤", "Skin");

        if (_list.Columns.Count >= 2)
        {
            _list.Columns[0].Text = L.T("项目", "Item");
            _list.Columns[1].Text = L.T("详情", "Details");
        }

        _menuCopyValue.Text = L.T("复制详情", "Copy details");
        _menuCopyName.Text = L.T("复制项目名", "Copy item name");
        _menuCopyLine.Text = L.T("复制整行", "Copy row");

        if (!_hasData && !_loading)
            _lblStatus.Text = L.T("正在读取硬件信息…", "Reading hardware…");
    }

    private void BuildUi()
    {
        Text = L.T("电脑配置详情", "System Information");
        FormBorderStyle = FormBorderStyle.Sizable;
        MaximizeBox = true;
        MinimizeBox = true;
        ShowInTaskbar = true;
        StartPosition = FormStartPosition.CenterParent;
        Font = new Font("Segoe UI", 9f);
        BackColor = DefaultBack;
        DoubleBuffered = true;
        MinimumSize = new Size(560, 420);
        ClientSize = new Size(720, 560);

        const int pad = 8;

        var top = new Panel
        {
            Dock = DockStyle.Top,
            Height = 36,
            BackColor = DefaultBack
        };

        _lblStatus.AutoSize = false;
        _lblStatus.Location = new Point(pad, 8);
        _lblStatus.Size = new Size(480, 22);
        _lblStatus.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        _lblStatus.ForeColor = Color.DimGray;
        _lblStatus.Text = L.T("正在读取硬件信息…", "Reading hardware…");

        _btnRefresh.Text = L.T("刷新", "Refresh");
        _btnRefresh.Size = new Size(70, 26);
        _btnRefresh.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        _btnRefresh.Click += async (_, _) => await LoadAsync();

        _btnSkin = WindowSkin.CreateButton(this, _levels, WindowSkin.KeySystemInfo, DefaultBack);
        _btnSkin.Anchor = AnchorStyles.Top | AnchorStyles.Right;

        top.Controls.Add(_lblStatus);
        top.Controls.Add(_btnSkin);
        top.Controls.Add(_btnRefresh);
        top.Resize += (_, _) => LayoutTopButtons(top, pad);

        var bottom = new Panel
        {
            Dock = DockStyle.Bottom,
            Height = 44,
            BackColor = DefaultBack
        };

        _btnClose.Text = L.T("关闭", "Close");
        _btnClose.Size = new Size(70, 28);
        _btnClose.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        _btnClose.Click += (_, _) => Close();

        bottom.Controls.Add(_btnClose);
        bottom.Resize += (_, _) =>
        {
            _btnClose.Location = new Point(bottom.ClientSize.Width - _btnClose.Width - pad, 8);
        };

        _list.Dock = DockStyle.Fill;
        _list.View = View.Details;
        _list.FullRowSelect = true;
        _list.MultiSelect = true;
        _list.GridLines = false;
        _list.HeaderStyle = ColumnHeaderStyle.Nonclickable;
        _list.HideSelection = false;
        _list.BorderStyle = BorderStyle.FixedSingle;
        _list.Columns.Add(L.T("项目", "Item"), 180);
        _list.Columns.Add(L.T("详情", "Details"), 480);
        _list.ShowItemToolTips = true;
        _list.MouseUp += List_MouseUp;
        _list.KeyDown += List_KeyDown;

        _menuCopyValue.Text = L.T("复制详情", "Copy details");
        _menuCopyValue.Click += (_, _) => CopySelected(CopyMode.Value);
        _menuCopyName.Text = L.T("复制项目名", "Copy item name");
        _menuCopyName.Click += (_, _) => CopySelected(CopyMode.Name);
        _menuCopyLine.Text = L.T("复制整行", "Copy row");
        _menuCopyLine.Click += (_, _) => CopySelected(CopyMode.Line);
        _itemMenu.Items.AddRange(new ToolStripItem[] { _menuCopyValue, _menuCopyName, _menuCopyLine });
        _itemMenu.Opening += (_, e) =>
        {
            if (_list.SelectedItems.Count == 0)
                e.Cancel = true;
        };
        _list.ContextMenuStrip = _itemMenu;

        var listHost = new Panel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(pad, 0, pad, 0),
            BackColor = DefaultBack
        };
        listHost.Controls.Add(_list);

        Controls.Add(listHost);
        Controls.Add(bottom);
        Controls.Add(top);

        LayoutTopButtons(top, pad);
        _btnClose.Location = new Point(bottom.ClientSize.Width - _btnClose.Width - pad, 8);
        _lblStatus.Width = Math.Max(100, (_btnSkin?.Left ?? _btnRefresh.Left) - pad * 2);
        UiTheme.StyleTree(this);
        EchoChrome.Attach(this, canResize: true, showMin: true);
    }

    private void LayoutTopButtons(Panel top, int pad)
    {
        _btnRefresh.Location = new Point(top.ClientSize.Width - _btnRefresh.Width - pad, 5);
        if (_btnSkin is not null)
        {
            _btnSkin.Location = new Point(_btnRefresh.Left - _btnSkin.Width - 6, 5);
            _lblStatus.Width = Math.Max(100, _btnSkin.Left - pad * 2);
        }
        else
        {
            _lblStatus.Width = Math.Max(100, _btnRefresh.Left - pad * 2);
        }
    }

    private async Task LoadAsync()
    {
        if (_loading)
            return;

        _loading = true;
        _btnRefresh.Enabled = false;
        _lblStatus.Text = L.T("正在读取硬件信息…", "Reading hardware…");
        _list.Items.Clear();

        try
        {
            var sections = await Task.Run(HwInfoReader.Collect);
            FillList(sections);
            _hasData = true;
            _lblStatus.Text = L.T(
                $"已读取 {sections.Count} 类配置 · {DateTime.Now:HH:mm:ss}",
                $"Loaded {sections.Count} sections · {DateTime.Now:HH:mm:ss}");
        }
        catch (Exception ex)
        {
            _lblStatus.Text = L.T("读取失败", "Read failed");
            MessageBox.Show(this,
                L.T($"无法读取电脑配置：{ex.Message}", $"Could not read system info: {ex.Message}"),
                L.T("错误", "Error"),
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        finally
        {
            _loading = false;
            _btnRefresh.Enabled = true;
        }
    }

    private void FillList(List<HwSection> sections)
    {
        _list.BeginUpdate();
        try
        {
            _list.Items.Clear();
            foreach (var section in sections)
            {
                var header = new ListViewItem($"【{section.Title}】")
                {
                    ForeColor = Color.FromArgb(30, 90, 160),
                    Font = _headerFont ?? _list.Font,
                    ToolTipText = section.Title
                };
                header.SubItems.Add("");
                _list.Items.Add(header);

                foreach (var (name, value) in section.Items)
                {
                    var item = new ListViewItem(name)
                    {
                        ToolTipText = $"{name}\n{value}"
                    };
                    item.SubItems.Add(value);
                    ApplyHighlight(item, name);
                    _list.Items.Add(item);
                }

                // 分组间隔空行
                _list.Items.Add(new ListViewItem(""));
            }
        }
        finally
        {
            _list.EndUpdate();
        }

        BeginInvoke(() =>
        {
            if (_list.IsDisposed || _list.Columns.Count < 2 || _list.ClientSize.Width <= 0)
                return;
            _list.Columns[0].Width = 180;
            _list.Columns[1].Width = Math.Max(280, _list.ClientSize.Width - _list.Columns[0].Width - 24);
        });
    }

    private void List_MouseUp(object? sender, MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Right)
            return;

        var hit = _list.HitTest(e.Location);
        if (hit.Item is null)
            return;

        if (!hit.Item.Selected)
        {
            _list.SelectedItems.Clear();
            hit.Item.Selected = true;
            hit.Item.Focused = true;
        }
    }

    private void List_KeyDown(object? sender, KeyEventArgs e)
    {
        if (e.Control && e.KeyCode == Keys.C)
        {
            CopySelected(CopyMode.Value);
            e.Handled = true;
            e.SuppressKeyPress = true;
        }
        else if (e.Control && e.KeyCode == Keys.A)
        {
            foreach (ListViewItem item in _list.Items)
                item.Selected = true;
            e.Handled = true;
            e.SuppressKeyPress = true;
        }
    }

    private enum CopyMode { Value, Name, Line }

    private void CopySelected(CopyMode mode)
    {
        if (_list.SelectedItems.Count == 0)
            return;

        var lines = new List<string>(_list.SelectedItems.Count);
        foreach (ListViewItem item in _list.SelectedItems)
        {
            var name = item.Text?.Trim() ?? "";
            var value = item.SubItems.Count > 1 ? item.SubItems[1].Text?.Trim() ?? "" : "";

            // 跳过空行和纯分组标题可仍允许复制
            string text = mode switch
            {
                CopyMode.Name => name,
                CopyMode.Line => string.IsNullOrEmpty(value) ? name : $"{name}\t{value}",
                _ => string.IsNullOrEmpty(value) ? name : value
            };

            if (!string.IsNullOrWhiteSpace(text))
                lines.Add(text);
        }

        if (lines.Count == 0)
            return;

        try
        {
            Clipboard.SetText(string.Join(Environment.NewLine, lines));
            _lblStatus.Text = lines.Count == 1
                ? L.T("已复制到剪贴板", "Copied to clipboard")
                : L.T($"已复制 {lines.Count} 行到剪贴板", $"Copied {lines.Count} lines");
        }
        catch (Exception ex)
        {
            MessageBox.Show(this,
                L.T($"复制失败：{ex.Message}", $"Copy failed: {ex.Message}"),
                L.T("提示", "Notice"),
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    /// <summary>名称 / 型号 / 版本用不同颜色高亮。</summary>
    private void ApplyHighlight(ListViewItem item, string fieldName)
    {
        // 去掉「CPU1 · 」这类前缀再判断
        var key = fieldName;
        var dot = key.LastIndexOf('·');
        if (dot >= 0 && dot + 1 < key.Length)
            key = key[(dot + 1)..].Trim();

        var bold = _boldFont;
        if (key.Contains("名称", StringComparison.Ordinal) ||
            key.Contains("名字", StringComparison.Ordinal) ||
            key.Equals("Name", StringComparison.OrdinalIgnoreCase))
        {
            item.ForeColor = Color.FromArgb(20, 100, 180); // 蓝
            if (bold is not null)
                item.Font = bold;
            return;
        }

        if (key.Contains("型号", StringComparison.Ordinal) ||
            key.Contains("产品", StringComparison.Ordinal) ||
            key.Contains("Part number", StringComparison.OrdinalIgnoreCase) ||
            key.Equals("Model", StringComparison.OrdinalIgnoreCase) ||
            key.Equals("Product", StringComparison.OrdinalIgnoreCase))
        {
            item.ForeColor = Color.FromArgb(180, 100, 20); // 橙
            if (bold is not null)
                item.Font = bold;
            return;
        }

        if (key.Contains("版本", StringComparison.Ordinal) ||
            key.Contains("Version", StringComparison.OrdinalIgnoreCase) ||
            key.Contains("Driver", StringComparison.OrdinalIgnoreCase))
        {
            item.ForeColor = Color.FromArgb(110, 50, 160); // 紫
            if (bold is not null)
                item.Font = bold;
            return;
        }

        if (key.Contains("温度", StringComparison.Ordinal) ||
            key.Contains("Temperature", StringComparison.OrdinalIgnoreCase) ||
            key.Contains("Temp", StringComparison.OrdinalIgnoreCase))
        {
            item.ForeColor = Color.FromArgb(180, 60, 40); // 红橙
            if (bold is not null)
                item.Font = bold;
        }
    }
}
