using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace MemWatch;

internal sealed class DiskRepairResult
{
    public bool Success { get; init; }
    public bool NeedsReboot { get; init; }
    public string Summary { get; init; } = "";
    public string Log { get; init; } = "";
}

/// <summary>
/// 通过 chkdsk 修复磁盘卷上的文件系统错误 / 坏扇区标记。
/// 注意：S.M.A.R.T. 硬件老化本身无法被软件「恢复」，但可尽量修复卷错误并隔离坏扇区。
/// </summary>
internal static class DiskRepairer
{
    public static IReadOnlyList<string> ParseDriveLetters(string? driveLetters)
    {
        if (string.IsNullOrWhiteSpace(driveLetters) || driveLetters.Trim() == "-")
            return Array.Empty<string>();

        var list = new List<string>();
        foreach (Match m in Regex.Matches(driveLetters, @"[A-Za-z]:"))
        {
            var letter = m.Value.ToUpperInvariant();
            if (!list.Contains(letter, StringComparer.OrdinalIgnoreCase))
                list.Add(letter);
        }

        return list;
    }

    public static async Task<DiskRepairResult> RepairAsync(
        DiskDriveInfo drive,
        IProgress<string>? progress = null,
        CancellationToken cancellationToken = default)
    {
        var letters = ParseDriveLetters(drive.DriveLetters);
        if (letters.Count == 0)
            throw new InvalidOperationException(L.T(
                "该磁盘没有可用盘符，无法执行文件系统修复。",
                "No drive letter available; cannot repair the file system."));

        // 有坏扇区相关告警时做深度扫描（/r）；否则做标准修复（/f）
        var deepScan = drive.Health == DiskHealthLevel.Bad ||
                       drive.Problems.Any(IsSectorRelatedProblem);

        var log = new StringBuilder();
        var needsReboot = false;
        var anyFail = false;
        var fixedCount = 0;

        for (var i = 0; i < letters.Count; i++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var letter = letters[i];
            progress?.Report(L.T(
                $"正在修复 {letter}\\（{i + 1}/{letters.Count}）…",
                $"Repairing {letter}\\ ({i + 1}/{letters.Count})…"));

            var args = deepScan
                ? $"{letter} /f /r"
                : $"{letter} /f";

            log.AppendLine($">>> chkdsk {args}");
            log.AppendLine();

            var (exitCode, output, reboot) = await RunChkdskAsync(args, progress, cancellationToken)
                .ConfigureAwait(false);

            log.AppendLine(output);
            log.AppendLine();
            log.AppendLine(L.T($"退出码：{exitCode}", $"Exit code: {exitCode}"));
            log.AppendLine(new string('-', 40));

            if (reboot)
                needsReboot = true;

            // chkdsk：0=无错误；1=已修复；2=需清理（少见）；3=未能修复或被取消
            if (exitCode is 0 or 1)
                fixedCount++;
            else if (!reboot)
                anyFail = true;
        }

        string summary;
        if (needsReboot && fixedCount == 0 && anyFail == false)
            summary = L.T(
                "系统盘正在使用中，已安排下次重启时自动修复。请尽快重启电脑以完成修复。",
                "System volume is in use; repair is scheduled for the next reboot. Please restart soon.");
        else if (needsReboot)
            summary = L.T(
                "已处理部分卷；另有卷需重启后继续修复。请尽快重启电脑。",
                "Some volumes were processed; others need a reboot to finish. Please restart soon.");
        else if (anyFail)
            summary = L.T(
                "修复过程中部分卷未能完成，请查看详细日志或手动以管理员运行 chkdsk。",
                "Some volumes failed to repair. Check the log or run chkdsk as administrator.");
        else if (fixedCount > 0)
            summary = deepScan
                ? L.T(
                    "深度扫描与修复已完成（已尝试修复文件系统错误并检查坏扇区）。",
                    "Deep scan finished (file system errors fixed; bad sectors checked).")
                : L.T("文件系统修复已完成。", "File system repair finished.");
        else
            summary = L.T("修复流程已结束。", "Repair finished.");

        return new DiskRepairResult
        {
            Success = !anyFail,
            NeedsReboot = needsReboot,
            Summary = summary,
            Log = log.ToString()
        };
    }

    internal static bool IsSectorRelatedProblem(string p) =>
        p.Contains("扇区", StringComparison.Ordinal) ||
        p.Contains("Sector", StringComparison.OrdinalIgnoreCase) ||
        p.Contains("介质错误", StringComparison.Ordinal) ||
        p.Contains("Media error", StringComparison.OrdinalIgnoreCase) ||
        p.Contains("Media Errors", StringComparison.OrdinalIgnoreCase) ||
        p.Contains("重映射", StringComparison.Ordinal) ||
        p.Contains("Reallocat", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// chkdsk 为控制台程序，中文 Windows 下重定向输出多为 OEM/GBK（936），
    /// 不能用 .NET 默认的 UTF-8（Encoding.GetEncoding(0) 在 .NET 8 也是 UTF-8），否则中文乱码。
    /// </summary>
    private static Encoding GetChkdskOutputEncoding()
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        try
        {
            var oem = CultureInfo.CurrentCulture.TextInfo.OEMCodePage;
            if (oem > 0)
                return Encoding.GetEncoding(oem);
        }
        catch
        {
            // fall through
        }

        try
        {
            return Encoding.GetEncoding(936); // 简体中文 GBK
        }
        catch
        {
            return Encoding.Default;
        }
    }

    private static async Task<(int ExitCode, string Output, bool NeedsReboot)> RunChkdskAsync(
        string arguments,
        IProgress<string>? progress,
        CancellationToken cancellationToken)
    {
        var enc = GetChkdskOutputEncoding();
        var psi = new ProcessStartInfo
        {
            FileName = "chkdsk.exe",
            Arguments = arguments,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
            CreateNoWindow = true,
            StandardOutputEncoding = enc,
            StandardErrorEncoding = enc
        };

        using var proc = new Process { StartInfo = psi, EnableRaisingEvents = true };
        var sb = new StringBuilder();
        var reboot = false;

        proc.OutputDataReceived += (_, e) =>
        {
            if (e.Data is null)
                return;
            lock (sb)
                sb.AppendLine(e.Data);

            if (LooksLikeRebootPrompt(e.Data))
                reboot = true;

            var line = e.Data.Trim();
            if (line.Length > 0)
                progress?.Report(LocalizeChkdskStatus(line));
        };
        proc.ErrorDataReceived += (_, e) =>
        {
            if (e.Data is null)
                return;
            lock (sb)
                sb.AppendLine(e.Data);
            if (LooksLikeRebootPrompt(e.Data))
                reboot = true;

            var line = e.Data.Trim();
            if (line.Length > 0)
                progress?.Report(LocalizeChkdskStatus(line));
        };

        if (!proc.Start())
            throw new InvalidOperationException(L.T("无法启动 chkdsk。", "Failed to start chkdsk."));

        proc.BeginOutputReadLine();
        proc.BeginErrorReadLine();

        // 若 chkdsk 询问是否计划下次启动修复，自动回答 Y
        try
        {
            await proc.StandardInput.WriteLineAsync("Y").ConfigureAwait(false);
            await proc.StandardInput.FlushAsync().ConfigureAwait(false);
        }
        catch
        {
            // 非交互场景可忽略
        }

        try
        {
            await proc.WaitForExitAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            try
            {
                if (!proc.HasExited)
                    proc.Kill(entireProcessTree: true);
            }
            catch
            {
                // ignore
            }

            throw;
        }

        string output;
        lock (sb)
            output = sb.ToString();

        if (!reboot)
            reboot = LooksLikeRebootPrompt(output);

        return (proc.ExitCode, output, reboot);
    }

    private static bool LooksLikeRebootPrompt(string text) =>
        text.Contains("would you like to schedule", StringComparison.OrdinalIgnoreCase) ||
        text.Contains("next time the system restarts", StringComparison.OrdinalIgnoreCase) ||
        text.Contains("下次重新启动", StringComparison.Ordinal) ||
        text.Contains("下次启动", StringComparison.Ordinal) ||
        text.Contains("已将该卷标记", StringComparison.Ordinal) ||
        text.Contains("scheduled to be checked", StringComparison.OrdinalIgnoreCase);

    private static bool HasCjk(string s)
    {
        foreach (var c in s)
        {
            if (c >= '\u4e00' && c <= '\u9fff')
                return true;
        }

        return false;
    }

    /// <summary>
    /// chkdsk 输出跟系统语言走，与界面中英切换无关；进度条需按当前 UI 语言再映射一遍。
    /// </summary>
    private static string LocalizeChkdskStatus(string line)
    {
        var hasCjk = HasCjk(line);
        string text;
        if (L.IsChinese == hasCjk)
            text = line;
        else
            text = L.IsChinese ? TranslateChkdskEnToZh(line) : TranslateChkdskZhToEn(line);

        return TruncateStatus(text);
    }

    private static string TranslateChkdskZhToEn(string line)
    {
        // 进度：已完成 123 (共 456)；阶段: 65%; 总计: 13%
        var m = Regex.Match(line,
            @"进度[：:]\s*已完成\s*(\d+)\s*\(共\s*(\d+)\)\s*[；;]?\s*阶段[：:]\s*(\d+)%\s*[；;]?\s*总计[：:]\s*(\d+)%");
        if (m.Success)
            return $"Progress: {m.Groups[1].Value} of {m.Groups[2].Value}; Stage: {m.Groups[3].Value}%; Total: {m.Groups[4].Value}%";

        m = Regex.Match(line, @"进度[：:]\s*已完成\s*(\d+)\s*\(共\s*(\d+)\)");
        if (m.Success)
            return $"Progress: {m.Groups[1].Value} of {m.Groups[2].Value} complete";

        m = Regex.Match(line, @"阶段\s*(\d+)\s*[：:]\s*(.+)");
        if (m.Success)
            return $"Stage {m.Groups[1].Value}: {TranslateChkdskPhraseZhToEn(m.Groups[2].Value.Trim())}";

        m = Regex.Match(line, @"文件系统的类型是\s*(.+?)[。.]?\s*$");
        if (m.Success)
            return $"The type of the file system is {m.Groups[1].Value.Trim()}.";

        // 固定短语（长句优先）
        var pairs = new (string Zh, string En)[]
        {
            ("警告! 未指定 /F 参数。", "Warning! /F was not specified."),
            ("警告！未指定 /F 参数。", "Warning! /F was not specified."),
            ("将在只读模式下运行 CHKDSK。", "CHKDSK will be performed in read-only mode."),
            ("Windows 已检查文件系统，未发现问题。", "Windows has scanned the file system and found no problems."),
            ("Windows 已检查该文件系统并发现了问题。", "Windows has scanned the file system and found problems."),
            ("已找到并更正错误。", "Errors found and corrected."),
            ("未能更正错误。", "Errors could not be corrected."),
            ("此卷正由另一进程使用。", "This volume is in use by another process."),
            ("是否将此卷计划在系统下次重新启动时检查?", "Would you like to schedule this volume to be checked the next time the system restarts?"),
            ("是否将此卷计划在系统下次重新启动时检查？", "Would you like to schedule this volume to be checked the next time the system restarts?"),
            ("已将该卷标记为在系统下次重新启动时进行脏扫描。", "This volume has been marked dirty and will be checked on next restart."),
            ("CHKDSK 正在验证文件", "CHKDSK is verifying files"),
            ("CHKDSK 正在验证索引", "CHKDSK is verifying indexes"),
            ("CHKDSK 正在验证安全描述符", "CHKDSK is verifying security descriptors"),
            ("正在验证文件", "Verifying files"),
            ("正在验证索引", "Verifying indexes"),
            ("正在验证安全描述符", "Verifying security descriptors"),
            ("检查基本文件系统结构", "Examining basic file system structure"),
            ("检查文件名链接", "Examining file name linkage"),
            ("检查安全描述符", "Examining security descriptors"),
            ("查找错误簇", "Looking for bad clusters"),
            ("检查可用空间", "Checking free space"),
            ("正在进行磁盘检查", "Disk check in progress"),
            ("已完成", "complete"),
        };

        foreach (var (zh, en) in pairs)
        {
            if (line.Contains(zh, StringComparison.Ordinal))
                line = line.Replace(zh, en, StringComparison.Ordinal);
        }

        // 残留常见词
        line = line
            .Replace("阶段", "Stage", StringComparison.Ordinal)
            .Replace("进度", "Progress", StringComparison.Ordinal)
            .Replace("总计", "Total", StringComparison.Ordinal)
            .Replace("共", "of", StringComparison.Ordinal);

        return line;
    }

    private static string TranslateChkdskPhraseZhToEn(string phrase)
    {
        if (phrase.Contains("基本文件系统结构", StringComparison.Ordinal))
            return "Examining basic file system structure...";
        if (phrase.Contains("文件名链接", StringComparison.Ordinal))
            return "Examining file name linkage...";
        if (phrase.Contains("安全描述符", StringComparison.Ordinal))
            return "Examining security descriptors...";
        if (phrase.Contains("错误簇", StringComparison.Ordinal) || phrase.Contains("坏簇", StringComparison.Ordinal))
            return "Looking for bad clusters...";
        if (phrase.Contains("可用空间", StringComparison.Ordinal))
            return "Checking free space...";
        return TranslateChkdskZhToEn(phrase);
    }

    private static string TranslateChkdskEnToZh(string line)
    {
        var m = Regex.Match(line,
            @"Progress:\s*(\d+)\s*of\s*(\d+)(?:\s*complete)?[;,]?\s*Stage:\s*(\d+)%[;,]?\s*Total:\s*(\d+)%",
            RegexOptions.IgnoreCase);
        if (m.Success)
            return $"进度: 已完成 {m.Groups[1].Value} (共 {m.Groups[2].Value})；阶段: {m.Groups[3].Value}%；总计: {m.Groups[4].Value}%";

        m = Regex.Match(line, @"Stage\s*(\d+)\s*:\s*(.+)", RegexOptions.IgnoreCase);
        if (m.Success)
            return $"阶段 {m.Groups[1].Value}: {TranslateChkdskPhraseEnToZh(m.Groups[2].Value.Trim())}";

        m = Regex.Match(line, @"The type of the file system is\s*(.+?)\.?\s*$", RegexOptions.IgnoreCase);
        if (m.Success)
            return $"文件系统的类型是 {m.Groups[1].Value.Trim()}。";

        var pairs = new (string En, string Zh)[]
        {
            ("Warning! /F was not specified.", "警告! 未指定 /F 参数。"),
            ("CHKDSK will be performed in read-only mode.", "将在只读模式下运行 CHKDSK。"),
            ("Windows has scanned the file system and found no problems.", "Windows 已检查文件系统，未发现问题。"),
            ("Windows has scanned the file system and found problems.", "Windows 已检查该文件系统并发现了问题。"),
            ("This volume is in use by another process.", "此卷正由另一进程使用。"),
            ("Would you like to schedule this volume to be checked the next time the system restarts?",
                "是否将此卷计划在系统下次重新启动时检查？"),
            ("Examining basic file system structure", "检查基本文件系统结构"),
            ("Examining file name linkage", "检查文件名链接"),
            ("Examining security descriptors", "检查安全描述符"),
            ("Looking for bad clusters", "查找错误簇"),
            ("Checking free space", "检查可用空间"),
            ("Verifying files", "正在验证文件"),
            ("Verifying indexes", "正在验证索引"),
            ("Verifying security descriptors", "正在验证安全描述符"),
        };

        foreach (var (en, zh) in pairs)
        {
            if (line.Contains(en, StringComparison.OrdinalIgnoreCase))
                line = Regex.Replace(line, Regex.Escape(en), zh, RegexOptions.IgnoreCase);
        }

        return line;
    }

    private static string TranslateChkdskPhraseEnToZh(string phrase)
    {
        if (phrase.Contains("basic file system", StringComparison.OrdinalIgnoreCase))
            return "检查基本文件系统结构...";
        if (phrase.Contains("file name", StringComparison.OrdinalIgnoreCase))
            return "检查文件名链接...";
        if (phrase.Contains("security descriptor", StringComparison.OrdinalIgnoreCase))
            return "检查安全描述符...";
        if (phrase.Contains("bad cluster", StringComparison.OrdinalIgnoreCase))
            return "查找错误簇...";
        if (phrase.Contains("free space", StringComparison.OrdinalIgnoreCase))
            return "检查可用空间...";
        return TranslateChkdskEnToZh(phrase);
    }

    private static string TruncateStatus(string line)
    {
        const int max = 80;
        if (line.Length <= max)
            return line;
        return line[..(max - 1)] + "…";
    }
}
