namespace MemWatch;

/// <summary>
/// 黑白弱边框：浅灰底、白列表、黑字。按钮仍用木纹立体画法，色调改成灰黑。
/// </summary>
internal static class UiTheme
{
    /// <summary>浅灰底。</summary>
    public static readonly Color Back = Color.FromArgb(0xF2, 0xF2, 0xF2);

    /// <summary>中灰，普通按钮。</summary>
    public static readonly Color Panel = Color.FromArgb(0xE4, 0xE4, 0xE4);

    /// <summary>白，列表/输入。</summary>
    public static readonly Color Surface = Color.FromArgb(0xFF, 0xFF, 0xFF);

    /// <summary>极弱灰边。</summary>
    public static readonly Color Line = Color.FromArgb(0xD4, 0xD4, 0xD4);

    public static readonly Color Ink = Color.FromArgb(0x11, 0x11, 0x11);
    public static readonly Color Muted = Color.FromArgb(0x73, 0x73, 0x73);

    /// <summary>黑：确认。</summary>
    public static readonly Color Accent = Color.FromArgb(0x17, 0x17, 0x17);

    /// <summary>深黑：强制结束。</summary>
    public static readonly Color Danger = Color.FromArgb(0x2A, 0x2A, 0x2A);

    /// <summary>中黑：猎杀警告。</summary>
    public static readonly Color Warn = Color.FromArgb(0x44, 0x44, 0x44);

    /// <summary>灰：信息。</summary>
    public static readonly Color Info = Color.FromArgb(0x55, 0x55, 0x55);

    public static readonly Color OnSolid = Color.FromArgb(0xF4, 0xF4, 0xF4);
    public static readonly Color Yellow = Warn;

    public static readonly Color Whale = Color.FromArgb(0x11, 0x11, 0x11);
    public static readonly Color Elephant = Color.FromArgb(0x33, 0x33, 0x33);
    public static readonly Color Dog = Color.FromArgb(0x55, 0x55, 0x55);
    public static readonly Color Cat = Color.FromArgb(0x77, 0x77, 0x77);

    /// <summary>深灰顶栏。</summary>
    public static readonly Color TitleBar = Color.FromArgb(0x2A, 0x2A, 0x2A);

    /// <summary>顶栏白字。</summary>
    public static readonly Color TitleInk = Color.FromArgb(0xF4, 0xF4, 0xF4);

    public static void FlattenButton(Button btn, Color? fill = null, Color? text = null, bool hardShadow = false)
    {
        btn.UseVisualStyleBackColor = false;
        btn.FlatStyle = FlatStyle.Flat;
        btn.Cursor = Cursors.Hand;
        btn.FlatAppearance.BorderSize = 0;
        btn.FlatAppearance.BorderColor = Line;
        var kind = ButtonKind.Normal;
        if (fill is Color c)
        {
            btn.BackColor = c;
            if (fill is Color d && d.ToArgb() == Danger.ToArgb())
                kind = ButtonKind.Danger;
            else if (fill is Color a && a.ToArgb() == Accent.ToArgb())
                kind = ButtonKind.Accent;
        }
        else
        {
            btn.BackColor = Panel;
        }

        btn.FlatAppearance.MouseOverBackColor = ControlPaint.Light(btn.BackColor, 0.08f);
        btn.FlatAppearance.MouseDownBackColor = ControlPaint.Dark(btn.BackColor, 0.06f);
        _ = hardShadow;

        if (fill is Color fc && fc.ToArgb() == TitleBar.ToArgb())
        {
            btn.BackgroundImage = null;
            btn.ForeColor = text ?? OnSolid;
            return;
        }

        if (btn.Width < 2 || btn.Height < 2)
        {
            btn.BackgroundImage = null;
            btn.ForeColor = text ?? Ink;
            return;
        }

        btn.BackgroundImage = FarmSkin.WoodButton(btn.Size, kind);
        btn.BackgroundImageLayout = ImageLayout.Stretch;
        // 按贴图实际深浅：深灰/黑底白字，浅灰/白底黑字
        btn.ForeColor = text ?? (kind is ButtonKind.Danger or ButtonKind.Accent ? OnSolid : Ink);
    }

    public static void StyleList(ListView lv)
    {
        lv.BackColor = Surface;
        lv.ForeColor = Ink;
        lv.BorderStyle = BorderStyle.None;
        lv.GridLines = false;
    }

    /// <summary>给窗口树套黑白配色；已设强调色的按钮不覆盖。</summary>
    public static void StyleTree(Control root)
    {
        ApplyOne(root);
        foreach (Control child in root.Controls)
            StyleTree(child);
    }

    private static void ApplyOne(Control c)
    {
        switch (c)
        {
            case Button b:
                if (b.FlatStyle == FlatStyle.Flat &&
                    !IsLegacyFill(b.BackColor) &&
                    b.BackColor != Surface &&
                    b.BackColor != Back &&
                    b.BackColor != Panel)
                    break;
                FlattenButton(b);
                break;
            case Label l:
                l.BackColor = Color.Transparent;
                if (l.ForeColor.ToArgb() == Color.DimGray.ToArgb() ||
                    l.ForeColor.ToArgb() == Color.Gray.ToArgb() ||
                    l.ForeColor.ToArgb() == Color.FromArgb(0x73, 0x73, 0x73).ToArgb() ||
                    l.ForeColor.ToArgb() == Color.FromArgb(0x6A, 0x84, 0x99).ToArgb() ||
                    l.ForeColor.ToArgb() == Color.FromArgb(0x5A, 0x6E, 0x78).ToArgb())
                    l.ForeColor = Muted;
                else if (l.ForeColor.ToArgb() == SystemColors.ControlText.ToArgb() ||
                         l.ForeColor.ToArgb() == Color.Black.ToArgb() ||
                         l.ForeColor.ToArgb() == Color.FromArgb(0x11, 0x11, 0x11).ToArgb() ||
                         l.ForeColor.ToArgb() == Color.FromArgb(0x1E, 0x3D, 0x56).ToArgb() ||
                         l.ForeColor.ToArgb() == Color.FromArgb(0x1E, 0x3A, 0x4C).ToArgb())
                    l.ForeColor = Ink;
                break;
            case CheckBox cb:
                cb.ForeColor = Ink;
                cb.BackColor = Color.Transparent;
                break;
            case ListView lv:
                StyleList(lv);
                NativeUi.UseClassicWhenReady(lv);
                break;
            case ThemedMeter:
                break;
            case RopeSlider:
                break;
            case ProgressBar bar:
                bar.Style = ProgressBarStyle.Continuous;
                bar.BackColor = Panel;
                bar.ForeColor = Accent;
                NativeUi.UseClassicWhenReady(bar);
                break;
            case TrackBar track:
                track.BackColor = Back;
                NativeUi.UseClassicWhenReady(track);
                break;
            case PictureBox pic:
                pic.BackColor = Color.Transparent;
                break;
            case ListBox lb:
                lb.BackColor = Surface;
                lb.ForeColor = Ink;
                lb.BorderStyle = BorderStyle.None;
                break;
            case TextBox tb:
                tb.BackColor = Surface;
                tb.ForeColor = Ink;
                tb.BorderStyle = BorderStyle.None;
                break;
            case ComboBox combo:
                combo.BackColor = Surface;
                combo.ForeColor = Ink;
                combo.FlatStyle = FlatStyle.Flat;
                break;
            case NumericUpDown num:
                num.BackColor = Surface;
                num.ForeColor = Ink;
                num.BorderStyle = BorderStyle.None;
                break;
            case TabControl tab:
                tab.BackColor = Back;
                tab.ForeColor = Ink;
                break;
            case TabPage page:
                page.BackColor = Back;
                page.ForeColor = Ink;
                break;
            case System.Windows.Forms.Panel or System.Windows.Forms.Form:
                if (IsLegacyFill(c.BackColor))
                    c.BackColor = Back;
                if (c is ScrollableControl sc && sc.AutoScroll)
                    NativeUi.UseClassicWhenReady(sc);
                if (c is System.Windows.Forms.Form f)
                    f.ForeColor = Ink;
                break;
        }
    }

    private static bool IsLegacyFill(Color c)
    {
        var a = c.ToArgb();
        return a == Color.FromArgb(245, 246, 248).ToArgb() ||
               a == Color.FromArgb(0xF2, 0xF2, 0xF2).ToArgb() ||
               a == Color.FromArgb(0xE4, 0xE4, 0xE4).ToArgb() ||
               a == Color.FromArgb(0xFA, 0xFA, 0xFA).ToArgb() ||
               a == Color.FromArgb(0xD8, 0xEE, 0xF8).ToArgb() ||
               a == Color.FromArgb(0xC5, 0xE4, 0xF4).ToArgb() ||
               a == Color.FromArgb(0xF4, 0xE4, 0xC1).ToArgb() ||
               a == Color.FromArgb(0xF6, 0xF1, 0xE8).ToArgb() ||
               a == Color.FromArgb(0x10, 0x13, 0x18).ToArgb() ||
               a == Color.FromArgb(0xF3, 0xE6, 0xC8).ToArgb() ||
               a == Color.FromArgb(0xF3, 0xE6, 0xC4).ToArgb() ||
               a == Color.FromArgb(0xE2, 0xC9, 0x96).ToArgb() ||
               a == Color.White.ToArgb() ||
               a == SystemColors.Control.ToArgb();
    }
}
