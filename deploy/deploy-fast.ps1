# deploy-fast.ps1 — aichatt 本地构建产物直推 VPS（3-5 分钟热修）
#
# 前置条件（只需一次）:
#   1. compose 已切到挂载产物模式（/opt/aichatt-dist:/app:ro, 见 deploy/docker-compose.yml）
#   2. VPS 已有对应 Node 大版本 slim 镜像（node:24-slim, 与本地 node -v 对齐）
#   3. SSH 免密: ssh root@yuban.icu 能直连
#
# 用法:  powershell -File deploy/deploy-fast.ps1
# 原理:  本地 npm run build → 组装 standalone 产物(排除 win32 sharp)
#        → tar.gz → scp → VPS 解压到 .new 目录 → mv 原子切换 → 重启容器 → 健康验证
#        验证失败自动回滚（把 .old 目录换回去重启）。
#
# 注意:  构建走独立 distDir(.next-deploy), 与运行中 dev 的 .next 完全隔离, 产物不会被 dev 写坏;
#        [1/6] 的 dev 暂停逻辑保留(部署结束无论成败自动恢复), 但不再依赖它保证产物完整。

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path $PSScriptRoot -Parent
$VpsHost = "root@yuban.icu"
$DistDir = "/opt/aichatt-dist"
# 包名带时间戳: 防并行会话/历史残留撞车——2026-09-29 两会话同写 /tmp/aichatt-dist.tar.gz,
# 我方 [6/6] 读到被并发写坏的包导致解压失败(本地包完好、通道干净, 纯属路径撞车)
$PkgName = "aichatt-dist-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".tar.gz"
# scp 上传限速(Kbit/s): 家宽上行被 scp 打满会拖慢全屋上网, 默认 ~1.1MB/s(实测链路峰值 1.8MB/s 的一半);
# 设 0 则不限速全速上传
$UploadLimitKbps = 9000

Write-Host "=== [1/6] dev server 自动暂停（部署结束后自动恢复）===" -ForegroundColor Cyan
# dev/build 共用 .next 会互相写坏产物必须错峰; 之前检测到就直接报错退出让用户手动停,
# 部署完还得手动想起重启 —— 改为自动 Stop, 结尾 finally 自动拉起, 用户全程无感
$needDevRestart = $false
$nextProcs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'next' -and $_.CommandLine -match [regex]::Escape("$ProjectRoot\") -and $_.CommandLine -notmatch 'deploy-fast' }
if ($nextProcs) {
    $needDevRestart = $true
    $nextProcs | ForEach-Object {
        Write-Host ("  暂停 PID " + $_.ProcessId + ": " + $_.CommandLine.Substring(0, [Math]::Min(80, $_.CommandLine.Length)))
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
}
Write-Host "OK"

try {

Write-Host "=== [2/6] 本地构建 npm run build (独立 distDir, 与 dev 的 .next 隔离) ===" -ForegroundColor Cyan
$LocalDist = ".next-deploy"
Push-Location $ProjectRoot
try {
    # client 必须与本次部署的 schema 同步: src/generated/prisma 是 gitignored, stash/回滚
    # 都不会动它 —— 本地按开发中 schema generate 过的话, 超前字段会被编译进产物推上线
    # (2026-10-17 实锤: 线上 DB 无该列, /api/memories 报 "Memory.status does not exist" 500),
    # 故每次构建前强制重生成
    npx prisma generate
    if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: prisma generate 失败" -ForegroundColor Red; exit 1 }
    $env:NEXT_DIST_DIR = $LocalDist
    npm run build
    $buildExit = $LASTEXITCODE
} finally {
    Remove-Item Env:NEXT_DIST_DIR -ErrorAction SilentlyContinue
    Pop-Location
}
if ($buildExit -ne 0) { Write-Host "ERROR: 构建失败" -ForegroundColor Red; exit 1 }
if (-not (Test-Path "$ProjectRoot\$LocalDist\standalone\server.js")) {
    Write-Host "ERROR: $LocalDist\standalone\server.js 不存在, 确认 next.config.mjs 的 output:'standalone'" -ForegroundColor Red
    exit 1
}
Write-Host "OK"

Write-Host "=== [3/6] 组装产物（standalone + static + public, 排除 win32 sharp）===" -ForegroundColor Cyan
$stage = Join-Path $env:TEMP "aichatt-dist-stage"
Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $stage | Out-Null
# standalone 本体（含打包的 node_modules 与 server.js）
Copy-Item -Recurse "$ProjectRoot\$LocalDist\standalone\*" $stage
# standalone 不自带静态资源/公共文件，需手动并入（与 Dockerfile 一致）
# 注意: 目标目录名必须与 distDir 同名(server.js 按构建时的 distDir 找静态资源)
Copy-Item -Recurse "$ProjectRoot\$LocalDist\static" "$stage\$LocalDist\static" -Force
# 拷「内容」而非目录本身: 若 standalone 自带了 public, 目标已存在时 Copy-Item 会把整个
# public 塞成 stage\public\public 子目录, skip 清理只够到外层, kb-pages 207MB 原样进包
# (2026-11-07 包虚胖 528MB 实测)。拷内容是幂等合并, 再兜底删一把嵌套目录。
Copy-Item -Recurse "$ProjectRoot\public\*" "$stage\public\" -Force
Remove-Item -Recurse -Force "$stage\public\public" -ErrorAction SilentlyContinue
# 瘦身: 字体二进制(103MB)/uploads(16MB)/kb-pages(207MB 课本页图)不进包, VPS 从旧产物回填(见 [6/6]);
# 字体 CSS 是行为代码, 必须随包更新, 否则 font-display 修复会被旧产物覆盖。
# uploads 在容器里被 named volume 挂载遮蔽, 宿主机这份本来就不生效, 纯属白传
foreach ($skip in @("fonts-subset", "fonts", "uploads", "kb-pages")) {
    Remove-Item -Recurse -Force "$stage\public\$skip" -ErrorAction SilentlyContinue
}
foreach ($weight in @("100", "300", "400", "500", "600")) {
    $fontCssDir = "$stage\public\fonts-subset\$weight"
    New-Item -ItemType Directory -Path $fontCssDir -Force | Out-Null
    Copy-Item "$ProjectRoot\public\fonts-subset\$weight\result.css" "$fontCssDir\result.css" -Force -ErrorAction Stop
}
# 数字等宽子集(~3.5KB, 见 fonts-subset/digits/digits.css)是行为代码, 随包直发不走红填链;
# 缺目录时静默跳过, 不拦部署
if (Test-Path "$ProjectRoot\public\fonts-subset\digits") {
    Copy-Item -Recurse "$ProjectRoot\public\fonts-subset\digits" "$stage\public\fonts-subset\digits" -Force
}
# 临时截图目录(tmp-shots-*)不进生产包——组装是整目录并入, 不剔会白传(2026-10-08 包虚胖70MB实测)
Remove-Item -Recurse -Force "$stage\public\tmp-*" -ErrorAction SilentlyContinue
# 排除 win32 原生 sharp（Linux 容器用不上; 若代码开始 import sharp 需改为在容器内重装）
$imgDir = "$stage\node_modules\@img"
if (Test-Path $imgDir) { Remove-Item -Recurse -Force $imgDir; Write-Host "已排除 node_modules\@img (win32 sharp)" }

Write-Host "=== [4/6] 打包 tar.gz ===" -ForegroundColor Cyan
$pkgPath = Join-Path $env:TEMP $PkgName
Remove-Item -Force $pkgPath -ErrorAction SilentlyContinue
# 必须用 Windows 自带 bsdtar: 从 Git Bash 启动时 PATH 会先命中 GNU tar,
# 它把 "C:\..." 的盘符当远程主机(host:path)解析, 直接报 "Cannot connect to C:"
& "$env:SystemRoot\System32\tar.exe" -czf $pkgPath -C $stage .
if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: tar 打包失败" -ForegroundColor Red; exit 1 }
$pkgMB = [math]::Round((Get-Item $pkgPath).Length / 1MB, 1)
# 本地包指纹, 供远端解压前校验(防上传损坏/并发改写)
$pkgMd5 = (Get-FileHash -Algorithm MD5 -Path $pkgPath).Hash.ToLower()
Write-Host "OK ($pkgMB MB, md5 $pkgMd5)"

Write-Host "=== [5/6] 上传 VPS ===" -ForegroundColor Cyan
$scpArgs = @()
if ($UploadLimitKbps -gt 0) { $scpArgs += @("-l", "$UploadLimitKbps") }
# 长连接保活: 528MB 包上传中途被 Connection reset 实测(2026-11-07), 家宽 NAT 对静默长连接不友好
$scpArgs += @("-o", "ServerAliveInterval=20", "-o", "ServerAliveCountMax=8")
$scpArgs += @($pkgPath, "${VpsHost}:/tmp/$PkgName")
& C:\Windows\System32\OpenSSH\scp.exe @scpArgs
if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: scp 失败" -ForegroundColor Red; exit 1 }
Write-Host "OK"

Write-Host "=== [6/6] VPS 原子切换 + 重启 + 健康验证（失败自动回滚）===" -ForegroundColor Cyan
$remoteScript = @"
set -e
PKG=/tmp/$PkgName
NEW=$DistDir.new
OLD=$DistDir.old
# 解压前校验指纹: 包被并发写入/传输损坏时在此退出 —— 尚未触碰线上产物, 服务不受影响
if ! echo "$pkgMd5  `$PKG" | md5sum -c -; then
  echo "PKG MD5 MISMATCH (并发写入或传输损坏)"
  rm -f `$PKG
  exit 1
fi
rm -rf `$NEW
mkdir -p `$NEW
tar -xzf `$PKG -C `$NEW
rm -f `$PKG
# 原子切换: dist -> dist.old, dist.new -> dist
if [ -d $DistDir ]; then
  rm -rf `$OLD
  mv $DistDir `$OLD
fi
mv `$NEW $DistDir
# uploads 目录被瘦身剔除,但容器 named volume 需要 /app/public/uploads 作挂载点
# (:ro 只读 rootfs 无法自动建目录,缺失会让容器起不来—— 2026-09-20 踩坑)
mkdir -p $DistDir/public/uploads
# 字体二进制/课本页图不在 tar 包里: 合并旧资源, -n 保留包内的新 CSS, 不用旧 swap 策略覆盖。
# 复制而非搬走: OLD 保持完整, 验证失败回滚时字体仍在。
for d in fonts fonts-subset kb-pages; do
  if [ -d `$OLD/public/`$d ]; then
    mkdir -p $DistDir/public/`$d
    cp -an `$OLD/public/`$d/. $DistDir/public/`$d/
  fi
done
# .env 不入包(数据库/密钥/闲鱼隧道变量), 垫片 goofish-cli-shim.js 同理 —— 都从 OLD 回填,
# 否则切换后 500 / 实时价静默失效(2026-11-07 live-bridge 起依赖)
if [ -f `$OLD/.env ] && [ ! -f $DistDir/.env ]; then cp `$OLD/.env $DistDir/.env; fi
if [ -f `$OLD/goofish-cli-shim.js ]; then cp `$OLD/goofish-cli-shim.js $DistDir/goofish-cli-shim.js && chmod 755 $DistDir/goofish-cli-shim.js; fi
# 重启失败(如挂载点缺失)也要回滚,不能靠 set -e 直接退—— 否则线上停在起不来的新产物上
if ! docker restart aichatt-app >/dev/null; then
  echo "RESTART FAILED, rolling back..."
  if [ -d `$OLD ]; then
    rm -rf $DistDir
    mv `$OLD $DistDir
    docker restart aichatt-app >/dev/null || true
  fi
  echo "ROLLBACK DONE"
  exit 1
fi
# 健康验证: 最多等 60s, 检查登录页渲染 + session API
OK=0
for i in `$(seq 1 12); do
  sleep 5
  BODY=`$(curl -s http://127.0.0.1:3001/login || true)
  if echo "`$BODY" | grep -q "aichatt"; then OK=1; break; fi
done
if [ `$OK -ne 1 ]; then
  echo "VERIFY FAILED, rolling back..."
  if [ -d `$OLD ]; then
    rm -rf $DistDir
    mv `$OLD $DistDir
    docker restart aichatt-app >/dev/null
  fi
  echo "ROLLBACK DONE"
  exit 1
fi
rm -rf `$OLD 2>/dev/null || true
echo "DEPLOY OK: /login 渲染正常, 旧产物已清理"
"@
$cleanScript = ($remoteScript -replace "`r`n", "`n") -replace "`r", ""
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($cleanScript))
& C:\Windows\System32\OpenSSH\ssh.exe -o BatchMode=yes $VpsHost "echo $b64 | base64 -d | bash"
if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: VPS 切换失败（已自动回滚或需人工检查）" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "=== [7/6] 字体二进制自愈（线上缺 woff2 时补传种子包, 一次性约 77MB）===" -ForegroundColor Cyan
# 瘦身策略: 五字重 woff2 不进主包, 靠 $OLD 回填链续命; 2026-10-21 链条断过一次后,
# 每代 cp -an 都在拷空(字体 CSS 200 假象, 全部 woff2 404)。直问权威源:
# 线上 fonts-subset 下 woff2 数 < 100(数字子集仅 3 个, 不能只判存在)就补传种子包
# 并解进线上目录, 之后 $OLD 链自续; 链条再断也会被本步重新发现并自愈。
$woff2Count = [int](& C:\Windows\System32\OpenSSH\ssh.exe -o BatchMode=yes $VpsHost "find $DistDir/public/fonts-subset -name '*.woff2' 2>/dev/null | wc -l")
if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: woff2 检查失败(SSH)" -ForegroundColor Red; exit 1 }
if ($woff2Count -lt 100) {
    Write-Host "  线上仅 $woff2Count 个 woff2, 打种子包..."
    $seedName = "aichatt-fonts-seed-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".tar.gz"
    $seedPath = Join-Path $env:TEMP $seedName
    Remove-Item -Force $seedPath -ErrorAction SilentlyContinue
    & "$env:SystemRoot\System32\tar.exe" -czf $seedPath -C "$ProjectRoot\public" fonts-subset
    if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: 种子包打包失败" -ForegroundColor Red; exit 1 }
    $seedMB = [math]::Round((Get-Item $seedPath).Length / 1MB, 1)
    Write-Host "  上传种子包 ($seedMB MB, 受 $UploadLimitKbps Kbps 限速)..."
    & C:\Windows\System32\OpenSSH\scp.exe -l $UploadLimitKbps $seedPath "${VpsHost}:/tmp/$seedName"
    if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: 种子包上传失败" -ForegroundColor Red; exit 1 }
    & C:\Windows\System32\OpenSSH\ssh.exe -o BatchMode=yes $VpsHost "tar -xzf /tmp/$seedName -C $DistDir/public && rm -f /tmp/$seedName && find $DistDir/public/fonts-subset -name '*.woff2' | wc -l"
    if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: 种子包解压失败" -ForegroundColor Red; exit 1 }
    # Next standalone 的 public 文件清单在 server 启动时扫描: 种子在 [6/6] restart 之后
    # 才解入, 不 restart 的话磁盘上有文件但 HTTP 全 404(2026-10-31 实测踩坑)。
    # restart 后复验 /login, 防止种子步骤把服务搞挂
    & C:\Windows\System32\OpenSSH\ssh.exe -o BatchMode=yes $VpsHost "docker restart aichatt-app >/dev/null && for i in \$(seq 1 12); do sleep 5; curl -sf http://127.0.0.1:3001/login >/dev/null && echo 'RESTART OK' && exit 0; done; echo 'RESTART VERIFY FAILED'; exit 1"
    if ($LASTEXITCODE -ne 0) { Write-Host "ERROR: 种子后重启验证失败" -ForegroundColor Red; exit 1 }
    Write-Host "OK (woff2 已补齐, 容器已重启)"
} else {
    Write-Host "OK (线上已有 $woff2Count 个 woff2, 跳过)"
}

Write-Host ""
Write-Host "部署完成 ✅  https://chat.yuban.icu" -ForegroundColor Green

} finally {
    if ($needDevRestart) {
        Write-Host "恢复本地 dev server (3456)..." -ForegroundColor Cyan
        Start-Process powershell -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "Set-Location '$ProjectRoot'; npm run dev" -WindowStyle Minimized
    }
}
