// 考点打标台 server(端口 3462,仅监听 127.0.0.1,零框架:node http + pg + dotenv)
// 用途:全库 PaperQuestion.topics 考点回填的预览工具。dry-run 纪律:
//   本 server 对 DB 只读(SELECT);AI 建议/用户裁决全部落在 data/topic-tagging/ 下
//   的 JSON 文件,验收通过后由独立 apply 脚本落库,本工具链任何环节都不写库。
// 数据文件:
//   data/topic-tagging/vocab.json      受控词表(按学科;打标台页首可增删改)
//   data/topic-tagging/suggestions.json questionId → AI 建议标签(dry-run 产物)
//   data/topic-tagging/verdicts.json    questionId → 用户裁决(accepted/edited/rejected/pending)
// AI:DeepSeek 直连(.env API_KEY_DEEPSEEK,OpenAI 兼容);逐卷批量,建议只允许词表内标签。
const http = require('http');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data', 'topic-tagging');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = 3462;

const DEEPSEEK_KEY = process.env.API_KEY_DEEPSEEK;
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const AI_MODEL = 'deepseek-chat';
const AI_BATCH = 10;          // 每次 AI 调用打包的题数
const AI_MAX_RETRY = 3;

const SUBJECT_LABELS = { math: '数学', chinese: '语文', english: '英语', physics: '物理', chemistry: '化学', biology: '生物', history: '历史', geography: '地理', politics: '政治', other: '综合' };

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
fs.mkdirSync(DATA_DIR, { recursive: true });

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8' });
  res.end(body);
}
function sendJSON(res, code, obj) { send(res, code, JSON.stringify(obj)); }

function vocabPath() { return path.join(DATA_DIR, 'vocab.json'); }
function suggPath() { return path.join(DATA_DIR, 'suggestions.json'); }
function verdPath() { return path.join(DATA_DIR, 'verdicts.json'); }
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJSON(file, obj) { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }

function defaultVocab() {
  return readJSON(vocabPath(), null) || { math: [], chinese: [], physics: [], politics: [] };
}

// ---------- DB(只读) ----------
async function loadLibrary() {
  const r = await pool.query(
    `SELECT p.id, p.slug, p.title, p.subject, p."questionCount",
            COUNT(q.id) AS q_actual,
            COUNT(q.id) FILTER (WHERE array_length(q.topics, 1) > 0) AS q_db_topics
     FROM "Paper" p LEFT JOIN "PaperQuestion" q ON q."paperId" = p.id
     GROUP BY p.id HAVING COUNT(q.id) > 0 ORDER BY p.subject, p.slug`
  );
  const verd = readJSON(verdPath(), {});
  const sugg = readJSON(suggPath(), {});
  const papers = r.rows.map((p) => {
    const per = { verdict: 0, accepted: 0, suggested: 0 };
    for (const id of Object.keys(verd)) {
      if (verd[id].slug !== p.slug) continue;
      if (verd[id].action === 'pending') continue;
      per.verdict++;
      if (verd[id].action !== 'rejected') per.accepted++;
    }
    for (const id of Object.keys(sugg)) if (sugg[id].slug === p.slug) per.suggested++;
    return {
      id: p.id, slug: p.slug, title: p.title, subject: p.subject,
      questionCount: Number(p.q_actual),
      dbTopics: Number(p.q_db_topics),
      verdict: per.verdict, accepted: per.accepted, suggested: per.suggested,
    };
  });
  return papers;
}

async function loadQuestions(slug) {
  const p = await pool.query(`SELECT id, title, subject FROM "Paper" WHERE slug = $1`, [slug]);
  if (!p.rowCount) return null;
  const q = await pool.query(
    `SELECT q.id, q.number, q.kind, q.multiple, q.score, q.section, q.stem, q.options, q.answer, q.topics, q.flagged
     FROM "PaperQuestion" q WHERE q."paperId" = $1 ORDER BY q.number`,
    [p.rows[0].id]
  );
  const sugg = readJSON(suggPath(), {});
  const verd = readJSON(verdPath(), {});
  return {
    paper: { id: p.rows[0].id, slug, title: p.rows[0].title, subject: p.rows[0].subject },
    questions: q.rows.map((row) => ({
      id: row.id, number: row.number, kind: row.kind, multiple: row.multiple,
      score: row.score, section: row.section || '', stem: row.stem,
      options: row.options || [], answer: row.answer, dbTopics: row.topics || [],
      flagged: row.flagged,
      suggestion: sugg[row.id] || null,
      verdict: verd[row.id] || null,
    })),
  };
}

// ---------- AI 打标(dry-run,只写 suggestions.json) ----------
let aiBusy = false; // 单飞:同一时刻只允许一个打标请求(DeepSeek 并发敏感)

function questionBlock(q) {
  const lines = [`【第 ${q.number} 题|${q.multiple ? '多选题' : q.kind === 'choice' ? '单选题' : '解答/填空题'}】`, q.stem];
  if (q.options.length) lines.push(q.options.join('\n'));
  return lines.join('\n');
}

const TAG_SYSTEM =
  '你是高中学业水平考试试卷的考点打标助手。给你同一学科的一组题目(题干含 $...$ LaTeX,' +
  '[图N] 表示此处有插图)。为每道题从给定受控词表中挑选 1~3 个最贴切的考点标签。硬性规则:' +
  '①标签必须逐字取自受控词表,禁止自创、改写、拼接;②每题 1~3 个标签,按贴切程度排序;' +
  '③综合题选最核心的考点;④依赖插图才能判断的细节不必猜,按题面文字可确定的考点打标。' +
  '输出严格 JSON:{"results":[{"number":题号,"topics":["标签1","标签2"]}]}。只输出 JSON,不要围栏和解释。';

async function callAI(system, prompt) {
  let lastErr = null;
  for (let i = 0; i < AI_MAX_RETRY; i++) {
    try {
      const resp = await fetch(DEEPSEEK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_KEY}` },
        body: JSON.stringify({
          model: AI_MODEL,
          messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
          temperature: 0.1,
          max_tokens: 4000,
        }),
        signal: AbortSignal.timeout(180000),
      });
      if (resp.status === 429 || resp.status >= 500) throw new Error(`upstream ${resp.status}`);
      if (!resp.ok) throw new Error(`upstream ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      const data = await resp.json();
      return (data.choices?.[0]?.message?.content || '').trim();
    } catch (e) {
      lastErr = e;
      if (i < AI_MAX_RETRY - 1) await new Promise((r) => setTimeout(r, 2500 * (i + 1)));
    }
  }
  throw lastErr;
}

function parseTopics(text, vocabSet) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('no_json');
  const parsed = JSON.parse(m[0]);
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  return results.map((r) => {
    const raw = Array.isArray(r.topics) ? r.topics : [];
    const topics = [], out = [];
    for (const t of raw) {
      const s = String(t).trim();
      if (!s) continue;
      if (vocabSet.has(s)) { if (!topics.includes(s)) topics.push(s); }
      else out.push(s);
    }
    return { number: Number(r.number), topics: topics.slice(0, 3), outOfVocab: out.slice(0, 3) };
  });
}

async function suggestForPaper(slug, force) {
  if (!DEEPSEEK_KEY) return { ok: false, error: '缺 API_KEY_DEEPSEEK(.env)' };
  if (aiBusy) return { ok: false, error: '已有打标任务在进行中,请等它结束', busy: true };
  const data = await loadQuestions(slug);
  if (!data) return { ok: false, error: '试卷不存在: ' + slug };
  const { paper, questions } = data;
  const vocab = defaultVocab()[paper.subject] || [];
  if (!vocab.length) return { ok: false, error: `受控词表缺该学科(${paper.subject}),请先在页首词表里补齐` };
  const vocabSet = new Set(vocab);

  const targets = questions.filter((q) => {
    if (q.dbTopics.length) return false;             // 库里已有标签(如 math-mock-1),不动
    if (!force && q.verdict && q.verdict.action !== 'pending') return false; // 已裁决的题不重打
    return true;
  });
  if (!targets.length) return { ok: true, done: 0, failed: [], results: [], note: '本卷无可打标的题(已全部裁决或已有库内标签)' };

  aiBusy = true;
  const sugg = readJSON(suggPath(), {});
  const results = [], failed = [];
  try {
    for (let i = 0; i < targets.length; i += AI_BATCH) {
      const batch = targets.slice(i, i + AI_BATCH);
      const prompt =
        `【学科】${SUBJECT_LABELS[paper.subject] || paper.subject}\n` +
        `【受控词表】\n${vocab.map((t) => '- ' + t).join('\n')}\n\n` +
        `【题目】\n${batch.map(questionBlock).join('\n\n')}`;
      try {
        const text = await callAI(TAG_SYSTEM, prompt);
        const byNumber = new Map(parseTopics(text, vocabSet).map((r) => [r.number, r]));
        for (const q of batch) {
          const r = byNumber.get(q.number);
          const entry = {
            slug, number: q.number,
            topics: r ? r.topics : [],
            outOfVocab: r ? r.outOfVocab : [],
            model: AI_MODEL, ts: new Date().toISOString(),
          };
          sugg[q.id] = entry;
          results.push({ questionId: q.id, number: q.number, ...entry });
          if (!entry.topics.length) failed.push(q.number);
        }
      } catch (e) {
        for (const q of batch) failed.push(q.number);
        console.error('[suggest] batch failed:', e.message);
      }
      writeJSON(suggPath(), sugg);
    }
  } finally {
    aiBusy = false;
  }
  return { ok: true, done: results.length, failed, results };
}

// ---------- 裁决 ----------
function setVerdict(body) {
  const qid = String(body.questionId || '');
  if (!qid) return { ok: false, error: 'questionId required' };
  const action = String(body.action || '');
  if (!['accepted', 'edited', 'rejected', 'pending'].includes(action)) return { ok: false, error: 'bad action' };
  const verd = readJSON(verdPath(), {});
  if (action === 'pending') delete verd[qid];
  else verd[qid] = {
    slug: String(body.slug || ''), number: Number(body.number || 0),
    action, topics: Array.isArray(body.topics) ? body.topics.map(String) : [],
    ts: new Date().toISOString(),
  };
  writeJSON(verdPath(), verd);
  return { ok: true, verdict: verd[qid] || null };
}

function setVerdictBatch(body) {
  const ids = Array.isArray(body.questionIds) ? body.questionIds.map(String) : [];
  const action = String(body.action || '');
  if (!ids.length) return { ok: false, error: 'questionIds required' };
  const verd = readJSON(verdPath(), {});
  let n = 0;
  for (const qid of ids) {
    if (action === 'pending') { delete verd[qid]; n++; continue; }
    if (!['accepted', 'edited', 'rejected'].includes(action)) continue;
    verd[qid] = {
      slug: String(body.slug || ''), number: Number(body.number || 0),
      action,
      topics: Array.isArray(body.topicsByQuestion?.[qid]) ? body.topicsByQuestion[qid].map(String) : [],
      ts: new Date().toISOString(),
    };
    n++;
  }
  writeJSON(verdPath(), verd);
  return { ok: true, count: n };
}

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  if (req.method === 'POST') {
    let raw = '';
    req.on('data', (ch) => { raw += ch; if (raw.length > 2e6) req.destroy(); });
    req.on('end', async () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (e) { return sendJSON(res, 400, { ok: false, error: 'bad json' }); }
      try {
        if (p === '/api/suggest') return sendJSON(res, 200, await suggestForPaper(String(body.slug || ''), !!body.force));
        if (p === '/api/verdict') return sendJSON(res, 200, setVerdict(body));
        if (p === '/api/verdict-batch') return sendJSON(res, 200, setVerdictBatch(body));
        if (p === '/api/vocab') {
          const v = body.vocab;
          if (!v || typeof v !== 'object' || Array.isArray(v)) return sendJSON(res, 400, { ok: false, error: 'vocab 需为 {subject: string[]}' });
          const cur = defaultVocab();
          const merged = { ...cur };
          for (const s of Object.keys(v)) {
            if (!Array.isArray(v[s])) continue;
            merged[s] = Array.from(new Set(v[s].map((t) => String(t).trim()).filter(Boolean)));
          }
          merged._说明 = cur._说明 || '全库 PaperQuestion 考点受控词表';
          merged._updated = new Date().toISOString().slice(0, 10);
          writeJSON(vocabPath(), merged);
          return sendJSON(res, 200, { ok: true, vocab: merged });
        }
        return sendJSON(res, 404, { ok: false, error: 'not found' });
      } catch (e) {
        console.error('[api]', p, e);
        return sendJSON(res, 500, { ok: false, error: String(e.message || e) });
      }
    });
    return;
  }

  if (req.method === 'GET') {
    if (p === '/api/library') {
      return loadLibrary().then((papers) => sendJSON(res, 200, { ok: true, papers }))
        .catch((e) => sendJSON(res, 500, { ok: false, error: String(e.message || e) }));
    }
    if (p === '/api/questions') {
      const slug = url.searchParams.get('slug') || '';
      if (!/^[A-Za-z0-9._-]+$/.test(slug)) return sendJSON(res, 400, { ok: false, error: 'bad slug' });
      return loadQuestions(slug).then((d) => d ? sendJSON(res, 200, { ok: true, ...d }) : sendJSON(res, 404, { ok: false, error: 'not found' }))
        .catch((e) => sendJSON(res, 500, { ok: false, error: String(e.message || e) }));
    }
    if (p === '/api/vocab') return sendJSON(res, 200, { ok: true, vocab: defaultVocab() });
    if (p === '/' || p === '/index.html') {
      return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, 'index.html')), MIME['.html']);
    }
    if (p.startsWith('/static/')) {
      const file = path.join(PUBLIC_DIR, p.slice('/static/'.length));
      if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) return send(res, 404, 'not found', 'text/plain; charset=utf-8');
      return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
    }
    // KaTeX 直出 node_modules(题面 $...$ 公式渲染;只读映射,防穿越)
    if (p.startsWith('/katex/')) {
      const rel = p.slice('/katex/'.length);
      const file = path.resolve(ROOT, 'node_modules', 'katex', 'dist', rel);
      if (!file.startsWith(path.resolve(ROOT, 'node_modules', 'katex', 'dist')) || !fs.existsSync(file)) return send(res, 404, 'not found', 'text/plain; charset=utf-8');
      const ext = path.extname(file).toLowerCase();
      const kmime = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
      return send(res, 200, fs.readFileSync(file), kmime[ext] || 'application/octet-stream');
    }
    return send(res, 404, 'not found', 'text/plain; charset=utf-8');
  }
  send(res, 404, 'not found', 'text/plain; charset=utf-8');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('topic-tagging server on http://127.0.0.1:' + PORT + '  data: ' + DATA_DIR);
});
