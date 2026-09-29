namespace MemWatch;

/// <summary>剪切板历史：复制 / 收藏 / 置顶 / 长按拖动。</summary>
public sealed class ClipboardHistoryForm : Form
{
    private const int DragHoldMs = 380;
    private const int DragMovePx = 6;

    private readonly LevelConfig _levels;
    private readonly ListView _list = new();
    private readonly ImageList _thumbs = new();
    private readonly Button _btnCopy = new();
    private readonly Button _btnFav = new();
    private readonly Button _btnPin = new();
    private readonly Button _btnDelete = new();
    private readonly Button _btnClear = new();
    private readonly Button _btnClose = new();
    private readonly Label _lblMax = new();
    private readonly NumericUpDown _numMax = new();
    private readonly Label _lblHint = new();

    private bool _dragPending;
    private Point _dragDown;
    private long _dragDownTick;
    private ListViewItem? _dragItem;
    private ClipboardDragGhostForm? _ghost;

    public ClipboardHistoryForm(LevelConfig levels)
    {
        _levels = levels;
        BuildUi();
        ApplyLanguage();
        Reload();
        ClipboardHistoryService.Instance.Changed += OnChanged;
        FormClosed += (_, _) =>
        {
            ClipboardHistoryService.Instance.Changed -= OnChanged;
            _thumbs.Dispose();
        };
        L.Changed += OnLang;
        FormClosed += (_, _) => L.Changed -= OnLang;
    }

    private void OnLang()
    {
        if (IsDisposed) return;
        if (InvokeRequired) { BeginInvoke(OnLang); return; }
        ApplyLanguage();
        Reload();
    }

    private void OnChanged()
    {
        if (IsDisposed) return;
        if (InvokeRequired) { BeginInvoke(Reload); return; }
        Reload();
    }

    private void ApplyLanguage()
    {
        Text = L.T("剪切板历史", "Clipboard history");
        _btnCopy.Text = L.T("复制", "Copy");
        _btnFav.Text = L.T("收藏/取消", "Favorite");
        _btnPin.Text = L.T("图钉置顶", "Pin");
        _btnDelete.Text = L.T("删除", "Delete");
        _btnClear.Text = L.T("清理非收藏", "Clear non-favorites");
        _btnClose.Text = L.T("关闭", "Close");
        _lblMax.Text = L.T("非收藏上限", "Non-fav limit");
        _lblHint.Text = L.T("收藏项不会被自动清理。长按条目可拖到其它窗口；双击复制。",
            "Favorites are never auto-cleaned. Long-press to drag out; double-click to copy.");
        if (_list.Columns.Count >= 3)
        {
            _list.Columns[0].Text = L.T("收藏", "Fav");
            _list.Columns[1].Text = L.T("类型", "Type");
            _list.Columns[2].Text = L.T("内容", "Content");
        }
    }

    private void BuildUi()
    {
        FormBorderStyle = FormBorderStyle.Sizable;
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(520, 420);
        ClientSize = new Size(640, 480);
        Font = new Font("Segoe UI", 9f);
        BackColor = UiTheme.Back;

        var top = new Panel { Dock = DockStyle.Top, Height = 44, Padding = new Padding(8) };
        _lblMax.AutoSize = true;
        _lblMax.Location = new Point(8, 12);
        _numMax.Minimum = 5;
        _numMax.Maximum = 500;
        _numMax.Value = LevelConfig.ClampClipboardHistoryMax(_levels.ClipboardHistoryMax);
        _numMax.Location = new Point(100, 8);
        _numMax.Width = 60;
        _numMax.ValueChanged += (_, _) =>
        {
            var v = LevelConfig.ClampClipboardHistoryMax((int)_numMax.Value);
            _levels.ClipboardHistoryMax = v;
            _levels.Save();
            ClipboardHistoryService.Instance.MaxNonFavorite = v;
        };
        top.Controls.Add(_lblMax);
        top.Controls.Add(_numMax);

        _thumbs.ImageSize = new Size(48, 48);
        _thumbs.ColorDepth = ColorDepth.Depth32Bit;
        _list.Dock = DockStyle.Fill;
        _list.View = View.Details;
        _list.FullRowSelect = true;
        _list.GridLines = true;
        _list.HideSelection = false;
        _list.SmallImageList = _thumbs;
        _list.Columns.Add("Fav", 50);
        _list.Columns.Add("Type", 70);
        _list.Columns.Add("Content", 460);
        _list.DoubleClick += (_, _) => CopySelected();
        _list.MouseDown += List_MouseDown;
        _list.MouseMove += List_MouseMove;
        _list.MouseUp += List_MouseUp;

        var bottom = new Panel { Dock = DockStyle.Bottom, Height = 78 };
        _lblHint.Dock = DockStyle.Top;
        _lblHint.Height = 28;
        _lblHint.ForeColor = Color.DimGray;
        var bar = new FlowLayoutPanel
        {
            Dock = DockStyle.Fill,
            FlowDirection = FlowDirection.LeftToRight,
            Padding = new Padding(8, 4, 8, 4),
            WrapContents = false
        };
        foreach (var b in new[] { _btnCopy, _btnFav, _btnPin, _btnDelete, _btnClear, _btnClose })
        {
            b.AutoSize = true;
            b.Height = 28;
            bar.Controls.Add(b);
        }

        _btnCopy.Click += (_, _) => CopySelected();
        _btnFav.Click += (_, _) => ToggleFavorite();
        _btnPin.Click += (_, _) => PinSelected();
        _btnDelete.Click += (_, _) => DeleteSelected();
        _btnClear.Click += (_, _) =>
        {
            ClipboardHistoryService.Instance.ClearNonFavorites();
            Reload();
        };
        _btnClose.Click += (_, _) => Close();

        bottom.Controls.Add(bar);
        bottom.Controls.Add(_lblHint);
        Controls.Add(_list);
        Controls.Add(bottom);
        Controls.Add(top);
        UiTheme.StyleTree(this);
        EchoChrome.Attach(this, canResize: true, showMin: true);
    }

    private void Reload()
    {
        _list.BeginUpdate();
        try
        {
            _list.Items.Clear();
            _thumbs.Images.Clear();
            var items = ClipboardHistoryService.Instance.GetSnapshot();
            foreach (var item in items)
            {
                var fav = item.Favorite ? "★" : "";
                var type = item.Kind == ClipboardEntryKind.Image
                    ? L.T("图片", "Image")
                    : L.T("文本", "Text");
                var row = new ListViewItem(fav) { Tag = item.Id };
                row.SubItems.Add(type);
                row.SubItems.Add(item.Preview.Replace('\r', ' ').Replace('\n', ' '));
                if (item.Kind == ClipboardEntryKind.Image)
                {
                    var thumb = ClipboardHistoryService.Instance.LoadThumbnail(item.Id, 48);
                    if (thumb is not null)
                    {
                        _thumbs.Images.Add(item.Id, thumb);
                        row.ImageKey = item.Id;
                    }
                }

                _list.Items.Add(row);
            }
        }
        finally
        {
            _list.EndUpdate();
        }
    }

    private string? SelectedId() =>
        _list.SelectedItems.Count > 0 ? _list.SelectedItems[0].Tag as string : null;

    private void CopySelected()
    {
        var id = SelectedId();
        if (id is null) return;
        if (!ClipboardHistoryService.Instance.TryCopyToClipboard(id))
            MessageBox.Show(this, L.T("复制失败。", "Copy failed."), Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }

    private void ToggleFavorite()
    {
        var id = SelectedId();
        if (id is null) return;
        var item = ClipboardHistoryService.Instance.GetSnapshot().FirstOrDefault(x => x.Id == id);
        if (item is null) return;
        ClipboardHistoryService.Instance.SetFavorite(id, !item.Favorite);
    }

    private void PinSelected()
    {
        var id = SelectedId();
        if (id is null) return;
        if (!ClipboardHistoryService.Instance.TryPin(id))
            MessageBox.Show(this, L.T("只能置顶图片条目。", "Only image entries can be pinned."),
                Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
    }

    private void DeleteSelected()
    {
        var id = SelectedId();
        if (id is null) return;
        ClipboardHistoryService.Instance.Remove(id);
    }

    private void List_MouseDown(object? sender, MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left) return;
        var item = _list.HitTest(e.Location).Item;
        if (item is null) return;

        _dragPending = true;
        _dragItem = item;
        _dragDown = e.Location;
        _dragDownTick = Environment.TickCount64;
        item.Selected = true;
        _list.Capture = true;
    }

    private void List_MouseMove(object? sender, MouseEventArgs e)
    {
        if (!_dragPending || _dragItem is null) return;
        if (Environment.TickCount64 - _dragDownTick < DragHoldMs) return;
        if (Math.Abs(e.X - _dragDown.X) < DragMovePx && Math.Abs(e.Y - _dragDown.Y) < DragMovePx) return;

        _dragPending = false;
        var item = _dragItem;
        _dragItem = null;
        _list.Capture = false;
        BeginDrag(item);
    }

    private void List_MouseUp(object? sender, MouseEventArgs e)
    {
        _dragPending = false;
        _dragItem = null;
        _list.Capture = false;
    }

    private void BeginDrag(ListViewItem item)
    {
        var id = item.Tag as string;
        if (id is null) return;

        var data = ClipboardHistoryService.Instance.CreateDragData(id);
        if (data is null) return;

        Bitmap? owned = null;
        GiveFeedbackEventHandler? onFeedback = null;
        QueryContinueDragEventHandler? onQuery = null;
        try
        {
            if (data.GetDataPresent(DataFormats.Bitmap))
                owned = data.GetData(DataFormats.Bitmap) as Bitmap;

            var ghostBmp = CreateDragGhostBitmap(id);
            if (ghostBmp is not null)
            {
                _ghost = new ClipboardDragGhostForm(ghostBmp);
                _ghost.Follow(Cursor.Position);
            }

            var dragCursor = Cursors.SizeAll;
            onFeedback = (_, e) =>
            {
                e.UseDefaultCursors = false;
                Cursor.Current = dragCursor;
                _ghost?.Follow(Cursor.Position);
            };
            onQuery = (_, e) =>
            {
                if (e.EscapePressed || e.Action is DragAction.Drop or DragAction.Cancel)
                    HideDragGhost();
            };

            _list.GiveFeedback += onFeedback;
            _list.QueryContinueDrag += onQuery;
            Hide();
            try
            {
                _list.DoDragDrop(data, DragDropEffects.Copy);
            }
            finally
            {
                Show();
                BringToFront();
            }
        }
        finally
        {
            if (onFeedback is not null) _list.GiveFeedback -= onFeedback;
            if (onQuery is not null) _list.QueryContinueDrag -= onQuery;
            HideDragGhost();
            owned?.Dispose();
        }
    }

    private void HideDragGhost()
    {
        _ghost?.Dispose();
        _ghost = null;
    }

    private static Bitmap? CreateDragGhostBitmap(string id)
    {
        var entry = ClipboardHistoryService.Instance.TryGetEntry(id);
        if (entry is null) return null;

        Bitmap? content = null;
        if (entry.Kind == ClipboardEntryKind.Image)
        {
            using var thumb = ClipboardHistoryService.Instance.LoadThumbnail(id, 72);
            if (thumb is null) return null;
            content = new Bitmap(thumb);
        }
        else
        {
            var text = entry.Text ?? entry.Preview;
            if (string.IsNullOrWhiteSpace(text)) return null;

            var sample = text.Replace('\r', ' ').Replace('\n', ' ');
            if (sample.Length > 56) sample = sample[..56] + "…";

            const int maxW = 180;
            const int maxH = 56;
            using var font = new Font("Segoe UI", 9f);
            var sz = TextRenderer.MeasureText(sample, font, new Size(maxW, maxH),
                TextFormatFlags.WordBreak | TextFormatFlags.EndEllipsis);
            var w = Math.Max(72, Math.Min(maxW, sz.Width) + 12);
            var h = Math.Max(24, Math.Min(maxH, sz.Height) + 12);
            content = new Bitmap(w, h);
            using (var g = Graphics.FromImage(content))
            {
                g.Clear(Color.White);
                TextRenderer.DrawText(g, sample, font, new Rectangle(6, 4, w - 12, h - 8),
                    Color.Black, TextFormatFlags.WordBreak | TextFormatFlags.EndEllipsis);
            }
        }

        return ComposeGhostFrame(content);
    }

    private static Bitmap ComposeGhostFrame(Bitmap content)
    {
        const int pad = 4;
        var frame = new Bitmap(content.Width + pad * 2, content.Height + pad * 2);
        using (var g = Graphics.FromImage(frame))
        {
            g.Clear(Color.FromArgb(1, 0, 0, 0)); // 近透明底，减轻 Opacity 叠加重绘
            var r = new Rectangle(pad - 1, pad - 1, content.Width + 1, content.Height + 1);
            using var fill = new SolidBrush(Color.FromArgb(248, 255, 255, 255));
            g.FillRectangle(fill, r);
            g.DrawImageUnscaled(content, pad, pad);
            using var pen = new Pen(Color.FromArgb(210, 25, 118, 210), 2f);
            g.DrawRectangle(pen, r);
        }

        content.Dispose();
        return frame;
    }
}
