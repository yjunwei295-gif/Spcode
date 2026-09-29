namespace MemWatch;

/// <summary>猎杀候选：内存占用 + 可选 CPU 采样。</summary>
public readonly record struct HuntCandidate(int Pid, string Name, long MemMb, double? CpuPct);

/// <summary>猎杀模式确认：列出拟猎杀进程，可排除、仅选低活动或一键清理低活动。</summary>
public sealed class HuntConfirmForm : Form
{
    private readonly CheckedListBox _list = new();
    private readonly Label _lbl = new();
    private readonly CheckBox _chkAutoLow = new();
    private readonly Button _btnOk = new();
    private readonly Button _btnCancel = new();
    private readonly Button _btnAll = new();
    private readonly Button _btnNone = new();
    private readonly Button _btnSelectLow = new();
    private readonly Button _btnCleanLow = new();
    private readonly int _lowCpuPct;
    private readonly int _lowMemMb;
    private readonly int _foregroundPid;

    public HuntConfirmForm(
        IReadOnlyList<HuntCandidate> candidates,
        int thresholdPct,
        double currentPct,
        int lowActivityCpuPct,
        int lowActivityMemMb,
        int foregroundPid,
        bool autoSelectLowActivity)
    {
        _lowCpuPct = lowActivityCpuPct;
        _lowMemMb = lowActivityMemMb;
        _foregroundPid = foregroundPid;

        Text = L.T("亚哈准备猎杀", "Ahab ready to hunt");
        FormBorderStyle = FormBorderStyle.FixedDialog;
        StartPosition = FormStartPosition.CenterParent;
        MinimizeBox = false;
        MaximizeBox = false;
        ShowInTaskbar = false;
        ClientSize = new Size(480, 448);
        Font = new Font("Segoe UI", 9f);
        BackColor = UiTheme.Back;
        ForeColor = UiTheme.Ink;

        _lbl.AutoSize = false;
        _lbl.Location = new Point(12, 10);
        _lbl.Size = new Size(ClientSize.Width - 24, 58);
        _lbl.Text = L.T(
            $"当前内存 {currentPct:0.0}% ≥ 猎杀阈值 {thresholdPct}%\n" +
            $"低活动 = CPU ≤ {lowActivityCpuPct}% 且内存 ≤ {lowActivityMemMb} MB（不含前台窗口）。\n" +
            "开发中的大项目通常不会被自动勾选；可手动勾选或点「一键清理低活动」。",
            $"Memory {currentPct:0.0}% ≥ hunt threshold {thresholdPct}%\n" +
            $"Low activity = CPU ≤ {lowActivityCpuPct}% and memory ≤ {lowActivityMemMb} MB (excludes foreground).\n" +
            "Active dev projects usually stay unchecked; use “Clean low activity” for one-click cleanup.");

        _list.Location = new Point(12, 74);
        _list.Size = new Size(ClientSize.Width - 24, 262);
        _list.CheckOnClick = true;
        _list.IntegralHeight = false;
        foreach (var c in candidates)
        {
            var cpuText = c.CpuPct.HasValue ? $"{c.CpuPct.Value:0.0}%" : "?";
            var fgMark = c.Pid == foregroundPid
                ? L.T(" · 前台", " · foreground")
                : "";
            var text = $"{c.Name}  (PID {c.Pid}, {c.MemMb:N0} MB, CPU {cpuText}){fgMark}";
            var item = new HuntItem(c.Pid, c.Name, c.MemMb, c.CpuPct, text);
            var check = autoSelectLowActivity ? IsLowActivity(item) : true;
            _list.Items.Add(item, isChecked: check);
        }

        _chkAutoLow.Text = L.T("打开时自动勾选低活动", "Auto-check low activity on open");
        _chkAutoLow.AutoSize = true;
        _chkAutoLow.Location = new Point(12, 344);
        _chkAutoLow.Checked = autoSelectLowActivity;

        _btnAll.Text = L.T("全选", "All");
        _btnAll.Size = new Size(56, 28);
        _btnAll.Location = new Point(12, 374);
        _btnAll.Click += (_, _) => SetAll(true);

        _btnNone.Text = L.T("全不选", "None");
        _btnNone.Size = new Size(56, 28);
        _btnNone.Location = new Point(74, 374);
        _btnNone.Click += (_, _) => SetAll(false);

        _btnSelectLow.Text = L.T("仅选低活动", "Low only");
        _btnSelectLow.Size = new Size(88, 28);
        _btnSelectLow.Location = new Point(136, 374);
        _btnSelectLow.Click += (_, _) => SelectOnlyLowActivity();

        _btnCleanLow.Text = L.T("一键清理低活动", "Clean low activity");
        _btnCleanLow.Size = new Size(118, 28);
        _btnCleanLow.Location = new Point(230, 374);
        UiTheme.FlattenButton(_btnCleanLow, UiTheme.Accent);
        _btnCleanLow.Click += (_, _) => ConfirmCleanLowActivity();

        _btnOk.Text = L.T("开始猎杀", "Start hunt");
        _btnOk.Size = new Size(96, 28);
        _btnOk.Location = new Point(ClientSize.Width - 12 - 96 - 8 - 108, 410);
        UiTheme.FlattenButton(_btnOk, UiTheme.Warn);
        _btnOk.Click += (_, _) => ConfirmHunt();

        _btnCancel.Text = L.T("本次不猎杀", "Skip this hunt");
        _btnCancel.Size = new Size(108, 28);
        _btnCancel.Location = new Point(ClientSize.Width - 12 - 108, 410);
        _btnCancel.DialogResult = DialogResult.Cancel;

        AcceptButton = _btnOk;
        CancelButton = _btnCancel;

        Controls.AddRange(new Control[]
        {
            _lbl, _list, _chkAutoLow, _btnAll, _btnNone, _btnSelectLow, _btnCleanLow, _btnOk, _btnCancel
        });
        UiTheme.StyleTree(this);
        EchoChrome.Attach(this, canResize: false, showMin: false);
    }

    /// <summary>用户是否勾选「打开时自动勾选低活动」。</summary>
    public bool AutoSelectLowActivity => _chkAutoLow.Checked;

    /// <summary>按列表顺序返回勾选的目标（已是从大到小）。</summary>
    public List<(int Pid, string Name, long MemMb)> GetSelected()
    {
        var result = new List<(int, string, long)>();
        for (var i = 0; i < _list.Items.Count; i++)
        {
            if (!_list.GetItemChecked(i))
                continue;
            if (_list.Items[i] is HuntItem item)
                result.Add((item.Pid, item.Name, item.MemMb));
        }

        return result;
    }

    private bool IsLowActivity(HuntItem item)
    {
        if (item.Pid == _foregroundPid)
            return false;
        if (!item.CpuPct.HasValue)
            return false;
        return item.CpuPct.Value <= _lowCpuPct && item.MemMb <= _lowMemMb;
    }

    private void SelectOnlyLowActivity()
    {
        for (var i = 0; i < _list.Items.Count; i++)
        {
            if (_list.Items[i] is HuntItem item)
                _list.SetItemChecked(i, IsLowActivity(item));
        }
    }

    private void ConfirmCleanLowActivity()
    {
        SelectOnlyLowActivity();
        ConfirmHunt();
    }

    private void ConfirmHunt()
    {
        if (_list.CheckedItems.Count == 0)
        {
            MessageBox.Show(this,
                L.T("请至少勾选一个程序，或点「本次不猎杀」。", "Check at least one app, or cancel the hunt."),
                L.T("提示", "Notice"),
                MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        DialogResult = DialogResult.OK;
        Close();
    }

    private void SetAll(bool check)
    {
        for (var i = 0; i < _list.Items.Count; i++)
            _list.SetItemChecked(i, check);
    }

    private sealed class HuntItem(int pid, string name, long memMb, double? cpuPct, string display)
    {
        public int Pid { get; } = pid;
        public string Name { get; } = name;
        public long MemMb { get; } = memMb;
        public double? CpuPct { get; } = cpuPct;
        public override string ToString() => display;
    }
}
