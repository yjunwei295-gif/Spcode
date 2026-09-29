namespace MemWatch;

/// <summary>简易中英切换：L.T("中文", "English")。</summary>
internal static class L
{
    public const string Zh = "zh";
    public const string En = "en";

    public static string Code { get; private set; } = Zh;

    public static bool IsChinese => Code == Zh;

    public static event Action? Changed;

    public static void Init(string? code) => Code = Normalize(code);

    public static void Set(string code)
    {
        var n = Normalize(code);
        if (Code == n)
            return;
        Code = n;
        Changed?.Invoke();
    }

    public static void Toggle() => Set(IsChinese ? En : Zh);

    public static string T(string zh, string en) => IsChinese ? zh : en;

    public static string Normalize(string? code) =>
        string.Equals(code, En, StringComparison.OrdinalIgnoreCase) ? En : Zh;
}
