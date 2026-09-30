using System;
using System.IO;
using System.Diagnostics;
using System.Text;
using System.Collections.Generic;
using System.Threading;

class CleanUserData
{
    // 程序入口：判断自动模式并依次执行清理流程。
    static void Main(string[] args)
    {
        bool 自动模式 = false;
        bool 静默退出 = false;
        bool 等待退出 = true;
        try
        {
            // 检查参数中是否包含不区分大小写的自动确认开关。
            for (int i = 0; i < args.Length; i++)
            {
                if (String.Equals(args[i], "/y", StringComparison.OrdinalIgnoreCase))
                {
                    自动模式 = true;
                }
                if (String.Equals(args[i], "/q", StringComparison.OrdinalIgnoreCase))
                {
                    静默退出 = true;
                }
            }
            等待退出 = !自动模式 || !静默退出;

            // 获取当前用户的漫游和本地应用数据目录。
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

            // 先检查 SimpleCode 进程，避免清理正在使用中的数据。
            Process[] 运行进程 = Process.GetProcessesByName("SimpleCode");
            if (运行进程.Length > 0 && !自动模式)
            {
                Console.WriteLine("SimpleCode 正在运行，请先完全退出再运行本工具");
                if (等待退出) 等待按键退出();
                return;
            }
            if (运行进程.Length > 0 && 自动模式)
            {
                for (int i = 0; i < 运行进程.Length; i++)
                {
                    try
                    {
                        Process 目标进程 = Process.GetProcessById(运行进程[i].Id);
                        目标进程.Kill();
                    }
                    catch (Exception 异常)
                    {
                        Console.WriteLine("结束进程失败：" + 异常.Message);
                    }
                }
                Thread.Sleep(1500);
            }

            // 用两个一一对应的列表收集待删除路径和中文说明。
            List<string> 待删路径 = new List<string>();
            List<string> 待删说明 = new List<string>();
            收集SimpleCode项目(Path.Combine(appData, "SimpleCode"), "漫游数据", 待删路径, 待删说明);
            收集SimpleCode项目(Path.Combine(localAppData, "SimpleCode"), "本地数据", 待删路径, 待删说明);
            收集SinpoCode项目(Path.Combine(appData, "SinpoCode"), "漫游 SinpoCode 数据", 待删路径, 待删说明);
            收集SinpoCode项目(Path.Combine(localAppData, "SinpoCode"), "本地 SinpoCode 数据", 待删路径, 待删说明);

            // 打印标题和完整的待删清单。
            Console.WriteLine("SimpleCode 用户数据清理工具");
            Console.WriteLine("待删清单：");
            if (待删路径.Count == 0)
            {
                Console.WriteLine("（没有发现待删除项）");
                if (等待退出) 等待按键退出();
                return;
            }
            for (int i = 0; i < 待删路径.Count; i++)
            {
                Console.WriteLine((i + 1).ToString() + ". " + 待删路径[i] + " —— " + 待删说明[i]);
            }

            // 非自动模式必须由用户按下 Y 才会继续删除。
            if (!自动模式)
            {
                Console.WriteLine("确认删除以上内容请输入 Y，其他任意键取消");
                ConsoleKeyInfo 按键 = Console.ReadKey(true);
                if (按键.Key != ConsoleKey.Y)
                {
                    Console.WriteLine("已取消，未删除任何文件");
                    if (等待退出) 等待按键退出();
                    return;
                }
            }

            // 按清单逐项删除，单项失败不会阻止后续项目。
            for (int i = 0; i < 待删路径.Count; i++)
            {
                DeleteEntry(待删路径[i]);
            }

            // 检查漫游 SimpleCode 目录中是否只保留 models。
            string appSimpleCode = Path.Combine(appData, "SimpleCode");
            Console.WriteLine("%APPDATA%\\SimpleCode 剩余项");
            if (Directory.Exists(appSimpleCode))
            {
                try
                {
                    string[] 剩余项目 = Directory.GetFileSystemEntries(appSimpleCode);
                    if (剩余项目.Length == 0)
                    {
                        Console.WriteLine("（无剩余项）");
                    }
                    for (int i = 0; i < 剩余项目.Length; i++)
                    {
                        Console.WriteLine(Path.GetFileName(剩余项目[i]));
                    }
                }
                catch (Exception 异常)
                {
                    Console.WriteLine("跳过（无权限/被占用）：" + appSimpleCode + " " + 异常.Message);
                }
            }
            else
            {
                Console.WriteLine("SimpleCode 目录已消失");
            }

            // 检查两个位置的 SinpoCode 目录是否仍存在。
            Console.WriteLine("SinpoCode 是否已清除");
            Console.WriteLine("漫游位置：" + (Directory.Exists(Path.Combine(appData, "SinpoCode")) ? "仍存在" : "已清除"));
            Console.WriteLine("本地位置：" + (Directory.Exists(Path.Combine(localAppData, "SinpoCode")) ? "仍存在" : "已清除"));

            // 检查漫游 SimpleCode 的 settings.json 是否仍存在。
            Console.WriteLine("settings.json 是否已清除");
            Console.WriteLine(File.Exists(Path.Combine(appSimpleCode, "settings.json")) ? "仍存在" : "已清除");

            // 输出安装包重装验证步骤。
            Console.WriteLine("重装验证三步：");
            Console.WriteLine("① 装包时取消勾选「运行 SimpleCode」，装完不要启动；");
            Console.WriteLine("② 在 cmd 里执行 dir \"%APPDATA%\" /b | findstr /i simple；");
            Console.WriteLine("③ 此时若没有 SimpleCode 目录，说明安装包干净；若出现且带 settings.json，说明包被污染，请把该文件保留下来。");
            if (等待退出) 等待按键退出();
        }
        catch (Exception 异常)
        {
            Console.WriteLine("发生未处理异常，清理流程已停止。");
            Console.WriteLine("异常类型：" + 异常.GetType().FullName);
            Console.WriteLine("消息：" + 异常.Message);
            Console.WriteLine("堆栈：" + 异常.StackTrace);
            if (等待退出) 等待按键退出();
        }
    }

    // 按策略等待用户按键，避免控制台窗口一闪而过。
    static void 等待按键退出()
    {
        Console.WriteLine();
        Console.WriteLine("按任意键退出…");
        Console.ReadKey(true);
    }

    // 收集 SimpleCode 目录的下一级项目，并始终跳过名为 models 的项目。
    static void 收集SimpleCode项目(string 目录, string 位置说明, List<string> 待删路径, List<string> 待删说明)
    {
        if (!Directory.Exists(目录))
        {
            Console.WriteLine("未发现：" + 目录);
            return;
        }

        string[] 项目列表;
        try
        {
            项目列表 = Directory.GetFileSystemEntries(目录);
        }
        catch (Exception 异常)
        {
            Console.WriteLine("跳过（无权限/被占用）：" + 目录 + " " + 异常.Message);
            return;
        }
        for (int i = 0; i < 项目列表.Length; i++)
        {
            string 名称 = Path.GetFileName(项目列表[i]);
            if (String.Equals(名称, "models", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            待删路径.Add(项目列表[i]);
            待删说明.Add(位置说明 + "（SimpleCode 下一级项目）");
        }
    }

    // 收集整个 SinpoCode 目录作为一个待删除项目。
    static void 收集SinpoCode项目(string 目录, string 位置说明, List<string> 待删路径, List<string> 待删说明)
    {
        if (!Directory.Exists(目录))
        {
            Console.WriteLine("未发现：" + 目录);
            return;
        }
        待删路径.Add(目录);
        待删说明.Add(位置说明);
    }

    // 删除一个文件或目录，单项错误以中文提示并继续清理。
    static void DeleteEntry(string 路径)
    {
        try
        {
            if (File.Exists(路径))
            {
                File.Delete(路径);
            }
            else if (Directory.Exists(路径))
            {
                Directory.Delete(路径, true);
            }
        }
        catch (Exception 异常)
        {
            Console.WriteLine("删除失败：" + 路径 + " —— " + 异常.Message);
        }
    }
}
