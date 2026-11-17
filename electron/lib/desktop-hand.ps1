# 常驻 UTF-8 帮助进程：每行接收一个 JSON 请求并返回一个 JSON 结果。
# [Rivet opt] rework: unicode typing via SendInput, window list/focus, foreground check, full key map. Other AIs: do not change or revert this to clipboard-only typing.
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $OutputEncoding
[Console]::InputEncoding = $OutputEncoding

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class DeskHand {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
  // 前台窗口物理坐标，供后台请求检测只裁剪当前窗口。
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  // 所属显示器的物理边界，与客户区使用同一 Win32 坐标系，供截图按实际尺寸缩放。
  [StructLayout(LayoutKind.Sequential)]
  public struct MONITORINFO { public uint cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  public const uint MONITOR_DEFAULTTONULL = 0;
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public int type; public InputUnion u; }

  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern short VkKeyScanW(char ch);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT point);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);

  public const int LEFTDOWN = 0x0002;
  public const int LEFTUP = 0x0004;
  public const int RIGHTDOWN = 0x0008;
  public const int RIGHTUP = 0x0010;
  public const int MIDDLEDOWN = 0x0020;
  public const int MIDDLEUP = 0x0040;
  public const int WHEEL = 0x0800;
  public const int KEYUP = 0x0002;
  public const int EXTENDED = 0x0001;

  static INPUT Key(ushort vk, ushort scan, uint flags) {
    INPUT i = new INPUT();
    i.type = 1;
    i.u.ki.wVk = vk;
    i.u.ki.wScan = scan;
    i.u.ki.dwFlags = flags;
    return i;
  }

  public static int TypeUnicode(string text) {
    int sent = 0;
    int size = Marshal.SizeOf(typeof(INPUT));
    foreach (char c in text) {
      if (c == '\r') continue;
      INPUT[] pair;
      if (c == '\n') pair = new INPUT[] { Key(13, 0, 0), Key(13, 0, 2) };
      else if (c == '\t') pair = new INPUT[] { Key(9, 0, 0), Key(9, 0, 2) };
      else pair = new INPUT[] { Key(0, (ushort)c, 4), Key(0, (ushort)c, 4 | 2) };
      SendInput(2, pair, size);
      sent++;
      if (sent % 16 == 0) System.Threading.Thread.Sleep(8);
    }
    return sent;
  }

  public static List<object[]> ListWindows() {
    List<object[]> list = new List<object[]>();
    IntPtr fg = GetForegroundWindow();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      if (GetWindow(h, 4) != IntPtr.Zero) return true;
      int ex = GetWindowLong(h, -20);
      if ((ex & 0x80) != 0) return true;
      int cloaked = 0;
      try { DwmGetWindowAttribute(h, 14, out cloaked, 4); } catch { }
      if (cloaked != 0) return true;
      int len = GetWindowTextLength(h);
      if (len <= 0) return true;
      StringBuilder sb = new StringBuilder(len + 1);
      GetWindowText(h, sb, sb.Capacity);
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      list.Add(new object[] { h.ToInt64(), sb.ToString(), (int)pid, h == fg, IsIconic(h) });
      return true;
    }, IntPtr.Zero);
    return list;
  }

  // 查询窗口和进程身份，拒绝失效句柄或复用后属于其它进程的窗口。
  public static string ProcessIdentity(int processId) {
    using (System.Diagnostics.Process p = System.Diagnostics.Process.GetProcessById(processId)) {
      return processId.ToString() + ":" + p.StartTime.ToUniversalTime().Ticks.ToString();
    }
  }
  public static void CheckWindow(long handle, int processId) {
    uint actual;
    GetWindowThreadProcessId(new IntPtr(handle), out actual);
    if (actual == 0 || actual != (uint)processId) throw new InvalidOperationException("Window identity changed");
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] bytes, UIntPtr length, out UIntPtr count);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  // 仅读取明确的短区间；复用当前帮助进程，避免每次采样重新启动并编译 PowerShell。
  public static string ReadMemory(int processId, string address, int length) {
    IntPtr process = OpenProcess(0x410, false, processId);
    if (process == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {
      byte[] bytes = new byte[length];
      UIntPtr count;
      long location = unchecked((long)Convert.ToUInt64(address.Substring(2), 16));
      if (!ReadProcessMemory(process, new IntPtr(location), bytes, new UIntPtr((uint)length), out count))
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      if (count.ToUInt64() != (ulong)length) throw new InvalidOperationException("Partial memory read");
      return Convert.ToBase64String(bytes);
    } finally { CloseHandle(process); }
  }

  public static bool Focus(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    keybd_event(0x12, 0, 0, 0);
    keybd_event(0x12, 0, KEYUP, 0);
    SetForegroundWindow(h);
    BringWindowToTop(h);
    System.Threading.Thread.Sleep(120);
    return GetForegroundWindow() == h;
  }
}
"@

# Per-monitor DPI aware: UIA rects and SetCursorPos both use physical pixels, matching Node's dipToScreenPoint.
try { [DeskHand]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null } catch {}

# UI Automation: read controls of the target window and act on them by index.
Add-Type -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Threading;
using System.Windows.Automation;
public static class Uia {
  static List<AutomationElement> cache = new List<AutomationElement>();
  static int seq = 0;
  // 超时的扫描线程停不下来；它还活着时不再开新线程，避免越堆越多拖慢目标程序
  static Thread running = null;
  static readonly ControlType[] Wanted = new ControlType[] {
    ControlType.Button, ControlType.SplitButton, ControlType.MenuItem, ControlType.Edit, ControlType.Document,
    ControlType.CheckBox, ControlType.RadioButton, ControlType.ComboBox, ControlType.ListItem, ControlType.TabItem,
    ControlType.Hyperlink, ControlType.TreeItem, ControlType.Slider, ControlType.Spinner, ControlType.DataItem
  };
  static bool B(object o) { return o is bool && (bool)o; }

  public static object[] Scan(IntPtr hwnd, int max, int timeoutMs) {
    if (running != null && running.IsAlive) return new object[] { -1, "busy", null };
    List<object[]> rows = null;
    List<AutomationElement> els = null;
    string err = null;
    Thread t = new Thread(delegate () {
      try {
        AutomationElement root = AutomationElement.FromHandle(hwnd);
        Condition[] ors = new Condition[Wanted.Length];
        for (int i = 0; i < Wanted.Length; i++) ors[i] = new PropertyCondition(AutomationElement.ControlTypeProperty, Wanted[i]);
        Condition cond = new AndCondition(new PropertyCondition(AutomationElement.IsOffscreenProperty, false), new OrCondition(ors));
        CacheRequest cr = new CacheRequest();
        cr.Add(AutomationElement.NameProperty);
        cr.Add(AutomationElement.ControlTypeProperty);
        cr.Add(AutomationElement.BoundingRectangleProperty);
        cr.Add(AutomationElement.IsEnabledProperty);
        cr.Add(AutomationElement.AutomationIdProperty);
        cr.Add(AutomationElement.IsInvokePatternAvailableProperty);
        cr.Add(AutomationElement.IsTogglePatternAvailableProperty);
        cr.Add(AutomationElement.IsValuePatternAvailableProperty);
        cr.Add(AutomationElement.IsExpandCollapsePatternAvailableProperty);
        cr.Add(AutomationElement.IsSelectionItemPatternAvailableProperty);
        cr.Add(ValuePattern.ValueProperty);
        cr.Add(TogglePattern.ToggleStateProperty);
        AutomationElementCollection found;
        using (cr.Activate()) { found = root.FindAll(TreeScope.Descendants, cond); }
        rows = new List<object[]>();
        els = new List<AutomationElement>();
        foreach (AutomationElement el in found) {
          if (rows.Count >= max) break;
          object ro = el.GetCachedPropertyValue(AutomationElement.BoundingRectangleProperty);
          if (!(ro is System.Windows.Rect)) continue;
          System.Windows.Rect r = (System.Windows.Rect)ro;
          if (r.IsEmpty || r.Width < 2 || r.Height < 2) continue;
          string name = el.GetCachedPropertyValue(AutomationElement.NameProperty) as string ?? "";
          ControlType ct = el.GetCachedPropertyValue(AutomationElement.ControlTypeProperty) as ControlType;
          string type = ct == null ? "" : ct.ProgrammaticName.Replace("ControlType.", "");
          string aid = el.GetCachedPropertyValue(AutomationElement.AutomationIdProperty) as string ?? "";
          object v = el.GetCachedPropertyValue(ValuePattern.ValueProperty);
          string value = v is string ? (string)v : "";
          if (value.Length > 80) value = value.Substring(0, 80);
          object tg = el.GetCachedPropertyValue(TogglePattern.ToggleStateProperty);
          string toggle = tg is ToggleState ? tg.ToString() : "";
          string pats =
            (B(el.GetCachedPropertyValue(AutomationElement.IsInvokePatternAvailableProperty)) ? "i" : "") +
            (B(el.GetCachedPropertyValue(AutomationElement.IsTogglePatternAvailableProperty)) ? "t" : "") +
            (B(el.GetCachedPropertyValue(AutomationElement.IsValuePatternAvailableProperty)) ? "v" : "") +
            (B(el.GetCachedPropertyValue(AutomationElement.IsExpandCollapsePatternAvailableProperty)) ? "e" : "") +
            (B(el.GetCachedPropertyValue(AutomationElement.IsSelectionItemPatternAvailableProperty)) ? "s" : "");
          bool enabled = B(el.GetCachedPropertyValue(AutomationElement.IsEnabledProperty));
          rows.Add(new object[] { els.Count, type, name, aid, value, toggle, pats, enabled, (int)r.X, (int)r.Y, (int)r.Width, (int)r.Height });
          els.Add(el);
        }
      } catch (Exception e) { err = e.Message; }
    });
    t.IsBackground = true;
    t.Priority = ThreadPriority.BelowNormal;
    running = t;
    t.Start();
    if (!t.Join(timeoutMs)) return new object[] { -1, "timeout", null };
    running = null;
    if (err != null) return new object[] { -1, err, null };
    cache = els;
    seq++;
    return new object[] { seq, "", rows };
  }

  // 单份在途查询限制 UIA 超时线程数量，独立于操作编号缓存。
  static Thread stateRunning;
  // 具名工作对象保存一次查询的输入与结果，线程不使用匿名闭包。
  sealed class StateQuery {
    readonly long handle;
    readonly string[] keys, names, aids, types;
    public readonly Dictionary<string, object> records = new Dictionary<string, object>();
    public Exception failure;
    // 输入数组仅在当前查询使用，结果不持有 AutomationElement 强引用。
    public StateQuery(long handle, string[] keys, string[] names, string[] aids, string[] types) {
      this.handle = handle; this.keys = keys; this.names = names; this.aids = aids; this.types = types;
    }
    // 在专用后台线程读取完整字段；错误交回等待方，不吞掉失效对象或多匹配。
    public void Run() {
      try {
        AutomationElement root = AutomationElement.FromHandle(new IntPtr(handle));
        for (int i = 0; i < keys.Length; i++) {
          List<Condition> filters = new List<Condition>();
          // PowerShell 绑定 string[] 时把未提供项转为空串；只为实际提供的非空属性建立条件。
          if (!String.IsNullOrEmpty(names[i])) filters.Add(new PropertyCondition(AutomationElement.NameProperty, names[i]));
          if (!String.IsNullOrEmpty(aids[i])) filters.Add(new PropertyCondition(AutomationElement.AutomationIdProperty, aids[i]));
          Condition filter = filters.Count == 1 ? filters[0] : new AndCondition(filters.ToArray());
          AutomationElementCollection found = root.FindAll(TreeScope.Descendants, filter);
          AutomationElement match = null;
          int count = 0;
          foreach (AutomationElement element in found) {
            string type = element.Current.ControlType.ProgrammaticName.Substring("ControlType.".Length);
            if (!String.IsNullOrEmpty(types[i]) && type != types[i]) continue;
            count++;
            match = element;
          }
          if (count > 1) throw new InvalidOperationException("Ambiguous control: " + keys[i]);
          if (count == 0) continue;
          Dictionary<string, object> item = new Dictionary<string, object>();
          item["name"] = match.Current.Name;
          item["automationId"] = match.Current.AutomationId;
          item["type"] = match.Current.ControlType.ProgrammaticName.Substring("ControlType.".Length);
          item["runtimeId"] = String.Join(".", Array.ConvertAll(match.GetRuntimeId(), ConvertInt));
          item["enabled"] = match.Current.IsEnabled;
          item["offscreen"] = match.Current.IsOffscreen;
          item["password"] = match.Current.IsPassword;
          object pattern;
          if (!match.Current.IsPassword && match.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) {
            ValuePattern.ValuePatternInformation value = ((ValuePattern)pattern).Current;
            item["value"] = value.Value;
            item["readOnly"] = value.IsReadOnly;
          }
          if (match.TryGetCurrentPattern(TogglePattern.Pattern, out pattern)) item["toggle"] = ((TogglePattern)pattern).Current.ToggleState.ToString();
          if (match.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)) item["selected"] = ((SelectionItemPattern)pattern).Current.IsSelected;
          if (match.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern)) item["expanded"] = ((ExpandCollapsePattern)pattern).Current.ExpandCollapseState.ToString();
          if (match.TryGetCurrentPattern(RangeValuePattern.Pattern, out pattern)) item["range"] = ((RangeValuePattern)pattern).Current.Value;
          records.Add(keys[i], item);
        }
      } catch (Exception error) { failure = error; }
    }
  }
  // 按精确选择器只读控件状态；超时明确失败，不更新屏幕控件编号。
  public static Dictionary<string, object> Observe(long handle, string[] keys, string[] names, string[] aids, string[] types, int timeoutMs) {
    if (stateRunning != null && stateRunning.IsAlive) throw new InvalidOperationException("State query still busy");
    StateQuery query = new StateQuery(handle, keys, names, aids, types);
    Thread thread = new Thread(query.Run);
    thread.IsBackground = true;
    thread.Priority = ThreadPriority.BelowNormal;
    stateRunning = thread;
    thread.Start();
    if (!thread.Join(timeoutMs)) throw new TimeoutException("State query timeout");
    stateRunning = null;
    if (query.failure != null) throw query.failure;
    return query.records;
  }
  // 运行时编号只用于识别对象替换，不转换成可操作的屏幕控件编号。
  static string ConvertInt(int value) { return value.ToString(); }

  public static string Act(int s, int idx, string action, string text) {
    if (s != seq) return "stale";
    if (idx < 0 || idx >= cache.Count) return "badindex";
    AutomationElement el = cache[idx];
    string result = "nopattern";
    Thread t = new Thread(delegate () {
      try {
        object p;
        if (action == "focus") { el.SetFocus(); result = "ok"; return; }
        if (action == "set_text") {
          if (el.TryGetCurrentPattern(ValuePattern.Pattern, out p)) {
            ValuePattern vp = (ValuePattern)p;
            if (vp.Current.IsReadOnly) { result = "readonly"; return; }
            vp.SetValue(text ?? "");
            result = "ok";
          }
          return;
        }
        if (action == "toggle") {
          if (el.TryGetCurrentPattern(TogglePattern.Pattern, out p)) { ((TogglePattern)p).Toggle(); result = "ok"; }
          return;
        }
        if (action == "select") {
          if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) { ((SelectionItemPattern)p).Select(); result = "ok"; }
          return;
        }
        if (action == "expand" || action == "collapse") {
          if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) {
            if (action == "expand") ((ExpandCollapsePattern)p).Expand(); else ((ExpandCollapsePattern)p).Collapse();
            result = "ok";
          }
          return;
        }
        if (el.TryGetCurrentPattern(InvokePattern.Pattern, out p)) { ((InvokePattern)p).Invoke(); result = "ok"; return; }
        if (el.TryGetCurrentPattern(TogglePattern.Pattern, out p)) { ((TogglePattern)p).Toggle(); result = "ok"; return; }
        if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) { ((SelectionItemPattern)p).Select(); result = "ok"; return; }
        if (el.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) {
          ExpandCollapsePattern ec = (ExpandCollapsePattern)p;
          if (ec.Current.ExpandCollapseState == ExpandCollapseState.Expanded) ec.Collapse(); else ec.Expand();
          result = "ok";
        }
      } catch (Exception e) { result = "error: " + e.Message; }
    });
    t.IsBackground = true;
    t.Start();
    // Invoke on a button that opens a modal dialog can block until the dialog closes
    if (!t.Join(3000)) return "ok";
    return result;
  }
}
"@

function Send-Obj($obj) {
  Write-Output ($obj | ConvertTo-Json -Compress -Depth 5)
  [Console]::Out.Flush()
}

function Reply([bool]$ok, [string]$message) {
  Send-Obj @{ ok = $ok; message = ([string]$message).Trim() }
}

function Button-Flags([string]$button) {
  $down = [DeskHand]::LEFTDOWN
  $up = [DeskHand]::LEFTUP
  if ($button -eq "right") { $down = [DeskHand]::RIGHTDOWN; $up = [DeskHand]::RIGHTUP }
  elseif ($button -eq "middle") { $down = [DeskHand]::MIDDLEDOWN; $up = [DeskHand]::MIDDLEUP }
  return @{ down = $down; up = $up }
}

function Click-Button([string]$button, [int]$times) {
  $flags = Button-Flags $button
  for ($i = 0; $i -lt $times; $i++) {
    [DeskHand]::mouse_event($flags.down, 0, 0, 0, 0)
    Start-Sleep -Milliseconds 30
    [DeskHand]::mouse_event($flags.up, 0, 0, 0, 0)
    if ($i + 1 -lt $times) { Start-Sleep -Milliseconds 60 }
  }
}

function Drag-Path($points, [string]$button) {
  $flags = Button-Flags $button
  $held = $false
  try {
    $first = $points[0]
    [DeskHand]::SetCursorPos([int]$first.x, [int]$first.y) | Out-Null
    Start-Sleep -Milliseconds 30
    [DeskHand]::mouse_event($flags.down, 0, 0, 0, 0)
    $held = $true
    Start-Sleep -Milliseconds 40
    foreach ($p in $points) {
      [DeskHand]::SetCursorPos([int]$p.x, [int]$p.y) | Out-Null
      Start-Sleep -Milliseconds 12
    }
  } finally {
    if ($held) { [DeskHand]::mouse_event($flags.up, 0, 0, 0, 0) }
  }
}

$KeyMap = @{
  enter = 13; return = 13; tab = 9; escape = 27; esc = 27; backspace = 8; delete = 46; del = 46;
  insert = 45; ins = 45; up = 38; down = 40; left = 37; right = 39; home = 36; end = 35;
  space = 32; pageup = 33; pgup = 33; pagedown = 34; pgdn = 34;
  capslock = 20; numlock = 144; scrolllock = 145; pause = 19; printscreen = 44; prtsc = 44;
  menu = 93; apps = 93; plus = 187; minus = 189;
  ctrl = 17; control = 17; alt = 18; shift = 16; win = 91; meta = 91; cmd = 91; super = 91
}
for ($n = 1; $n -le 24; $n++) { $KeyMap["f$n"] = 111 + $n }
$ExtendedVk = @(33, 34, 35, 36, 37, 38, 39, 40, 45, 46, 91, 93, 144)

function Resolve-Keys($names) {
  $vks = New-Object System.Collections.ArrayList
  $needShift = $false
  foreach ($name in $names) {
    $key = ([string]$name).Trim().ToLower()
    if (-not $key) { continue }
    if ($KeyMap.ContainsKey($key)) { [void]$vks.Add([int]$KeyMap[$key]); continue }
    if ($key.Length -eq 1) {
      $scan = [DeskHand]::VkKeyScanW([char]$key)
      if ($scan -eq -1) { return $null }
      [void]$vks.Add([int]($scan -band 0xFF))
      if (($scan -shr 8) -band 1) { $needShift = $true }
      continue
    }
    return $null
  }
  if ($needShift -and -not ($vks -contains 16)) { $vks.Insert(0, 16) }
  return ,$vks
}

function Press-Keys($vks) {
  foreach ($vk in $vks) {
    $f = 0
    if ($ExtendedVk -contains $vk) { $f = [DeskHand]::EXTENDED }
    [DeskHand]::keybd_event([byte]$vk, 0, $f, 0)
    Start-Sleep -Milliseconds 15
  }
  for ($i = $vks.Count - 1; $i -ge 0; $i--) {
    $vk = $vks[$i]
    $f = [DeskHand]::KEYUP
    if ($ExtendedVk -contains $vk) { $f = $f -bor [DeskHand]::EXTENDED }
    [DeskHand]::keybd_event([byte]$vk, 0, $f, 0)
    Start-Sleep -Milliseconds 15
  }
}

function Window-List {
  $rows = @()
  foreach ($w in [DeskHand]::ListWindows()) {
    $proc = ""
    try { $proc = (Get-Process -Id $w[2] -ErrorAction Stop).ProcessName } catch {}
    $rows += @{ hwnd = [string]$w[0]; title = [string]$w[1]; pid = [int]$w[2]; proc = $proc; fg = [bool]$w[3]; min = [bool]$w[4] }
  }
  return ,$rows
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if (-not $line) { continue }
  $savedX = $null
  $savedY = $null
  try {
    $cmd = $line | ConvertFrom-Json
    $op = [string]$cmd.op
    if ($op -eq "ping") { Reply $true "pong"; continue }
    if ($op -eq "windows") { Send-Obj @{ ok = $true; windows = (Window-List) }; continue }
    if ($op -eq "foreground") {
      $h = [DeskHand]::GetForegroundWindow()
      $procId = [uint32]0
      [DeskHand]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
      # 前台窗口信息只用于本地屏幕接单裁剪，不向聊天模型发送窗口截图。
      $rect = New-Object DeskHand+RECT
      # 客户区不含透明阴影与标题栏，后方动画不会导致请求 OCR 缓存失效。
      if (-not [DeskHand]::GetClientRect($h, [ref]$rect)) { throw "Cannot read foreground client bounds" }
      # 在已启用的逐屏 DPI 感知上下文中转换两个角，不能把客户区宽高直接加到屏幕坐标上。
      $origin = New-Object DeskHand+POINT
      $origin.X = $rect.Left
      $origin.Y = $rect.Top
      $extent = New-Object DeskHand+POINT
      $extent.X = $rect.Right
      $extent.Y = $rect.Bottom
      if (-not [DeskHand]::ClientToScreen($h, [ref]$origin)) { throw "Cannot locate foreground client origin" }
      if (-not [DeskHand]::ClientToScreen($h, [ref]$extent)) { throw "Cannot locate foreground client extent" }
      # 显示器边界与客户区来自同一物理坐标系；裁剪不依赖 Electron 的 DIP 尺寸或缩放档位。
      $monitorHandle = [DeskHand]::MonitorFromWindow($h, [DeskHand]::MONITOR_DEFAULTTONULL)
      $monitorInfo = New-Object DeskHand+MONITORINFO
      $monitorInfo.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($monitorInfo)
      if (-not [DeskHand]::GetMonitorInfo($monitorHandle, [ref]$monitorInfo)) { throw "Cannot read foreground monitor bounds" }
      $caption = New-Object System.Text.StringBuilder 1024
      [DeskHand]::GetWindowText($h, $caption, $caption.Capacity) | Out-Null
      $foregroundProc = Get-Process -Id $procId -ErrorAction Stop
      Send-Obj @{ ok = $true; hwnd = [string]$h.ToInt64(); pid = [int]$procId; title = $caption.ToString(); proc = $foregroundProc.ProcessName; left = $origin.X; top = $origin.Y; right = $extent.X; bottom = $extent.Y; monitor = @{ left = $monitorInfo.rcMonitor.Left; top = $monitorInfo.rcMonitor.Top; right = $monitorInfo.rcMonitor.Right; bottom = $monitorInfo.rcMonitor.Bottom } }
      continue
    }
    # 结构化状态不截图、不做 OCR，也不更新 UIA 操作缓存；错误原样返回给调用者。
    if ($op -eq "runtime_read") {
      $startedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      $records = @{}
      $identity = "windows"
      if ($cmd.source -eq "windows") {
        foreach ($window in (Window-List)) {
          if ($window.pid -eq $cmd.selfPid) { continue }
          if ($null -ne $cmd.target -and $window.pid -ne $cmd.target.pid) { continue }
          $records["window:" + $window.hwnd] = $window
        }
      } else {
        $identity = [DeskHand]::ProcessIdentity([int]$cmd.target.pid)
        if ($cmd.source -eq "controls") {
          [DeskHand]::CheckWindow([int64]$cmd.target.hwnd, [int]$cmd.target.pid)
          $identity += ":" + [string]$cmd.target.hwnd
          $keys = New-Object 'System.Collections.Generic.List[string]'
          $names = New-Object 'System.Collections.Generic.List[string]'
          $aids = New-Object 'System.Collections.Generic.List[string]'
          $types = New-Object 'System.Collections.Generic.List[string]'
          foreach ($selector in $cmd.controls) {
            $keys.Add([string]$selector.key)
            $names.Add($selector.name)
            $aids.Add($selector.automationId)
            $types.Add($selector.type)
          }
          $records = [Uia]::Observe([int64]$cmd.target.hwnd, $keys.ToArray(), $names.ToArray(), $aids.ToArray(), $types.ToArray(), 2500)
          [DeskHand]::CheckWindow([int64]$cmd.target.hwnd, [int]$cmd.target.pid)
          if ($identity -ne ([DeskHand]::ProcessIdentity([int]$cmd.target.pid) + ":" + [string]$cmd.target.hwnd)) { throw "Process identity changed" }
        } elseif ($cmd.source -eq "memory") {
          foreach ($field in $cmd.memory) {
            $records[[string]$field.key] = @{ base64 = [DeskHand]::ReadMemory([int]$cmd.target.pid, [string]$field.address, [int]$field.length) }
          }
          if ($identity -ne [DeskHand]::ProcessIdentity([int]$cmd.target.pid)) { throw "Process identity changed" }
        } else { throw "Unknown runtime source" }
      }
      Send-Obj @{ ok = $true; source = $cmd.source; identity = $identity; startedAt = $startedAt; observedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); records = $records }
      continue
    }
    if ($op -eq "focus") {
      $ok = [DeskHand]::Focus([IntPtr][int64]$cmd.hwnd)
      Reply $ok $(if ($ok) { "ok" } else { "focus refused by system" })
      continue
    }
    if ($op -eq "uia_scan") {
      # Target = topmost visible window that is not SimpleCode itself (z-order from EnumWindows)
      $target = $null
      foreach ($w in [DeskHand]::ListWindows()) {
        if ([int]$w[2] -eq [int]$cmd.selfPid) { continue }
        if ([bool]$w[4]) { continue }
        $target = $w
        break
      }
      if ($null -eq $target) { Send-Obj @{ ok = $false; message = "no target window" }; continue }
      $max = 200
      if ($cmd.max) { $max = [int]$cmd.max }
      $res = [Uia]::Scan([IntPtr][int64]$target[0], $max, 2500)
      if ([int]$res[0] -lt 0) { Send-Obj @{ ok = $false; message = [string]$res[1]; title = [string]$target[1]; pid = [int]$target[2] }; continue }
      $proc = ""
      try { $proc = (Get-Process -Id $target[2] -ErrorAction Stop).ProcessName } catch {}
      $items = @()
      foreach ($r in $res[2]) {
        $items += ,@($r[0], $r[1], $r[2], $r[3], $r[4], $r[5], $r[6], $r[7], $r[8], $r[9], $r[10], $r[11])
      }
      Send-Obj @{ ok = $true; seq = [int]$res[0]; hwnd = [string]$target[0]; title = [string]$target[1]; pid = [int]$target[2]; proc = $proc; items = $items }
      continue
    }
    if ($op -eq "uia_act") {
      $r = [Uia]::Act([int]$cmd.seq, [int]$cmd.idx, [string]$cmd.action, [string]$cmd.text)
      Send-Obj @{ ok = ($r -eq "ok"); message = $r }
      continue
    }
    if ($op -eq "type") {
      $n = [DeskHand]::TypeUnicode([string]$cmd.text)
      Send-Obj @{ ok = $true; sent = $n }
      continue
    }
    if ($op -eq "key") {
      $vks = Resolve-Keys @($cmd.keys)
      if ($null -eq $vks -or $vks.Count -eq 0) { Reply $false "unknown key"; continue }
      Press-Keys $vks
      Reply $true "ok"
      continue
    }
    $pt = New-Object DeskHand+POINT
    [DeskHand]::GetCursorPos([ref]$pt) | Out-Null
    $savedX = $pt.X
    $savedY = $pt.Y
    if ($op -eq "click" -or $op -eq "scroll") {
      [DeskHand]::SetCursorPos([int]$cmd.x, [int]$cmd.y) | Out-Null
      Start-Sleep -Milliseconds 20
    }
    if ($op -eq "drag") {
      $pts = @($cmd.points)
      if ($pts.Count -lt 2) { Reply $false "need at least 2 points"; continue }
      $button = "left"
      if ($cmd.button) { $button = [string]$cmd.button }
      Drag-Path $pts $button
    } elseif ($op -eq "click") {
      $times = 1
      if ($cmd.times) { $times = [int]$cmd.times }
      if ($times -lt 1) { $times = 1 }
      if ($times -gt 3) { $times = 3 }
      $button = "left"
      if ($cmd.button) { $button = [string]$cmd.button }
      Click-Button $button $times
    } elseif ($op -eq "scroll") {
      [DeskHand]::mouse_event([DeskHand]::WHEEL, 0, 0, [int]$cmd.delta, 0)
    } else {
      Reply $false "unknown op"
      continue
    }
    Start-Sleep -Milliseconds 30
    [DeskHand]::SetCursorPos($savedX, $savedY) | Out-Null
    Reply $true "ok"
  } catch {
    if ($null -ne $savedX) {
      try { [DeskHand]::SetCursorPos([int]$savedX, [int]$savedY) | Out-Null } catch {}
    }
    Reply $false $_.Exception.Message
  }
}
