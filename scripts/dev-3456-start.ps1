# 分离进程启动 3456 dev(AGENTS.md 配方:不能用会话内后台任务挂 npm,会被回收)。
# 输出统一落 scripts/dev-3456-auto.log,方便事后排查(predev 会自动派生预热)。
# 用法: powershell -ExecutionPolicy Bypass -File scripts/dev-3456-start.ps1
$root = Split-Path -Parent $PSScriptRoot
Start-Process -WindowStyle Hidden -FilePath "powershell" -ArgumentList @(
  "-NoProfile", "-Command",
  "Set-Location '$root'; npm run dev *>> scripts\dev-3456-auto.log"
) | Out-Null
Write-Output "dev starting (detached); log: scripts\dev-3456-auto.log; warmup: scripts\dev-warmup.log"
