/**
 * 一次性导入脚本：课本/资料 HTML -> 学习知识库(KnowledgeDoc + KnowledgeChunk)
 *
 * 输入：PDF 转 HTML 后的单文件课本（豆包等工具导出，结构规整：h2 章/h3 节/h4 小节，
 *       栏目用语义化 class：example/exercise/think/explore/reading/history/summary）
 * 输出：KnowledgeDoc(元数据) + KnowledgeChunk(按章节切块的检索文本)
 *
 * 解析规则：
 *   - cover/copyright-info/toc 三个 div 只提取元数据(书名/年级/出版社)，不入切块
 *   - h2.chapter-title → chapter(章)，章下 h3 前的段落 → 「章引言」块
 *   - h3.section-title → section(节)；节内 h4 → subsection(小节)，按 h4 再拆块
 *   - 非 chapter 的 h2(如「致同学」)作为独立块(chapter=null)
 *   - 栏目 div 转为【例题】【练习】【思考】【探究】【阅读与思考】【数学史料】【小结】
 *     前缀内联(首行已含栏目名时不重复加)；LaTeX 公式原样保留
 *   - 单块超 4000 字符按段落边界续拆(heading 加 ·续N)
 *
 * 用法：node scripts/import-knowledge-html.cjs <html路径> [--user admin@qq.com]
 *       [--subject math] [--title 覆盖书名]
 * 幂等：同用户同名(title)资料重复导入时，先删旧再导。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
const { Pool } = require('pg')

const SOFT_CHUNK_LIMIT = 4000 // 单块软上限，超过按段落边界续拆

// —— 命令行参数 ——
function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) { args[key] = next; i++ } else { args[key] = true }
    } else {
      args._.push(a)
    }
  }
  return args
}

const args = parseArgs(process.argv)
const HTML_PATH = args._[0]
if (!HTML_PATH || !fs.existsSync(HTML_PATH)) {
  console.error('用法: node scripts/import-knowledge-html.cjs <html路径> [--user email] [--subject math] [--title 覆盖书名]')
  process.exit(1)
}
const USER_EMAIL = args.user || 'admin@qq.com'
const SUBJECT_OVERRIDE = args.subject
const KIND = args.kind === 'material' || args.kind === 'textbook' ? args.kind : null

/** 按书名猜学科(与 NOTE_SUBJECTS 对齐) */
function guessSubject(text) {
  const map = [['数学', 'math'], ['语文', 'chinese'], ['英语', 'english'], ['物理', 'physics'], ['化学', 'chemistry'], ['生物', 'biology'], ['历史', 'history'], ['地理', 'geography'], ['政治', 'politics']]
  for (const [kw, sub] of map) if (text.includes(kw)) return sub
  return 'other'
}

/** 按标题猜资料类型(与迁移回填同规则):资料关键词命中 → material,否则课本 */
const MATERIAL_TITLE_RE = /答题模板|提纲|秘籍|讲义|笔记/
function guessKind(title) {
  return MATERIAL_TITLE_RE.test(title) ? 'material' : 'textbook'
}

// —— HTML → 纯文本 ——
const ENTITIES = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&ldquo;': '“', '&rdquo;': '”' }

function htmlToText(html) {
  let s = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|table)>/gi, '\n')
    .replace(/<(td|th)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
  for (const [ent, ch] of Object.entries(ENTITIES)) s = s.split(ent).join(ch)
  return s
    .split('\n').map((l) => l.replace(/[ \t\u3000]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 提取标签文本(取 innerHTML 转文本,用于 h2/h3/h4 标题) */
function tagText(tagHtml) {
  return htmlToText(tagHtml.replace(/^<[^>]*>/, '').replace(/<\/[^>]*>$/, '')).replace(/\n/g, ' ').trim()
}

/** 从 <div class="cover"> 中提取书名/年级/出版社 */
function parseCover(divHtml) {
  const pick = (cls) => {
    const m = divHtml.match(new RegExp(`class="${cls}"[^>]*>([\\s\\S]*?)<`, 'i'))
    // 只处理捕获组(标签内内容),避免把 class 属性本身带进文本
    return m ? htmlToText(m[1]).replace(/\n/g, ' ').trim() : ''
  }
  return { book: pick('book-name'), grade: pick('grade'), publisher: pick('publisher') }
}

// —— 顶层元素流(顺序扫描 body,div 用平衡匹配防嵌套截断) ——
function tokenizeBody(body) {
  const tokens = []
  const re = /<(h2|h3|h4)([^>]*)>([\s\S]*?)<\/\1>|<div([^>]*)>|<table[\s\S]*?<\/table>|<p(?![\w-])[^>]*>[\s\S]*?<\/p>/gi
  let m
  while ((m = re.exec(body))) {
    if (m[1]) {
      tokens.push({ type: m[1].toLowerCase(), attrs: m[2] || '', inner: m[3], text: tagText(m[0]) })
      continue
    }
    if (m[4] !== undefined) {
      // div: 从 <div 起做标签平衡扫描,取完整块(整标签匹配,防 end 停在 > 前、正文残留「</div」)
      const start = m.index
      let depth = 0, i = start, end = -1
      const tagRe = /<\/?div\b[^>]*>/g
      tagRe.lastIndex = start
      let t
      while ((t = tagRe.exec(body))) {
        depth += t[0].startsWith('</div') ? -1 : 1
        if (depth === 0) { end = tagRe.lastIndex; break }
      }
      if (end === -1) end = body.length
      const divHtml = body.slice(start, end)
      const clsM = divHtml.match(/^<div[^>]*class="([^"]*)"/i)
      tokens.push({ type: 'div', cls: clsM ? clsM[1] : '', inner: divHtml.replace(/^<div[^>]*>/, '').replace(/<\/div>\s*$/, ''), raw: divHtml })
      re.lastIndex = end
      continue
    }
    if (/^<table/i.test(m[0])) {
      tokens.push({ type: 'table', text: htmlToText(m[0]) })
      continue
    }
    tokens.push({ type: 'p', text: htmlToText(m[0]) })
  }
  return tokens
}

const COLUMN_LABELS = { example: '【例题】', exercise: '【练习】', think: '【思考】', explore: '【探究】', reading: '【阅读与思考】', history: '【数学史料】', summary: '【小结】' }
const COLUMN_NAMES = { example: '例题', exercise: '练习', think: '思考', explore: '探究', reading: '阅读与思考', history: '数学史料', summary: '小结' }

/** 栏目文本:首行已含栏目名则不加前缀,避免重复 */
function columnText(cls, inner) {
  const text = htmlToText(inner)
  const name = COLUMN_NAMES[cls]
  const label = COLUMN_LABELS[cls]
  if (!label || !name || !text) return text
  return text.slice(0, 30).includes(name) ? text : `${label}\n${text}`
}

// —— 切块状态机 ——
function buildChunks(tokens) {
  const chunks = []
  let ctx = { chapter: null, section: null, subsection: null, heading: null, parts: [] }

  const flush = () => {
    // 用空行分隔段落，splitOversized 才能按段落边界续拆(原来用单换行,超长块无法拆)
    const content = ctx.parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
    if (ctx.heading && content) chunks.push({ chapter: ctx.chapter, section: ctx.section, subsection: ctx.subsection, heading: ctx.heading, content })
    ctx = { chapter: ctx.chapter, section: ctx.section, subsection: null, heading: null, parts: [] }
  }

  const push = (text) => {
    if (!text) return
    if (!ctx.heading) {
      // 游离内容(无标题上下文):按当前章/节兜底命名
      ctx.heading = ctx.subsection || ctx.section || (ctx.chapter ? `${ctx.chapter}（续）` : '前言')
    }
    ctx.parts.push(text)
  }

  for (const tk of tokens) {
    if (tk.type === 'div' && ['cover', 'copyright-info', 'toc'].includes(tk.cls)) {
      continue // 仅元数据/目录,不入切块
    }
    if (tk.type === 'h2') {
      flush()
      const isChapter = /chapter-title/i.test(tk.attrs || '')
      if (isChapter) {
        ctx.chapter = tk.text
        ctx.section = null
        ctx.subsection = null
        ctx.heading = `${tk.text}（章引言）`
      } else {
        ctx.chapter = null
        ctx.section = tk.text
        ctx.heading = tk.text
      }
      continue
    }
    if (tk.type === 'h3') {
      flush()
      ctx.section = tk.text
      ctx.subsection = null
      ctx.heading = tk.text
      continue
    }
    if (tk.type === 'h4') {
      flush()
      ctx.subsection = tk.text
      ctx.heading = tk.text
      continue
    }
    if (tk.type === 'div') {
      push(columnText(tk.cls, tk.inner))
      continue
    }
    push(tk.text)
  }
  flush()
  return chunks
}

/** 单块超限按段落边界续拆 */
function splitOversized(chunks) {
  const out = []
  for (const c of chunks) {
    if (c.content.length <= SOFT_CHUNK_LIMIT) { out.push(c); continue }
    const paras = c.content.split(/\n\n+/)
    let buf = [], part = 1
    const flushBuf = () => {
      if (!buf.length) return
      out.push({ ...c, heading: part === 1 ? c.heading : `${c.heading} ·续${part}`, content: buf.join('\n\n') })
      part++
      buf = []
    }
    for (const p of paras) {
      if (buf.join('\n\n').length + p.length > SOFT_CHUNK_LIMIT && buf.length) flushBuf()
      buf.push(p)
    }
    flushBuf()
  }
  return out
}

// —— 主流程 ——
async function main() {
  const html = fs.readFileSync(HTML_PATH, 'utf-8')
  const titleTag = (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || path.basename(HTML_PATH, '.html')
  const body = (html.match(/<body[^>]*>([\s\S]*?)<\/body>/i) || [, html])[1]
  const tokens = tokenizeBody(body)

  // 元数据:cover 优先,回退 <title>
  let meta = { book: '', grade: '', publisher: '' }
  for (const tk of tokens) if (tk.type === 'div' && tk.cls === 'cover') { meta = parseCover(tk.raw); break }
  // 书名 + 册别组合作为资料名(同科目不同册不冲突,幂等判断也因此准确)
  const title = (typeof args.title === 'string' && args.title) || [meta.book, meta.grade].filter(Boolean).join(' ').trim() || titleTag.trim()
  const subject = SUBJECT_OVERRIDE || guessSubject(title)
  const kind = KIND || guessKind(title)
  const grade = meta.grade || null
  const publisher = meta.publisher || null

  const chunks = splitOversized(buildChunks(tokens))
  if (!chunks.length) { console.error('未解析出任何切块,请检查 HTML 结构'); process.exit(1) }
  const charCount = chunks.reduce((n, c) => n + c.content.length, 0)

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    const u = await pool.query(`SELECT id FROM "User" WHERE email = $1`, [USER_EMAIL])
    if (!u.rowCount) { console.error(`用户不存在: ${USER_EMAIL}`); process.exit(1) }
    const userId = u.rows[0].id

    // 幂等:同用户同名资料先删旧(doc 级联删 chunk)
    const del = await pool.query(`DELETE FROM "KnowledgeDoc" WHERE "userId" = $1 AND title = $2`, [userId, title])
    if (del.rowCount) console.log(`已删除旧资料 "${title}" x${del.rowCount}(含切块)`)

    const docId = crypto.randomUUID()
    await pool.query(
      `INSERT INTO "KnowledgeDoc" (id, "userId", title, subject, kind, publisher, grade, "charCount", "chunkCount") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [docId, userId, title, subject, kind, publisher, grade, charCount, chunks.length]
    )
    // 批量插入切块(多值参数化;id 用 uuid,内容与栏目已在上游处理)
    const COLS = 10
    const values = []
    const params = []
    chunks.forEach((c, i) => {
      const b = i * COLS
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10})`)
      params.push(crypto.randomUUID(), docId, userId, c.chapter, c.section, c.subsection, c.heading, c.content, i, c.content.length)
    })
    await pool.query(
      `INSERT INTO "KnowledgeChunk" (id, "docId", "userId", chapter, section, subsection, heading, content, "sortOrder", "charCount") VALUES ${values.join(',')}`,
      params
    )

    // 统计输出
    const byChapter = {}
    for (const c of chunks) {
      const k = c.chapter || '(无章)'
      byChapter[k] = (byChapter[k] || 0) + 1
    }
    console.log(`\n导入完成: ${title} [${subject}/${kind}] ${grade || ''} ${publisher || ''}`)
    console.log(`切块: ${chunks.length} 块 / 共 ${charCount} 字符,归属用户: ${USER_EMAIL}`)
    for (const [k, v] of Object.entries(byChapter)) console.log(`  ${k}: ${v} 块`)
    console.log('\n示例切块:')
    for (const c of [chunks[0], chunks[Math.floor(chunks.length / 2)], chunks[chunks.length - 1]]) {
      console.log(`  [${c.heading}] ${c.content.slice(0, 80).replace(/\n/g, ' ')}…`)
    }
  } finally {
    await pool.end()
  }
}

main().catch((e) => { console.error('FAIL:', e.message); process.exitCode = 1 })
