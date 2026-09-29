namespace MemWatch;

/// <summary>通过 WMI 读取本机硬件配置（COM，无额外 NuGet）。</summary>
internal static class HwInfoReader
{
    [ThreadStatic]
    private static IReadOnlyList<(string Name, float Celsius)>? _snapCpuTemps;

    [ThreadStatic]
    private static IReadOnlyList<(string Name, float Celsius)>? _snapGpuTemps;

    [ThreadStatic]
    private static CpuTempReader.CpuClockSnapshot _snapClocks;

    public static List<HwSection> Collect()
    {
        // 一次加锁取完整快照，避免主界面定时读温穿插导致各核列表被冲掉
        var (cpuTemps, gpuTemps, clocks) = CpuTempReader.TakeFullSnapshot();
        _snapCpuTemps = cpuTemps;
        _snapGpuTemps = gpuTemps;
        _snapClocks = clocks;

        try
        {
            var sections = new List<HwSection>();

            sections.Add(ReadSystem());
            sections.Add(ReadOs());
            sections.Add(ReadCpu());
            sections.Add(ReadMotherboard());
            sections.Add(ReadBios());
            sections.Add(ReadMemory());
            sections.Add(ReadGpu());
            sections.Add(ReadStorage());
            sections.Add(ReadVolumes());
            sections.Add(ReadNetwork());

            return sections;
        }
        finally
        {
            _snapCpuTemps = null;
            _snapGpuTemps = null;
            _snapClocks = default;
        }
    }

    private static HwSection ReadSystem()
    {
        var s = new HwSection(L.T("系统", "System"));
        try
        {
            foreach (var row in Query(@"root\CIMV2",
                         "SELECT Manufacturer, Model, SystemType, TotalPhysicalMemory, UserName, Name FROM Win32_ComputerSystem"))
            {
                s.Items.Add((L.T("制造商", "Manufacturer"), Str(row, "Manufacturer")));
                s.Items.Add((L.T("型号", "Model"), Str(row, "Model")));
                s.Items.Add((L.T("系统类型", "System type"), Str(row, "SystemType")));
                s.Items.Add((L.T("计算机名", "Computer name"), Str(row, "Name")));
                s.Items.Add((L.T("当前用户", "Current user"), Str(row, "UserName")));
                if (TryUlong(row, "TotalPhysicalMemory", out var bytes))
                    s.Items.Add((L.T("物理内存总量", "Total physical memory"), FormatBytes(bytes)));
            }
        }
        catch (Exception ex)
        {
            s.Items.Add((L.T("错误", "Error"), ex.Message));
        }

        if (s.Items.Count == 0)
            s.Items.Add((L.T("信息", "Info"), L.T("无法读取", "Unavailable")));
        return s;
    }

    private static HwSection ReadOs()
    {
        var s = new HwSection(L.T("操作系统", "Operating system"));
        try
        {
            foreach (var row in Query(@"root\CIMV2",
                         "SELECT Caption, Version, BuildNumber, OSArchitecture, InstallDate, LastBootUpTime, RegisteredUser FROM Win32_OperatingSystem"))
            {
                s.Items.Add((L.T("名称", "Name"), Str(row, "Caption")));
                s.Items.Add((L.T("版本", "Version"), Str(row, "Version")));
                s.Items.Add((L.T("内部版本", "Build"), Str(row, "BuildNumber")));
                s.Items.Add((L.T("架构", "Architecture"), Str(row, "OSArchitecture")));
                s.Items.Add((L.T("注册用户", "Registered user"), Str(row, "RegisteredUser")));
                s.Items.Add((L.T("安装时间", "Install date"), FormatWmiDate(Str(row, "InstallDate"))));
                s.Items.Add((L.T("上次启动", "Last boot"), FormatWmiDate(Str(row, "LastBootUpTime"))));
            }
        }
        catch (Exception ex)
        {
            s.Items.Add((L.T("错误", "Error"), ex.Message));
        }

        if (s.Items.Count == 0)
            s.Items.Add((L.T("信息", "Info"), L.T("无法读取", "Unavailable")));
        return s;
    }

    private static HwSection ReadCpu()
    {
        var s = new HwSection(L.T("处理器 (CPU)", "Processor (CPU)"));
        try
        {
            var index = 0;
            foreach (var row in Query(@"root\CIMV2",
                         "SELECT Name, Manufacturer, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed, CurrentClockSpeed, L2CacheSize, L3CacheSize, SocketDesignation FROM Win32_Processor"))
            {
                index++;
                var prefix = index > 1 ? $"CPU{index} · " : "";
                s.Items.Add((prefix + L.T("名称", "Name"), Str(row, "Name")));
                s.Items.Add((prefix + L.T("制造商", "Manufacturer"), Str(row, "Manufacturer")));
                s.Items.Add((prefix + L.T("插槽", "Socket"), Str(row, "SocketDesignation")));
                s.Items.Add((prefix + L.T("核心数", "Cores"), Str(row, "NumberOfCores")));
                s.Items.Add((prefix + L.T("逻辑处理器", "Logical processors"), Str(row, "NumberOfLogicalProcessors")));

                // WMI MaxClockSpeed 实际是基础频率；CurrentClockSpeed 在新 U 上常卡死不动。
                // 睿频/实时核频改走 LibreHardwareMonitor。
                if (TryUint(row, "MaxClockSpeed", out var baseMhz) && baseMhz > 0)
                    s.Items.Add((prefix + L.T("基础频率", "Base clock"), $"{baseMhz} MHz"));

                if (index == 1)
                    AppendCpuClocks(s, prefix);

                // Win32_Processor 没有 L1；从 Win32_CacheMemory（Level=3 Primary）汇总
                if (index == 1)
                {
                    var l1 = SumCpuCacheKb(level: 3);
                    if (l1 > 0)
                        s.Items.Add((prefix + L.T("L1 缓存", "L1 cache"), $"{l1} KB"));
                }

                if (TryUint(row, "L2CacheSize", out var l2) && l2 > 0)
                    s.Items.Add((prefix + L.T("L2 缓存", "L2 cache"), $"{l2} KB"));
                if (TryUint(row, "L3CacheSize", out var l3) && l3 > 0)
                    s.Items.Add((prefix + L.T("L3 缓存", "L3 cache"), $"{l3} KB"));
            }

            var temps = _snapCpuTemps ?? CpuTempReader.TryReadAllCelsius();
            AppendCpuTemps(s, temps);
        }
        catch (Exception ex)
        {
            s.Items.Add((L.T("错误", "Error"), ex.Message));
        }

        if (s.Items.Count == 0)
            s.Items.Add((L.T("信息", "Info"), L.T("无法读取", "Unavailable")));
        return s;
    }

    private static void AppendCpuTemps(HwSection s, IReadOnlyList<(string Name, float Celsius)> temps)
    {
        if (temps.Count == 1)
        {
            s.Items.Add((L.T("温度", "Temperature"),
                L.T($"{temps[0].Celsius:0.#} °C（{temps[0].Name}）",
                    $"{temps[0].Celsius:0.#} °C ({temps[0].Name})")));
            return;
        }

        if (temps.Count > 1)
        {
            s.Items.Add((L.T("温度点数", "Temp sensors"), temps.Count.ToString()));
            if (!CpuTempReader.IsRunningAsAdmin())
                s.Items.Add((L.T("提示", "Note"), L.T(
                    "未以管理员运行时，可能只能读到主板热区（会偏低）。请右键「以管理员身份运行」以对齐 Core Temp。",
                    "Without admin rights, only motherboard thermal zones may be available (often lower). Run as administrator for core temps.")));

            var i = 0;
            foreach (var (name, c) in temps)
            {
                i++;
                var label = name.Contains("Core", StringComparison.OrdinalIgnoreCase) ||
                            name.Contains("Package", StringComparison.OrdinalIgnoreCase) ||
                            name.Contains("核", StringComparison.OrdinalIgnoreCase)
                    ? name
                    : L.T($"温度{i} · {name}", $"Temp {i} · {name}");
                s.Items.Add((label, $"{c:0.#} °C"));
            }

            return;
        }

        s.Items.Add((L.T("温度", "Temperature"), CpuTempReader.IsRunningAsAdmin()
            ? L.T("不可用", "Unavailable")
            : L.T("不可用（请以管理员身份运行以读取 CPU 核心温度）",
                "Unavailable (run as administrator for CPU core temps)")));
    }

    private static void AppendCpuClocks(HwSection s, string prefix)
    {
        var clocks = _snapCpuTemps is not null ? _snapClocks : CpuTempReader.TryReadCpuClocks();
        if (clocks.AverageMhz is float avg && avg > 0)
            s.Items.Add((prefix + L.T("当前频率", "Current clock"),
                L.T($"{avg:0} MHz（各核平均）", $"{avg:0} MHz (core average)")));
        else
            s.Items.Add((prefix + L.T("当前频率", "Current clock"), CpuTempReader.IsRunningAsAdmin()
                ? L.T("不可用", "Unavailable")
                : L.T("不可用（请以管理员身份运行）", "Unavailable (run as administrator)")));

        if (clocks.MaxCoreMhz is float max && max > 0)
            s.Items.Add((prefix + L.T("当前最高核频", "Max core clock"), $"{max:0} MHz"));

        if (clocks.BusMhz is float bus && bus > 0)
            s.Items.Add((prefix + L.T("总线频率", "Bus clock"), $"{bus:0.#} MHz"));
    }

    private static HwSection ReadMotherboard()
    {
        var s = new HwSection(L.T("主板", "Motherboard"));
        try
        {
            foreach (var row in Query(@"root\CIMV2",
                         "SELECT Manufacturer, Product, Version, SerialNumber FROM Win32_BaseBoard"))
            {
                s.Items.Add((L.T("制造商", "Manufacturer"), Str(row, "Manufacturer")));
                s.Items.Add((L.T("型号", "Model"), Str(row, "Product")));
                s.Items.Add((L.T("版本", "Version"), Str(row, "Version")));
                s.Items.Add((L.T("序列号", "Serial number"), Str(row, "SerialNumber")));
            }
        }
        catch (Exception ex)
        {
            s.Items.Add((L.T("错误", "Error"), ex.Message));
        }

        if (s.Items.Count == 0)
            s.Items.Add((L.T("信息", "Info"), L.T("无法读取", "Unavailable")));
        return s;
    }

    private static HwSection ReadBios()
    {
        var s = new HwSection("BIOS");
        try
        {
            foreach (var row in Query(@"root\CIMV2",
                         "SELECT Manufacturer, SMBIOSBIOSVersion, ReleaseDate, SerialNumber FROM Win32_BIOS"))
            {
                s.Items.Add((L.T("制造商", "Manufacturer"), Str(row, "Manufacturer")));
                s.Items.Add((L.T("版本", "Version"), Str(row, "SMBIOSBIOSVersion")));
                s.Items.Add((L.T("发布日期", "Release date"), FormatWmiDate(Str(row, "ReleaseDate"))));
                s.Items.Add((L.T("序列号", "Serial number"), Str(row, "SerialNumber")));
            }
        }
        catch (Exception ex)
        {
            s.Items.Add((L.T("错误", "Error"), ex.Message));
        }

        if (s.Items.Count == 0)
            s.Items.Add((L.T("信息", "Info"), L.T("无法读取", "Unavailable")));
        return s;
    }

    private static HwSection ReadMemory()
    {
        var s = new HwSection(L.T("内存", "Memory"));
        try
        {
            var stick = 0;
            ulong total = 0;
            foreach (var row in Query(@"root\CIMV2",
                         "SELECT Capacity, Speed, Manufacturer, PartNumber, ConfiguredClockSpeed, DeviceLocator, MemoryType, FormFactor FROM Win32_PhysicalMemory"))
            {
                stick++;
                var prefix = L.T($"插槽{stick} · ", $"Slot {stick} · ");
                if (TryUlong(row, "Capacity", out var cap))
                {
                    total += cap;
                    s.Items.Add((prefix + L.T("容量", "Capacity"), FormatBytes(cap)));
                }

                var speed = Str(row, "ConfiguredClockSpeed");
                if (string.IsNullOrWhiteSpace(speed) || speed == "0")
                    speed = Str(row, "Speed");
                if (!string.IsNullOrWhiteSpace(speed) && speed != "0")
                    s.Items.Add((prefix + L.T("频率", "Speed"), $"{speed} MHz"));

                s.Items.Add((prefix + L.T("制造商", "Manufacturer"), Str(row, "Manufacturer")));
                s.Items.Add((prefix + L.T("型号", "Part number"), Str(row, "PartNumber").Trim()));
                s.Items.Add((prefix + L.T("位置", "Locator"), Str(row, "DeviceLocator")));
            }

            if (total > 0)
                s.Items.Insert(0, (L.T("合计容量", "Total capacity"), FormatBytes(total)));
            if (stick > 0)
                s.Items.Insert(total > 0 ? 1 : 0, (L.T("内存条数", "Modules"), stick.ToString()));
        }
        catch (Exception ex)
        {
            s.Items.Add((L.T("错误", "Error"), ex.Message));
        }

        if (s.Items.Count == 0)
            s.Items.Add((L.T("信息", "Info"), L.T("无法读取", "Unavailable")));
        return s;
    }

    private static HwSection ReadGpu()
    {
        var s = new HwSection(L.T("显卡", "Graphics"));
        try
        {
            var index = 0;
            foreach (var row in Query(@"root\CIMV2",
                         "SELECT Name, AdapterRAM, DriverVersion, VideoProcessor, VideoModeDescription, CurrentHorizontalResolution, CurrentVerticalResolution, CurrentRefreshRate, Status FROM Win32_VideoController"))
            {
                var name = Str(row, "Name");
                // 跳过明显的虚拟/远程显示适配器空项
                if (string.IsNullOrWhiteSpace(name))
                    continue;

                index++;
                var prefix = index > 1 ? $"GPU{index} · " : "";
                s.Items.Add((prefix + L.T("名称", "Name"), name));
                s.Items.Add((prefix + L.T("芯片", "Chip"), Str(row, "VideoProcessor")));
                if (TryUlong(row, "AdapterRAM", out var vram) && vram > 0)
                    s.Items.Add((prefix + L.T("显存", "VRAM"), FormatBytes(vram)));
                s.Items.Add((prefix + L.T("驱动版本", "Driver"), Str(row, "DriverVersion")));
                s.Items.Add((prefix + L.T("当前模式", "Current mode"), Str(row, "VideoModeDescription")));

                if (TryUint(row, "CurrentHorizontalResolution", out var w) &&
                    TryUint(row, "CurrentVerticalResolution", out var h) &&
                    w > 0 && h > 0)
                {
                    var hz = TryUint(row, "CurrentRefreshRate", out var rate) && rate > 0
                        ? $" @ {rate} Hz"
                        : "";
                    s.Items.Add((prefix + L.T("分辨率", "Resolution"), $"{w} × {h}{hz}"));
                }

                s.Items.Add((prefix + L.T("状态", "Status"), Str(row, "Status")));
            }

            AppendGpuTemperatures(s);
        }
        catch (Exception ex)
        {
            s.Items.Add((L.T("错误", "Error"), ex.Message));
        }

        if (s.Items.Count == 0)
            s.Items.Add((L.T("信息", "Info"), L.T("无法读取", "Unavailable")));
        return s;
    }

    private static void AppendGpuTemperatures(HwSection s)
    {
        var temps = _snapGpuTemps ?? CpuTempReader.TryReadGpuAllCelsius();
        if (temps.Count == 0)
        {
            s.Items.Add((L.T("GPU 温度", "GPU temperature"), CpuTempReader.IsRunningAsAdmin()
                ? L.T("不可用（本机未读到 GPU 温度传感器）", "Unavailable (no GPU temp sensor found)")
                : L.T("不可用（请以管理员身份运行以读取 GPU 温度）",
                    "Unavailable (run as administrator for GPU temp)")));
            return;
        }

        if (temps.Count == 1)
        {
            s.Items.Add((L.T("GPU 温度", "GPU temperature"),
                L.T($"{temps[0].Celsius:0.#} °C（{temps[0].Name}）",
                    $"{temps[0].Celsius:0.#} °C ({temps[0].Name})")));
            return;
        }

        s.Items.Add((L.T("GPU 温度点数", "GPU temp sensors"), temps.Count.ToString()));
        foreach (var (name, c) in temps)
            s.Items.Add((L.T($"GPU 温度 · {name}", $"GPU temp · {name}"), $"{c:0.#} °C"));
    }

    private static HwSection ReadStorage()
    {
        var s = new HwSection(L.T("磁盘", "Storage"));
        try
        {
            var index = 0;
            foreach (var row in Query(@"root\CIMV2",
                         "SELECT Model, Size, InterfaceType, MediaType, SerialNumber, Partitions FROM Win32_DiskDrive"))
            {
                index++;
                var prefix = L.T($"磁盘{index} · ", $"Disk {index} · ");
                s.Items.Add((prefix + L.T("型号", "Model"), Str(row, "Model")));
                if (TryUlong(row, "Size", out var size) && size > 0)
                    s.Items.Add((prefix + L.T("容量", "Capacity"), FormatBytes(size)));
                s.Items.Add((prefix + L.T("接口", "Interface"), Str(row, "InterfaceType")));
                s.Items.Add((prefix + L.T("介质", "Media"), Str(row, "MediaType")));
                s.Items.Add((prefix + L.T("分区数", "Partitions"), Str(row, "Partitions")));
                s.Items.Add((prefix + L.T("序列号", "Serial number"), Str(row, "SerialNumber").Trim()));
            }
        }
        catch (Exception ex)
        {
            s.Items.Add((L.T("错误", "Error"), ex.Message));
        }

        if (s.Items.Count == 0)
            s.Items.Add((L.T("信息", "Info"), L.T("无法读取", "Unavailable")));
        return s;
    }

    private static HwSection ReadVolumes()
    {
        var s = new HwSection(L.T("分区 / 卷", "Volumes"));
        try
        {
            foreach (var row in Query(@"root\CIMV2",
                         "SELECT DeviceID, FileSystem, Size, FreeSpace, VolumeName FROM Win32_LogicalDisk WHERE DriveType=3"))
            {
                var id = Str(row, "DeviceID");
                var vol = Str(row, "VolumeName");
                var title = string.IsNullOrWhiteSpace(vol) ? id : $"{id} ({vol})";
                if (TryUlong(row, "Size", out var size) && TryUlong(row, "FreeSpace", out var free))
                {
                    var used = size >= free ? size - free : 0;
                    s.Items.Add((title, L.T(
                        $"共 {FormatBytes(size)} · 已用 {FormatBytes(used)} · 可用 {FormatBytes(free)} · {Str(row, "FileSystem")}",
                        $"Total {FormatBytes(size)} · Used {FormatBytes(used)} · Free {FormatBytes(free)} · {Str(row, "FileSystem")}")));
                }
                else
                {
                    s.Items.Add((title, Str(row, "FileSystem")));
                }
            }
        }
        catch (Exception ex)
        {
            s.Items.Add((L.T("错误", "Error"), ex.Message));
        }

        if (s.Items.Count == 0)
            s.Items.Add((L.T("信息", "Info"), L.T("无法读取", "Unavailable")));
        return s;
    }

    private static HwSection ReadNetwork()
    {
        var s = new HwSection(L.T("网卡", "Network"));
        try
        {
            var index = 0;
            foreach (var row in Query(@"root\CIMV2",
                         "SELECT Name, MACAddress, Speed, NetEnabled, AdapterType, Manufacturer FROM Win32_NetworkAdapter WHERE PhysicalAdapter=True AND MACAddress IS NOT NULL"))
            {
                var enabled = Str(row, "NetEnabled");
                // 只要物理网卡；优先显示已启用的，全部列出
                index++;
                var prefix = L.T($"网卡{index} · ", $"NIC {index} · ");
                s.Items.Add((prefix + L.T("名称", "Name"), Str(row, "Name")));
                s.Items.Add((prefix + L.T("制造商", "Manufacturer"), Str(row, "Manufacturer")));
                s.Items.Add((prefix + L.T("MAC", "MAC"), Str(row, "MACAddress")));
                if (TryUlong(row, "Speed", out var speed) && speed > 0)
                    s.Items.Add((prefix + L.T("速率", "Speed"), FormatBitsPerSec(speed)));
                s.Items.Add((prefix + L.T("类型", "Type"), Str(row, "AdapterType")));
                s.Items.Add((prefix + L.T("已启用", "Enabled"),
                    enabled is "True" or "true" ? L.T("是", "Yes") : L.T("否", "No")));
            }
        }
        catch (Exception ex)
        {
            s.Items.Add((L.T("错误", "Error"), ex.Message));
        }

        if (s.Items.Count == 0)
            s.Items.Add((L.T("信息", "Info"), L.T("无法读取", "Unavailable")));
        return s;
    }

    private static IEnumerable<Dictionary<string, object?>> Query(string ns, string wql)
    {
        var locatorType = Type.GetTypeFromProgID("WbemScripting.SWbemLocator");
        if (locatorType is null)
            yield break;

        dynamic locator = Activator.CreateInstance(locatorType)!;
        dynamic services = locator.ConnectServer(".", ns);
        dynamic results = services.ExecQuery(wql);

        foreach (dynamic obj in results)
        {
            var dict = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
            try
            {
                foreach (dynamic prop in obj.Properties_)
                {
                    try
                    {
                        string name = prop.Name;
                        object? value = prop.Value;
                        dict[name] = value;
                    }
                    catch
                    {
                        // skip property
                    }
                }
            }
            catch
            {
                // skip object
            }

            yield return dict;
        }
    }

    private static string Str(Dictionary<string, object?> row, string key)
    {
        if (!row.TryGetValue(key, out var v) || v is null)
            return "—";
        var s = Convert.ToString(v)?.Trim();
        return string.IsNullOrWhiteSpace(s) ? "—" : s;
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

    private static bool TryUint(Dictionary<string, object?> row, string key, out uint value)
    {
        value = 0;
        if (!row.TryGetValue(key, out var v) || v is null)
            return false;
        try
        {
            value = Convert.ToUInt32(v);
            return true;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Win32_CacheMemory.Level：3=L1(Primary)，4=L2，5=L3。
    /// 返回各条目 InstalledSize/MaxCacheSize 之和（KB）。
    /// </summary>
    private static uint SumCpuCacheKb(ushort level)
    {
        uint sum = 0;
        try
        {
            foreach (var row in Query(@"root\CIMV2",
                         "SELECT Level, InstalledSize, MaxCacheSize FROM Win32_CacheMemory"))
            {
                if (!TryUint(row, "Level", out var lvl) || lvl != level)
                    continue;

                if (TryUint(row, "InstalledSize", out var installed) && installed > 0)
                    sum += installed;
                else if (TryUint(row, "MaxCacheSize", out var max) && max > 0)
                    sum += max;
            }
        }
        catch
        {
            return 0;
        }

        return sum;
    }

    private static string FormatBytes(ulong bytes)
    {
        if (bytes >= 1024UL * 1024 * 1024 * 1024)
            return $"{bytes / (1024d * 1024 * 1024 * 1024):0.##} TB";
        if (bytes >= 1024UL * 1024 * 1024)
            return $"{bytes / (1024d * 1024 * 1024):0.##} GB";
        if (bytes >= 1024UL * 1024)
            return $"{bytes / (1024d * 1024):0.##} MB";
        if (bytes >= 1024UL)
            return $"{bytes / 1024d:0.##} KB";
        return $"{bytes} B";
    }

    private static string FormatBitsPerSec(ulong bits)
    {
        if (bits >= 1_000_000_000)
            return $"{bits / 1_000_000_000d:0.##} Gbps";
        if (bits >= 1_000_000)
            return $"{bits / 1_000_000d:0.##} Mbps";
        if (bits >= 1_000)
            return $"{bits / 1_000d:0.##} Kbps";
        return $"{bits} bps";
    }

    private static string FormatWmiDate(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw) || raw == "—" || raw.Length < 14)
            return raw;
        try
        {
            // yyyyMMddHHmmss.ffffff+UUU
            var dt = new DateTime(
                int.Parse(raw[..4]),
                int.Parse(raw.Substring(4, 2)),
                int.Parse(raw.Substring(6, 2)),
                int.Parse(raw.Substring(8, 2)),
                int.Parse(raw.Substring(10, 2)),
                int.Parse(raw.Substring(12, 2)));
            return dt.ToString("yyyy-MM-dd HH:mm:ss");
        }
        catch
        {
            return raw;
        }
    }
}

internal sealed class HwSection
{
    public string Title { get; }
    public List<(string Name, string Value)> Items { get; } = new();

    public HwSection(string title) => Title = title;
}
