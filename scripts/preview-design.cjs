/**
 * 原型预览服务器（只读）：把 design/ 目录挂在 8899，方便用浏览器看预览稿。
 * 用法：npm run design:preview  →  http://127.0.0.1:8899/文件名.html
 * 只服务静态文件，不参与正式应用；与 dev(3456) 互不影响。
 */
const http = require('http')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', 'design')
const PORT = Number(process.env.PREVIEW_PORT || 8899)
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

http
  .createServer((req, res) => {
    const rel = decodeURIComponent((req.url || '/').split('?')[0])
    const target = path.join(ROOT, rel === '/' ? '' : rel)
    if (!path.resolve(target).startsWith(path.resolve(ROOT))) {
      res.writeHead(403).end('forbidden')
      return
    }
    fs.stat(target, (err, st) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found'); return }
      if (st.isDirectory()) {
        const items = fs.readdirSync(target).filter((f) => f.endsWith('.html'))
        res.writeHead(200, { 'Content-Type': TYPES['.html'] })
        res.end(
          `<meta charset="utf-8"><body style="font:14px/1.9 system-ui;padding:24px">` +
            `<h3>design/ 原型列表</h3>` +
            items.map((f) => `<div><a href="/${f}">${f}</a></div>`).join('') +
            `</body>`,
        )
        return
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(target)] || 'application/octet-stream' })
      fs.createReadStream(target).pipe(res)
    })
  })
  .listen(PORT, process.env.PREVIEW_HOST || '127.0.0.1', () => console.log(`design preview: http://127.0.0.1:${PORT}/`))
