using System.Diagnostics;
using Microsoft.Win32;

namespace MemWatch;

/// <summary>已安装软件条目（注册表卸载信息）。</summary>
internal sealed class InstalledSoftware
{
    public string DisplayName { get; init; } = "";
    public string? Publisher { get; init; }
    public string? DisplayVersion { get; init; }
    public string? InstallLocation { get; init; }
    public string? UninstallString { get; init; }
    public string? QuietUninstallString { get; init; }
    public string RegistryKeyPath { get; init; } = "";
    /// <summary>注册表 EstimatedSize（KB），可能缺失或不准。</summary>
    public long? EstimatedSizeKb { get; init; }
    /// <summary>解析后的占用字节数（优先安装目录实测）。</summary>
    public long? SizeBytes { get; set; }
}

/// <summary>根据文件路径匹配已安装软件，并支持强力卸载。</summary>
internal static class SoftwareUninstaller
{
    public static List<InstalledSoftware> FindByPath(string filePath)
    {
        var hits = new List<InstalledSoftware>();
        if (string.IsNullOrWhiteSpace(filePath))
            return hits;

        string full;
        try { full = Path.GetFullPath(filePath); }
        catch { return hits; }

        var dir = Path.GetDirectoryName(full) ?? full;
        var all = EnumerateInstalled();
        foreach (var app in all)
        {
            if (string.IsNullOrWhiteSpace(app.InstallLocation))
                continue;
            string loc;
            try { loc = Path.GetFullPath(app.InstallLocation.Trim().Trim('"')); }
            catch { continue; }

            if (!loc.EndsWith(Path.DirectorySeparatorChar))
                loc += Path.DirectorySeparatorChar;
            var probe = dir;
            if (!probe.EndsWith(Path.DirectorySeparatorChar))
                probe += Path.DirectorySeparatorChar;

            if (probe.StartsWith(loc, StringComparison.OrdinalIgnoreCase) ||
                loc.StartsWith(probe, StringComparison.OrdinalIgnoreCase) ||
                full.StartsWith(loc, StringComparison.OrdinalIgnoreCase))
            {
                hits.Add(app);
            }
        }

        // 无 InstallLocation 时：用文件夹名对 DisplayName 模糊匹配
        if (hits.Count == 0)
        {
            var folder = Path.GetFileName(dir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
            if (!string.IsNullOrWhiteSpace(folder) && folder.Length >= 3)
            {
                foreach (var app in all)
                {
                    if (string.IsNullOrWhiteSpace(app.DisplayName)) continue;
                    if (app.DisplayName.Contains(folder, StringComparison.OrdinalIgnoreCase) ||
                        folder.Contains(SanitizeName(app.DisplayName), StringComparison.OrdinalIgnoreCase))
                        hits.Add(app);
                }
            }
        }

        return hits
            .GroupBy(a => a.RegistryKeyPath, StringComparer.OrdinalIgnoreCase)
            .Select(g => g.First())
            .OrderBy(a => a.DisplayName)
            .ToList();
    }

    public static List<InstalledSoftware> EnumerateInstalled()
    {
        var list = new List<InstalledSoftware>();
        string[] roots =
        [
            @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
            @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
        ];

        foreach (var root in roots)
        {
            CollectFromHive(Registry.LocalMachine, root, list);
            CollectFromHive(Registry.CurrentUser, root, list);
        }

        return list;
    }

    /// <summary>列出安装在指定盘符上的软件。</summary>
    public static List<InstalledSoftware> FindByDrive(string driveRoot)
    {
        var root = Path.GetPathRoot(driveRoot);
        if (string.IsNullOrWhiteSpace(root))
            return [];

        root = root.TrimEnd('\\') + "\\";
        return EnumerateInstalled()
            .Where(a => IsOnDrive(a, root))
            .GroupBy(a => a.RegistryKeyPath, StringComparer.OrdinalIgnoreCase)
            .Select(g => g.First())
            .OrderBy(a => a.DisplayName, StringComparer.CurrentCultureIgnoreCase)
            .ToList();
    }

    /// <summary>
    /// 为列表填充占用大小：优先递归统计安装目录；否则用注册表 EstimatedSize。
    /// </summary>
    public static void FillSizes(IEnumerable<InstalledSoftware> apps)
    {
        Parallel.ForEach(apps, app =>
        {
            try { app.SizeBytes = MeasureInstallSize(app); }
            catch { app.SizeBytes = null; }
        });
    }

    public static long? MeasureInstallSize(InstalledSoftware app)
    {
        var loc = app.InstallLocation?.Trim().Trim('"');
        if (!string.IsNullOrWhiteSpace(loc))
        {
            try
            {
                loc = Path.GetFullPath(loc);
                if (Directory.Exists(loc) && !IsTooBroadToMeasure(loc))
                    return GetDirectorySizeBytes(loc);
            }
            catch
            {
                // 改用注册表估计
            }
        }

        if (app.EstimatedSizeKb is > 0)
            return app.EstimatedSizeKb.Value * 1024L;
        return null;
    }

    public static string FormatSize(long? bytes)
    {
        if (bytes is null or < 0)
            return "-";
        var b = (double)bytes.Value;
        if (b >= 1024d * 1024d * 1024d)
            return $"{b / (1024d * 1024d * 1024d):0.##} GB";
        if (b >= 1024d * 1024d)
            return $"{b / (1024d * 1024d):0.#} MB";
        if (b >= 1024d)
            return $"{b / 1024d:0.#} KB";
        return $"{bytes.Value} B";
    }

    private static long GetDirectorySizeBytes(string root)
    {
        long total = 0;
        var stack = new Stack<string>();
        stack.Push(root);
        while (stack.Count > 0)
        {
            var dir = stack.Pop();
            try
            {
                foreach (var file in Directory.EnumerateFiles(dir))
                {
                    try { total += new FileInfo(file).Length; }
                    catch { /* 跳过不可读文件 */ }
                }

                foreach (var sub in Directory.EnumerateDirectories(dir))
                    stack.Push(sub);
            }
            catch
            {
                // 跳过无权限目录
            }
        }

        return total;
    }

    private static bool IsTooBroadToMeasure(string loc)
    {
        var n = loc.Replace('/', '\\').TrimEnd('\\');
        if (n.Length <= 3)
            return true;
        if (n.Equals(@"C:\Windows", StringComparison.OrdinalIgnoreCase) ||
            n.Contains(@"\Windows\", StringComparison.OrdinalIgnoreCase) ||
            n.Contains(@"\WinSxS", StringComparison.OrdinalIgnoreCase))
            return true;
        if (n.Equals(@"C:\Program Files", StringComparison.OrdinalIgnoreCase) ||
            n.Equals(@"C:\Program Files (x86)", StringComparison.OrdinalIgnoreCase) ||
            n.Equals(@"C:\ProgramData", StringComparison.OrdinalIgnoreCase) ||
            n.Equals(@"C:\Users", StringComparison.OrdinalIgnoreCase))
            return true;
        return false;
    }

    private static long? ReadEstimatedSizeKb(RegistryKey sub)
    {
        try
        {
            var v = sub.GetValue("EstimatedSize");
            switch (v)
            {
                case int i when i > 0:
                    return i;
                case long l when l > 0:
                    return l;
                case string s when long.TryParse(s, out var p) && p > 0:
                    return p;
            }
        }
        catch
        {
            // ignore
        }

        return null;
    }

    private static bool IsOnDrive(InstalledSoftware app, string driveRoot)
    {
        if (TryGetPathDrive(app.InstallLocation, out var locDrive) &&
            string.Equals(locDrive, driveRoot, StringComparison.OrdinalIgnoreCase))
            return true;

        // 无 InstallLocation 时，看卸载命令指向的路径
        var cmd = app.QuietUninstallString ?? app.UninstallString;
        if (string.IsNullOrWhiteSpace(cmd))
            return false;

        if (!TryParseCommand(cmd, out var file, out _))
            return false;

        return TryGetPathDrive(file, out var cmdDrive) &&
               string.Equals(cmdDrive, driveRoot, StringComparison.OrdinalIgnoreCase);
    }

    private static bool TryGetPathDrive(string? path, out string driveRoot)
    {
        driveRoot = "";
        if (string.IsNullOrWhiteSpace(path))
            return false;
        try
        {
            var full = Path.GetFullPath(path.Trim().Trim('"'));
            var r = Path.GetPathRoot(full);
            if (string.IsNullOrWhiteSpace(r))
                return false;
            driveRoot = r.TrimEnd('\\') + "\\";
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static void CollectFromHive(RegistryKey hive, string root, List<InstalledSoftware> list)
    {
        try
        {
            using var key = hive.OpenSubKey(root);
            if (key is null) return;
            foreach (var name in key.GetSubKeyNames())
            {
                try
                {
                    using var sub = key.OpenSubKey(name);
                    if (sub is null) continue;
                    var display = sub.GetValue("DisplayName") as string;
                    if (string.IsNullOrWhiteSpace(display)) continue;
                    if (sub.GetValue("SystemComponent") is int sc && sc == 1) continue;

                    list.Add(new InstalledSoftware
                    {
                        DisplayName = display.Trim(),
                        Publisher = sub.GetValue("Publisher") as string,
                        DisplayVersion = sub.GetValue("DisplayVersion") as string,
                        InstallLocation = sub.GetValue("InstallLocation") as string,
                        UninstallString = sub.GetValue("UninstallString") as string,
                        QuietUninstallString = sub.GetValue("QuietUninstallString") as string,
                        EstimatedSizeKb = ReadEstimatedSizeKb(sub),
                        RegistryKeyPath = $"{hive.Name}\\{root}\\{name}"
                    });
                }
                catch { /* ignore one entry */ }
            }
        }
        catch { /* ignore hive */ }
    }

    private static string SanitizeName(string name)
    {
        var chars = name.Where(char.IsLetterOrDigit).ToArray();
        return new string(chars);
    }

    /// <summary>
    /// 强力卸载：提权运行卸载命令；可选再强制删除安装目录。
    /// </summary>
    public static (bool ok, string message) ForceUninstall(InstalledSoftware app, bool alsoDeleteFolder)
    {
        var cmd = app.QuietUninstallString;
        if (string.IsNullOrWhiteSpace(cmd))
            cmd = app.UninstallString;
        if (string.IsNullOrWhiteSpace(cmd))
            return (false, L.T("未找到卸载命令", "No uninstall command found"));

        if (!TryParseCommand(cmd, out var file, out var args))
            return (false, L.T($"无法解析卸载命令：{cmd}", $"Cannot parse uninstall command: {cmd}"));

        // MSI 静默参数
        if (file.EndsWith("msiexec.exe", StringComparison.OrdinalIgnoreCase) &&
            !args.Contains("/qn", StringComparison.OrdinalIgnoreCase) &&
            !args.Contains("/quiet", StringComparison.OrdinalIgnoreCase))
        {
            args = args.Trim() + " /qn /norestart";
        }

        var elevated = ElevationUtil.TryRunElevated(file, args, out var err);
        if (!elevated)
            return (false, err ?? L.T("提权卸载失败", "Elevated uninstall failed"));

        var notes = new List<string>
        {
            L.T($"已提权执行卸载：{app.DisplayName}", $"Elevated uninstall started: {app.DisplayName}")
        };

        if (alsoDeleteFolder && !string.IsNullOrWhiteSpace(app.InstallLocation))
        {
            try
            {
                var loc = Path.GetFullPath(app.InstallLocation.Trim().Trim('"'));
                if (Directory.Exists(loc) && !IsDangerousFolder(loc))
                {
                    // 等卸载程序先跑一会儿
                    Thread.Sleep(1500);
                    var delCmd = $"attrib -r -s -h \"{loc}\\*\" /s /d & rmdir /s /q \"{loc}\"";
                    if (ElevationUtil.TryRunElevatedCmd(delCmd, out var delErr))
                        notes.Add(L.T($"已尝试强制清理目录：{loc}", $"Tried force-clean folder: {loc}"));
                    else if (!string.IsNullOrEmpty(delErr))
                        notes.Add(L.T($"清理目录失败：{delErr}", $"Folder clean failed: {delErr}"));
                }
            }
            catch (Exception ex)
            {
                notes.Add(L.T($"清理目录异常：{ex.Message}", $"Folder clean error: {ex.Message}"));
            }
        }

        return (true, string.Join("\n", notes));
    }

    private static bool IsDangerousFolder(string loc)
    {
        var n = loc.Replace('/', '\\').TrimEnd('\\') + "\\";
        return n.Contains(@"\Windows\", StringComparison.OrdinalIgnoreCase) ||
               n.EndsWith(@"\Windows\", StringComparison.OrdinalIgnoreCase) ||
               n.Equals(@"C:\", StringComparison.OrdinalIgnoreCase) ||
               n.Contains(@"\Program Files\WindowsApps\", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// 解析卸载命令为可执行文件 + 参数。
    /// 支持带引号路径，以及无引号但路径中含空格的情况（如 …\Tuanjie Cowork\uninstall.exe）。
    /// </summary>
    private static bool TryParseCommand(string command, out string file, out string args)
    {
        file = "";
        args = "";
        command = command.Trim();
        if (command.Length == 0) return false;

        if (command.StartsWith('"'))
        {
            var end = command.IndexOf('"', 1);
            if (end <= 1) return false;
            file = command[1..end];
            args = end + 1 < command.Length ? command[(end + 1)..].Trim() : "";
            return File.Exists(file) || LooksLikeExecutable(file);
        }

        // 整段就是文件（无参数）
        if (File.Exists(command))
        {
            file = command;
            args = "";
            return true;
        }

        // 无引号：按 .exe 等扩展名切分，或逐段用空格拼回，直到匹配到真实文件
        if ((command.Contains('\\') || command.Contains('/')) &&
            TrySplitUnquotedPathCommand(command, out file, out args))
            return true;

        // msiexec /X{guid} 等 PATH 中的短名
        var parts = command.Split(' ', 2, StringSplitOptions.RemoveEmptyEntries);
        file = parts[0];
        args = parts.Length > 1 ? parts[1] : "";
        if (!file.Contains('\\') && !file.Contains('/'))
            return true;

        return File.Exists(file);
    }

    private static bool TrySplitUnquotedPathCommand(string command, out string file, out string args)
    {
        file = "";
        args = "";

        string[] exts = [".exe", ".cmd", ".bat", ".com", ".msi"];
        foreach (var ext in exts)
        {
            var searchFrom = 0;
            while (searchFrom < command.Length)
            {
                var found = command.IndexOf(ext, searchFrom, StringComparison.OrdinalIgnoreCase);
                if (found < 0) break;
                var end = found + ext.Length;
                var candidate = command[..end];
                var okTail = end >= command.Length ||
                             command[end] is ' ' or '\t' or '/' or '-';
                if (okTail && File.Exists(candidate))
                {
                    file = candidate;
                    args = end < command.Length ? command[end..].Trim() : "";
                    return true;
                }

                searchFrom = found + 1;
            }
        }

        // 退化：空格分段逐步拼路径，找最长存在的文件
        var tokens = command.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        for (var i = 1; i <= tokens.Length; i++)
        {
            var candidate = string.Join(' ', tokens.Take(i));
            if (!File.Exists(candidate))
                continue;
            file = candidate;
            args = i < tokens.Length ? string.Join(' ', tokens.Skip(i)) : "";
            return true;
        }

        // 文件暂时不存在时：仍按第一个 .exe 边界切开，便于提权启动（卸载器偶发被锁）
        foreach (var ext in exts)
        {
            var found = command.IndexOf(ext, StringComparison.OrdinalIgnoreCase);
            if (found < 0) continue;
            var end = found + ext.Length;
            if (end < command.Length && command[end] is not (' ' or '\t' or '/' or '-'))
                continue;
            file = command[..end];
            args = end < command.Length ? command[end..].Trim() : "";
            return LooksLikeExecutable(file);
        }

        return false;
    }

    private static bool LooksLikeExecutable(string path) =>
        path.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ||
        path.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase) ||
        path.EndsWith(".bat", StringComparison.OrdinalIgnoreCase) ||
        path.EndsWith(".com", StringComparison.OrdinalIgnoreCase) ||
        path.EndsWith(".msi", StringComparison.OrdinalIgnoreCase);
}
