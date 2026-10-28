# 从用户指定的参考图浏览器获取窗口图像，不移动用户窗口。
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ReferenceWindow {
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int L,T,R,B; }
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
 public delegate bool WindowVisitor(IntPtr h,IntPtr data);
 [DllImport("user32.dll")] public static extern bool EnumWindows(WindowVisitor visitor,IntPtr data);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,System.Text.StringBuilder text,int size);
 private static string wanted;private static IntPtr found;
 private static bool Visit(IntPtr h,IntPtr data){var text=new System.Text.StringBuilder(2048);GetWindowText(h,text,text.Capacity);if(text.ToString().Contains(wanted)){found=h;return false;}return true;}
 public static IntPtr Find(string title){wanted=title;found=IntPtr.Zero;EnumWindows(Visit,IntPtr.Zero);return found;}
}
'@
$referenceHandle = [ReferenceWindow]::Find('摩羯的搜索结果')
if ($referenceHandle -eq [IntPtr]::Zero) { throw '没有找到用户指定的摩羯参考图浏览器窗口' }
$rect = New-Object ReferenceWindow+Rect
[ReferenceWindow]::GetWindowRect($referenceHandle,[ref]$rect) | Out-Null
$bitmap = New-Object System.Drawing.Bitmap(($rect.R-$rect.L),($rect.B-$rect.T))
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$dc = $graphics.GetHdc()
$printed = [ReferenceWindow]::PrintWindow($referenceHandle,$dc,2)
$graphics.ReleaseHdc($dc)
if (-not $printed) { throw '参考图窗口截图失败' }
$outputPath = Join-Path (Get-Location) 'generated/desktop-pet-check/reference.png'
$bitmap.Save($outputPath,[System.Drawing.Imaging.ImageFormat]::Png)
[System.Windows.Forms.Clipboard]::SetImage($bitmap)
$graphics.Dispose()
$bitmap.Dispose()
Write-Output $outputPath
