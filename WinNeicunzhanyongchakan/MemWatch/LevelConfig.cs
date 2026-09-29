using System.Text.Json;

namespace MemWatch;

/// <summary>应用配置：等级门槛、窗口位置、亚哈击杀数等。</summary>
public sealed class LevelConfig
{
    public const int WhaleMinMb = 2000;
    public const int MouseDefaultMb = 200;

    public int MouseMb { get; set; } = MouseDefaultMb;
    public int CatMb { get; set; } = 300;
    public int DogMb { get; set; } = 500;
    public int ElephantMb { get; set; } = 1000;
    public int WhaleMb { get; set; } = WhaleMinMb;

    public int? FullX { get; set; }
    public int? FullY { get; set; }
    /// <summary>主窗口客户区高度（可拖动调整）。</summary>
    public int? FullHeight { get; set; }
    public int? MiniX { get; set; }
    public int? MiniY { get; set; }
    public bool StartInCompact { get; set; }

    /// <summary>点关闭时记住的第一次选择：shrink=缩小，exit=退出；空则弹窗询问。</summary>
    public string? CloseOnX { get; set; }
    public int AhabKillCount { get; set; }
    public bool TopMost { get; set; } = true;
    public bool AhabEnabled { get; set; }
    public bool HuntEnabled { get; set; }
    public int HuntThresholdPct { get; set; } = 85;
    /// <summary>猎杀弹窗打开时自动勾选低活动进程（低 CPU 且内存 ≤ 猫门槛）。</summary>
    public bool HuntAutoSelectLowActivity { get; set; } = true;
    /// <summary>低活动判定：CPU 占用上限（%）。</summary>
    public int HuntLowActivityCpuPct { get; set; } = 5;
    public bool AutoStart { get; set; }

    /// <summary>大文件扫描：上次选择的盘符根路径，如 C:\</summary>
    public string? LargeFileDrive { get; set; }

    /// <summary>大文件扫描：大小下限 MB</summary>
    public int LargeFileMinMb { get; set; } = 100;

    /// <summary>各窗口独立皮肤（相对路径，如 Skins\main.jpg）。</summary>
    public string? SkinMain { get; set; }
    public string? SkinLargeFiles { get; set; }
    public string? SkinSystemInfo { get; set; }
    public string? SkinDiskHealth { get; set; }

    /// <summary>各窗口皮肤亮度 15–100（100=原图，越小越暗）。</summary>
    public int SkinMainBrightness { get; set; } = 55;
    public int SkinLargeFilesBrightness { get; set; } = 55;
    public int SkinSystemInfoBrightness { get; set; } = 55;
    public int SkinDiskHealthBrightness { get; set; } = 55;

    /// <summary>各窗口白罩浓度 0–220（0=无罩全透出皮肤，越大越白）。</summary>
    public int SkinMainVeil { get; set; } = 168;
    public int SkinLargeFilesVeil { get; set; } = 168;
    public int SkinSystemInfoVeil { get; set; } = 168;
    public int SkinDiskHealthVeil { get; set; } = 168;

    /// <summary>主界面 CPU 温度刷新间隔（秒），最小 2。</summary>
    public int CpuTempRefreshSec { get; set; } = 5;

    /// <summary>界面语言：zh / en。</summary>
    public string UiLanguage { get; set; } = L.Zh;

    /// <summary>截图触发键（Windows Forms Keys 数值），默认 F2。</summary>
    public int ScreenshotKey { get; set; } = (int)Keys.F2;

    /// <summary>连续按下同一键多少次触发截图，默认 3。</summary>
    public int ScreenshotPressCount { get; set; } = 3;

    /// <summary>两次按键间隔超过该毫秒数则重新计数。</summary>
    public int ScreenshotPressGapMs { get; set; } = 700;

    /// <summary>截图涂鸦标注框颜色（ARGB）。</summary>
    public int ScreenshotMarkColorArgb { get; set; } = unchecked((int)0xE6FF5000);

    /// <summary>当前贴图分组 0~11（对应 Shift+F1~F12）。</summary>
    public int ActivePinGroup { get; set; }

    /// <summary>12 个贴图分组名称。</summary>
    public string[]? PinGroupNames { get; set; }

    /// <summary>剪切板历史：非收藏最大条数（收藏不计入清理）。</summary>
    public int ClipboardHistoryMax { get; set; } = 50;

    private static string ConfigPath =>
        Path.Combine(AppContext.BaseDirectory, "MemWatch.levels.json");

    public static LevelConfig Load()
    {
        try
        {
            if (File.Exists(ConfigPath))
            {
                var json = File.ReadAllText(ConfigPath);
                var cfg = JsonSerializer.Deserialize<LevelConfig>(json);
                if (cfg != null)
                {
                    cfg.Normalize();
                    if (cfg.AhabKillCount < 0)
                        cfg.AhabKillCount = 0;
                    if (cfg.HuntThresholdPct < 80)
                        cfg.HuntThresholdPct = 80;
                    if (cfg.HuntThresholdPct > 100)
                        cfg.HuntThresholdPct = 100;
                    return cfg;
                }
            }
        }
        catch
        {
            // 使用默认值
        }

        return new LevelConfig();
    }

    public void Save()
    {
        Normalize();
        if (AhabKillCount < 0)
            AhabKillCount = 0;

        try
        {
            var json = JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(ConfigPath, json);
        }
        catch
        {
            // 忽略保存失败
        }
    }

    public void Normalize()
    {
        WhaleMb = Math.Max(WhaleMinMb, WhaleMb);
        ElephantMb = Math.Min(ElephantMb, WhaleMb);
        DogMb = Math.Min(DogMb, ElephantMb);
        CatMb = Math.Min(CatMb, DogMb);
        MouseMb = Math.Min(Math.Max(50, MouseMb), CatMb);

        if (MouseMb < 50) MouseMb = 50;

        if (LargeFileMinMb < 1) LargeFileMinMb = 1;
        if (LargeFileMinMb > 1048576) LargeFileMinMb = 1048576;

        SkinMainBrightness = ClampBrightness(SkinMainBrightness);
        SkinLargeFilesBrightness = ClampBrightness(SkinLargeFilesBrightness);
        SkinSystemInfoBrightness = ClampBrightness(SkinSystemInfoBrightness);
        SkinDiskHealthBrightness = ClampBrightness(SkinDiskHealthBrightness);

        SkinMainVeil = ClampVeil(SkinMainVeil);
        SkinLargeFilesVeil = ClampVeil(SkinLargeFilesVeil);
        SkinSystemInfoVeil = ClampVeil(SkinSystemInfoVeil);
        SkinDiskHealthVeil = ClampVeil(SkinDiskHealthVeil);

        CpuTempRefreshSec = ClampCpuTempRefreshSec(CpuTempRefreshSec);
        UiLanguage = L.Normalize(UiLanguage);
        CloseOnX = NormalizeCloseOnX(CloseOnX);

        if (ScreenshotKey == 0 || ScreenshotKey == (int)Keys.None)
            ScreenshotKey = (int)Keys.F2;
        ScreenshotPressCount = ClampScreenshotPressCount(ScreenshotPressCount);
        ScreenshotPressGapMs = ClampScreenshotPressGapMs(ScreenshotPressGapMs);
        ActivePinGroup = Math.Clamp(ActivePinGroup, 0, 11);
        ClipboardHistoryMax = ClampClipboardHistoryMax(ClipboardHistoryMax);
        HuntLowActivityCpuPct = ClampHuntLowActivityCpuPct(HuntLowActivityCpuPct);
    }

    public static int ClampHuntLowActivityCpuPct(int value) => Math.Clamp(value, 1, 50);

    public static int ClampBrightness(int value) => Math.Clamp(value, 15, 100);

    public static int ClampVeil(int value) => Math.Clamp(value, 0, 220);

    public static int ClampCpuTempRefreshSec(int value) => Math.Clamp(value, 2, 600);

    public static int ClampScreenshotPressCount(int value) => Math.Clamp(value, 1, 10);

    public static int ClampScreenshotPressGapMs(int value) => Math.Clamp(value, 300, 3000);

    public static int ClampClipboardHistoryMax(int value) => Math.Clamp(value, 5, 500);

    public const string CloseShrink = "shrink";
    public const string CloseExit = "exit";

    public static string? NormalizeCloseOnX(string? value)
    {
        if (string.Equals(value, CloseShrink, StringComparison.OrdinalIgnoreCase))
            return CloseShrink;
        if (string.Equals(value, CloseExit, StringComparison.OrdinalIgnoreCase))
            return CloseExit;
        return null;
    }

    public bool TryApply(int mouse, int cat, int dog, int elephant, int whale, out string error)
    {
        if (mouse < 50)
        {
            error = L.T("老鼠门槛不能低于 50 MB。", "Mouse threshold cannot be below 50 MB.");
            return false;
        }

        if (whale < WhaleMinMb)
        {
            error = L.T($"鲸鱼门槛不能低于 {WhaleMinMb} MB。", $"Whale threshold cannot be below {WhaleMinMb} MB.");
            return false;
        }

        if (!(mouse <= cat && cat <= dog && dog <= elephant && elephant <= whale))
        {
            error = L.T(
                "门槛不能逾越：老鼠 ≤ 猫 ≤ 狗 ≤ 大象 ≤ 鲸鱼。",
                "Thresholds must satisfy: Mouse ≤ Cat ≤ Dog ≤ Elephant ≤ Whale.");
            return false;
        }

        MouseMb = mouse;
        CatMb = cat;
        DogMb = dog;
        ElephantMb = elephant;
        WhaleMb = whale;
        error = "";
        return true;
    }
}
