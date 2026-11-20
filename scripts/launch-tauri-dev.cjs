// Detached tauri dev launcher with WebView2 CDP port for real-window acceptance.
// Usage: node scripts/launch-tauri-dev.cjs
// Does NOT start the frontend dev server (must be already up on 3456).
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

const root = path.join(__dirname, '..')
const tauriJs = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
const logPath = path.join(root, 'scripts', 'tauri-dev.log')
const log = fs.openSync(logPath, 'a')

const child = spawn(
  process.execPath,
  [tauriJs, 'dev', '--no-watch', '--config', JSON.stringify({ build: { beforeDevCommand: '' } })],
  {
    cwd: root,
    detached: true,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9223',
    },
  }
)
child.unref()
console.log('launched pid=' + child.pid + ' log=' + logPath)
