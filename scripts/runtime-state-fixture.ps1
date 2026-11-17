# 原生验收专用窗口与内存样本；只改自身数据，通过独立命令文件响应测试，不操作用户软件。
param([Parameter(Mandatory=$true)][string]$CommandPath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName System.Windows.Forms
# 子类只覆盖受保护属性，抑制 Add-Type 对“无新增公共成员”的提示，保持 stdout 为 JSON 协议。
Add-Type -WarningAction SilentlyContinue -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System.Windows.Forms;
// 测试窗口显示时不激活，不抢用户当前焦点。
public class RuntimeFixtureForm : Form {
 protected override bool ShowWithoutActivation { get { return true; } }
}
'@
$memory = [Runtime.InteropServices.Marshal]::AllocHGlobal(32)
[Runtime.InteropServices.Marshal]::WriteInt32($memory, 137)
$form = New-Object RuntimeFixtureForm
$form.Text = 'SpCode Runtime Fixture'
# 使用标准顶层窗口，确保与生产 Window-List 的无 owner 筛选条件一致。
$form.ShowInTaskbar = $true
$form.StartPosition = 'Manual'
$form.Location = New-Object Drawing.Point(40, 40)
$form.Size = New-Object Drawing.Size(360, 180)
$edit = New-Object Windows.Forms.TextBox
$edit.AccessibleName = 'SpCode Runtime Editor'
$edit.Text = 'ready'
$edit.Location = New-Object Drawing.Point(10, 10)
$edit.Width = 320
$form.Controls.Add($edit)
$toggle = New-Object Windows.Forms.CheckBox
$toggle.AccessibleName = 'SpCode Runtime Toggle'
$toggle.Text = 'State'
$toggle.Location = New-Object Drawing.Point(10, 45)
$form.Controls.Add($toggle)
# 两个相同名称的按钮用于确认多匹配不会随意选中其中一个。
for ($i = 0; $i -lt 2; $i++) {
 $button = New-Object Windows.Forms.Button
 $button.AccessibleName = 'SpCode Duplicate'
 $button.Text = 'Duplicate'
 $button.Location = New-Object Drawing.Point((10 + $i * 110), 80)
 $form.Controls.Add($button)
}
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 50
$timer.Add_Tick({
 try {
  if (-not [IO.File]::Exists($CommandPath)) { return }
  $command = [IO.File]::ReadAllText($CommandPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
  [IO.File]::Delete($CommandPath)
  if ($command.exit) { $form.Close(); return }
  if ($null -ne $command.text) { $edit.Text = [string]$command.text }
  if ($null -ne $command.toggle) { $toggle.Checked = [bool]$command.toggle }
  if ($null -ne $command.value) { [Runtime.InteropServices.Marshal]::WriteInt32($memory, [int]$command.value) }
  [Console]::WriteLine((@{ack=$true} | ConvertTo-Json -Compress))
 } catch {
  [Console]::WriteLine((@{error=$_.Exception.Message} | ConvertTo-Json -Compress))
  $form.Close()
 }
})
$form.Add_Shown({
 [Console]::WriteLine((@{pid=$PID;hwnd=[string]$form.Handle.ToInt64();address=('0x' + $memory.ToInt64().ToString('X'))} | ConvertTo-Json -Compress))
 $timer.Start()
})
try { [Windows.Forms.Application]::Run($form) }
finally { $timer.Stop(); $timer.Dispose(); $form.Dispose(); [Runtime.InteropServices.Marshal]::FreeHGlobal($memory) }
