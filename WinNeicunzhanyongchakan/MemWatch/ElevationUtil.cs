using System.Diagnostics;
using System.Security.Principal;

namespace MemWatch;

/// <summary>提权与强制结束进程辅助。</summary>
internal static class ElevationUtil
{
    public static bool IsAdministrator()
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

    /// <summary>强制结束进程树；失败时用提权 taskkill。</summary>
    public static (int killed, List<string> failed, bool elevatedUsed) ForceKill(
        IReadOnlyList<(int Pid, string Name)> targets)
    {
        var failed = new List<(int Pid, string Name, string Err)>();
        var killed = 0;

        foreach (var (pid, name) in targets)
        {
            if (pid == Environment.ProcessId)
            {
                failed.Add((pid, name, L.T("不能结束自身", "Cannot end self")));
                continue;
            }

            try
            {
                using var p = Process.GetProcessById(pid);
                p.Kill(entireProcessTree: true);
                p.WaitForExit(2000);
                killed++;
            }
            catch (Exception ex)
            {
                failed.Add((pid, name, ex.Message));
            }
        }

        if (failed.Count == 0)
            return (killed, new List<string>(), false);

        // 提权 taskkill 再杀一遍失败项
        var still = failed.Where(f => f.Pid != Environment.ProcessId).ToList();
        if (still.Count == 0)
            return (killed, failed.Select(f => $"{f.Name}：{f.Err}").ToList(), false);

        var args = string.Join(" ", still.Select(f => $"/PID {f.Pid}"));
        var elevatedOk = TryRunElevated("taskkill.exe", $"/F /T {args}", out var elevateErr);
        if (!elevatedOk)
        {
            var list = failed.Select(f => $"{f.Name}：{f.Err}").ToList();
            if (!string.IsNullOrEmpty(elevateErr))
                list.Add(L.T($"提权失败：{elevateErr}", $"Elevation failed: {elevateErr}"));
            return (killed, list, false);
        }

        Thread.Sleep(400);
        var remain = new List<string>();
        foreach (var (pid, name, _) in still)
        {
            try
            {
                Process.GetProcessById(pid);
                remain.Add(L.T($"{name}：仍在运行", $"{name}: still running"));
            }
            catch (ArgumentException)
            {
                killed++;
            }
        }

        return (killed, remain, true);
    }

    /// <summary>以管理员身份启动程序（弹出 UAC）。</summary>
    public static bool TryRunElevated(string fileName, string arguments, out string? error)
    {
        error = null;
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = fileName,
                Arguments = arguments,
                UseShellExecute = true,
                Verb = "runas",
                WindowStyle = ProcessWindowStyle.Hidden
            };
            using var p = Process.Start(psi);
            if (p is null)
            {
                error = L.T("无法启动提权进程", "Failed to start elevated process");
                return false;
            }

            p.WaitForExit(120_000);
            return true;
        }
        catch (System.ComponentModel.Win32Exception ex) when (ex.NativeErrorCode == 1223)
        {
            error = L.T("已取消管理员授权", "Administrator elevation cancelled");
            return false;
        }
        catch (Exception ex)
        {
            error = ex.Message;
            return false;
        }
    }

    /// <summary>提权执行命令行（cmd /c）。</summary>
    public static bool TryRunElevatedCmd(string commandLine, out string? error) =>
        TryRunElevated("cmd.exe", "/c " + commandLine, out error);
}
