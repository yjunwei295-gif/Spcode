using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace MemWatch;

internal static class Program
{
    private const string MutexName = @"Local\MemWatch_SingleInstance_v1";

    [STAThread]
    private static void Main(string[] args)
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

        if (args.Any(a => string.Equals(a, "--dump-ui", StringComparison.OrdinalIgnoreCase)))
        {
            ApplicationConfiguration.Initialize();
            using var form = new Form1();
            form.StartPosition = FormStartPosition.Manual;
            form.Location = new Point(-4000, -4000);
            form.Show();
            Application.DoEvents();
            var path = Path.Combine(AppContext.BaseDirectory, "ui-layout-dump.txt");
            File.WriteAllText(path, UiLayoutDump.Capture(form), Encoding.UTF8);
            form.Close();
            return;
        }
        // 启用 GBK/OEM 等代码页，供 chkdsk 等控制台输出正确解码
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

        using var mutex = new Mutex(true, MutexName, out var createdNew);
        if (!createdNew)
        {
            ActivateExistingWindow();
            return;
        }

        ApplicationConfiguration.Initialize();
        try
        {
            Application.Run(new Form1());
        }
        finally
        {
            // 双保险：卸载 WinRing0，避免 MemWatch.App.sys 退出后仍被占用
            CpuTempReader.Shutdown();
        }
    }

    private static void ActivateExistingWindow()
    {
        try
        {
            var currentId = Environment.ProcessId;
            foreach (var proc in Process.GetProcessesByName("MemWatch"))
            {
                try
                {
                    if (proc.Id == currentId)
                        continue;

                    var hwnd = proc.MainWindowHandle;
                    if (hwnd == IntPtr.Zero)
                        continue;

                    ShowWindow(hwnd, SW_RESTORE);
                    SetForegroundWindow(hwnd);
                    return;
                }
                finally
                {
                    proc.Dispose();
                }
            }
        }
        catch
        {
            // 找不到已有窗口时直接退出
        }
    }

    private const int SW_RESTORE = 9;

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
