using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace MemWatch;

internal enum DeepRecoverability
{
    Recoverable,
    PossiblyIncomplete,
    Unsupported
}

internal sealed class DeepRecoverItem
{
    public string Drive { get; init; } = "";
    public long MftRecordNumber { get; init; }
    public string Name { get; init; } = "";
    public string RelativePath { get; init; } = "";
    public long SizeBytes { get; init; }
    public DateTime? ModifiedUtc { get; init; }
    public DeepRecoverability Recoverability { get; init; }
    public string StatusText { get; init; } = "";
    public string UnsupportedReason { get; init; } = "";

    /// <summary>常驻数据副本（仅扫描时缓存小文件）。</summary>
    public byte[]? ResidentData { get; init; }

    /// <summary>非驻留数据 runs；扫描后仍可用于恢复（相对卷起始）。</summary>
    public List<DataRun>? Runs { get; init; }

    public int BytesPerCluster { get; init; }
    public long RealSize { get; init; }
}

internal readonly struct DataRun
{
    public DataRun(long startLcn, long clusterCount)
    {
        StartLcn = startLcn;
        ClusterCount = clusterCount;
    }

    public long StartLcn { get; }
    public long ClusterCount { get; }
}

/// <summary>通过原始卷读取 NTFS MFT，枚举已删除文件并按 data run 导出。</summary>
internal static class NtfsDeepRecovery
{
    private const uint GenericRead = 0x80000000;
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint OpenExisting = 3;
    private const uint FileFlagRandomAccess = 0x10000000;

    private const uint AttrStandardInfo = 0x10;
    private const uint AttrFileName = 0x30;
    private const uint AttrData = 0x80;
    private const uint AttrEnd = 0xFFFFFFFF;

    private const ushort AttrFlagCompressed = 0x0001;
    private const ushort AttrFlagEncrypted = 0x4000;
    private const ushort AttrFlagSparse = 0x8000;

    public static IReadOnlyList<string> ListNtfsDrives()
    {
        var list = new List<string>();
        try
        {
            foreach (var d in DriveInfo.GetDrives())
            {
                if (!d.IsReady)
                    continue;
                if (d.DriveType is not (DriveType.Fixed or DriveType.Removable))
                    continue;
                string fs;
                try
                {
                    fs = d.DriveFormat;
                }
                catch
                {
                    continue;
                }

                if (!string.Equals(fs, "NTFS", StringComparison.OrdinalIgnoreCase))
                    continue;

                var root = d.Name.TrimEnd('\\');
                if (root.Length >= 2)
                    list.Add(root.ToUpperInvariant());
            }
        }
        catch
        {
            // ignore
        }

        return list;
    }

    public static List<DeepRecoverItem> Scan(
        string driveLetter,
        IProgress<(int Percent, string Message)>? progress,
        CancellationToken cancel)
    {
        var letter = NormalizeDrive(driveLetter);
        using var vol = VolumeStream.Open(letter);
        var boot = vol.ReadBoot();
        var mftRuns = vol.ReadMftLayout(boot);

        progress?.Report((2, L.T("正在解析目录索引…", "Indexing directories…")));

        // 先扫一遍建立「记录号 → 名称/父」表（含仍在用的目录）
        var nameIndex = new ConcurrentDictionary<long, (string Name, long Parent)>();
        var deletedCandidates = new List<(long RecordNo, byte[] Record)>();

        var totalRecords = EstimateRecordCount(mftRuns, boot.BytesPerCluster, boot.BytesPerRecord);
        var scanned = 0L;

        foreach (var (recordNo, record) in vol.EnumerateMftRecords(boot, mftRuns, cancel))
        {
            cancel.ThrowIfCancellationRequested();
            scanned++;
            if (scanned % 2048 == 0 || scanned == 1)
            {
                var pct = totalRecords <= 0
                    ? 5
                    : (int)Math.Clamp(5 + scanned * 85 / totalRecords, 5, 90);
                progress?.Report((pct, L.T(
                    $"已扫描 {scanned:N0} 条 MFT 记录…",
                    $"Scanned {scanned:N0} MFT record(s)…")));
            }

            if (recordNo < 16)
                continue;

            if (!TryParseRecordMeta(record, out var inUse, out var isDir, out var names, out var parent))
                continue;

            // 取最佳文件名（优先 Win32）
            var bestName = PickBestName(names);
            if (!string.IsNullOrEmpty(bestName))
                nameIndex[recordNo] = (bestName, parent);

            if (inUse || isDir)
                continue;

            deletedCandidates.Add((recordNo, record));
        }

        progress?.Report((92, L.T("正在整理已删除文件…", "Collecting deleted files…")));

        var results = new List<DeepRecoverItem>();
        foreach (var (recordNo, record) in deletedCandidates)
        {
            cancel.ThrowIfCancellationRequested();
            if (!TryBuildDeletedItem(letter, recordNo, record, boot, nameIndex, out var item))
                continue;
            results.Add(item);
        }

        results.Sort((a, b) =>
        {
            var c = b.SizeBytes.CompareTo(a.SizeBytes);
            return c != 0 ? c : string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase);
        });

        progress?.Report((100, L.T(
            $"扫描完成，找到 {results.Count} 个已删除文件",
            $"Scan done, found {results.Count} deleted file(s)")));

        return results;
    }

    public static (int Ok, int Fail) RecoverMany(
        string driveLetter,
        IEnumerable<DeepRecoverItem> items,
        string outputRoot,
        IProgress<(int Done, int Total, string Name)>? progress,
        CancellationToken cancel,
        out List<string> errors)
    {
        errors = new List<string>();
        var list = items.ToList();
        var ok = 0;
        var fail = 0;
        var letter = NormalizeDrive(driveLetter);

        using var vol = VolumeStream.Open(letter);
        var boot = vol.ReadBoot();
        var i = 0;
        foreach (var item in list)
        {
            cancel.ThrowIfCancellationRequested();
            i++;
            progress?.Report((i, list.Count, item.Name));

            if (item.Recoverability == DeepRecoverability.Unsupported)
            {
                fail++;
                errors.Add($"{item.Name}: {item.UnsupportedReason}");
                continue;
            }

            try
            {
                RecoverOne(vol, boot, item, outputRoot);
                ok++;
            }
            catch (Exception ex)
            {
                fail++;
                errors.Add($"{item.Name}: {ex.Message}");
            }
        }

        return (ok, fail);
    }

    private static void RecoverOne(VolumeStream vol, BootInfo boot, DeepRecoverItem item, string outputRoot)
    {
        var rel = string.IsNullOrWhiteSpace(item.RelativePath) ? item.Name : item.RelativePath;
        rel = SanitizeRelativePath(rel);
        var dest = Path.Combine(outputRoot, letterFolder(item.Drive), rel);
        var dir = Path.GetDirectoryName(dest);
        if (!string.IsNullOrEmpty(dir))
            Directory.CreateDirectory(dir);

        dest = UniquePath(dest);

        if (item.ResidentData is { Length: > 0 })
        {
            File.WriteAllBytes(dest, item.ResidentData);
            return;
        }

        if (item.Runs is null || item.Runs.Count == 0)
            throw new InvalidOperationException(L.T("没有可用的数据块。", "No usable data runs."));

        var remaining = item.RealSize > 0 ? item.RealSize : item.SizeBytes;
        if (remaining < 0)
            remaining = 0;

        using var fs = new FileStream(dest, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1024 * 256);
        var clusterBuf = new byte[boot.BytesPerCluster];

        foreach (var run in item.Runs)
        {
            if (remaining <= 0)
                break;

            if (run.StartLcn < 0)
            {
                // 稀疏洞：写零
                var sparseBytes = checked(run.ClusterCount * (long)boot.BytesPerCluster);
                var toZero = Math.Min(sparseBytes, remaining);
                WriteZeros(fs, toZero);
                remaining -= toZero;
                continue;
            }

            for (long c = 0; c < run.ClusterCount && remaining > 0; c++)
            {
                var offset = checked((run.StartLcn + c) * (long)boot.BytesPerCluster);
                vol.ReadExact(offset, clusterBuf.AsSpan());
                var take = (int)Math.Min(remaining, boot.BytesPerCluster);
                fs.Write(clusterBuf, 0, take);
                remaining -= take;
            }
        }

        fs.Flush(true);

        static string letterFolder(string drive)
        {
            var d = drive.TrimEnd(':').TrimEnd('\\');
            return string.IsNullOrEmpty(d) ? "Drive" : d + "_Recovered";
        }
    }

    private static void WriteZeros(Stream s, long count)
    {
        if (count <= 0)
            return;
        var buf = new byte[Math.Min(count, 64 * 1024)];
        while (count > 0)
        {
            var n = (int)Math.Min(count, buf.Length);
            s.Write(buf, 0, n);
            count -= n;
        }
    }

    private static string UniquePath(string path)
    {
        if (!File.Exists(path))
            return path;
        var dir = Path.GetDirectoryName(path) ?? "";
        var name = Path.GetFileNameWithoutExtension(path);
        var ext = Path.GetExtension(path);
        for (var i = 1; i < 10000; i++)
        {
            var p = Path.Combine(dir, $"{name}_{i}{ext}");
            if (!File.Exists(p))
                return p;
        }

        return Path.Combine(dir, $"{name}_{Guid.NewGuid():N}{ext}");
    }

    private static string SanitizeRelativePath(string rel)
    {
        var parts = rel.Replace('/', '\\').Split('\\', StringSplitOptions.RemoveEmptyEntries);
        var clean = new List<string>();
        foreach (var p in parts)
        {
            var s = p.Trim();
            foreach (var c in Path.GetInvalidFileNameChars())
                s = s.Replace(c, '_');
            if (s is "." or ".." || string.IsNullOrWhiteSpace(s))
                continue;
            clean.Add(s);
        }

        return clean.Count == 0 ? "recovered.bin" : string.Join("\\", clean);
    }

    private static string NormalizeDrive(string driveLetter)
    {
        var s = driveLetter.Trim().TrimEnd('\\').ToUpperInvariant();
        if (s.Length == 1)
            s += ":";
        if (s.Length < 2 || s[1] != ':')
            throw new ArgumentException("Invalid drive.");
        return s[..2];
    }

    private static long EstimateRecordCount(List<DataRun> runs, int bytesPerCluster, int bytesPerRecord)
    {
        long clusters = 0;
        foreach (var r in runs)
        {
            if (r.StartLcn >= 0)
                clusters += r.ClusterCount;
        }

        if (bytesPerRecord <= 0)
            return 0;
        return clusters * bytesPerCluster / bytesPerRecord;
    }

    private static bool TryParseRecordMeta(
        byte[] record,
        out bool inUse,
        out bool isDir,
        out List<(string Name, byte NameType, long Parent)> names,
        out long parent)
    {
        inUse = false;
        isDir = false;
        names = new List<(string, byte, long)>();
        parent = 5;

        if (record.Length < 0x30)
            return false;
        if (record[0] != (byte)'F' || record[1] != (byte)'I' || record[2] != (byte)'L' || record[3] != (byte)'E')
            return false;

        ApplyFixup(record);

        var flags = BinaryPrimitives.ReadUInt16LittleEndian(record.AsSpan(0x16));
        // Actually flags are at 0x16? Wait - NTFS MFT:
        // 0x12: sequence number (2) - no
        // Layout:
        // 0x00 Signature
        // 0x04 UsaOffset
        // 0x06 UsaCount
        // 0x08 Lsn
        // 0x10 SequenceNumber
        // 0x12 LinkCount
        // 0x14 AttributeOffset
        // 0x16 Flags  << YES 0x16
        // 0x18 BytesInUse
        // 0x1C BytesAllocated
        // 0x20 BaseFileRecord
        // ...

        inUse = (flags & 0x01) != 0;
        isDir = (flags & 0x02) != 0;

        var attrOff = BinaryPrimitives.ReadUInt16LittleEndian(record.AsSpan(0x14));
        if (attrOff < 0x30 || attrOff >= record.Length)
            return false;

        parent = 5;
        var firstParent = true;
        var offset = (int)attrOff;
        while (offset + 8 <= record.Length)
        {
            var type = BinaryPrimitives.ReadUInt32LittleEndian(record.AsSpan(offset));
            if (type == AttrEnd)
                break;
            var len = BinaryPrimitives.ReadUInt32LittleEndian(record.AsSpan(offset + 4));
            if (len < 24 || offset + (int)len > record.Length)
                break;

            if (type == AttrFileName)
            {
                if (TryReadFileNameAttr(record, offset, out var fn, out var nt, out var par))
                {
                    names.Add((fn, nt, par));
                    if (firstParent || nt == 1) // Win32
                    {
                        parent = par;
                        firstParent = false;
                    }
                }
            }

            offset += (int)len;
        }

        return true;
    }

    private static string PickBestName(List<(string Name, byte NameType, long Parent)> names)
    {
        if (names.Count == 0)
            return "";
        // 1 = Win32, 3 = Win32+DOS, 0 = POSIX, 2 = DOS
        foreach (var n in names)
        {
            if (n.NameType is 1 or 3)
                return n.Name;
        }

        return names[0].Name;
    }

    private static bool TryBuildDeletedItem(
        string drive,
        long recordNo,
        byte[] record,
        BootInfo boot,
        ConcurrentDictionary<long, (string Name, long Parent)> nameIndex,
        out DeepRecoverItem item)
    {
        item = null!;
        // record 在扫描阶段已做过 fixup，勿重复应用

        var names = new List<(string Name, byte NameType, long Parent)>();
        DateTime? mtime = null;
        byte[]? resident = null;
        List<DataRun>? runs = null;
        long realSize = 0;
        var unsupported = false;
        var reason = "";
        var hasData = false;

        var attrOff = BinaryPrimitives.ReadUInt16LittleEndian(record.AsSpan(0x14));
        var offset = (int)attrOff;
        while (offset + 8 <= record.Length)
        {
            var type = BinaryPrimitives.ReadUInt32LittleEndian(record.AsSpan(offset));
            if (type == AttrEnd)
                break;
            var len = BinaryPrimitives.ReadUInt32LittleEndian(record.AsSpan(offset + 4));
            if (len < 24 || offset + (int)len > record.Length)
                break;

            var nonResident = record[offset + 8];
            var nameLen = record[offset + 9];
            var aFlags = BinaryPrimitives.ReadUInt16LittleEndian(record.AsSpan(offset + 12));

            if (type == AttrStandardInfo && nonResident == 0)
            {
                var vLen = BinaryPrimitives.ReadUInt32LittleEndian(record.AsSpan(offset + 16));
                var vOff = BinaryPrimitives.ReadUInt16LittleEndian(record.AsSpan(offset + 20));
                if (vOff + 24 <= len && offset + vOff + 24 <= record.Length)
                {
                    // modification time at +8 in STANDARD_INFORMATION (FILETIME)
                    var ft = BinaryPrimitives.ReadInt64LittleEndian(record.AsSpan(offset + vOff + 8));
                    try
                    {
                        if (ft > 0)
                            mtime = DateTime.FromFileTimeUtc(ft);
                    }
                    catch
                    {
                        // ignore
                    }
                }
            }
            else if (type == AttrFileName && nonResident == 0)
            {
                if (TryReadFileNameAttr(record, offset, out var fn, out var nt, out var par))
                    names.Add((fn, nt, par));
            }
            else if (type == AttrData && nameLen == 0) // unnamed $DATA
            {
                hasData = true;
                if ((aFlags & AttrFlagEncrypted) != 0)
                {
                    unsupported = true;
                    reason = L.T("加密文件", "Encrypted");
                }
                else if ((aFlags & AttrFlagCompressed) != 0)
                {
                    unsupported = true;
                    reason = L.T("压缩文件", "Compressed");
                }
                else if ((aFlags & AttrFlagSparse) != 0)
                {
                    // 仍尝试恢复稀疏文件（洞写零）
                }

                if (!unsupported)
                {
                    if (nonResident == 0)
                    {
                        var vLen = BinaryPrimitives.ReadUInt32LittleEndian(record.AsSpan(offset + 16));
                        var vOff = BinaryPrimitives.ReadUInt16LittleEndian(record.AsSpan(offset + 20));
                        if (vOff + vLen <= len && offset + vOff + (int)vLen <= record.Length)
                        {
                            resident = new byte[vLen];
                            Buffer.BlockCopy(record, offset + vOff, resident, 0, (int)vLen);
                            realSize = vLen;
                        }
                    }
                    else
                    {
                        // non-resident header
                        if (offset + 0x40 <= record.Length)
                        {
                            realSize = BinaryPrimitives.ReadInt64LittleEndian(record.AsSpan(offset + 0x30));
                            var runOff = BinaryPrimitives.ReadUInt16LittleEndian(record.AsSpan(offset + 0x20));
                            var compressionUnit = BinaryPrimitives.ReadUInt16LittleEndian(record.AsSpan(offset + 0x22));
                            if (compressionUnit != 0 && (aFlags & AttrFlagCompressed) != 0)
                            {
                                unsupported = true;
                                reason = L.T("压缩文件", "Compressed");
                            }
                            else if (runOff > 0 && offset + runOff < offset + (int)len)
                            {
                                runs = ParseDataRuns(record.AsSpan(offset + runOff, (int)len - runOff));
                            }
                        }
                    }
                }
            }

            offset += (int)len;
        }

        var name = PickBestName(names);
        if (string.IsNullOrWhiteSpace(name))
            name = $"file_{recordNo}";

        long parent = names.Count > 0 ? names.OrderBy(n => n.NameType is 1 or 3 ? 0 : 1).First().Parent : 5;
        var relPath = BuildPath(nameIndex, parent, name);

        if (!hasData && resident is null && (runs is null || runs.Count == 0))
            return false;

        DeepRecoverability rec;
        string status;
        if (unsupported)
        {
            rec = DeepRecoverability.Unsupported;
            status = L.T("不支持", "Unsupported") + (string.IsNullOrEmpty(reason) ? "" : $" ({reason})");
        }
        else if (resident is { Length: > 0 })
        {
            rec = DeepRecoverability.Recoverable;
            status = L.T("可恢复", "Recoverable");
        }
        else if (runs is { Count: > 0 } && realSize >= 0)
        {
            // 无法廉价验证簇是否被覆盖 → 标为可能不完整但仍允许恢复
            rec = DeepRecoverability.PossiblyIncomplete;
            status = L.T("可能可恢复", "Possibly recoverable");
        }
        else
        {
            rec = DeepRecoverability.Unsupported;
            status = L.T("无数据", "No data");
            reason = status;
            unsupported = true;
        }

        item = new DeepRecoverItem
        {
            Drive = drive,
            MftRecordNumber = recordNo,
            Name = name,
            RelativePath = relPath,
            SizeBytes = realSize > 0 ? realSize : (resident?.Length ?? 0),
            ModifiedUtc = mtime,
            Recoverability = rec,
            StatusText = status,
            UnsupportedReason = reason,
            ResidentData = unsupported ? null : resident,
            Runs = unsupported ? null : runs,
            BytesPerCluster = boot.BytesPerCluster,
            RealSize = realSize
        };
        return true;
    }

    private static string BuildPath(
        ConcurrentDictionary<long, (string Name, long Parent)> index,
        long parent,
        string fileName)
    {
        var parts = new List<string> { fileName };
        var guard = 0;
        var cur = parent;
        while (cur >= 16 && guard++ < 64)
        {
            if (!index.TryGetValue(cur, out var node))
            {
                parts.Insert(0, "_Orphan");
                break;
            }

            parts.Insert(0, node.Name);
            if (node.Parent == cur)
                break;
            cur = node.Parent;
            if (cur == 5) // root
                break;
        }

        if (cur != 5 && guard >= 64)
            parts.Insert(0, "_Orphan");

        return string.Join("\\", parts);
    }

    private static bool TryReadFileNameAttr(byte[] record, int offset, out string name, out byte nameType, out long parent)
    {
        name = "";
        nameType = 0;
        parent = 5;
        var nonResident = record[offset + 8];
        if (nonResident != 0)
            return false;
        var len = BinaryPrimitives.ReadUInt32LittleEndian(record.AsSpan(offset + 4));
        var vLen = BinaryPrimitives.ReadUInt32LittleEndian(record.AsSpan(offset + 16));
        var vOff = BinaryPrimitives.ReadUInt16LittleEndian(record.AsSpan(offset + 20));
        if (vOff + 0x42 > len || offset + vOff + 0x42 > record.Length)
            return false;

        var body = offset + vOff;
        var pref = BinaryPrimitives.ReadUInt64LittleEndian(record.AsSpan(body));
        parent = (long)(pref & 0x0000FFFFFFFFFFFFUL);
        nameType = record[body + 0x41];
        var nameChars = record[body + 0x40];
        var nameBytes = nameChars * 2;
        if (body + 0x42 + nameBytes > offset + (int)len || body + 0x42 + nameBytes > record.Length)
            return false;
        name = System.Text.Encoding.Unicode.GetString(record, body + 0x42, nameBytes);
        return !string.IsNullOrWhiteSpace(name);
    }

    private static List<DataRun> ParseDataRuns(ReadOnlySpan<byte> runs)
    {
        var list = new List<DataRun>();
        long lcn = 0;
        var i = 0;
        while (i < runs.Length)
        {
            var header = runs[i++];
            if (header == 0)
                break;
            var lenSize = header & 0x0F;
            var offSize = (header >> 4) & 0x0F;
            if (lenSize == 0 || i + lenSize + offSize > runs.Length)
                break;

            var clusterCount = ReadLittleEndianUnsigned(runs.Slice(i, lenSize), lenSize);
            i += lenSize;

            long offsetLcn = 0;
            if (offSize > 0)
            {
                offsetLcn = ReadLittleEndianSigned(runs.Slice(i, offSize), offSize);
                i += offSize;
                lcn += offsetLcn;
                list.Add(new DataRun(lcn, clusterCount));
            }
            else
            {
                // sparse
                list.Add(new DataRun(-1, clusterCount));
            }
        }

        return list;
    }

    private static long ReadLittleEndianUnsigned(ReadOnlySpan<byte> data, int size)
    {
        ulong v = 0;
        for (var i = 0; i < size; i++)
            v |= (ulong)data[i] << (8 * i);
        return (long)v;
    }

    private static long ReadLittleEndianSigned(ReadOnlySpan<byte> data, int size)
    {
        long v = 0;
        for (var i = 0; i < size; i++)
            v |= (long)data[i] << (8 * i);
        var shift = (8 - size) * 8;
        return (v << shift) >> shift;
    }

    private static void ApplyFixup(byte[] record)
    {
        if (record.Length < 8)
            return;
        var usaOff = BinaryPrimitives.ReadUInt16LittleEndian(record.AsSpan(4));
        var usaCount = BinaryPrimitives.ReadUInt16LittleEndian(record.AsSpan(6));
        if (usaOff == 0 || usaCount < 2)
            return;
        if (usaOff + usaCount * 2 > record.Length)
            return;

        var sectorSize = 512;
        // Update sequence: usa[0] is USN, usa[1..] replace last 2 bytes of each sector
        for (var s = 1; s < usaCount; s++)
        {
            var sectorEnd = s * sectorSize;
            if (sectorEnd > record.Length)
                break;
            var pos = sectorEnd - 2;
            var fix = BinaryPrimitives.ReadUInt16LittleEndian(record.AsSpan(usaOff + s * 2));
            record[pos] = (byte)(fix & 0xFF);
            record[pos + 1] = (byte)(fix >> 8);
        }
    }

    private sealed class BootInfo
    {
        public int BytesPerSector;
        public int SectorsPerCluster;
        public int BytesPerCluster;
        public long MftStartLcn;
        public int BytesPerRecord;
    }

    private sealed class VolumeStream : IDisposable
    {
        private readonly SafeFileHandle _handle;
        private long _position;

        private VolumeStream(SafeFileHandle handle) => _handle = handle;

        public static VolumeStream Open(string driveLetter)
        {
            var path = @"\\.\" + driveLetter;
            var h = CreateFile(path, GenericRead, FileShareRead | FileShareWrite, IntPtr.Zero,
                OpenExisting, FileFlagRandomAccess, IntPtr.Zero);
            if (h.IsInvalid)
                throw new InvalidOperationException(L.T(
                    $"无法打开卷 {driveLetter}（需要管理员权限，且盘符为 NTFS）。错误码 {Marshal.GetLastWin32Error()}",
                    $"Cannot open volume {driveLetter} (admin + NTFS required). Win32 {Marshal.GetLastWin32Error()}"));
            return new VolumeStream(h);
        }

        public BootInfo ReadBoot()
        {
            var sector = new byte[512];
            ReadExact(0, sector);
            if (sector[3] != (byte)'N' || sector[4] != (byte)'T' || sector[5] != (byte)'F' || sector[6] != (byte)'S')
            {
                // OEM often "NTFS    "
            }

            var bytesPerSector = BinaryPrimitives.ReadUInt16LittleEndian(sector.AsSpan(0x0B));
            var sectorsPerCluster = sector[0x0D];
            if (bytesPerSector == 0 || sectorsPerCluster == 0)
                throw new InvalidOperationException(L.T("无效的 NTFS 引导扇区。", "Invalid NTFS boot sector."));

            var mftLcn = BinaryPrimitives.ReadInt64LittleEndian(sector.AsSpan(0x30));
            var clustersPerRecord = unchecked((sbyte)sector[0x40]);
            int bytesPerRecord;
            if (clustersPerRecord > 0)
                bytesPerRecord = clustersPerRecord * bytesPerSector * sectorsPerCluster;
            else
                bytesPerRecord = 1 << (-clustersPerRecord);

            if (bytesPerRecord < 1024 || bytesPerRecord > 4096)
                bytesPerRecord = 1024;

            return new BootInfo
            {
                BytesPerSector = bytesPerSector,
                SectorsPerCluster = sectorsPerCluster,
                BytesPerCluster = bytesPerSector * sectorsPerCluster,
                MftStartLcn = mftLcn,
                BytesPerRecord = bytesPerRecord
            };
        }

        public List<DataRun> ReadMftLayout(BootInfo boot)
        {
            var first = new byte[boot.BytesPerRecord];
            var mftOffset = checked(boot.MftStartLcn * (long)boot.BytesPerCluster);
            ReadExact(mftOffset, first);
            ApplyFixup(first);

            // Find unnamed $DATA of record 0
            var attrOff = BinaryPrimitives.ReadUInt16LittleEndian(first.AsSpan(0x14));
            var offset = (int)attrOff;
            while (offset + 8 <= first.Length)
            {
                var type = BinaryPrimitives.ReadUInt32LittleEndian(first.AsSpan(offset));
                if (type == AttrEnd)
                    break;
                var len = BinaryPrimitives.ReadUInt32LittleEndian(first.AsSpan(offset + 4));
                if (len < 24 || offset + (int)len > first.Length)
                    break;

                var nonResident = first[offset + 8];
                var nameLen = first[offset + 9];
                if (type == AttrData && nameLen == 0 && nonResident != 0)
                {
                    var runOff = BinaryPrimitives.ReadUInt16LittleEndian(first.AsSpan(offset + 0x20));
                    if (runOff > 0 && offset + runOff < offset + (int)len)
                    {
                        var runs = ParseDataRuns(first.AsSpan(offset + runOff, (int)len - runOff));
                        if (runs.Count > 0)
                            return runs;
                    }
                }

                offset += (int)len;
            }

            // Fallback: contiguous from MFT start (at least a few records)
            return new List<DataRun> { new(boot.MftStartLcn, 64) };
        }

        public IEnumerable<(long RecordNo, byte[] Record)> EnumerateMftRecords(
            BootInfo boot,
            List<DataRun> mftRuns,
            CancellationToken cancel)
        {
            var recordSize = boot.BytesPerRecord;
            var clusterSize = boot.BytesPerCluster;
            long recordNo = 0;
            var buf = new byte[Math.Max(clusterSize, recordSize)];

            foreach (var run in mftRuns)
            {
                cancel.ThrowIfCancellationRequested();
                if (run.StartLcn < 0)
                {
                    // sparse MFT? skip holes in numbering still advance?
                    var holeRecords = run.ClusterCount * clusterSize / recordSize;
                    recordNo += holeRecords;
                    continue;
                }

                for (long c = 0; c < run.ClusterCount; c++)
                {
                    cancel.ThrowIfCancellationRequested();
                    var offset = checked((run.StartLcn + c) * (long)clusterSize);
                    if (buf.Length < clusterSize)
                        buf = new byte[clusterSize];
                    ReadExact(offset, buf.AsSpan(0, clusterSize));

                    for (var pos = 0; pos + recordSize <= clusterSize; pos += recordSize)
                    {
                        var rec = new byte[recordSize];
                        Buffer.BlockCopy(buf, pos, rec, 0, recordSize);
                        if (rec[0] == (byte)'F' && rec[1] == (byte)'I' && rec[2] == (byte)'L' && rec[3] == (byte)'E')
                            yield return (recordNo, rec);
                        recordNo++;
                    }
                }
            }
        }

        public void ReadExact(long offset, Span<byte> buffer)
        {
            SetFilePointerEx(_handle, offset, IntPtr.Zero, 0);
            _position = offset;
            var total = 0;
            while (total < buffer.Length)
            {
                if (!ReadFile(_handle, ref MemoryMarshal.GetReference(buffer[total..]), buffer.Length - total, out var read, IntPtr.Zero))
                    throw new IOException(L.T(
                        $"读取卷失败，偏移 {offset}+{total}，错误 {Marshal.GetLastWin32Error()}",
                        $"Volume read failed at {offset}+{total}, Win32 {Marshal.GetLastWin32Error()}"));
                if (read == 0)
                    throw new EndOfStreamException();
                total += read;
            }
        }

        public void Dispose() => _handle.Dispose();

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern SafeFileHandle CreateFile(
            string lpFileName,
            uint dwDesiredAccess,
            uint dwShareMode,
            IntPtr lpSecurityAttributes,
            uint dwCreationDisposition,
            uint dwFlagsAndAttributes,
            IntPtr hTemplateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetFilePointerEx(
            SafeFileHandle hFile,
            long liDistanceToMove,
            IntPtr lpNewFilePointer,
            uint dwMoveMethod);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool ReadFile(
            SafeFileHandle hFile,
            ref byte lpBuffer,
            int nNumberOfBytesToRead,
            out int lpNumberOfBytesRead,
            IntPtr lpOverlapped);
    }
}
