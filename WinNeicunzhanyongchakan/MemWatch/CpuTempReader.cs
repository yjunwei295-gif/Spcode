using System.Diagnostics;
using System.Security.Principal;
using System.Threading;
using LibreHardwareMonitor.Hardware;

namespace MemWatch;

/// <summary>
/// CPU / GPU 温度与频率。主界面只轻量读 CPU 温度；完整快照仅供配置页手动刷新。
/// </summary>
internal static class CpuTempReader
{
    private static bool _shuttingDown;

    private static DateTime _cpuTempReadUtc = DateTime.MinValue;
    private static float? _cachedDisplay;
    private static List<(string Name, float Celsius)>? _cachedCpuTemps;

    private static List<(string Name, float Celsius)>? _cachedGpu;
    private static CpuClockSnapshot _cachedClocks;
    private static DateTime _fullSnapshotUtc = DateTime.MinValue;

    /// <summary>主界面 CPU 温度缓存有效期；由 Form1 按用户设置同步。</summary>
    private static TimeSpan _cpuTempCacheTtl = TimeSpan.FromSeconds(5);

    public readonly record struct CpuClockSnapshot(float? AverageMhz, float? MaxCoreMhz, float? BusMhz);

    public static void SetCpuTempCacheSeconds(int seconds)
    {
        _cpuTempCacheTtl = TimeSpan.FromSeconds(LevelConfig.ClampCpuTempRefreshSec(seconds));
    }

    /// <summary>浮窗 / 主界面：只更新显示用单点温度，绝不改写配置页的各核列表。</summary>
    public static float? TryReadCelsius(bool forceRefresh = false)
    {
        EnsureCpuTempCache(forceRefresh);
        return _cachedDisplay;
    }

    /// <summary>配置页用：强制完整刷新 CPU 温度 + 频率 + GPU 温度（单次遍历）。</summary>
    public static void RefreshFullSnapshot()
    {
        lock (LhmHub.Sync)
        {
            if (_shuttingDown)
                return;
            RefreshFullSnapshotLocked();
        }
    }

    /// <summary>
    /// 配置页一次加锁：刷新并拷贝 CPU 温度 / GPU 温度 / 频率，避免与主界面轻量读温交错读到半截缓存。
    /// </summary>
    public static (
        IReadOnlyList<(string Name, float Celsius)> CpuTemps,
        IReadOnlyList<(string Name, float Celsius)> GpuTemps,
        CpuClockSnapshot Clocks) TakeFullSnapshot()
    {
        lock (LhmHub.Sync)
        {
            if (_shuttingDown)
            {
                return (
                    Array.Empty<(string, float)>(),
                    Array.Empty<(string, float)>(),
                    default);
            }

            RefreshFullSnapshotLocked();
            return (
                CopyTemps(_cachedCpuTemps),
                CopyTemps(_cachedGpu),
                _cachedClocks);
        }
    }

    public static IReadOnlyList<(string Name, float Celsius)> TryReadAllCelsius()
    {
        lock (LhmHub.Sync)
        {
            if (_shuttingDown)
                return Array.Empty<(string, float)>();

            if (_fullSnapshotUtc == DateTime.MinValue || _cachedCpuTemps is null)
                RefreshFullSnapshotLocked();

            return CopyTemps(_cachedCpuTemps);
        }
    }

    public static IReadOnlyList<(string Name, float Celsius)> TryReadGpuAllCelsius()
    {
        lock (LhmHub.Sync)
        {
            if (_shuttingDown)
                return Array.Empty<(string, float)>();
            if (_fullSnapshotUtc == DateTime.MinValue || _cachedGpu is null)
                RefreshFullSnapshotLocked();
            return CopyTemps(_cachedGpu);
        }
    }

    public static CpuClockSnapshot TryReadCpuClocks()
    {
        lock (LhmHub.Sync)
        {
            if (_shuttingDown)
                return default;
            if (_fullSnapshotUtc == DateTime.MinValue)
                RefreshFullSnapshotLocked();
            return _cachedClocks;
        }
    }

    private static IReadOnlyList<(string Name, float Celsius)> CopyTemps(
        List<(string Name, float Celsius)>? source) =>
        source is null || source.Count == 0
            ? Array.Empty<(string, float)>()
            : source.ToList();

    public static bool IsRunningAsAdmin()
    {
        try
        {
            using var id = WindowsIdentity.GetCurrent();
            return new WindowsPrincipal(id).IsInRole(WindowsBuiltInRole.Administrator);
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// 退出时必须调用：关闭 LHM 并卸载 WinRing0，否则 MemWatch.App.sys 会一直被占用无法删除。
    /// </summary>
    public static void Shutdown()
    {
        lock (LhmHub.Sync)
        {
            _shuttingDown = true;
            _cachedDisplay = null;
            _cachedCpuTemps = null;
            _cachedGpu = null;
            _cachedClocks = default;
            _cpuTempReadUtc = DateTime.MinValue;
            _fullSnapshotUtc = DateTime.MinValue;
        }

        LhmHub.Shutdown();

        // Close 之后若驱动服务仍挂着，文件会继续被锁（服务名形如 R0MemWatch_App）
        TryStopAndDeleteRing0Services();
        TryDeleteExtractedDriverFiles();
    }

    private static void TryStopAndDeleteRing0Services()
    {
        try
        {
            foreach (var name in FindRing0ServiceNames())
            {
                // 需要管理员；本程序已 requireAdministrator
                RunSc($"stop \"{name}\"");
                // 等内核卸驱动
                Thread.Sleep(200);
                RunSc($"delete \"{name}\"");
            }
        }
        catch
        {
            // ignore
        }
    }

    private static IEnumerable<string> FindRing0ServiceNames()
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        // 本程序集对应的默认名
        names.Add("R0MemWatch_App");
        names.Add("R0MemWatch");

        try
        {
            foreach (var row in QueryDriverServices())
            {
                if (row.Contains("MemWatch", StringComparison.OrdinalIgnoreCase) ||
                    row.Contains("WinRing", StringComparison.OrdinalIgnoreCase))
                    names.Add(row);
            }
        }
        catch
        {
            // ignore
        }

        return names;
    }

    private static IEnumerable<string> QueryDriverServices()
    {
        // 用 WMI 找 PathName 指向我们目录下 .sys 的驱动
        var dir = AppContext.BaseDirectory.TrimEnd('\\', '/');
        object? resultsObj;
        try
        {
            var locatorType = Type.GetTypeFromProgID("WbemScripting.SWbemLocator");
            if (locatorType is null)
                yield break;

            dynamic locator = Activator.CreateInstance(locatorType)!;
            dynamic services = locator.ConnectServer(".", @"root\CIMV2");
            resultsObj = services.ExecQuery(
                "SELECT Name, PathName FROM Win32_SystemDriver");
        }
        catch
        {
            yield break;
        }

        dynamic results = resultsObj!;
        foreach (dynamic obj in results)
        {
            string name;
            string path;
            try
            {
                name = Convert.ToString(obj.Properties_.Item("Name").Value) ?? "";
                path = Convert.ToString(obj.Properties_.Item("PathName").Value) ?? "";
            }
            catch
            {
                continue;
            }

            if (string.IsNullOrWhiteSpace(name))
                continue;

            if (path.Contains("MemWatch", StringComparison.OrdinalIgnoreCase) ||
                (!string.IsNullOrEmpty(dir) &&
                 path.Contains(dir, StringComparison.OrdinalIgnoreCase)))
                yield return name;
        }
    }

    private static void RunSc(string args)
    {
        try
        {
            using var p = Process.Start(new ProcessStartInfo
            {
                FileName = "sc.exe",
                Arguments = args,
                CreateNoWindow = true,
                UseShellExecute = false,
                WindowStyle = ProcessWindowStyle.Hidden
            });
            p?.WaitForExit(3000);
        }
        catch
        {
            // ignore
        }
    }

    private static void TryDeleteExtractedDriverFiles()
    {
        try
        {
            var dir = AppContext.BaseDirectory;
            if (string.IsNullOrWhiteSpace(dir) || !Directory.Exists(dir))
                return;

            foreach (var path in Directory.EnumerateFiles(dir, "*.sys"))
            {
                var name = Path.GetFileName(path);
                // LHM 会抽出以程序集名命名的 WinRing0，例如 MemWatch.App.sys
                if (!name.StartsWith("MemWatch", StringComparison.OrdinalIgnoreCase) &&
                    !name.Contains("WinRing", StringComparison.OrdinalIgnoreCase) &&
                    !name.Contains("Ring0", StringComparison.OrdinalIgnoreCase))
                    continue;

                try
                {
                    File.Delete(path);
                }
                catch
                {
                    // 仍被占用则留给用户重启后再删；至少已尽量 Close
                }
            }
        }
        catch
        {
            // ignore
        }
    }

    private static void EnsureCpuTempCache(bool forceRefresh = false)
    {
        lock (LhmHub.Sync)
        {
            if (_shuttingDown)
                return;

            var now = DateTime.UtcNow;
            if (!forceRefresh &&
                _cachedDisplay.HasValue &&
                now - _cpuTempReadUtc < _cpuTempCacheTtl)
                return;

            RefreshCpuTempOnlyLocked();
        }
    }

    private static void RefreshCpuTempOnlyLocked()
    {
        var computer = LhmHub.GetComputerUnlocked();
        var list = new List<(string Name, float Celsius)>();

        if (computer is not null)
        {
            try
            {
                UpdateCpuHardwareOnly(computer);
                CollectAllCpuTemps(computer, list);
            }
            catch
            {
                // 短暂失败：尝试恢复共享 Computer，不永久拉黑 LHM
                computer = LhmHub.RecoverComputerUnlocked();
                if (computer is not null)
                {
                    try
                    {
                        UpdateCpuHardwareOnly(computer);
                        CollectAllCpuTemps(computer, list);
                    }
                    catch
                    {
                        // fall through to WMI
                    }
                }
            }
        }

        if (list.Count == 0)
            list = ReadCpuTempsFallbackWmi();

        var deduped = Dedup(list);
        // 只更新主界面/浮窗单点温度；各核完整列表仅由 RefreshFullSnapshotLocked 维护
        if (deduped.Count > 0)
            _cachedDisplay = PickDisplayTemp(deduped);
        _cpuTempReadUtc = DateTime.UtcNow;
    }

    private static void RefreshFullSnapshotLocked()
    {
        var computer = LhmHub.GetComputerUnlocked();
        var cpuTemps = new List<(string Name, float Celsius)>();
        var gpuTemps = new List<(string Name, float Celsius)>();
        var cores = new List<float>();
        float? bus = null;

        if (computer is not null)
        {
            try
            {
                foreach (var hw in computer.Hardware)
                {
                    if (hw.HardwareType is not (HardwareType.Cpu or HardwareType.GpuNvidia
                        or HardwareType.GpuAmd or HardwareType.GpuIntel))
                        continue;
                    hw.Update();
                    foreach (var sub in hw.SubHardware)
                        sub.Update();
                }

                foreach (var hw in computer.Hardware)
                {
                    if (hw.HardwareType == HardwareType.Cpu)
                    {
                        CollectCpuTemps(hw, cpuTemps);
                        CollectCpuClocks(hw, cores, ref bus);
                        foreach (var sub in hw.SubHardware)
                        {
                            CollectCpuTemps(sub, cpuTemps);
                            CollectCpuClocks(sub, cores, ref bus);
                        }
                    }
                    else if (IsGpuHardware(hw.HardwareType))
                    {
                        var gpuName = string.IsNullOrWhiteSpace(hw.Name) ? "GPU" : hw.Name.Trim();
                        CollectGpuTemps(hw, gpuName, gpuTemps);
                        foreach (var sub in hw.SubHardware)
                            CollectGpuTemps(sub, gpuName, gpuTemps);
                    }
                }
            }
            catch
            {
                computer = LhmHub.RecoverComputerUnlocked();
                if (computer is not null)
                {
                    try
                    {
                        foreach (var hw in computer.Hardware)
                        {
                            if (hw.HardwareType != HardwareType.Cpu && !IsGpuHardware(hw.HardwareType))
                                continue;
                            hw.Update();
                            foreach (var sub in hw.SubHardware)
                                sub.Update();
                        }

                        foreach (var hw in computer.Hardware)
                        {
                            if (hw.HardwareType == HardwareType.Cpu)
                            {
                                CollectCpuTemps(hw, cpuTemps);
                                CollectCpuClocks(hw, cores, ref bus);
                                foreach (var sub in hw.SubHardware)
                                {
                                    CollectCpuTemps(sub, cpuTemps);
                                    CollectCpuClocks(sub, cores, ref bus);
                                }
                            }
                            else if (IsGpuHardware(hw.HardwareType))
                            {
                                var gpuName = string.IsNullOrWhiteSpace(hw.Name) ? "GPU" : hw.Name.Trim();
                                CollectGpuTemps(hw, gpuName, gpuTemps);
                                foreach (var sub in hw.SubHardware)
                                    CollectGpuTemps(sub, gpuName, gpuTemps);
                            }
                        }
                    }
                    catch
                    {
                        // fall through
                    }
                }
            }
        }

        if (cpuTemps.Count == 0)
            cpuTemps = ReadCpuTempsFallbackWmi();

        var dedupedCpu = Dedup(cpuTemps);
        // 关键保护：LHM 被干扰后若只读到 1 点，不要冲掉已有的各核完整列表
        if (_cachedCpuTemps is { Count: > 1 } && dedupedCpu.Count <= 1)
        {
            if (dedupedCpu.Count == 1)
                _cachedDisplay = PickDisplayTemp(dedupedCpu);
        }
        else
        {
            _cachedCpuTemps = dedupedCpu;
            _cachedDisplay = PickDisplayTemp(_cachedCpuTemps);
            _fullSnapshotUtc = DateTime.UtcNow;
        }

        _cpuTempReadUtc = DateTime.UtcNow;

        var dedupedGpu = Dedup(gpuTemps);
        if (!(_cachedGpu is { Count: > 1 } && dedupedGpu.Count <= 1))
            _cachedGpu = dedupedGpu;

        if (cores.Count > 0)
            _cachedClocks = new CpuClockSnapshot(cores.Average(), cores.Max(), bus);
        else if (_cachedClocks.AverageMhz is null)
            _cachedClocks = new CpuClockSnapshot(null, null, bus);
    }

    private static void UpdateCpuHardwareOnly(Computer computer)
    {
        foreach (var hw in computer.Hardware)
        {
            if (hw.HardwareType != HardwareType.Cpu)
                continue;
            hw.Update();
            foreach (var sub in hw.SubHardware)
                sub.Update();
        }
    }

    private static void CollectAllCpuTemps(Computer computer, List<(string Name, float Celsius)> list)
    {
        foreach (var hw in computer.Hardware)
        {
            if (hw.HardwareType != HardwareType.Cpu)
                continue;
            CollectCpuTemps(hw, list);
            foreach (var sub in hw.SubHardware)
                CollectCpuTemps(sub, list);
        }
    }

    private static List<(string Name, float Celsius)> ReadCpuTempsFallbackWmi()
    {
        var wmiLhm = new List<(string, float)>();
        foreach (var (name, c) in QueryWmiTemps(
                     @"root\LibreHardwareMonitor",
                     "SELECT Name, Value FROM Sensor WHERE SensorType='Temperature'",
                     "Name",
                     "Value",
                     raw => (float)raw))
        {
            if (IsNonCpuSensor(name))
                continue;
            if (name.Contains("Distance", StringComparison.OrdinalIgnoreCase))
                continue;
            wmiLhm.Add((name, c));
        }

        if (wmiLhm.Count > 0)
            return Dedup(wmiLhm);

        var acpi = new List<(string, float)>();
        foreach (var (name, c) in QueryWmiTemps(
                     @"root\WMI",
                     "SELECT InstanceName, CurrentTemperature FROM MSAcpi_ThermalZoneTemperature",
                     "InstanceName",
                     "CurrentTemperature",
                     raw => (float)(raw / 10.0 - 273.15)))
        {
            acpi.Add((L.T($"主板热区 · {CleanZoneName(name)}", $"MB thermal · {CleanZoneName(name)}"), c));
        }

        if (acpi.Count > 0)
            return Dedup(acpi);

        foreach (var (name, c) in QueryWmiTemps(
                     @"root\CIMV2",
                     "SELECT Name, Temperature FROM Win32_PerfFormattedData_Counters_ThermalZoneInformation",
                     "Name",
                     "Temperature",
                     raw => (float)(raw - 273.15)))
        {
            acpi.Add((L.T($"系统热区 · {CleanZoneName(name)}", $"System thermal · {CleanZoneName(name)}"), c));
        }

        return Dedup(acpi);
    }

    private static bool IsGpuHardware(HardwareType type) =>
        type is HardwareType.GpuNvidia or HardwareType.GpuAmd or HardwareType.GpuIntel;

    private static void CollectGpuTemps(IHardware hardware, string gpuName, List<(string Name, float Celsius)> list)
    {
        foreach (var sensor in hardware.Sensors)
        {
            if (sensor.SensorType != SensorType.Temperature)
                continue;
            if (!sensor.Value.HasValue)
                continue;

            var sensorName = string.IsNullOrWhiteSpace(sensor.Name) ? L.T("温度", "Temperature") : sensor.Name.Trim();
            if (sensorName.Contains("Distance", StringComparison.OrdinalIgnoreCase))
                continue;

            var v = sensor.Value.Value;
            if (v is < -20 or > 150)
                continue;

            list.Add(($"{gpuName} · {sensorName}", v));
        }
    }

    private static void CollectCpuTemps(IHardware hardware, List<(string Name, float Celsius)> list)
    {
        foreach (var sensor in hardware.Sensors)
        {
            if (sensor.SensorType != SensorType.Temperature)
                continue;
            if (!sensor.Value.HasValue)
                continue;

            var name = sensor.Name ?? "CPU";
            if (name.Contains("Distance", StringComparison.OrdinalIgnoreCase))
                continue;

            var v = sensor.Value.Value;
            if (v is < -20 or > 150)
                continue;

            list.Add((name, v));
        }
    }

    private static void CollectCpuClocks(IHardware hardware, List<float> cores, ref float? bus)
    {
        foreach (var sensor in hardware.Sensors)
        {
            if (sensor.SensorType != SensorType.Clock)
                continue;
            if (!sensor.Value.HasValue)
                continue;

            var name = sensor.Name ?? "";
            var mhz = sensor.Value.Value;
            if (mhz is < 50 or > 10000)
                continue;

            if (name.Contains("Bus", StringComparison.OrdinalIgnoreCase))
            {
                bus = mhz;
                continue;
            }

            if (name.Contains("Core", StringComparison.OrdinalIgnoreCase))
                cores.Add(mhz);
        }
    }

    private static float? PickDisplayTemp(List<(string Name, float Celsius)> list)
    {
        if (list.Count == 0)
            return null;

        static bool Match(string name, string key) =>
            name.Contains(key, StringComparison.OrdinalIgnoreCase);

        foreach (var (name, c) in list)
        {
            if (Match(name, "Package") || Match(name, "CPU Package"))
                return c;
        }

        foreach (var (name, c) in list)
        {
            if (Match(name, "Core Average") || Match(name, "Average"))
                return c;
        }

        foreach (var (name, c) in list)
        {
            if (Match(name, "Core Max") || Match(name, "Max"))
                return c;
        }

        var cores = list
            .Where(x => Match(x.Name, "Core #") || Match(x.Name, "Core "))
            .Select(x => x.Celsius)
            .ToList();
        if (cores.Count > 0)
            return cores.Average();

        var cpuLike = list.Where(x => !Match(x.Name, "热区") && !Match(x.Name, "thermal")).Select(x => x.Celsius).ToList();
        if (cpuLike.Count > 0)
            return cpuLike.Max();

        return list.Max(x => x.Celsius);
    }

    private static bool IsNonCpuSensor(string name) =>
        name.Contains("GPU", StringComparison.OrdinalIgnoreCase) ||
        name.Contains("HDD", StringComparison.OrdinalIgnoreCase) ||
        name.Contains("SSD", StringComparison.OrdinalIgnoreCase) ||
        name.Contains("NVMe", StringComparison.OrdinalIgnoreCase) ||
        name.Contains("WiFi", StringComparison.OrdinalIgnoreCase) ||
        name.Contains("Ethernet", StringComparison.OrdinalIgnoreCase);

    private static IEnumerable<(string Name, float Celsius)> QueryWmiTemps(
        string ns,
        string query,
        string nameProp,
        string valueProp,
        Func<double, float> toCelsius)
    {
        object? resultsObj;
        try
        {
            var locatorType = Type.GetTypeFromProgID("WbemScripting.SWbemLocator");
            if (locatorType is null)
                yield break;

            dynamic locator = Activator.CreateInstance(locatorType)!;
            dynamic services = locator.ConnectServer(".", ns);
            resultsObj = services.ExecQuery(query);
        }
        catch
        {
            yield break;
        }

        dynamic results = resultsObj!;
        var index = 0;
        foreach (dynamic obj in results)
        {
            index++;
            string name;
            float c;
            try
            {
                try
                {
                    name = Convert.ToString(obj.Properties_.Item(nameProp).Value) ?? L.T($"传感器{index}", $"Sensor {index}");
                }
                catch
                {
                    name = L.T($"传感器{index}", $"Sensor {index}");
                }

                var raw = Convert.ToDouble(obj.Properties_.Item(valueProp).Value);
                c = toCelsius(raw);
            }
            catch
            {
                continue;
            }

            if (c is < -20 or > 150)
                continue;

            yield return (name, c);
        }
    }

    private static string CleanZoneName(string name)
    {
        if (string.IsNullOrWhiteSpace(name))
            return L.T("未知", "Unknown");
        var s = name.Replace(@"\\", @"\");
        var parts = s.Split('\\', StringSplitOptions.RemoveEmptyEntries);
        var last = parts.Length > 0 ? parts[^1] : s;
        return last.TrimEnd('_', '0');
    }

    private static List<(string Name, float Celsius)> Dedup(List<(string Name, float Celsius)> list)
    {
        var map = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase);
        foreach (var (name, c) in list)
        {
            var key = string.IsNullOrWhiteSpace(name) ? L.T("温度", "Temperature") : name.Trim();
            if (!map.TryGetValue(key, out var old) || c > old)
                map[key] = c;
        }

        return map.Select(kv => (kv.Key, kv.Value))
            .OrderBy(x => x.Key, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }
}
