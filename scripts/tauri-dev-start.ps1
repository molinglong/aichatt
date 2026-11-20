# Detached launcher for the Tauri desktop client.
# Reuses the already-running 3456 dev server by overriding beforeDevCommand
# (a second "npm run dev" would exit 1 on port conflict, and if tauri owned
# the dev server it would kill it when the client closes).
# Output goes to scripts/tauri-dev-auto.log for post-mortem (UTF-16; read via Get-Content).
# --config points to scripts/tauri-dev-override.json (inline JSON loses its quotes
# through Start-Process argument re-quoting - file path is the reliable channel).
# WebView2 remote debugging on 9222 so CDP e2e scripts (temp/course-*.mjs) can
# attach to the real window.
$root = Split-Path -Parent $PSScriptRoot
Start-Process -WindowStyle Hidden -FilePath "powershell" -ArgumentList @(
  "-NoProfile", "-Command",
  "Set-Location '$root'; `$env:PYTHONPATH=''; `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'; npx tauri dev --config scripts\tauri-dev-override.json *>> scripts\tauri-dev-auto.log"
) | Out-Null
Write-Output "tauri client starting (detached); log: scripts\tauri-dev-auto.log"
