/** 一次性批量导入队列(用后即删):--daemon 前自身作 launcher,spawn 自身脱离会话后台跑 */
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

const ROOT = path.join(__dirname, '..')
const SELF = __filename
const isDaemon = process.argv[2] === '--daemon'
// daemon 模式路径在 argv[3];launcher 模式在 argv[2]
const manifest = isDaemon ? process.argv[3] : process.argv[2]

if (!isDaemon) {
  const child = spawn(process.execPath, [SELF, '--daemon', manifest], {
    detached: true,
    stdio: 'ignore',
    cwd: ROOT,
  })
  child.unref()
  console.log('detached runner pid =', child.pid)
  process.exit(0)
}

const books = JSON.parse(fs.readFileSync(manifest, 'utf8'))
const base = path.basename(manifest).replace(/\.json$/, '')
const statusPath = path.join(__dirname, base + '.status.json')
const logPath = path.join(__dirname, base + '.log')
const log = fs.createWriteStream(logPath, { flags: 'a' })
const status = {
  manifest: base,
  startedAt: new Date().toISOString(),
  updatedAt: null,
  current: null,
  done: [],
  failed: [],
}
const writeStatus = () => {
  status.updatedAt = new Date().toISOString()
  fs.writeFileSync(statusPath, JSON.stringify(status, null, 2))
}
writeStatus()

;(async () => {
  for (const b of books) {
    const name = path.basename(b.pdf)
    status.current = name
    writeStatus()
    log.write(`\n===== START ${name} @ ${new Date().toISOString()} =====\n`)
    const args = [path.join('scripts', 'import-kb-pdf-pages.cjs'), b.pdf]
    for (const [k, v] of Object.entries(b.opts || {})) args.push(`--${k}`, String(v))
    const code = await new Promise((resolve) => {
      const p = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
      p.stdout.on('data', (d) => log.write(d))
      p.stderr.on('data', (d) => log.write(d))
      p.on('close', resolve)
    })
    log.write(`\n===== EXIT ${name} code=${code} @ ${new Date().toISOString()} =====\n`)
    ;(code === 0 ? status.done : status.failed).push(name)
    status.current = null
    writeStatus()
  }
  status.current = 'ALL-DONE'
  writeStatus()
  log.end()
  process.exit(0)
})()
