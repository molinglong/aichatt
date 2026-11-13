// 人工核对平台 server（零依赖，端口 3460，仅监听 127.0.0.1）
// 数据：data/proofread/<slug>.task.json（任务：原图+待核对项）
//       data/proofread/<slug>.verdicts.json（裁决记录，append-only，最新一条为准）
//       data/proofread/<slug>.drafts.json（未提交草稿：itemId -> {choice,note,ts}，提交裁决后自动清除）
//       data/proofread/<slug>.locate.json（图上标注：itemId -> {x,y,w,h,ts}，相对图片 0-1 坐标）
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data', 'proofread');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = 3460;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8' });
  res.end(body);
}
function sendJSON(res, code, obj) { send(res, code, JSON.stringify(obj)); }

function taskPath(slug) { return path.join(DATA_DIR, slug + '.task.json'); }
function verdictPath(slug) { return path.join(DATA_DIR, slug + '.verdicts.json'); }
function draftPath(slug) { return path.join(DATA_DIR, slug + '.drafts.json'); }
function locatePath(slug) { return path.join(DATA_DIR, slug + '.locate.json'); }

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function loadTasks() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  return fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.task.json'))
    .map(f => readJSON(path.join(DATA_DIR, f), null))
    .filter(Boolean)
    .map(t => ({
      slug: t.slug, title: t.title, subject: t.subject || '',
      photoCount: (t.photos || []).length,
      itemCount: (t.items || []).length,
    }));
}

function loadTask(slug) {
  // slug 白名单校验：仅允许 [A-Za-z0-9._-]，防止路径穿越
  if (!/^[A-Za-z0-9._-]+$/.test(slug)) return null;
  const t = readJSON(taskPath(slug), null);
  if (!t) return null;
  const verdicts = readJSON(verdictPath(slug), []);
  const drafts = readJSON(draftPath(slug), {});
  const locates = readJSON(locatePath(slug), {});
  return { task: t, verdicts, drafts, locates };
}

function saveDraft(slug, body) {
  const t = readJSON(taskPath(slug), null);
  if (!t) return { ok: false, error: 'task not found: ' + slug };
  const item = (t.items || []).find(i => i.id === body.itemId);
  if (!item) return { ok: false, error: 'item not found: ' + body.itemId };
  const drafts = readJSON(draftPath(slug), {});
  drafts[body.itemId] = {
    choice: body.choice == null ? null : String(body.choice),
    note: String(body.note || ''),
    ts: new Date().toISOString(),
  };
  fs.writeFileSync(draftPath(slug), JSON.stringify(drafts, null, 2));
  return { ok: true };
}

function clearDraft(slug, itemId) {
  const drafts = readJSON(draftPath(slug), {});
  if (drafts[itemId]) {
    delete drafts[itemId];
    fs.writeFileSync(draftPath(slug), JSON.stringify(drafts, null, 2));
  }
}

// 图上标注：itemId -> {x,y,w,h}（相对整图 0-1）；clear=true 删除
function saveLocate(slug, body) {
  const t = readJSON(taskPath(slug), null);
  if (!t) return { ok: false, error: 'task not found: ' + slug };
  const item = (t.items || []).find(i => i.id === body.itemId);
  if (!item) return { ok: false, error: 'item not found: ' + body.itemId };
  const locates = readJSON(locatePath(slug), {});
  if (body.clear) {
    delete locates[body.itemId];
  } else {
    const n = v => Math.min(Math.max(Number(v) || 0, 0), 1);
    locates[body.itemId] = {
      x: n(body.x), y: n(body.y),
      w: Math.min(n(body.w), 1), h: Math.min(n(body.h), 1),
      ts: new Date().toISOString(),
    };
  }
  fs.writeFileSync(locatePath(slug), JSON.stringify(locates, null, 2));
  return { ok: true, locates };
}

function saveVerdict(slug, body) {
  const t = readJSON(taskPath(slug), null);
  if (!t) return { ok: false, error: 'task not found: ' + slug };
  const item = (t.items || []).find(i => i.id === body.itemId);
  if (!item) return { ok: false, error: 'item not found: ' + body.itemId };
  const entry = {
    itemId: String(body.itemId || ''),
    choice: body.choice == null ? null : String(body.choice),
    note: String(body.note || ''),
    ts: new Date().toISOString(),
  };
  const list = readJSON(verdictPath(slug), []);
  list.push(entry);
  fs.writeFileSync(verdictPath(slug), JSON.stringify(list, null, 2));
  clearDraft(slug, entry.itemId);
  return { ok: true, entry };
}

function servePhoto(res, slug, photoId) {
  const t = readJSON(taskPath(slug), null);
  if (!t) return send(res, 404, 'task not found', 'text/plain; charset=utf-8');
  const photo = (t.photos || []).find(p => p.id === photoId);
  if (!photo || !photo.path) return send(res, 404, 'photo not found', 'text/plain; charset=utf-8');
  // 只允许 task JSON 里登记过的绝对路径（白名单，防任意文件读取）
  const file = photo.path;
  if (!path.isAbsolute(file) || !fs.existsSync(file)) return send(res, 404, 'file missing', 'text/plain; charset=utf-8');
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'Content-Length': fs.statSync(file).size,
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  if (req.method === 'POST' && p === '/api/verdict') {
    let raw = '';
    req.on('data', ch => { raw += ch; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw); } catch (e) { return sendJSON(res, 400, { ok: false, error: 'bad json' }); }
      const r = saveVerdict(String(body.slug || ''), body);
      sendJSON(res, r.ok ? 200 : 400, r);
    });
    return;
  }
  if (req.method === 'POST' && p === '/api/draft') {
    let raw = '';
    req.on('data', ch => { raw += ch; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw); } catch (e) { return sendJSON(res, 400, { ok: false, error: 'bad json' }); }
      const r = saveDraft(String(body.slug || ''), body);
      sendJSON(res, r.ok ? 200 : 400, r);
    });
    return;
  }
  if (req.method === 'POST' && p === '/api/locate') {
    let raw = '';
    req.on('data', ch => { raw += ch; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw); } catch (e) { return sendJSON(res, 400, { ok: false, error: 'bad json' }); }
      const r = saveLocate(String(body.slug || ''), body);
      sendJSON(res, r.ok ? 200 : 400, r);
    });
    return;
  }
  if (req.method === 'GET' && p === '/api/tasks') return sendJSON(res, 200, loadTasks());
  if (req.method === 'GET' && p.startsWith('/api/task/')) {
    const t = loadTask(p.slice('/api/task/'.length));
    return t ? sendJSON(res, 200, t) : sendJSON(res, 404, { error: 'not found' });
  }
  if (req.method === 'GET' && p === '/photo') {
    return servePhoto(res, url.searchParams.get('task') || '', url.searchParams.get('id') || '');
  }
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    const file = path.join(PUBLIC_DIR, 'index.html');
    return send(res, 200, fs.readFileSync(file), MIME['.html']);
  }
  return send(res, 404, 'not found', 'text/plain; charset=utf-8');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('proofread server on http://127.0.0.1:' + PORT + '  data: ' + DATA_DIR);
});
