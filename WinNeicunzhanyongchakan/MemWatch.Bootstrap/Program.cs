using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace MemWatch.Bootstrap;

internal static class Program
{
    // 官方跳转链接：.NET 8 Windows Desktop Runtime x64
    private const string RuntimeDownloadUrl =
        "https://aka.ms/dotnet/8.0/windowsdesktop-runtime-win-x64.exe";

    private const string AppFileName = "MemWatch.App.exe";

    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        var baseDir = AppDomain.CurrentDomain.BaseDirectory;
        var appPath = Path.Combine(baseDir, AppFileName);

        if (!File.Exists(appPath))
        {
            MessageBox.Show(
                $"找不到主程序：{AppFileName}\n请与启动器放在同一文件夹。",
                "MemWatch",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return;
        }

        if (HasDotNet8DesktopRuntime())
        {
            StartApp(appPath);
            return;
        }

        Application.Run(new BootstrapForm(appPath));
    }

    internal static bool HasDotNet8DesktopRuntime()
    {
        try
        {
            var roots = new[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "dotnet", "shared", "Microsoft.WindowsDesktop.App"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "dotnet", "shared", "Microsoft.WindowsDesktop.App"),
            };

            foreach (var root in roots)
            {
                if (!Directory.Exists(root))
                    continue;

                foreach (var dir in Directory.GetDirectories(root))
                {
                    var name = Path.GetFileName(dir);
                    if (name != null && name.StartsWith("8.", StringComparison.Ordinal))
                        return true;
                }
            }
        }
        catch
        {
            // ignore
        }

        return false;
    }

    internal static void StartApp(string appPath)
    {
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = appPath,
                WorkingDirectory = Path.GetDirectoryName(appPath) ?? "",
                UseShellExecute = true
            });
        }
        catch (Exception ex)
        {
            MessageBox.Show("无法启动主程序：\n" + ex.Message, "MemWatch",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    internal static string RuntimeUrl => RuntimeDownloadUrl;
}

internal sealed class BootstrapForm : Form
{
    private readonly string _appPath;
    private readonly Label _lbl;
    private readonly ProgressBar _bar;
    private readonly Button _btnCancel;
    private bool _busy;

    public BootstrapForm(string appPath)
    {
        _appPath = appPath;

        Text = "MemWatch - 准备运行环境";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(460, 140);
        Font = new Font("Segoe UI", 9f);

        _lbl = new Label
        {
            AutoSize = false,
            Location = new Point(16, 16),
            Size = new Size(428, 40),
            Text = "未检测到 .NET 8 Desktop Runtime。\n正在下载并安装，完成后将自动启动…"
        };

        _bar = new ProgressBar
        {
            Location = new Point(16, 66),
            Size = new Size(428, 22),
            Style = ProgressBarStyle.Continuous,
            Minimum = 0,
            Maximum = 100
        };

        _btnCancel = new Button
        {
            Text = "取消",
            Location = new Point(360, 100),
            Size = new Size(84, 28)
        };
        _btnCancel.Click += (_, __) =>
        {
            if (_busy)
            {
                var r = MessageBox.Show(this, "正在下载/安装，确定要取消吗？", "确认",
                    MessageBoxButtons.YesNo, MessageBoxIcon.Question);
                if (r != DialogResult.Yes)
                    return;
            }

            Close();
        };

        Controls.Add(_lbl);
        Controls.Add(_bar);
        Controls.Add(_btnCancel);

        Shown += async (_, __) => await RunAsync();
    }

    private async Task RunAsync()
    {
        _busy = true;
        _btnCancel.Enabled = true;

        string installerPath = null;
        try
        {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;

            installerPath = Path.Combine(Path.GetTempPath(), "windowsdesktop-runtime-8.0-win-x64.exe");
            _lbl.Text = "正在下载 .NET 8 Desktop Runtime…";
            _bar.Style = ProgressBarStyle.Continuous;
            _bar.Value = 0;

            await DownloadAsync(Program.RuntimeUrl, installerPath);

            if (!File.Exists(installerPath) || new FileInfo(installerPath).Length < 1024 * 100)
                throw new Exception("下载的安装包无效或过小。");

            _lbl.Text = "正在安装运行时（可能需要管理员权限）…";
            _bar.Style = ProgressBarStyle.Marquee;

            var exitCode = await Task.Run(() => RunInstaller(installerPath));

            // 0 = success, 3010 = success reboot required
            if (exitCode != 0 && exitCode != 3010)
                throw new Exception("运行时安装失败，退出码：" + exitCode);

            // 稍等文件系统刷新
            await Task.Delay(800);

            if (!Program.HasDotNet8DesktopRuntime())
            {
                // 有时安装成功但路径尚未立刻可见，再等一次
                await Task.Delay(1500);
            }

            if (!Program.HasDotNet8DesktopRuntime())
            {
                MessageBox.Show(this,
                    "安装似乎已完成，但仍未检测到运行时。\n请重启电脑后再试，或手动安装：\nhttps://dotnet.microsoft.com/download/dotnet/8.0",
                    "提示",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
                return;
            }

            _lbl.Text = "安装完成，正在启动 MemWatch…";
            _bar.Style = ProgressBarStyle.Continuous;
            _bar.Value = 100;
            await Task.Delay(400);

            Program.StartApp(_appPath);
            Close();
        }
        catch (Exception ex)
        {
            MessageBox.Show(this,
                "自动安装失败：\n" + ex.Message + "\n\n请手动下载安装 .NET 8 Desktop Runtime：\nhttps://dotnet.microsoft.com/download/dotnet/8.0",
                "错误",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            Close();
        }
        finally
        {
            _busy = false;
            try
            {
                if (installerPath != null && File.Exists(installerPath))
                    File.Delete(installerPath);
            }
            catch
            {
                // ignore
            }
        }
    }

    private Task DownloadAsync(string url, string destPath)
    {
        var tcs = new TaskCompletionSource<bool>();

        var wc = new WebClient();
        wc.DownloadProgressChanged += (_, e) =>
        {
            try
            {
                if (IsDisposed)
                    return;
                BeginInvoke(new Action(() =>
                {
                    _bar.Value = Math.Max(0, Math.Min(100, e.ProgressPercentage));
                    _lbl.Text = $"正在下载 .NET 8 Desktop Runtime… {e.ProgressPercentage}%";
                }));
            }
            catch
            {
                // ignore
            }
        };
        wc.DownloadFileCompleted += (_, e) =>
        {
            if (e.Cancelled)
                tcs.TrySetCanceled();
            else if (e.Error != null)
                tcs.TrySetException(e.Error);
            else
                tcs.TrySetResult(true);
            wc.Dispose();
        };

        try
        {
            if (File.Exists(destPath))
                File.Delete(destPath);
        }
        catch
        {
            // ignore
        }

        wc.DownloadFileAsync(new Uri(url), destPath);
        return tcs.Task;
    }

    private static int RunInstaller(string installerPath)
    {
        // /passive 显示简单进度；需要管理员时会弹 UAC
        var psi = new ProcessStartInfo
        {
            FileName = installerPath,
            Arguments = "/install /passive /norestart",
            UseShellExecute = true,
            Verb = "runas"
        };

        try
        {
            using (var p = Process.Start(psi))
            {
                if (p == null)
                    return -1;
                p.WaitForExit();
                return p.ExitCode;
            }
        }
        catch (System.ComponentModel.Win32Exception)
        {
            // 用户取消 UAC：再尝试不提权（有时已有权限）
            psi.Verb = null;
            using (var p = Process.Start(psi))
            {
                if (p == null)
                    return -1;
                p.WaitForExit();
                return p.ExitCode;
            }
        }
    }
}
