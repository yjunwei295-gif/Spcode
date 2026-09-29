using System.Globalization;
using System.Runtime.InteropServices;

namespace MemWatch;

internal sealed class RecycleBinItem
{
    public string Name { get; init; } = "";
    public string OriginalPath { get; init; } = "-";
    public string DeletedOn { get; init; } = "-";
    public string SizeText { get; init; } = "-";
    public long SizeBytes { get; init; }
    public string TypeName { get; init; } = "-";
    public string Drive { get; init; } = "-";
    /// <summary>Shell FolderItem，仅在枚举线程/同进程内用于还原。</summary>
    public object? ShellItem { get; init; }
}

/// <summary>通过 Shell.Application 读取/还原回收站项目（弹窗数据恢复用）。</summary>
internal static class RecycleBinReader
{
    private const int SsfBitBucket = 10;

    public static List<RecycleBinItem> Enumerate()
    {
        var list = new List<RecycleBinItem>();
        object? shellObj = null;
        object? binObj = null;
        try
        {
            var shellType = Type.GetTypeFromProgID("Shell.Application");
            if (shellType is null)
                return list;

            shellObj = Activator.CreateInstance(shellType)!;
            dynamic shell = shellObj;
            binObj = shell.NameSpace(SsfBitBucket);
            if (binObj is null)
                return list;

            dynamic bin = binObj;
            foreach (var raw in bin.Items())
            {
                dynamic item = raw;
                string name;
                try
                {
                    name = Convert.ToString(item.Name) ?? "";
                }
                catch
                {
                    TryReleaseCom(raw);
                    continue;
                }

                if (string.IsNullOrWhiteSpace(name))
                {
                    TryReleaseCom(raw);
                    continue;
                }

                var original = SafeDetail(bin, item, 1);
                var deleted = SafeDetail(bin, item, 2);
                var sizeText = SafeDetail(bin, item, 3);
                var typeName = SafeDetail(bin, item, 4);
                if (string.IsNullOrWhiteSpace(original) || original == "-")
                    original = SafeDetail(bin, item, 0);

                var drive = ExtractDrive(original);
                list.Add(new RecycleBinItem
                {
                    Name = name.Trim(),
                    OriginalPath = string.IsNullOrWhiteSpace(original) ? "-" : original.Trim(),
                    DeletedOn = string.IsNullOrWhiteSpace(deleted) ? "-" : deleted.Trim(),
                    SizeText = string.IsNullOrWhiteSpace(sizeText) ? "-" : sizeText.Trim(),
                    SizeBytes = ParseSizeBytes(sizeText),
                    TypeName = string.IsNullOrWhiteSpace(typeName) ? "-" : typeName.Trim(),
                    Drive = drive,
                    ShellItem = item
                });
            }
        }
        catch
        {
            // 返回已收集部分
        }
        finally
        {
            TryReleaseCom(binObj);
            TryReleaseCom(shellObj);
        }

        return list
            .OrderByDescending(x => x.SizeBytes)
            .ThenBy(x => x.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    /// <summary>释放枚举时保留的 Shell FolderItem，避免 RCW 堆积。</summary>
    public static void ReleaseItems(IEnumerable<RecycleBinItem>? items)
    {
        if (items is null) return;
        foreach (var it in items)
        {
            TryReleaseCom(it.ShellItem);
        }
    }

    private static void TryReleaseCom(object? com)
    {
        if (com is null || !Marshal.IsComObject(com)) return;
        try { Marshal.FinalReleaseComObject(com); } catch { /* ignore */ }
    }

    public static bool TryRestore(RecycleBinItem item, out string error)
    {
        error = "";
        if (item.ShellItem is null)
        {
            error = L.T("无法定位回收站项目，请刷新后重试。", "Cannot locate recycle item. Refresh and retry.");
            return false;
        }

        try
        {
            dynamic shellItem = item.ShellItem;
            // 中英文系统动词都试一下
            foreach (var verb in new[] { "restore", "还原", "RESTORE", "Restore" })
            {
                try
                {
                    shellItem.InvokeVerb(verb);
                    return true;
                }
                catch
                {
                    // try next
                }
            }

            // 部分系统用 Verbs 集合
            try
            {
                foreach (var v in shellItem.Verbs())
                {
                    dynamic verb = v;
                    string? name = Convert.ToString(verb.Name);
                    if (string.IsNullOrWhiteSpace(name))
                        continue;
                    var n = name.Replace("&", "", StringComparison.Ordinal).Trim();
                    if (n.Contains("还原", StringComparison.OrdinalIgnoreCase) ||
                        n.Contains("restore", StringComparison.OrdinalIgnoreCase))
                    {
                        verb.DoIt();
                        return true;
                    }
                }
            }
            catch
            {
                // fall through
            }

            error = L.T("系统未提供可用的还原命令。", "No usable restore command from Shell.");
            return false;
        }
        catch (Exception ex)
        {
            error = ex.Message;
            return false;
        }
    }

    public static (int Ok, int Fail) RestoreMany(IEnumerable<RecycleBinItem> items, out List<string> errors)
    {
        errors = new List<string>();
        var ok = 0;
        var fail = 0;
        foreach (var item in items)
        {
            if (TryRestore(item, out var err))
            {
                ok++;
            }
            else
            {
                fail++;
                if (!string.IsNullOrWhiteSpace(err))
                    errors.Add($"{item.Name}: {err}");
            }
        }

        return (ok, fail);
    }

    private static string SafeDetail(dynamic folder, dynamic item, int index)
    {
        try
        {
            return Convert.ToString(folder.GetDetailsOf(item, index)) ?? "";
        }
        catch
        {
            return "";
        }
    }

    private static string ExtractDrive(string originalPath)
    {
        if (string.IsNullOrWhiteSpace(originalPath) || originalPath == "-")
            return "-";
        try
        {
            if (originalPath.Length >= 2 && originalPath[1] == ':')
                return char.ToUpperInvariant(originalPath[0]) + ":";
            var root = Path.GetPathRoot(originalPath);
            if (!string.IsNullOrWhiteSpace(root) && root.Length >= 2)
                return root.TrimEnd('\\', '/').ToUpperInvariant();
        }
        catch
        {
            // ignore
        }

        return "-";
    }

    private static long ParseSizeBytes(string? sizeText)
    {
        if (string.IsNullOrWhiteSpace(sizeText) || sizeText == "-")
            return 0;

        // 例：1.23 MB / 456 KB / 2,048 字节
        var s = sizeText.Trim().Replace(",", "", StringComparison.Ordinal);
        var parts = s.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (parts.Length == 0)
            return 0;

        if (!double.TryParse(parts[0], NumberStyles.Float, CultureInfo.CurrentCulture, out var n) &&
            !double.TryParse(parts[0], NumberStyles.Float, CultureInfo.InvariantCulture, out n))
            return 0;

        var unit = parts.Length > 1 ? parts[1].ToUpperInvariant() : "B";
        if (unit.StartsWith("字节", StringComparison.Ordinal) || unit is "B" or "BYTE" or "BYTES")
            return (long)n;
        if (unit.StartsWith("KB", StringComparison.Ordinal) || unit.StartsWith("千", StringComparison.Ordinal))
            return (long)(n * 1024);
        if (unit.StartsWith("MB", StringComparison.Ordinal) || unit.StartsWith("兆", StringComparison.Ordinal))
            return (long)(n * 1024 * 1024);
        if (unit.StartsWith("GB", StringComparison.Ordinal) || unit.StartsWith("吉", StringComparison.Ordinal))
            return (long)(n * 1024 * 1024 * 1024);
        return (long)n;
    }
}
