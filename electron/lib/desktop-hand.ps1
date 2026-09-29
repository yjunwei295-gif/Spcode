# ASCII-only helper. Node writes one JSON command per line and reads one JSON line back.
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
  static readonly ControlType[] Wanted = new ControlType[] {
    ControlType.Button, ControlType.SplitButton, ControlType.MenuItem, ControlType.Edit, ControlType.Document,
    ControlType.CheckBox, ControlType.RadioButton, ControlType.ComboBox, ControlType.ListItem, ControlType.TabItem,
    ControlType.Hyperlink, ControlType.TreeItem, ControlType.Slider, ControlType.Spinner, ControlType.DataItem
  };
  static bool B(object o) { return o is bool && (bool)o; }

  public static object[] Scan(IntPtr hwnd, int max, int timeoutMs) {
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
    t.Start();
    if (!t.Join(timeoutMs)) return new object[] { -1, "timeout", null };
    if (err != null) return new object[] { -1, err, null };
    cache = els;
    seq++;
    return new object[] { seq, "", rows };
  }

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
      Send-Obj @{ ok = $true; hwnd = [string]$h.ToInt64(); pid = [int]$procId }
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
