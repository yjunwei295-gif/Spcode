using System.Runtime.InteropServices;

namespace MemWatch;

/// <summary>去掉系统蓝/白视觉样式，滚动条和进度条跟农舍底色走。</summary>
internal static class NativeUi
{
    [DllImport("uxtheme.dll", CharSet = CharSet.Unicode)]
    private static extern int SetWindowTheme(IntPtr hwnd, string pszSubAppName, string pszSubIdList);

    public static void UseClassicTheme(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero)
            return;
        try
        {
            SetWindowTheme(hwnd, string.Empty, string.Empty);
        }
        catch
        {
            // 忽略主题接口失败
        }
    }

    public static void UseClassicWhenReady(Control c)
    {
        if (c.IsHandleCreated)
            UseClassicTheme(c.Handle);
        else
            c.HandleCreated += (_, _) => UseClassicTheme(c.Handle);
    }
}
