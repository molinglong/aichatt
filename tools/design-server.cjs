// design/ 原型页静态服务（挑稿预览用，零依赖）。用法: node tools/design-server.cjs [port]
const http = require('http'), fs = require('fs'), path = require('path')
const root = path.join(__dirname, '..', 'design')
const port = Number(process.argv[2]) || 3461
http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0])
  const p = path.join(root, rel === '/' ? 'preview-assistant-autopilot.html' : rel)
  if (!p.startsWith(root)) { res.writeHead(403); res.end(); return }
  fs.readFile(p, (e, d) => {
    if (e) { res.writeHead(404); res.end('not found'); return }
    const ext = path.extname(p)
    res.writeHead(200, { 'Content-Type': ext === '.html' ? 'text/html; charset=utf-8' : 'application/octet-stream' })
    res.end(d)
  })
}).listen(port, '127.0.0.1', () => console.log('design preview: http://127.0.0.1:' + port))
