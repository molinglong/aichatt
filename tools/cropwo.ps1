# Crop + white-out handwritten marks in one pass (ratio coords, global reference).
# Usage: powershell -ExecutionPolicy Bypass -File crop-tmp/cropwo.ps1 -src <ascii> -out <ascii> -fx .. -fy .. -fw .. -fh .. -rects "gx,gy,gw,gh;gx,gy,gw,gh;..."
# rects = global-ratio white-fill rects; clamped to this crop and image bounds.
param(
  [Parameter(Mandatory=$true)][string]$src,
  [Parameter(Mandatory=$true)][string]$out,
  [Parameter(Mandatory=$true)][double]$fx,
  [Parameter(Mandatory=$true)][double]$fy,
  [Parameter(Mandatory=$true)][double]$fw,
  [Parameter(Mandatory=$true)][double]$fh,
  [string]$rects = "",
  [string]$fill = "255,255,255"
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($src)
$g = $null
$bmp = $null
try {
  $px = [int][Math]::Round($fx * $img.Width)
  $py = [int][Math]::Round($fy * $img.Height)
  $pw = [int][Math]::Round($fw * $img.Width)
  $ph = [int][Math]::Round($fh * $img.Height)
  if ($pw -le 0 -or $ph -le 0 -or $px -lt 0 -or $py -lt 0 -or ($px + $pw) -gt $img.Width -or ($py + $ph) -gt $img.Height) {
    throw "crop rect out of bounds: src $($img.Width)x$($img.Height), rect ($px,$py,$pw,$ph)"
  }
  $bmp = New-Object System.Drawing.Bitmap($pw, $ph)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $dstRect = New-Object System.Drawing.Rectangle(0, 0, $pw, $ph)
  $srcRect = New-Object System.Drawing.Rectangle($px, $py, $pw, $ph)
  $g.DrawImage($img, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
  if ($rects -ne "") {
    $fp = $fill.Split(',')
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb([int]$fp[0], [int]$fp[1], [int]$fp[2]))
    foreach ($r in $rects.Split(';')) {
      $p = $r.Split(',')
      $rx = [double]$p[0]; $ry = [double]$p[1]; $rw = [double]$p[2]; $rh = [double]$p[3]
      $x0 = [Math]::Max($rx, $fx) - $fx
      $y0 = [Math]::Max($ry, $fy) - $fy
      $x1 = [Math]::Min($rx + $rw, $fx + $fw) - $fx
      $y1 = [Math]::Min($ry + $rh, $fy + $fh) - $fy
      if ($x1 -le $x0 -or $y1 -le $y0) { continue }
      $rect = New-Object System.Drawing.Rectangle(
        [int][Math]::Round($x0 * $img.Width),
        [int][Math]::Round($y0 * $img.Height),
        [int][Math]::Round(($x1 - $x0) * $img.Width),
        [int][Math]::Round(($y1 - $y0) * $img.Height))
      $g.FillRectangle($brush, $rect)
    }
    $brush.Dispose()
  }
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output "saved $out ($pw x $ph)"
} finally {
  if ($g) { $g.Dispose() }
  if ($bmp) { $bmp.Dispose() }
  $img.Dispose()
}
