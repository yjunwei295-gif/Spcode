using System.Drawing.Imaging;

namespace MemWatch;

/// <summary>各弹窗独立背景皮肤（图片路径与亮度互不影响）。</summary>
internal static class WindowSkin
{
    public const string KeyMain = "main";
    public const string KeyLargeFiles = "largefiles";
    public const string KeySystemInfo = "sysinfo";
    public const string KeyDiskHealth = "diskhealth";

    private static readonly Dictionary<Form, Image?> Loaded = new();

    public static string? GetStoredPath(LevelConfig cfg, string key) => key switch
    {
        KeyMain => cfg.SkinMain,
        KeyLargeFiles => cfg.SkinLargeFiles,
        KeySystemInfo => cfg.SkinSystemInfo,
        KeyDiskHealth => cfg.SkinDiskHealth,
        _ => null
    };

    public static void SetStoredPath(LevelConfig cfg, string key, string? relativeOrNull)
    {
        switch (key)
        {
            case KeyMain: cfg.SkinMain = relativeOrNull; break;
            case KeyLargeFiles: cfg.SkinLargeFiles = relativeOrNull; break;
            case KeySystemInfo: cfg.SkinSystemInfo = relativeOrNull; break;
            case KeyDiskHealth: cfg.SkinDiskHealth = relativeOrNull; break;
        }

        cfg.Save();
    }

    public static int GetBrightness(LevelConfig cfg, string key) => LevelConfig.ClampBrightness(key switch
    {
        KeyMain => cfg.SkinMainBrightness,
        KeyLargeFiles => cfg.SkinLargeFilesBrightness,
        KeySystemInfo => cfg.SkinSystemInfoBrightness,
        KeyDiskHealth => cfg.SkinDiskHealthBrightness,
        _ => 55
    });

    public static void SetBrightness(LevelConfig cfg, string key, int value)
    {
        value = LevelConfig.ClampBrightness(value);
        switch (key)
        {
            case KeyMain: cfg.SkinMainBrightness = value; break;
            case KeyLargeFiles: cfg.SkinLargeFilesBrightness = value; break;
            case KeySystemInfo: cfg.SkinSystemInfoBrightness = value; break;
            case KeyDiskHealth: cfg.SkinDiskHealthBrightness = value; break;
        }

        cfg.Save();
    }

    public static int GetVeil(LevelConfig cfg, string key) => LevelConfig.ClampVeil(key switch
    {
        KeyMain => cfg.SkinMainVeil,
        KeyLargeFiles => cfg.SkinLargeFilesVeil,
        KeySystemInfo => cfg.SkinSystemInfoVeil,
        KeyDiskHealth => cfg.SkinDiskHealthVeil,
        _ => 168
    });

    public static void SetVeil(LevelConfig cfg, string key, int value)
    {
        value = LevelConfig.ClampVeil(value);
        switch (key)
        {
            case KeyMain: cfg.SkinMainVeil = value; break;
            case KeyLargeFiles: cfg.SkinLargeFilesVeil = value; break;
            case KeySystemInfo: cfg.SkinSystemInfoVeil = value; break;
            case KeyDiskHealth: cfg.SkinDiskHealthVeil = value; break;
        }

        cfg.Save();
    }

    public static string? ResolveFullPath(string? stored)
    {
        if (string.IsNullOrWhiteSpace(stored))
            return null;

        if (Path.IsPathRooted(stored))
            return File.Exists(stored) ? stored : null;

        var full = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, stored));
        return File.Exists(full) ? full : null;
    }

    /// <summary>应用已保存的皮肤；无皮肤时恢复纯色背景。</summary>
    public static void Apply(Form form, LevelConfig cfg, string key, Color defaultBackColor)
    {
        var full = ResolveFullPath(GetStoredPath(cfg, key));
        var brightness = GetBrightness(cfg, key);
        var veil = GetVeil(cfg, key);
        ApplyImage(form, full, defaultBackColor, brightness, veil);
    }

    /// <summary>弹出皮肤设置：选图、亮度、白罩、清除。</summary>
    public static void ShowPicker(Form owner, LevelConfig cfg, string key, Color defaultBackColor, Control? anchor = null)
    {
        var brightness = GetBrightness(cfg, key);
        var veil = GetVeil(cfg, key);

        using var dlg = new Form
        {
            Text = L.T("窗口皮肤", "Window skin"),
            FormBorderStyle = FormBorderStyle.FixedDialog,
            StartPosition = FormStartPosition.CenterParent,
            ClientSize = new Size(320, 268),
            MaximizeBox = false,
            MinimizeBox = false,
            ShowInTaskbar = false,
            TopMost = owner.TopMost,
            Font = owner.Font,
            BackColor = UiTheme.Back
        };

        var tip = new Label
        {
            AutoSize = false,
            Location = new Point(16, 10),
            Size = new Size(288, 28),
            Text = L.T(
                "为当前窗口设置独立背景。亮度与白罩互不影响其他窗口。",
                "Set a background for this window. Brightness and veil are per-window."),
            ForeColor = UiTheme.Muted
        };

        var lblBright = new Label
        {
            AutoSize = false,
            Location = new Point(16, 42),
            Size = new Size(288, 20),
            Text = FormatBrightLabel(brightness),
            ForeColor = Color.FromArgb(50, 50, 50)
        };

        var trackBright = new TrackBar
        {
            Location = new Point(12, 62),
            Size = new Size(296, 36),
            Minimum = 15,
            Maximum = 100,
            TickFrequency = 5,
            SmallChange = 1,
            LargeChange = 5,
            Value = brightness,
            TickStyle = TickStyle.None
        };

        var lblVeil = new Label
        {
            AutoSize = false,
            Location = new Point(16, 104),
            Size = new Size(288, 20),
            Text = FormatVeilLabel(veil),
            ForeColor = Color.FromArgb(50, 50, 50)
        };

        var trackVeil = new TrackBar
        {
            Location = new Point(12, 124),
            Size = new Size(296, 36),
            Minimum = 0,
            Maximum = 220,
            TickFrequency = 10,
            SmallChange = 1,
            LargeChange = 10,
            Value = veil,
            TickStyle = TickStyle.None
        };

        var btnPick = new Button
        {
            Text = L.T("选择图片…", "Choose image…"),
            Location = new Point(16, 200),
            Size = new Size(100, 30)
        };
        var btnClear = new Button
        {
            Text = L.T("清除皮肤", "Clear skin"),
            Location = new Point(124, 200),
            Size = new Size(80, 30)
        };
        var btnClose = new Button
        {
            Text = L.T("完成", "Done"),
            Location = new Point(244, 200),
            Size = new Size(60, 30),
            DialogResult = DialogResult.OK
        };

        void Preview()
        {
            lblBright.Text = FormatBrightLabel(trackBright.Value);
            lblVeil.Text = FormatVeilLabel(trackVeil.Value);
            SetBrightness(cfg, key, trackBright.Value);
            SetVeil(cfg, key, trackVeil.Value);
            if (!string.IsNullOrWhiteSpace(GetStoredPath(cfg, key)))
                Apply(owner, cfg, key, defaultBackColor);
        }

        trackBright.ValueChanged += (_, _) => Preview();
        trackVeil.ValueChanged += (_, _) => Preview();

        btnPick.Click += (_, _) =>
        {
            if (!TryChooseAndSave(dlg, cfg, key))
                return;
            SetBrightness(cfg, key, trackBright.Value);
            SetVeil(cfg, key, trackVeil.Value);
            Apply(owner, cfg, key, defaultBackColor);
        };
        btnClear.Click += (_, _) =>
        {
            ClearSkinFiles(key);
            SetStoredPath(cfg, key, null);
            Apply(owner, cfg, key, defaultBackColor);
        };

        dlg.Controls.AddRange(new Control[]
        {
            tip, lblBright, trackBright, lblVeil, trackVeil, btnPick, btnClear, btnClose
        });
        dlg.AcceptButton = btnClose;
        dlg.CancelButton = btnClose;
        UiTheme.StyleTree(dlg);
        EchoChrome.Attach(dlg, canResize: false, showMin: false);

        try
        {
            dlg.ShowDialog(owner);
        }
        catch
        {
            dlg.ShowDialog();
        }
        finally
        {
            SetBrightness(cfg, key, trackBright.Value);
            SetVeil(cfg, key, trackVeil.Value);
            if (!string.IsNullOrWhiteSpace(GetStoredPath(cfg, key)))
                Apply(owner, cfg, key, defaultBackColor);
        }
    }

    private static string FormatBrightLabel(int brightness) =>
        L.T($"皮肤亮度：{brightness}%（越小越暗）", $"Skin brightness: {brightness}% (lower = darker)");

    private static string FormatVeilLabel(int veil) =>
        L.T($"白罩透明度：{veil}（0=全透出皮肤，越大越白）",
            $"Veil opacity: {veil} (0 = show skin, higher = whiter)");

    public static Button CreateButton(Form owner, LevelConfig cfg, string key, Color defaultBackColor)
    {
        var btn = new Button
        {
            Text = L.T("皮肤", "Skin"),
            Size = new Size(56, 26),
            Cursor = Cursors.Hand
        };
        UiTheme.FlattenButton(btn);
        btn.Click += (_, _) => ShowPicker(owner, cfg, key, defaultBackColor, btn);
        return btn;
    }

    private static bool TryChooseAndSave(Form owner, LevelConfig cfg, string key)
    {
        using var dlg = new OpenFileDialog
        {
            Title = L.T("选择该窗口的背景图片", "Choose a background image"),
            Filter = L.T(
                "图片文件|*.png;*.jpg;*.jpeg;*.bmp;*.gif;*.webp|所有文件|*.*",
                "Image files|*.png;*.jpg;*.jpeg;*.bmp;*.gif;*.webp|All files|*.*"),
            CheckFileExists = true,
            Multiselect = false
        };

        if (dlg.ShowDialog(owner) != DialogResult.OK)
            return false;

        try
        {
            var relative = CopyToSkinsFolder(key, dlg.FileName);
            SetStoredPath(cfg, key, relative);
            return true;
        }
        catch (Exception ex)
        {
            MessageBox.Show(owner,
                L.T($"无法设置皮肤：{ex.Message}", $"Could not set skin: {ex.Message}"),
                L.T("皮肤", "Skin"),
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return false;
        }
    }

    private static string CopyToSkinsFolder(string key, string sourcePath)
    {
        var dir = Path.Combine(AppContext.BaseDirectory, "Skins");
        Directory.CreateDirectory(dir);

        foreach (var old in Directory.EnumerateFiles(dir, key + ".*"))
        {
            try
            {
                File.Delete(old);
            }
            catch
            {
                // ignore
            }
        }

        var ext = Path.GetExtension(sourcePath);
        if (string.IsNullOrWhiteSpace(ext))
            ext = ".png";

        var destName = key + ext.ToLowerInvariant();
        var dest = Path.Combine(dir, destName);
        File.Copy(sourcePath, dest, overwrite: true);
        return Path.Combine("Skins", destName);
    }

    private static void ClearSkinFiles(string key)
    {
        try
        {
            var dir = Path.Combine(AppContext.BaseDirectory, "Skins");
            if (!Directory.Exists(dir))
                return;

            foreach (var old in Directory.EnumerateFiles(dir, key + ".*"))
            {
                try
                {
                    File.Delete(old);
                }
                catch
                {
                    // ignore
                }
            }
        }
        catch
        {
            // ignore
        }
    }

    private static void ApplyImage(Form form, string? fullPath, Color defaultBackColor, int brightnessPercent, int veilAlpha)
    {
        Image? next = null;
        if (!string.IsNullOrWhiteSpace(fullPath) && File.Exists(fullPath))
        {
            try
            {
                using var ms = new MemoryStream(File.ReadAllBytes(fullPath));
                using var temp = Image.FromStream(ms);
                using var raw = new Bitmap(temp);
                using var dimmed = AdjustBrightness(raw, brightnessPercent);
                next = ApplyColorVeil(dimmed, defaultBackColor, veilAlpha);
            }
            catch
            {
                next?.Dispose();
                next = null;
            }
        }

        if (Loaded.TryGetValue(form, out var prev))
        {
            form.BackgroundImage = null;
            prev?.Dispose();
            Loaded.Remove(form);
        }
        else
        {
            form.BackgroundImage = null;
        }

        if (next is null)
        {
            form.BackgroundImage = null;
            form.BackColor = defaultBackColor;
            SetOverlayTransparency(form, enabled: false, defaultBackColor);
            return;
        }

        form.BackColor = defaultBackColor;
        form.BackgroundImage = next;
        form.BackgroundImageLayout = ImageLayout.Stretch;
        Loaded[form] = next;
        SetOverlayTransparency(form, enabled: true, defaultBackColor);

        form.FormClosed -= Form_FormClosedRelease;
        form.FormClosed += Form_FormClosedRelease;
    }

    /// <summary>brightnessPercent：15–100，100 为原图亮度。</summary>
    private static Bitmap AdjustBrightness(Image source, int brightnessPercent)
    {
        var pct = LevelConfig.ClampBrightness(brightnessPercent);
        var factor = pct / 100f;
        var bmp = new Bitmap(source.Width, source.Height);

        if (Math.Abs(factor - 1f) < 0.001f)
        {
            using var gCopy = Graphics.FromImage(bmp);
            gCopy.DrawImage(source, 0, 0, source.Width, source.Height);
            return bmp;
        }

        // ColorMatrix 等比压暗 RGB
        var matrix = new ColorMatrix(
        [
            [factor, 0, 0, 0, 0],
            [0, factor, 0, 0, 0],
            [0, 0, factor, 0, 0],
            [0, 0, 0, 1, 0],
            [0, 0, 0, 0, 1]
        ]);

        using var g = Graphics.FromImage(bmp);
        using var attrs = new ImageAttributes();
        attrs.SetColorMatrix(matrix);
        g.DrawImage(
            source,
            new Rectangle(0, 0, bmp.Width, bmp.Height),
            0, 0, source.Width, source.Height,
            GraphicsUnit.Pixel,
            attrs);
        return bmp;
    }

    /// <summary>在皮肤上叠半透明浅色罩，避免背景过抢、文字难读。</summary>
    private static Bitmap ApplyColorVeil(Image source, Color veilColor, int alpha)
    {
        var bmp = new Bitmap(source.Width, source.Height);
        using var g = Graphics.FromImage(bmp);
        g.DrawImage(source, 0, 0, source.Width, source.Height);
        using var brush = new SolidBrush(Color.FromArgb(
            Math.Clamp(alpha, 0, 255),
            veilColor.R,
            veilColor.G,
            veilColor.B));
        g.FillRectangle(brush, 0, 0, bmp.Width, bmp.Height);
        return bmp;
    }

    private static void Form_FormClosedRelease(object? sender, FormClosedEventArgs e)
    {
        if (sender is not Form form)
            return;

        form.FormClosed -= Form_FormClosedRelease;
        if (!Loaded.TryGetValue(form, out var img))
            return;

        form.BackgroundImage = null;
        img?.Dispose();
        Loaded.Remove(form);
    }

    private static void SetOverlayTransparency(Form form, bool enabled, Color defaultBackColor)
    {
        foreach (Control c in form.Controls)
            ApplyControlSkinOverlay(c, enabled, defaultBackColor, isRootChild: true);
    }

    private static void ApplyControlSkinOverlay(Control c, bool enabled, Color defaultBackColor, bool isRootChild)
    {
        // 列表 / 输入框保持不透明，保证文字可读
        if (c is ListView or ListBox or TextBox or ComboBox or NumericUpDown or ProgressBar or TrackBar or DataGridView)
            return;

        if (c is Panel or TableLayoutPanel or FlowLayoutPanel or SplitContainer or GroupBox)
        {
            // 背景图已带浅色罩，面板改为透明露出罩层（避免再叠一层发灰）
            c.BackColor = enabled ? Color.Transparent : defaultBackColor;
        }
        else if (c is Label or CheckBox)
        {
            // 主界面 / 大文件扫描：标签与勾选框透明，才能露出统一的浅色皮肤罩
            c.BackColor = Color.Transparent;
        }

        foreach (Control child in c.Controls)
            ApplyControlSkinOverlay(child, enabled, defaultBackColor, isRootChild: false);
    }
}
