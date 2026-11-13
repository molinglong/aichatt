# 裁图工具：按比例坐标从照片裁出插图 PNG
# 用法: powershell -ExecutionPolicy Bypass -File tools/figcrop.ps1 -src <ASCII路径> -out <ASCII路径> -fx 0.1 -fy 0.2 -fw 0.5 -fh 0.3
# 注意: src/out 必须是 ASCII 路径（中文路径会乱码）,先用 Git Bash cp 到 crop-tmp/ 再裁,裁完 cp 回 slug images/
# 坑: 参数名不能用 x/y/w/h —— PowerShell 变量大小写不敏感,内部 [int]$W 会覆盖 [double]$w 导致 GDI+ 报"参数无效"
param(
  [Parameter(Mandatory=$true)][string]$src,
  [Parameter(Mandatory=$true)][string]$out,
  [Parameter(Mandatory=$true)][double]$fx,
  [Parameter(Mandatory=$true)][double]$fy,
  [Parameter(Mandatory=$true)][double]$fw,
  [Parameter(Mandatory=$true)][double]$fh
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($src)
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
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output "saved $out ($pw x $ph)"
  $g.Dispose(); $bmp.Dispose()
} finally {
  $img.Dispose()
}
