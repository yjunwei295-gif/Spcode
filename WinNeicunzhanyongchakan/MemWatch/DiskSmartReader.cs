using System.Globalization;
using System.Text;
using LibreHardwareMonitor.Hardware;
using LibreHardwareMonitor.Hardware.Storage;

namespace MemWatch;

internal enum DiskHealthLevel
{
    Unknown,
    Good,
    Caution,
    Bad
}

internal sealed class DiskSmartAttr
{
    public string Id { get; init; } = "";
    public string Name { get; init; } = "";
    public string Current { get; init; } = "-";
    public string Worst { get; init; } = "-";
    public string Threshold { get; init; } = "-";
    public string Raw { get; init; } = "-";
    public bool IsWarning { get; init; }
}

internal sealed class DiskDriveInfo
{
    public int Index { get; init; }
    public string Model { get; set; } = "Unknown";
    public string Firmware { get; set; } = "-";
    public string Serial { get; set; } = "-";
    public string Interface { get; set; } = "-";
    public string MediaType { get; set; } = "-";
    public string CapacityText { get; set; } = "-";
    public string DriveLetters { get; set; } = "-";
    public string Features { get; set; } = "-";
    public string TransferMode { get; set; } = "-";
    public string Standard { get; set; } = "-";

    public float? TemperatureC { get; set; }
    public DiskHealthLevel Health { get; set; } = DiskHealthLevel.Unknown;
    public string HealthDetail { get; set; } = "";

    public string PowerOnHours { get; set; } = "-";
    public string PowerOnCount { get; set; } = "-";
    public string HostWrites { get; set; } = "-";
    public string HostReads { get; set; } = "-";
    public string RotationRate { get; set; } = "-";
    public string UsedSpace { get; set; } = "-";

    public List<DiskSmartAttr> Attributes { get; } = new();

    /// <summary>具体故障点描述；无问题时为空（不提示「硬盘正常」）。</summary>
    public List<string> Problems { get; } = new();

    public bool HasProblems => Problems.Count > 0;
}

/// <summary>
/// 硬盘健康 / SMART 读取（LibreHardwareMonitor Storage + WMI 补充）。
/// 通过 LhmHub 共用 Computer，避免与 CPU 温度互相 Open/Close。
/// </summary>
internal static class DiskSmartReader
{
    private static readonly object Gate = new();

    public static List<DiskDriveInfo> Collect()
    {
        lock (Gate)
        {
            var map = new Dictionary<int, DiskDriveInfo>();

            EnrichFromWmi(map);
            EnrichFromLibreHardwareMonitor(map);

            foreach (var disk in map.Values)
                BuildProblems(disk);

            return map.Values
                .OrderBy(d => d.Index)
                .ToList();
        }
    }

    /// <summary>根据健康等级与告警属性生成可读的故障点列表。</summary>
    private static void BuildProblems(DiskDriveInfo disk)
    {
        disk.Problems.Clear();

        if (disk.Health is not (DiskHealthLevel.Caution or DiskHealthLevel.Bad))
        {
            // 温度过高也算问题点（即使整体仍标为良好）
            if (disk.TemperatureC is >= 65f)
                disk.Problems.Add(L.T(
                    $"温度过高：{disk.TemperatureC.Value:0} °C（建议加强散热，持续高温会加速老化）",
                    $"High temperature: {disk.TemperatureC.Value:0} °C (improve cooling; heat shortens lifespan)"));
            return;
        }

        foreach (var a in disk.Attributes.Where(x => x.IsWarning))
        {
            var detail = DescribeAttributeProblem(a);
            if (!string.IsNullOrWhiteSpace(detail) &&
                !disk.Problems.Contains(detail, StringComparer.Ordinal))
                disk.Problems.Add(detail);
        }

        if (disk.TemperatureC is >= 60f)
        {
            var tempMsg = L.T($"温度偏高：{disk.TemperatureC.Value:0} °C",
                $"Elevated temperature: {disk.TemperatureC.Value:0} °C");
            if (!disk.Problems.Any(p =>
                    p.Contains("温度", StringComparison.Ordinal) ||
                    p.Contains("Temperature", StringComparison.OrdinalIgnoreCase) ||
                    p.Contains("temperature", StringComparison.Ordinal)))
                disk.Problems.Add(tempMsg);
        }

        if (disk.Problems.Count == 0)
        {
            var fallback = string.IsNullOrWhiteSpace(disk.HealthDetail)
                ? (disk.Health == DiskHealthLevel.Bad
                    ? L.T("健康状态不良", "Health status: Bad")
                    : L.T("健康状态需注意", "Health status: Caution"))
                : disk.HealthDetail;
            disk.Problems.Add(fallback);
        }
    }

    private static string DescribeAttributeProblem(DiskSmartAttr a)
    {
        var name = string.IsNullOrWhiteSpace(a.Name) ? L.T("未知属性", "Unknown attribute") : a.Name;
        var id = string.IsNullOrWhiteSpace(a.Id) || a.Id == "-" ? "" : $"[{a.Id}] ";

        // 针对常见关键属性给出更具体的说明（中英属性名都匹配）
        var hint = name switch
        {
            "重映射扇区数" or "Reallocated Sectors Count" or "Reallocated Sector Count" =>
                L.T("已出现坏扇区并被重映射，磁盘可靠性下降",
                    "Bad sectors remapped; reliability reduced"),
            "当前待映射扇区数" or "Current Pending Sector Count" =>
                L.T("存在待处理坏扇区，读写可能出错",
                    "Pending bad sectors; I/O errors possible"),
            "不可纠正扇区数" or "Uncorrectable Sector Count" or "Offline Uncorrectable" =>
                L.T("存在无法纠正的扇区错误", "Uncorrectable sector errors present"),
            "重映射事件数" or "Reallocation Event Count" =>
                L.T("发生过扇区重映射事件", "Sector reallocation events occurred"),
            "原始读取错误率" or "Raw Read Error Rate" =>
                L.T("读取错误率异常", "Abnormal read error rate"),
            "UltraDMA CRC 错误数" or "UltraDMA CRC Error Count" =>
                L.T("数据线/接口传输校验错误偏多", "Cable/interface CRC errors elevated"),
            "介质错误" or "Media Errors" =>
                L.T("存储介质报告错误", "Storage media reported errors"),
            "可用备用空间" or "Available Spare" or "Available Reserved Space" =>
                L.T("备用空间不足，寿命或健康度告警",
                    "Spare space low; health/life warning"),
            "已使用百分比" or "Percentage Used" or "Percent Life Used" =>
                L.T("闪存损耗接近或达到警戒线", "Flash wear near or at threshold"),
            "严重警告" or "Critical Warning" =>
                L.T("控制器发出严重健康警告", "Controller critical health warning"),
            "不安全关机次数" or "Unsafe Shutdowns" =>
                L.T("非正常关机次数偏多，可能损坏文件系统",
                    "Many unsafe shutdowns; file system may be damaged"),
            _ => L.T("属性异常", "Attribute abnormal")
        };

        var raw = string.IsNullOrWhiteSpace(a.Raw) || a.Raw == "-"
            ? ""
            : L.T($"，原始值 {a.Raw}", $", raw {a.Raw}");
        var cur = string.IsNullOrWhiteSpace(a.Current) || a.Current == "-"
            ? ""
            : L.T($"，当前值 {a.Current}", $", current {a.Current}");
        return L.IsChinese
            ? $"{id}{name}：{hint}{cur}{raw}"
            : $"{id}{name}: {hint}{cur}{raw}";
    }

    private static void EnrichFromLibreHardwareMonitor(Dictionary<int, DiskDriveInfo> map)
    {
        // 与 CPU 温度共用同一 Computer，禁止单独 Open/Close（会破坏 WinRing0 / 各核温度）
        lock (LhmHub.Sync)
        {
            var computer = LhmHub.GetComputerUnlocked();
            if (computer is null)
                return;

            try
            {
                foreach (var hw in computer.Hardware)
                {
                    if (hw.HardwareType != HardwareType.Storage)
                        continue;

                    hw.Update();
                    if (hw is not AbstractStorage storage)
                        continue;

                    var disk = GetOrCreate(map, storage.Index);
                    if (!string.IsNullOrWhiteSpace(storage.Name))
                        disk.Model = storage.Name.Trim();
                    if (!string.IsNullOrWhiteSpace(storage.FirmwareRevision))
                        disk.Firmware = storage.FirmwareRevision.Trim();

                    try
                    {
                        var letters = storage.DriveInfos
                            .Select(d => d.Name.TrimEnd('\\'))
                            .Where(s => !string.IsNullOrWhiteSpace(s))
                            .Distinct(StringComparer.OrdinalIgnoreCase)
                            .OrderBy(s => s, StringComparer.OrdinalIgnoreCase)
                            .ToArray();
                        if (letters.Length > 0)
                            disk.DriveLetters = string.Join(" ", letters);
                    }
                    catch
                    {
                        // ignore
                    }

                    foreach (var sensor in hw.Sensors)
                    {
                        if (!sensor.Value.HasValue)
                            continue;

                        if (sensor.SensorType == SensorType.Temperature &&
                            (sensor.Name.Equals("Temperature", StringComparison.OrdinalIgnoreCase) ||
                             !disk.TemperatureC.HasValue))
                            disk.TemperatureC = sensor.Value.Value;

                        if (sensor.SensorType == SensorType.Load &&
                            sensor.Name.Contains("Used Space", StringComparison.OrdinalIgnoreCase))
                            disk.UsedSpace = $"{sensor.Value.Value:0.#}%";
                    }

                    if (hw is NVMeGeneric nvme)
                        FillNvme(disk, nvme);
                    else if (hw is AtaStorage ata)
                        FillAta(disk, ata);
                    else
                    {
                        disk.Features = L.T("有限信息（可能为 USB / 虚拟盘）", "Limited info (USB / virtual disk?)");
                        if (disk.Health == DiskHealthLevel.Unknown)
                            disk.Health = DiskHealthLevel.Unknown;
                    }
                }
            }
            catch
            {
                // WMI 已有基础信息时仍可展示；尝试恢复共享实例供后续 CPU 读温
                try
                {
                    LhmHub.RecoverComputerUnlocked();
                }
                catch
                {
                    // ignore
                }
            }
        }
    }

    private static void FillNvme(DiskDriveInfo disk, NVMeGeneric nvme)
    {
        disk.Interface = "NVM Express";
        disk.MediaType = "SSD (NVMe)";
        disk.RotationRate = "(SSD)";
        disk.Standard = "NVMe";
        disk.TransferMode = "PCIe / NVMe";
        disk.Features = "S.M.A.R.T., TRIM, VolatileWriteCache";

        try
        {
            var info = nvme.Smart.GetInfo();
            if (info != null)
            {
                if (!string.IsNullOrWhiteSpace(info.Model))
                    disk.Model = info.Model.Trim();
                if (!string.IsNullOrWhiteSpace(info.Serial))
                    disk.Serial = CleanSerial(info.Serial);
                if (!string.IsNullOrWhiteSpace(info.Revision))
                    disk.Firmware = info.Revision.Trim();
                if (info.TotalCapacity > 0)
                    disk.CapacityText = FormatBytes(info.TotalCapacity);
            }
        }
        catch
        {
            // ignore
        }

        NVMeHealthInfo? health = null;
        try
        {
            health = nvme.Smart.GetHealthInfo();
        }
        catch
        {
            // ignore
        }

        if (health is null)
        {
            disk.Attributes.Add(new DiskSmartAttr
            {
                Id = "-",
                Name = L.T("NVMe 健康信息", "NVMe health info"),
                Raw = L.T("不可用（请以管理员运行）", "Unavailable (run as administrator)")
            });
            return;
        }

        disk.TemperatureC ??= health.Temperature;
        disk.PowerOnHours = L.T($"{health.PowerOnHours:N0} 小时", $"{health.PowerOnHours:N0} hours");
        disk.PowerOnCount = L.T($"{health.PowerCycle:N0} 次", $"{health.PowerCycle:N0} cycles");
        // NVMe Data Unit = 1000 * 512 bytes ≈ 512 KB
        disk.HostWrites = FormatNvmeDataUnitsGb(health.DataUnitWritten);
        disk.HostReads = FormatNvmeDataUnitsGb(health.DataUnitRead);

        var warn = health.CriticalWarning.ToString();
        var hasCritical = (int)health.CriticalWarning != 0;
        var caution = hasCritical
                      || health.PercentageUsed >= 90
                      || health.AvailableSpare < health.AvailableSpareThreshold
                      || health.MediaErrors > 0
                      || health.UnsafeShutdowns > 50;
        var bad = health.AvailableSpare < health.AvailableSpareThreshold
                  || health.MediaErrors > 0
                  || health.PercentageUsed >= 100
                  || hasCritical;

        if (bad && (health.MediaErrors > 0 || health.AvailableSpare < health.AvailableSpareThreshold || health.PercentageUsed >= 100))
        {
            disk.Health = DiskHealthLevel.Bad;
            disk.HealthDetail = L.T(
                $"不良（{warn}，损耗 {health.PercentageUsed}%）",
                $"Bad ({warn}, wear {health.PercentageUsed}%)");
        }
        else if (caution)
        {
            disk.Health = DiskHealthLevel.Caution;
            disk.HealthDetail = L.T(
                $"注意（损耗 {health.PercentageUsed}%，备用空间 {health.AvailableSpare}%）",
                $"Caution (wear {health.PercentageUsed}%, spare {health.AvailableSpare}%)");
        }
        else
        {
            disk.Health = DiskHealthLevel.Good;
            disk.HealthDetail = L.T(
                $"良好（损耗 {health.PercentageUsed}%）",
                $"Good (wear {health.PercentageUsed}%)");
        }

        void Add(string id, string name, object? current, object? threshold, object? raw, bool warning = false)
        {
            disk.Attributes.Add(new DiskSmartAttr
            {
                Id = id,
                Name = name,
                Current = current?.ToString() ?? "-",
                Worst = "-",
                Threshold = threshold?.ToString() ?? "-",
                Raw = raw?.ToString() ?? "-",
                IsWarning = warning
            });
        }

        Add("01", L.T("严重警告", "Critical warning"), TranslateCriticalWarning(warn), L.T("无", "None"),
            TranslateCriticalWarning(warn), hasCritical);
        Add("02", L.T("温度", "Temperature"), $"{health.Temperature} °C", "-", $"{health.Temperature} °C");
        Add("03", L.T("可用备用空间", "Available spare"), $"{health.AvailableSpare} %", $"{health.AvailableSpareThreshold} %",
            $"{health.AvailableSpare} %",
            health.AvailableSpare < health.AvailableSpareThreshold);
        Add("04", L.T("已使用百分比", "Percentage used"), $"{health.PercentageUsed} %", "100 %",
            $"{health.PercentageUsed} %",
            health.PercentageUsed >= 90);
        Add("05", L.T("读取数据量", "Data units read"), "-", "-", FormatNvmeDataUnitsGb(health.DataUnitRead));
        Add("06", L.T("写入数据量", "Data units written"), "-", "-", FormatNvmeDataUnitsGb(health.DataUnitWritten));
        Add("07", L.T("主机读取命令", "Host read commands"), "-", "-", $"{health.HostReadCommands:N0}");
        Add("08", L.T("主机写入命令", "Host write commands"), "-", "-", $"{health.HostWriteCommands:N0}");
        Add("09", L.T("控制器繁忙时间", "Controller busy time"), "-", "-",
            L.T($"{health.ControllerBusyTime:N0} 分钟", $"{health.ControllerBusyTime:N0} min"));
        Add("0A", L.T("通电次数", "Power cycles"), "-", "-", $"{health.PowerCycle:N0}");
        Add("0B", L.T("通电时间", "Power-on hours"), "-", "-", $"{health.PowerOnHours:N0}");
        Add("0C", L.T("不安全关机次数", "Unsafe shutdowns"), "-", "-", $"{health.UnsafeShutdowns:N0}",
            health.UnsafeShutdowns > 50);
        Add("0D", L.T("介质错误", "Media errors"), "-", "-", $"{health.MediaErrors:N0}",
            health.MediaErrors > 0);
        Add("0E", L.T("错误日志条目", "Error log entries"), "-", "-", $"{health.ErrorInfoLogEntryCount:N0}");

        if (health.TemperatureSensors is { Length: > 0 })
        {
            for (var i = 0; i < health.TemperatureSensors.Length; i++)
            {
                var t = health.TemperatureSensors[i];
                if (t <= 0)
                    continue;
                Add($"T{i + 1}", L.T($"温度传感器 {i + 1}", $"Temp sensor {i + 1}"), $"{t} °C", "-", $"{t} °C");
            }
        }
    }

    private static string TranslateCriticalWarning(string warn)
    {
        if (string.IsNullOrWhiteSpace(warn) ||
            warn.Equals("None", StringComparison.OrdinalIgnoreCase) ||
            warn == "0")
            return L.T("无", "None");

        if (!L.IsChinese)
            return warn;

        return warn
            .Replace("AvailableSpace", "可用空间不足", StringComparison.OrdinalIgnoreCase)
            .Replace("Temperature", "温度异常", StringComparison.OrdinalIgnoreCase)
            .Replace("Reliability", "可靠性下降", StringComparison.OrdinalIgnoreCase)
            .Replace("ReadOnly", "只读", StringComparison.OrdinalIgnoreCase)
            .Replace("VolatileMemoryBackup", "易失性备份失败", StringComparison.OrdinalIgnoreCase);
    }

    private static void FillAta(DiskDriveInfo disk, AtaStorage ata)
    {
        disk.Interface = string.IsNullOrWhiteSpace(disk.Interface) || disk.Interface == "-"
            ? "Serial ATA"
            : disk.Interface;
        if (disk.MediaType == "-" || disk.MediaType.Contains("Fixed", StringComparison.OrdinalIgnoreCase))
            disk.MediaType = disk.Model.Contains("SSD", StringComparison.OrdinalIgnoreCase) ? "SSD" : "HDD";

        // 转速：SSD 固定显示；HDD 保留 WMI SpindleSpeed，否则从 LHM Identify 报告解析
        if (disk.MediaType.Contains("SSD", StringComparison.OrdinalIgnoreCase))
        {
            disk.RotationRate = "(SSD)";
        }
        else if (!IsKnownRotation(disk.RotationRate))
        {
            try
            {
                var parsed = TryParseRotationFromReport(ata.GetReport());
                if (!string.IsNullOrWhiteSpace(parsed))
                    disk.RotationRate = parsed!;
            }
            catch
            {
                // ignore
            }

            if (!IsKnownRotation(disk.RotationRate))
                disk.RotationRate = "-";
        }

        disk.Features = "S.M.A.R.T., AAM/APM, NCQ";
        disk.Standard = "ATA / ACS";
        disk.TransferMode = "SATA";

        if (!ata.Smart.IsValid)
        {
            try
            {
                ata.Smart.EnableSmart();
            }
            catch
            {
                // ignore
            }
        }

        if (!ata.Smart.IsValid)
        {
            disk.Attributes.Add(new DiskSmartAttr
            {
                Id = "-",
                Name = "S.M.A.R.T.",
                Raw = L.T("不可用（请以管理员运行或盘不支持）",
                    "Unavailable (run as administrator or unsupported)")
            });
            return;
        }

        dynamic? attrs = null;
        dynamic? thresholds = null;
        try
        {
            attrs = ata.Smart.ReadSmartData();
            thresholds = ata.Smart.ReadSmartThresholds();
        }
        catch
        {
            // ignore
        }

        var thMap = new Dictionary<byte, byte>();
        if (thresholds != null)
        {
            foreach (var t in thresholds)
            {
                byte id = (byte)t.Id;
                if (id != 0)
                    thMap[id] = (byte)t.Threshold;
            }
        }

        var anyFail = false;
        var anyWarn = false;

        if (attrs != null)
        {
            foreach (var a in attrs)
            {
                byte id = (byte)a.Id;
                if (id == 0)
                    continue;

                var def = ata.SmartAttributes.FirstOrDefault(x => x.Id == id);
                var name = TranslateSmartName(def?.Name ?? L.T($"属性 0x{id:X2}", $"Attribute 0x{id:X2}"));
                thMap.TryGetValue(id, out var th);
                byte[] rawBytes = (byte[])a.RawValue;
                var rawNum = RawToUInt64(rawBytes);
                var rawText = FormatAtaRaw(id, rawBytes, rawNum);

                byte current = (byte)a.CurrentValue;
                byte worst = (byte)a.WorstValue;
                var fail = th > 0 && current > 0 && current <= th;
                if (fail)
                    anyFail = true;

                if ((id is 0x05 or 0xC5 or 0xC6 or 0xC4) && rawNum > 0)
                    anyWarn = true;

                disk.Attributes.Add(new DiskSmartAttr
                {
                    Id = id.ToString("X2"),
                    Name = name,
                    Current = current.ToString(CultureInfo.InvariantCulture),
                    Worst = worst.ToString(CultureInfo.InvariantCulture),
                    Threshold = th > 0 ? th.ToString(CultureInfo.InvariantCulture) : "-",
                    Raw = rawText,
                    IsWarning = fail || ((id is 0x05 or 0xC5 or 0xC6) && rawNum > 0)
                });

                switch (id)
                {
                    case 0x09:
                        disk.PowerOnHours = L.T($"{rawNum:N0} 小时", $"{rawNum:N0} hours");
                        break;
                    case 0x0C:
                        disk.PowerOnCount = L.T($"{rawNum:N0} 次", $"{rawNum:N0} cycles");
                        break;
                    case 0xC2:
                    case 0xE7:
                    case 0xBE:
                        if (rawBytes.Length > 0)
                            disk.TemperatureC ??= rawBytes[0];
                        break;
                    case 0xF1:
                    case 0xF5:
                        disk.HostWrites = L.T($"{rawNum:N0} (原始计数)", $"{rawNum:N0} (raw count)");
                        break;
                    case 0xF2:
                        disk.HostReads = L.T($"{rawNum:N0} (原始计数)", $"{rawNum:N0} (raw count)");
                        break;
                }
            }
        }

        // 部分厂商 SSD 有 Host Writes 传感器
        foreach (var sensor in ata.Sensors)
        {
            if (sensor.SensorType == SensorType.Data &&
                sensor.Name.Contains("Written", StringComparison.OrdinalIgnoreCase) &&
                sensor.Value.HasValue)
                disk.HostWrites = $"{sensor.Value.Value:0.#} GB";
            if (sensor.SensorType == SensorType.Data &&
                sensor.Name.Contains("Read", StringComparison.OrdinalIgnoreCase) &&
                sensor.Value.HasValue)
                disk.HostReads = $"{sensor.Value.Value:0.#} GB";
        }

        if (anyFail)
        {
            disk.Health = DiskHealthLevel.Bad;
            disk.HealthDetail = L.T("不良（存在低于阈值的属性）", "Bad (attribute below threshold)");
        }
        else if (anyWarn)
        {
            disk.Health = DiskHealthLevel.Caution;
            disk.HealthDetail = L.T("注意（存在重映射/待处理扇区）", "Caution (reallocated/pending sectors)");
        }
        else
        {
            disk.Health = DiskHealthLevel.Good;
            disk.HealthDetail = L.T("良好", "Good");
        }
    }

    private static void EnrichFromWmi(Dictionary<int, DiskDriveInfo> map)
    {
        try
        {
            foreach (var row in Query(@"root\CIMV2",
                         "SELECT Index, Model, Size, InterfaceType, SerialNumber, FirmwareRevision, MediaType, Partitions FROM Win32_DiskDrive"))
            {
                if (!TryInt(row, "Index", out var index))
                    continue;

                var disk = GetOrCreate(map, index);
                var model = Str(row, "Model");
                if (!string.IsNullOrWhiteSpace(model))
                    disk.Model = model.Trim();

                var serial = CleanSerial(Str(row, "SerialNumber"));
                if (!string.IsNullOrWhiteSpace(serial) && serial != "-")
                    disk.Serial = serial;

                var fw = Str(row, "FirmwareRevision");
                if (!string.IsNullOrWhiteSpace(fw))
                    disk.Firmware = fw.Trim();

                var iface = Str(row, "InterfaceType");
                if (!string.IsNullOrWhiteSpace(iface))
                    disk.Interface = iface;

                var media = Str(row, "MediaType");
                if (!string.IsNullOrWhiteSpace(media))
                    disk.MediaType = media;

                if (TryUlong(row, "Size", out var size) && size > 0)
                    disk.CapacityText = FormatBytes(size);

                disk.DriveLetters = ResolveDriveLetters(index);
            }
        }
        catch
        {
            // ignore
        }

        try
        {
            foreach (var row in Query(@"root\Microsoft\Windows\Storage",
                         "SELECT DeviceId, FriendlyName, SerialNumber, FirmwareVersion, BusType, MediaType, HealthStatus, Size, SpindleSpeed FROM MSFT_PhysicalDisk"))
            {
                if (!TryInt(row, "DeviceId", out var index))
                    continue;

                var disk = GetOrCreate(map, index);
                var name = Str(row, "FriendlyName");
                if (!string.IsNullOrWhiteSpace(name))
                    disk.Model = name.Trim();

                var serial = CleanSerial(Str(row, "SerialNumber"));
                if (!string.IsNullOrWhiteSpace(serial) && serial != "-")
                    disk.Serial = serial;

                var fw = Str(row, "FirmwareVersion");
                if (!string.IsNullOrWhiteSpace(fw))
                    disk.Firmware = fw.Trim();

                if (TryUlong(row, "Size", out var size) && size > 0)
                    disk.CapacityText = FormatBytes(size);

                if (TryInt(row, "BusType", out var bus))
                {
                    disk.Interface = bus switch
                    {
                        7 => "Serial ATA",
                        8 => "SAS",
                        9 => "SATA",
                        11 => "SCSI",
                        17 => "NVM Express",
                        _ => disk.Interface == "-" ? $"BusType {bus}" : disk.Interface
                    };
                    if (bus == 17)
                    {
                        disk.Standard = "NVMe";
                        disk.TransferMode = "PCIe / NVMe";
                    }
                    else if (bus is 7 or 9)
                    {
                        disk.Standard = "ATA / ACS";
                        disk.TransferMode = "SATA";
                    }
                }

                var mediaTypeCode = -1;
                if (TryInt(row, "MediaType", out var media))
                {
                    mediaTypeCode = media;
                    disk.MediaType = media switch
                    {
                        3 => "HDD",
                        4 => "SSD",
                        5 => "SCM",
                        _ => disk.MediaType
                    };
                }

                // SpindleSpeed：HDD 为转速（如 7200）；SSD 通常为 0
                if (TryInt(row, "SpindleSpeed", out var spindle) && spindle >= 1000)
                    disk.RotationRate = $"{spindle} RPM";
                else if (mediaTypeCode == 4 || spindle is 0 or 1)
                    disk.RotationRate = mediaTypeCode == 4 || spindle == 1
                        ? "(SSD)"
                        : disk.RotationRate;

                if (TryInt(row, "HealthStatus", out var hs) && disk.Health == DiskHealthLevel.Unknown)
                {
                    disk.Health = hs switch
                    {
                        0 => DiskHealthLevel.Good,
                        1 => DiskHealthLevel.Caution,
                        2 => DiskHealthLevel.Bad,
                        _ => DiskHealthLevel.Unknown
                    };
                    disk.HealthDetail = disk.Health switch
                    {
                        DiskHealthLevel.Good => L.T("良好", "Good"),
                        DiskHealthLevel.Caution => L.T("注意", "Caution"),
                        DiskHealthLevel.Bad => L.T("不良", "Bad"),
                        _ => L.T("未知", "Unknown")
                    };
                }
            }
        }
        catch
        {
            // ignore
        }
    }

    private static string ResolveDriveLetters(int diskIndex)
    {
        try
        {
            var letters = new List<string>();
            foreach (var link in Query(@"root\CIMV2",
                         "SELECT Antecedent, Dependent FROM Win32_DiskDriveToDiskPartition"))
            {
                var ante = Str(link, "Antecedent");
                if (!ante.Contains($"PHYSICALDRIVE{diskIndex}", StringComparison.OrdinalIgnoreCase) &&
                    !ante.Contains($"DeviceID=\\\"\\\\\\\\.\\\\PHYSICALDRIVE{diskIndex}\\\"", StringComparison.OrdinalIgnoreCase) &&
                    !ante.Contains($"PHYSICALDRIVE{diskIndex}", StringComparison.OrdinalIgnoreCase))
                {
                    // WMI 关联字符串形如: Win32_DiskDrive.DeviceID="\\\\.\\PHYSICALDRIVE0"
                    if (!ante.Contains($"PHYSICALDRIVE{diskIndex}", StringComparison.OrdinalIgnoreCase))
                        continue;
                }

                var partition = Str(link, "Dependent");
                foreach (var logic in Query(@"root\CIMV2",
                             "SELECT Antecedent, Dependent FROM Win32_LogicalDiskToPartition"))
                {
                    if (!Str(logic, "Antecedent").Equals(partition, StringComparison.OrdinalIgnoreCase) &&
                        !Str(logic, "Antecedent").Contains(ExtractDeviceId(partition), StringComparison.OrdinalIgnoreCase))
                        continue;

                    var dep = Str(logic, "Dependent");
                    var letter = ExtractDeviceId(dep);
                    if (letter.Length >= 2 && letter[1] == ':')
                        letters.Add(letter[..2]);
                }
            }

            letters = letters.Distinct(StringComparer.OrdinalIgnoreCase)
                .OrderBy(x => x, StringComparer.OrdinalIgnoreCase)
                .ToList();
            return letters.Count > 0 ? string.Join(" ", letters) : "-";
        }
        catch
        {
            return "-";
        }
    }

    private static string ExtractDeviceId(string wmiPath)
    {
        // ...DeviceID="C:" 或 DeviceID="Disk #0, Partition #1"
        var key = "DeviceID=";
        var i = wmiPath.IndexOf(key, StringComparison.OrdinalIgnoreCase);
        if (i < 0)
            return wmiPath;
        var rest = wmiPath[(i + key.Length)..].Trim().Trim('"');
        return rest.TrimEnd('"');
    }

    private static DiskDriveInfo GetOrCreate(Dictionary<int, DiskDriveInfo> map, int index)
    {
        if (!map.TryGetValue(index, out var disk))
        {
            disk = new DiskDriveInfo
            {
                Index = index,
                Model = L.T("未知磁盘", "Unknown disk")
            };
            map[index] = disk;
        }

        return disk;
    }

    private static bool IsKnownRotation(string? value) =>
        !string.IsNullOrWhiteSpace(value) &&
        value != "-" &&
        (value.Contains("RPM", StringComparison.OrdinalIgnoreCase) ||
         value.Contains("SSD", StringComparison.OrdinalIgnoreCase));

    /// <summary>从 LibreHardwareMonitor Identify/报告中解析标称转速。</summary>
    private static string? TryParseRotationFromReport(string? report)
    {
        if (string.IsNullOrWhiteSpace(report))
            return null;

        foreach (var rawLine in report.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries))
        {
            var line = rawLine.Trim();
            if (line.Length == 0)
                continue;

            var isRotationLine =
                line.Contains("Nominal Media Rotation Rate", StringComparison.OrdinalIgnoreCase) ||
                line.Contains("Rotation Rate", StringComparison.OrdinalIgnoreCase) ||
                line.Contains("Rotational Rate", StringComparison.OrdinalIgnoreCase) ||
                line.Contains("转速", StringComparison.Ordinal);

            if (!isRotationLine)
                continue;

            if (line.Contains("Solid State", StringComparison.OrdinalIgnoreCase) ||
                line.Contains("Non-rotating", StringComparison.OrdinalIgnoreCase) ||
                line.Contains("Non rotating", StringComparison.OrdinalIgnoreCase) ||
                line.Contains("SSD", StringComparison.OrdinalIgnoreCase))
                return "(SSD)";

            // 提取 3600 / 5400 / 7200 / 10000 / 15000 等
            for (var i = 0; i < line.Length; i++)
            {
                if (!char.IsDigit(line[i]))
                    continue;
                var j = i;
                while (j < line.Length && char.IsDigit(line[j]))
                    j++;
                if (j > i && int.TryParse(line[i..j], out var rpm) && rpm is >= 1000 and <= 20000)
                    return $"{rpm} RPM";
                i = j;
            }
        }

        return null;
    }

    private static string TranslateSmartName(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
            return L.T("未知属性", "Unknown attribute");

        // 已是中文则原样返回
        if (name.Any(c => c is >= '\u4e00' and <= '\u9fff'))
            return name;

        var trimmed = name.Trim();
        // 英文界面保留英文 SMART 名
        if (!L.IsChinese)
            return trimmed;

        return trimmed switch
        {
            "Raw Read Error Rate" => "原始读取错误率",
            "Throughput Performance" => "吞吐性能",
            "Spin-Up Time" or "Spin Up Time" => "起转时间",
            "Start/Stop Count" => "启动/停止次数",
            "Reallocated Sectors Count" or "Reallocated Sector Count" => "重映射扇区数",
            "Read Channel Margin" => "读通道裕量",
            "Seek Error Rate" => "寻道错误率",
            "Seek Time Performance" => "寻道时间性能",
            "Power-On Hours" or "Power-On Hours Count" => "通电时间",
            "Spin Retry Count" => "起转重试次数",
            "Calibration Retry Count" => "校准重试次数",
            "Power Cycle Count" => "通电次数",
            "Soft Read Error Rate" => "软读取错误率",
            "Current Helium Level" => "当前氦气水平",
            "Available Reserved Space" or "Available Spare" => "可用备用空间",
            "SSD Wear Leveling Count" or "Wear Leveling Count" => "磨损均衡计数",
            "Used Reserved Block Count Total" => "已用保留块总数",
            "Unused Reserved Block Count Total" => "未用保留块总数",
            "Program Fail Count" or "Program Fail Count (Total)" => "编程失败次数",
            "Erase Fail Count" or "Erase Fail Count (Total)" => "擦除失败次数",
            "Runtime Bad Block" => "运行时坏块",
            "End-to-End Error" or "End-to-End Error Detection Count" => "端到端错误",
            "Reported Uncorrectable Errors" => "不可纠正错误报告",
            "Command Timeout" => "命令超时",
            "High Fly Writes" => "高飞写入",
            "Airflow Temperature" or "Airflow Temperature Cel" => "气流温度",
            "G-Sense Error Rate" => "冲击感应错误率",
            "Power-Off Retract Count" => "断电回缩次数",
            "Load/Unload Cycle Count" or "Load Cycle Count" => "加载循环次数",
            "Temperature" or "Temperature Celsius" => "温度",
            "Hardware ECC Recovered" => "硬件 ECC 恢复",
            "Reallocation Event Count" => "重映射事件数",
            "Current Pending Sector Count" => "当前待映射扇区数",
            "Uncorrectable Sector Count" or "Offline Uncorrectable" => "不可纠正扇区数",
            "UltraDMA CRC Error Count" => "UltraDMA CRC 错误数",
            "Multi-Zone Error Rate" or "Write Error Rate" => "多区/写入错误率",
            "Soft ECC Correction" => "软 ECC 纠正",
            "Data Address Mark Errors" => "数据地址标记错误",
            "Total LBAs Written" or "Host Writes" => "主机写入总量",
            "Total LBAs Read" or "Host Reads" => "主机读取总量",
            "NAND Writes" => "NAND 写入量",
            "Remaining Life" or "Media Wearout Indicator" => "剩余寿命",
            "Percentage Used" or "Percent Life Used" => "已使用百分比",
            "S.M.A.R.T." => "S.M.A.R.T.",
            _ => trimmed
        };
    }

    private static string FormatNvmeDataUnitsGb(ulong dataUnits)
    {
        // NVMe：1 Data Unit = 1000 × 512 bytes = 512_000 bytes
        var bytes = dataUnits * 512_000d;
        return FormatBytes((ulong)bytes);
    }

    private static string FormatBytes(ulong bytes)
    {
        if (bytes >= 1024UL * 1024 * 1024 * 1024)
            return $"{bytes / (1024d * 1024 * 1024 * 1024):0.##} TB";
        if (bytes >= 1024UL * 1024 * 1024)
            return $"{bytes / (1024d * 1024 * 1024):0.##} GB";
        if (bytes >= 1024UL * 1024)
            return $"{bytes / (1024d * 1024):0.##} MB";
        return $"{bytes} B";
    }

    private static string CleanSerial(string serial)
    {
        if (string.IsNullOrWhiteSpace(serial))
            return "-";
        var s = serial.Replace("_", "").Trim().TrimEnd('.');
        return string.IsNullOrWhiteSpace(s) ? "-" : s;
    }

    private static ulong RawToUInt64(byte[] raw)
    {
        if (raw is null || raw.Length == 0)
            return 0;
        ulong v = 0;
        var n = Math.Min(raw.Length, 6);
        for (var i = 0; i < n; i++)
            v |= (ulong)raw[i] << (8 * i);
        return v;
    }

    private static string FormatAtaRaw(byte id, byte[] raw, ulong rawNum)
    {
        if (raw is null || raw.Length == 0)
            return "-";

        if (id is 0x09 or 0x0C or 0x04 or 0x05 or 0xC5 or 0xC6 or 0xF1 or 0xF2)
            return rawNum.ToString("N0", CultureInfo.InvariantCulture);

        if (id is 0xC2 or 0xE7 or 0xBE)
            return $"{raw[0]} °C";

        var sb = new StringBuilder();
        foreach (var b in raw)
            sb.Append(b.ToString("X2"));
        return sb.ToString();
    }

    private static IEnumerable<Dictionary<string, object?>> Query(string ns, string wql)
    {
        object? resultsObj;
        try
        {
            var locatorType = Type.GetTypeFromProgID("WbemScripting.SWbemLocator");
            if (locatorType is null)
                yield break;

            dynamic locator = Activator.CreateInstance(locatorType)!;
            dynamic services = locator.ConnectServer(".", ns);
            resultsObj = services.ExecQuery(wql);
        }
        catch
        {
            yield break;
        }

        dynamic results = resultsObj!;
        foreach (dynamic obj in results)
        {
            var row = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
            try
            {
                foreach (dynamic prop in obj.Properties_)
                {
                    try
                    {
                        row[Convert.ToString(prop.Name) ?? ""] = prop.Value;
                    }
                    catch
                    {
                        // ignore property
                    }
                }
            }
            catch
            {
                continue;
            }

            yield return row;
        }
    }

    private static string Str(Dictionary<string, object?> row, string key)
    {
        if (!row.TryGetValue(key, out var v) || v is null)
            return "";
        return Convert.ToString(v)?.Trim() ?? "";
    }

    private static bool TryInt(Dictionary<string, object?> row, string key, out int value)
    {
        value = 0;
        if (!row.TryGetValue(key, out var v) || v is null)
            return false;
        try
        {
            value = Convert.ToInt32(v);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static bool TryUlong(Dictionary<string, object?> row, string key, out ulong value)
    {
        value = 0;
        if (!row.TryGetValue(key, out var v) || v is null)
            return false;
        try
        {
            value = Convert.ToUInt64(v);
            return true;
        }
        catch
        {
            return false;
        }
    }
}
