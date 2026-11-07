/**
 * 课本「翻原文」导入脚本：PDF → 页图 WebP + 按页切块入库(KnowledgeDoc + KnowledgeChunk)
 *
 * 与 import-knowledge-html.cjs(HTML 结构化切块)互补：本脚本按 PDF 页为单元，
 * 每页一个 chunk 且带 page 字段，支撑「检索命中 → 跳转原文页」；页图落
 * public/kb-pages/{bookKey}/pNNN.webp，由 /kb-pages 兜底路由读盘返回。
 *
 * 渲染：pdfjs-dist(legacy, node) + @napi-rs/canvas → PNG → sharp 转 WebP。
 *   - cMapUrl/standardFontDataUrl 指向 node_modules，CJK 教材必需；
 *   - scale 2.0 时教材页约 1190x1684，quality 80 下约 60KB/页(223 页 ≈ 13MB)。
 * 文本：page.getTextContent 按 hasEOL 重组行；逐页成块，heading 从页文本猜
 *   (第X单元/课/章 → chapter；N.N → section)；猜不出用「第n页」。
 *
 * 用法：node scripts/import-kb-pdf-pages.cjs <pdf路径> [--user admin@qq.com]
 *       [--subject politics] [--title 覆盖书名] [--scale 2.0] [--quality 80]
 *       [--start 1] [--limit N(调试:只处理前N页)]
 * 幂等：同用户同名(title)资料先删旧再导；bookKey 复用旧值(页图目录覆盖写，
 *       页数变少时旧目录残留文件不引用即无害)。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
const { Pool } = require('pg')
const sharp = require('sharp')
const { createCanvas } = require('@napi-rs/canvas')

const SOFT_CHUNK_LIMIT = 4000 // 单块软上限，超过按行边界续拆(与 HTML 导入口径一致)

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
const PDF_PATH = args._[0]
if (!PDF_PATH || !fs.existsSync(PDF_PATH)) {
  console.error('用法: node scripts/import-kb-pdf-pages.cjs <pdf路径> [--user email] [--subject politics] [--title 覆盖书名] [--limit N]')
  process.exit(1)
}
const USER_EMAIL = args.user || 'admin@qq.com'
const SCALE = Math.min(Math.max(parseFloat(args.scale) || 2.0, 1.0), 4.0)
const QUALITY = Math.min(Math.max(parseInt(args.quality) || 80, 40), 95)
const START_PAGE = Math.max(parseInt(args.start) || 1, 1)
const LIMIT = args.limit ? Math.max(parseInt(args.limit), 1) : null
const PAGE_TIMEOUT_MS = 60_000 // 单页看门狗:渲染+提取超 60s 视为该页 hang,写占位图继续(防个别损坏页卡死全程)

const KB_PAGES_DIR = path.join(__dirname, '..', 'public', 'kb-pages')

/** 按书名/参数猜学科(与 NOTE_SUBJECTS 对齐) */
function guessSubject(text) {
  if (typeof args.subject === 'string' && args.subject) return args.subject
  const map = [['数学', 'math'], ['语文', 'chinese'], ['英语', 'english'], ['物理', 'physics'], ['化学', 'chemistry'], ['生物', 'biology'], ['历史', 'history'], ['地理', 'geography'], ['政治', 'politics'], ['思想政治', 'politics']]
  for (const [kw, sub] of map) if (text.includes(kw)) return sub
  return 'other'
}

const MATERIAL_TITLE_RE = /答题模板|提纲|秘籍|讲义|笔记/
function guessKind(title) {
  return args.kind === 'material' || args.kind === 'textbook'
    ? args.kind
    : (MATERIAL_TITLE_RE.test(title) ? 'material' : 'textbook')
}

// —— 页文本 → 行列表(去页眉页脚噪音) ——
// CJK 字符间的空格是 PDF 字距的产物(「必 修」),去掉了才不破坏检索命中;
// 英文/数字之间的空格保留。
const CJK_SPACE_RE = /(?<=[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])[ ]+(?=[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])/g
function pageToLines(text) {
  return text
    .split('\n')
    .map((l) => l.replace(/[ \t\u3000]+/g, ' ').replace(CJK_SPACE_RE, '').trim())
    .filter((l) => l.length > 0)
    .filter((l) => !/^\d{1,4}$/.test(l)) // 纯页码行
}

// —— 从页文本猜 heading / chapter / section ——
const CHAPTER_RE = /^(第[一二三四五六七八九十百\d]+[单元课章讲])(\s*(.+))?$/
function guessHeading(lines) {
  for (const l of lines.slice(0, 8)) {
    const cm = l.match(CHAPTER_RE)
    if (cm) return { chapter: `${cm[1]}${cm[3] ? ' ' + cm[3] : ''}`, section: null, heading: l.slice(0, 60) }
  }
  for (const l of lines.slice(0, 8)) {
    const sm = l.match(/^(\d+\.\d+(?:\.\d+)?)[\s·]*(.*)$/)
    if (sm) return { chapter: null, section: sm[1], heading: l.slice(0, 60) }
  }
  const first = lines[0]
  if (first && first.length <= 40) return { chapter: null, section: null, heading: first }
  return { chapter: null, section: null, heading: null } // 调用方兜底「第n页」
}

/** 超长页按行边界续拆(同 HTML 导入 splitOversized 口径) */
function splitOversized(pageChunks) {
  const out = []
  for (const c of pageChunks) {
    if (c.content.length <= SOFT_CHUNK_LIMIT) { out.push(c); continue }
    const lines = c.content.split('\n')
    let parts = []
    let buf = []
    let len = 0
    for (const l of lines) {
      if (len + l.length + 1 > SOFT_CHUNK_LIMIT && buf.length) {
        parts.push(buf.join('\n'))
        buf = []
        len = 0
      }
      buf.push(l)
      len += l.length + 1
    }
    if (buf.length) parts.push(buf.join('\n'))
    parts.forEach((p, i) => out.push({ ...c, heading: i === 0 ? c.heading : `${c.heading} ·续${i}`, content: p }))
  }
  return out
}

async function main() {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(fs.readFileSync(PDF_PATH))
  const doc = await pdfjs.getDocument({
    data,
    useSystemFonts: true,
    cMapUrl: 'node_modules/pdfjs-dist/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/',
    wasmUrl: 'node_modules/pdfjs-dist/wasm/',
  }).promise

  const total = doc.numPages
  const end = LIMIT ? Math.min(START_PAGE + LIMIT - 1, total) : total
  console.log(`PDF: ${path.basename(PDF_PATH)} / ${total} 页,处理 ${START_PAGE}-${end},scale=${SCALE} quality=${QUALITY}`)

  // 元数据:文件名去扩展名作书名(--title 覆盖)
  const baseName = path.basename(PDF_PATH, '.pdf').replace(/^普通高中教科书[··]?/, '').trim()
  const title = (typeof args.title === 'string' && args.title) || baseName
  const subject = guessSubject(title + ' ' + path.basename(PDF_PATH))
  const kind = guessKind(title)

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })

  try {
    const u = await pool.query(`SELECT id FROM "User" WHERE email = $1`, [USER_EMAIL])
    if (!u.rowCount) { console.error(`用户不存在: ${USER_EMAIL}`); process.exit(1) }
    const userId = u.rows[0].id

    // 幂等:同用户同名先删旧;bookKey 复用旧值避免页图目录换名产生孤儿
    // (--bookkey 可显式指定,用于断点重跑时接续已有页图目录)
    const old = await pool.query(
      `SELECT id, "bookKey" FROM "KnowledgeDoc" WHERE "userId" = $1 AND title = $2`,
      [userId, title]
    )
    const argBookKey = typeof args.bookkey === 'string' && args.bookkey ? args.bookkey : null
    let bookKey = argBookKey || (old.rowCount && old.rows[0].bookKey ? old.rows[0].bookKey : null)
    if (!bookKey) {
      const { nanoid: nanoidGen } = await import('nanoid')
      bookKey = nanoidGen(12)
    }
    if (old.rowCount) {
      await pool.query(`DELETE FROM "KnowledgeDoc" WHERE "userId" = $1 AND title = $2`, [userId, title])
      console.log(`已删除旧资料 "${title}"(含切块)`)
    }

    const outDir = path.join(KB_PAGES_DIR, bookKey)
    fs.mkdirSync(outDir, { recursive: true })

    // 逐页:渲染 WebP + 提取文本(带页级看门狗)
    const pageChunks = []
    const skippedPages = []
    let charCount = 0
    for (let i = START_PAGE; i <= end; i++) {
      // 看门狗:单页处理超时 → 占位图 + 空文本块继续,不让个别损坏页卡死全程
      const pageWork = (async () => {
        const page = await doc.getPage(i)
        const viewport = page.getViewport({ scale: SCALE })
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
        const ctx = canvas.getContext('2d')
        await page.render({ canvas, canvasContext: ctx, viewport }).promise
        const webp = await sharp(canvas.toBuffer('image/png')).webp({ quality: QUALITY }).toBuffer()
        fs.writeFileSync(path.join(outDir, `p${String(i).padStart(3, '0')}.webp`), webp)
        const tc = await page.getTextContent()
        let text = ''
        for (const it of tc.items) {
          if (it.str) text += it.str + (it.hasEOL ? '\n' : '')
        }
        page.cleanup()
        return text
      })()
      let text = null
      try {
        text = await Promise.race([
          pageWork,
          new Promise((_, rej) => setTimeout(() => rej(new Error('page timeout')), PAGE_TIMEOUT_MS)),
        ])
      } catch (err) {
        // 超时/失败:写浅灰占位图防阅读器裂图,该页文本块跳过
        skippedPages.push(i)
        const placeholder = await sharp({
          create: { width: Math.round(595 * SCALE), height: Math.round(842 * SCALE), channels: 3, background: { r: 245, g: 245, b: 244 } },
        }).webp({ quality: 60 }).toBuffer()
        fs.writeFileSync(path.join(outDir, `p${String(i).padStart(3, '0')}.webp`), placeholder)
        console.warn(`\n页 ${i} 处理失败(${err.message}),已写占位图跳过`)
        pageChunks.push({ chapter: null, section: null, heading: `第 ${i} 页`, content: '', page: i })
        charCount += 0
        process.stdout.write(`\r页 ${i}/${end} 已处理`)
        continue
      }
      const lines = pageToLines(text)
      const g = guessHeading(lines)
      const body = lines.join('\n\n')
      pageChunks.push({
        chapter: g.chapter,
        section: g.section,
        heading: g.heading || `第 ${i} 页`,
        content: body,
        page: i,
      })
      charCount += body.length
      process.stdout.write(`\r页 ${i}/${end} 已处理`)
    }
    console.log('')

    const chunks = splitOversized(pageChunks)
    if (!chunks.length) { console.error('未解析出任何切块'); process.exit(1) }

    const docId = crypto.randomUUID()
    await pool.query(
      `INSERT INTO "KnowledgeDoc" (id, "userId", title, subject, kind, "bookKey", "pageCount", "charCount", "chunkCount") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [docId, userId, title, subject, kind, bookKey, total, charCount, chunks.length]
    )
    const COLS = 11
    const values = []
    const params = []
    chunks.forEach((c, i) => {
      const b = i * COLS
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11})`)
      params.push(crypto.randomUUID(), docId, userId, c.chapter, c.section, null, c.heading, c.content, i, c.page, c.content.length)
    })
    await pool.query(
      `INSERT INTO "KnowledgeChunk" (id, "docId", "userId", chapter, section, subsection, heading, content, "sortOrder", page, "charCount") VALUES ${values.join(',')}`,
      params
    )

    console.log(`\n导入完成: ${title} [${subject}/${kind}] bookKey=${bookKey}`)
    console.log(`页图: public/kb-pages/${bookKey}/ (${end - START_PAGE + 1} 张${skippedPages.length ? `,跳过 ${skippedPages.length} 页: ${skippedPages.join(',')}` : ''})`)
    console.log(`切块: ${chunks.length} 块 / 共 ${charCount} 字符,归属用户: ${USER_EMAIL}`)
    for (const c of [chunks[0], chunks[Math.floor(chunks.length / 2)], chunks[chunks.length - 1]]) {
      console.log(`  [P${c.page} ${c.heading}] ${c.content.slice(0, 60).replace(/\n/g, ' ')}…`)
    }
  } finally {
    await pool.end()
  }
}

main().catch((e) => { console.error('FAIL:', e.message); process.exitCode = 1 })
