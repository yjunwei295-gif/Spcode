using System.Diagnostics;

namespace MemWatch;

internal sealed class DiskSpeedTestResult
{
    public double WriteMBps { get; init; }
    public double ReadMBps { get; init; }
    public int TestSizeMb { get; init; }
    public string TargetRoot { get; init; } = "";
    public TimeSpan Elapsed { get; init; }
}

/// <summary>
/// 顺序读写测速：在目标盘写入临时文件再读回，测完删除。
/// 使用 WriteThrough，结果更接近真实落盘速度。
/// </summary>
internal static class DiskSpeedTester
{
    public const int DefaultTestSizeMb = 256;
    private const int BlockSize = 1024 * 1024; // 1 MB

    public static async Task<DiskSpeedTestResult> RunAsync(
        string driveRoot,
        int testSizeMb = DefaultTestSizeMb,
        IProgress<string>? progress = null,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(driveRoot))
            throw new ArgumentException(L.T("未指定测试盘符。", "No test drive specified."), nameof(driveRoot));

        var root = driveRoot.Trim();
        if (!root.EndsWith('\\') && !root.EndsWith('/'))
            root += "\\";

        if (!Directory.Exists(root))
            throw new DirectoryNotFoundException(L.T($"找不到盘符：{root}", $"Drive not found: {root}"));

        var di = new DriveInfo(Path.GetPathRoot(root) ?? root);
        if (!di.IsReady)
            throw new IOException(L.T($"磁盘未就绪：{root}", $"Drive not ready: {root}"));

        var needBytes = (long)testSizeMb * BlockSize;
        if (di.AvailableFreeSpace < needBytes + 64L * 1024 * 1024)
            throw new IOException(L.T(
                $"可用空间不足，至少需要约 {testSizeMb + 64} MB 空闲空间。",
                $"Not enough free space; need about {testSizeMb + 64} MB."));

        var filePath = Path.Combine(root, $"MemWatch_SpeedTest_{Guid.NewGuid():N}.tmp");
        var buffer = new byte[BlockSize];
        Random.Shared.NextBytes(buffer);

        var totalSw = Stopwatch.StartNew();
        double writeMBps;
        double readMBps;

        try
        {
            progress?.Report(L.T($"正在写入测试文件（{testSizeMb} MB）…", $"Writing test file ({testSizeMb} MB)…"));
            writeMBps = await Task.Run(() => WriteSequential(filePath, buffer, testSizeMb, progress, cancellationToken), cancellationToken)
                .ConfigureAwait(false);

            progress?.Report(L.T($"正在读取测试文件（{testSizeMb} MB）…", $"Reading test file ({testSizeMb} MB)…"));
            readMBps = await Task.Run(() => ReadSequential(filePath, buffer, testSizeMb, progress, cancellationToken), cancellationToken)
                .ConfigureAwait(false);
        }
        finally
        {
            progress?.Report(L.T("正在清理临时文件…", "Cleaning up temp file…"));
            try
            {
                if (File.Exists(filePath))
                    File.Delete(filePath);
            }
            catch
            {
                // ignore
            }
        }

        totalSw.Stop();
        progress?.Report(L.T("测试完成", "Test complete"));

        return new DiskSpeedTestResult
        {
            WriteMBps = writeMBps,
            ReadMBps = readMBps,
            TestSizeMb = testSizeMb,
            TargetRoot = root,
            Elapsed = totalSw.Elapsed
        };
    }

    private static double WriteSequential(
        string path,
        byte[] buffer,
        int testSizeMb,
        IProgress<string>? progress,
        CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        using var fs = new FileStream(
            path,
            FileMode.CreateNew,
            FileAccess.Write,
            FileShare.None,
            BlockSize,
            FileOptions.WriteThrough | FileOptions.SequentialScan);

        for (var i = 0; i < testSizeMb; i++)
        {
            ct.ThrowIfCancellationRequested();
            fs.Write(buffer, 0, buffer.Length);
            if (i % 16 == 0 || i + 1 == testSizeMb)
                progress?.Report(L.T($"写入中… {i + 1}/{testSizeMb} MB", $"Writing… {i + 1}/{testSizeMb} MB"));
        }

        fs.Flush(true);
        sw.Stop();
        var seconds = Math.Max(sw.Elapsed.TotalSeconds, 0.001);
        return testSizeMb / seconds;
    }

    private static double ReadSequential(
        string path,
        byte[] buffer,
        int testSizeMb,
        IProgress<string>? progress,
        CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        long totalRead = 0;
        using var fs = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            BlockSize,
            FileOptions.SequentialScan);

        int read;
        var blocks = 0;
        while ((read = fs.Read(buffer, 0, buffer.Length)) > 0)
        {
            ct.ThrowIfCancellationRequested();
            totalRead += read;
            blocks++;
            if (blocks % 16 == 0)
                progress?.Report(L.T(
                    $"读取中… {totalRead / (1024 * 1024)}/{testSizeMb} MB",
                    $"Reading… {totalRead / (1024 * 1024)}/{testSizeMb} MB"));
        }

        sw.Stop();
        var mb = totalRead / (1024.0 * 1024.0);
        var seconds = Math.Max(sw.Elapsed.TotalSeconds, 0.001);
        return mb / seconds;
    }

    /// <summary>从「C: D:」这类盘符串里取第一个可用于测试的根路径。</summary>
    public static string? PickTestRoot(string? driveLetters)
    {
        if (string.IsNullOrWhiteSpace(driveLetters) || driveLetters == "-")
            return null;

        foreach (var part in driveLetters.Split([' ', ',', ';', '|'], StringSplitOptions.RemoveEmptyEntries))
        {
            var s = part.Trim().TrimEnd('\\', '/');
            if (s.Length >= 2 && s[1] == ':')
            {
                var root = s[..2] + "\\";
                try
                {
                    var di = new DriveInfo(root);
                    if (di.IsReady && di.DriveType is DriveType.Fixed or DriveType.Removable)
                        return root;
                }
                catch
                {
                    // try next
                }
            }
        }

        return null;
    }
}
