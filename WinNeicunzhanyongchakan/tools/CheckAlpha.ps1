$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$p = "c:\Users\Administrator\Desktop\WinNeicunzhanyongchakan\MemWatch\appicon.png"
$b = [System.Drawing.Bitmap]::FromFile($p)
$trans = 0
$opaque = 0
for ($y=0; $y -lt $b.Height; $y++) {
  for ($x=0; $x -lt $b.Width; $x++) {
    $c = $b.GetPixel($x,$y)
    if ($c.A -eq 0) { $trans++ } else { $opaque++ }
  }
}
Write-Host ("size={0}x{1} transparent={2} opaque={3} cornerA={4}" -f $b.Width,$b.Height,$trans,$opaque,$b.GetPixel(0,0).A)
$b.Dispose()
