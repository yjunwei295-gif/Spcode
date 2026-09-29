using System.Runtime.InteropServices;

using System.Text;



namespace MemWatch;



/// <summary>截图窗口识别：悬停时用 WindowFromPoint（叠层穿透），兜底用预采集列表。</summary>

internal static class WindowCaptureHelper

{

    private const int GwlExStyle = -20;

    private const int WsExToolWindow = 0x00000080;

    private const int WsExNoActivate = 0x08000000;

    private const int DwmwaExtendedFrameBounds = 9;

    private const uint GaRoot = 2;



    internal readonly record struct WindowHit(Rectangle Bounds, string Title);



    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);



    [StructLayout(LayoutKind.Sequential)]

    private struct PointNative

    {

        public int X;

        public int Y;

    }



    [StructLayout(LayoutKind.Sequential)]

    private struct Rect

    {

        public int Left;

        public int Top;

        public int Right;

        public int Bottom;



        public Rectangle ToRectangle() =>

            Rectangle.FromLTRB(Left, Top, Right, Bottom);

    }



    [DllImport("user32.dll")]

    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);



    [DllImport("user32.dll")]

    private static extern bool IsWindow(IntPtr hWnd);



    [DllImport("user32.dll")]

    private static extern bool IsWindowVisible(IntPtr hWnd);



    [DllImport("user32.dll")]

    private static extern bool IsIconic(IntPtr hWnd);



    [DllImport("user32.dll", CharSet = CharSet.Unicode)]

    private static extern int GetWindowTextLength(IntPtr hWnd);



    [DllImport("user32.dll", CharSet = CharSet.Unicode)]

    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);



    [DllImport("user32.dll", CharSet = CharSet.Unicode)]

    private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);



    [DllImport("user32.dll")]

    private static extern bool GetWindowRect(IntPtr hWnd, out Rect lpRect);



    [DllImport("user32.dll")]

    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);



    [DllImport("user32.dll", EntryPoint = "GetWindowLong")]

    private static extern int GetWindowLong32(IntPtr hWnd, int nIndex);



    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtr")]

    private static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);



    [DllImport("user32.dll")]

    private static extern IntPtr WindowFromPoint(PointNative point);



    [DllImport("user32.dll")]

    private static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);



    [DllImport("dwmapi.dll")]

    private static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out Rect pvAttribute, int cbAttribute);



    /// <summary>截图叠层出现前采集可见顶层窗口（EnumWindows 顺序 = 前台到后台）。</summary>

    public static List<WindowHit> CollectVisibleWindows(Rectangle virtualScreen, int excludeProcessId)

    {

        var list = new List<WindowHit>(32);

        try

        {

            EnumWindows((hWnd, _) =>

            {

                try

                {

                    if (!IsTopLevelCandidate(hWnd, virtualScreen, excludeProcessId, out var bounds))

                        return true;



                    list.Add(new WindowHit(bounds, GetTitleSafe(hWnd)));

                }

                catch

                {

                    // 单个窗口失败不影响其余

                }



                return true;

            }, IntPtr.Zero);

        }

        catch

        {

            // 返回已采集部分

        }



        return list;

    }



    /// <summary>微信式：鼠标穿透叠层后，实时取鼠标下最前台窗口。</summary>

    public static bool TryHitWindowAtPoint(

        Point screenPoint,

        int excludeProcessId,

        IntPtr excludeHwnd,

        out WindowHit hit)

    {

        hit = default;

        try

        {

            var pt = new PointNative { X = screenPoint.X, Y = screenPoint.Y };

            var hwnd = WindowFromPoint(pt);

            if (hwnd == IntPtr.Zero || hwnd == excludeHwnd)

                return false;



            hwnd = GetAncestor(hwnd, GaRoot);

            if (hwnd == IntPtr.Zero || hwnd == excludeHwnd)

                return false;



            if (!IsTopLevelCandidate(hwnd, Rectangle.Empty, excludeProcessId, out var bounds))

                return false;



            if (!bounds.Contains(screenPoint))

                return false;



            hit = new WindowHit(bounds, GetTitleSafe(hwnd));

            return true;

        }

        catch

        {

            return false;

        }

    }



    /// <summary>兜底：预采集列表里取面积最小且包含点的窗口（避免大透明窗盖住小窗）。</summary>

    public static bool TryHitWindow(

        IReadOnlyList<WindowHit> windows,

        Point screenPoint,

        out WindowHit hit)

    {

        hit = default;

        WindowHit? best = null;

        var bestArea = int.MaxValue;



        foreach (var w in windows)

        {

            if (w.Bounds.Width < 40 || w.Bounds.Height < 40)

                continue;

            if (!w.Bounds.Contains(screenPoint))

                continue;



            var area = w.Bounds.Width * w.Bounds.Height;

            if (area >= bestArea)

                continue;



            bestArea = area;

            best = w;

        }



        if (best is null)

            return false;



        hit = best.Value;

        return true;

    }



    public static Rectangle ScreenToClientRect(Rectangle screenRect, Point virtualOrigin) =>

        new(

            screenRect.X - virtualOrigin.X,

            screenRect.Y - virtualOrigin.Y,

            screenRect.Width,

            screenRect.Height);



    private static bool IsTopLevelCandidate(

        IntPtr hWnd,

        Rectangle virtualScreen,

        int excludeProcessId,

        out Rectangle bounds)

    {

        bounds = Rectangle.Empty;



        if (!IsWindow(hWnd) || !IsWindowVisible(hWnd) || IsIconic(hWnd))

            return false;



        GetWindowThreadProcessId(hWnd, out var pid);

        if (excludeProcessId > 0 && pid == (uint)excludeProcessId)

            return false;



        if (IsOverlayLike(hWnd))

            return false;



        var cls = GetClassNameSafe(hWnd);

        if (IsShellClass(cls))

            return false;



        bounds = GetWindowBoundsSafe(hWnd);

        if (bounds.Width < 40 || bounds.Height < 40)

            return false;



        return virtualScreen.IsEmpty || virtualScreen.IntersectsWith(bounds);

    }



    private static Rectangle GetWindowBoundsSafe(IntPtr hWnd)

    {

        if (!IsWindow(hWnd))

            return Rectangle.Empty;



        if (DwmGetWindowAttribute(hWnd, DwmwaExtendedFrameBounds, out var dwm, Marshal.SizeOf<Rect>()) == 0)

        {

            var rect = dwm.ToRectangle();

            if (rect.Width > 0 && rect.Height > 0)

                return rect;

        }



        return GetWindowRect(hWnd, out var raw) ? raw.ToRectangle() : Rectangle.Empty;

    }



    private static bool IsOverlayLike(IntPtr hWnd)

    {

        if (!IsWindow(hWnd))

            return true;



        var ex = GetWindowLongPtr(hWnd).ToInt64();

        if ((ex & WsExToolWindow) != 0 && (ex & WsExNoActivate) != 0)

            return true;



        var cls = GetClassNameSafe(hWnd);

        return cls is "Progman" or "WorkerW" or "Shell_TrayWnd" or "Shell_SecondaryTrayWnd"

            or "NotifyIconOverflowWindow" or "Windows.UI.Core.CoreWindow";

    }



    private static bool IsShellClass(string cls) =>

        cls is "Progman" or "WorkerW" or "Shell_TrayWnd" or "Shell_SecondaryTrayWnd";



    private static IntPtr GetWindowLongPtr(IntPtr hwnd)

    {

        if (!IsWindow(hwnd))

            return IntPtr.Zero;



        return IntPtr.Size == 8

            ? GetWindowLongPtr64(hwnd, GwlExStyle)

            : new IntPtr(GetWindowLong32(hwnd, GwlExStyle));

    }



    private static string GetClassNameSafe(IntPtr hWnd)

    {

        if (!IsWindow(hWnd))

            return "";



        try

        {

            var sb = new StringBuilder(256);

            return GetClassName(hWnd, sb, sb.Capacity) > 0 ? sb.ToString() : "";

        }

        catch

        {

            return "";

        }

    }



    private static string GetTitleSafe(IntPtr hWnd)

    {

        if (!IsWindow(hWnd))

            return "";



        try

        {

            var len = GetWindowTextLength(hWnd);

            if (len <= 0)

                return GetClassNameSafe(hWnd);



            var sb = new StringBuilder(len + 2);

            GetWindowText(hWnd, sb, sb.Capacity);

            var text = sb.ToString();

            return string.IsNullOrWhiteSpace(text) ? GetClassNameSafe(hWnd) : text;

        }

        catch

        {

            return "";

        }

    }

}

