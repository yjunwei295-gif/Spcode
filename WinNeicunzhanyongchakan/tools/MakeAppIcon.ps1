# 将 icons.png 去黑底、加深色描边，生成透明 app.ico / appicon.png
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = "c:\Users\Administrator\Desktop\WinNeicunzhanyongchakan"
$srcPath = Join-Path $root "MemWatch\icons.png"
$outPng = Join-Path $root "MemWatch\appicon.png"
$outIco = Join-Path $root "MemWatch\app.ico"
$outIcoBoot = Join-Path $root "MemWatch.Bootstrap\app.ico"

function Make-Transparent([System.Drawing.Bitmap]$src) {
    $bmp = New-Object System.Drawing.Bitmap $src.Width, $src.Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    for ($y = 0; $y -lt $src.Height; $y++) {
        for ($x = 0; $x -lt $src.Width; $x++) {
            $c = $src.GetPixel($x, $y)
            if ($c.R -le 18 -and $c.G -le 18 -and $c.B -le 18) {
                $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, 0, 0, 0))
            } else {
                $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(255, $c.R, $c.G, $c.B))
            }
        }
    }
    return $bmp
}

# 给不透明主体加外描边：先铺描边环，再盖回原图，边缘清晰不糊
function Add-Outline([System.Drawing.Bitmap]$src, [int]$radius, [System.Drawing.Color]$outline) {
    $pad = $radius + 1
    $w = $src.Width + $pad * 2
    $h = $src.Height + $pad * 2
    $dst = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)

    # 1) 外扩描边
    for ($y = 0; $y -lt $src.Height; $y++) {
        for ($x = 0; $x -lt $src.Width; $x++) {
            if ($src.GetPixel($x, $y).A -lt 128) { continue }
            for ($dy = -$radius; $dy -le $radius; $dy++) {
                for ($dx = -$radius; $dx -le $radius; $dx++) {
                    if (($dx * $dx + $dy * $dy) -gt ($radius * $radius)) { continue }
                    $px = $x + $pad + $dx
                    $py = $y + $pad + $dy
                    $dst.SetPixel($px, $py, $outline)
                }
            }
        }
    }

    # 2) 盖回原像素
    for ($y = 0; $y -lt $src.Height; $y++) {
        for ($x = 0; $x -lt $src.Width; $x++) {
            $c = $src.GetPixel($x, $y)
            if ($c.A -lt 8) { continue }
            $dst.SetPixel($x + $pad, $y + $pad, $c)
        }
    }
    return $dst
}

function Resize-Icon([System.Drawing.Bitmap]$src, [int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    # 像素风：小尺寸最近邻，大尺寸双三次
    if ($size -le 48) {
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    } else {
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    }
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
    $g.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, $size, $size))
    $g.Dispose()
    return $bmp
}

function Write-Ico([System.Drawing.Bitmap]$src, [string]$path, [int[]]$sizes) {
    $pngBlobs = New-Object System.Collections.Generic.List[object]
    foreach ($size in $sizes) {
        $resized = Resize-Icon $src $size
        $ms = New-Object System.IO.MemoryStream
        $resized.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $pngBlobs.Add(@{ Size = $size; Bytes = $ms.ToArray() }) | Out-Null
        $ms.Dispose()
        $resized.Dispose()
    }

    $fs = [System.IO.File]::Create($path)
    $bw = New-Object System.IO.BinaryWriter $fs
    $bw.Write([uint16]0)
    $bw.Write([uint16]1)
    $bw.Write([uint16]$pngBlobs.Count)

    $offset = 6 + 16 * $pngBlobs.Count
    foreach ($item in $pngBlobs) {
        $s = [int]$item.Size
        $bytes = [byte[]]$item.Bytes
        $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
        $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
        $bw.Write([byte]0)
        $bw.Write([byte]0)
        $bw.Write([uint16]1)
        $bw.Write([uint16]32)
        $bw.Write([int]$bytes.Length)
        $bw.Write([int]$offset)
        $offset += $bytes.Length
    }
    foreach ($item in $pngBlobs) {
        $bw.Write([byte[]]$item.Bytes)
    }
    $bw.Flush()
    $bw.Dispose()
    $fs.Dispose()
}

$src = [System.Drawing.Bitmap]::FromFile($srcPath)
Write-Host ("src {0}x{1}" -f $src.Width, $src.Height)
$transparent = Make-Transparent $src
# 深蓝黑描边：托盘浅底上更清晰，又不抢绿/黄
$outline = [System.Drawing.Color]::FromArgb(255, 18, 28, 48)
$stroked = Add-Outline $transparent 2 $outline
Write-Host ("stroked {0}x{1}" -f $stroked.Width, $stroked.Height)
$stroked.Save($outPng, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Ico $stroked $outIco @(16, 24, 32, 48, 64, 128, 256)
Copy-Item $outIco $outIcoBoot -Force
$src.Dispose()
$transparent.Dispose()
$stroked.Dispose()
Write-Host "OK: $outPng"
Write-Host "OK: $outIco"
Write-Host "OK: $outIcoBoot"
