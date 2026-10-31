/**
 * 地理图册扫描页 → 视觉转写 → 知识库导入 HTML
 *
 * 前置: python scripts/pdf2geo-atlas-pages.py 已生成 tmp-geo-atlas/<slug>/pNNN.jpg
 * 用法:
 *   node scripts/geo-atlas-transcribe-to-kb.cjs --pages 1-6
 *   node scripts/geo-atlas-transcribe-to-kb.cjs              # 全量，已转写的页复用缓存
 *   node scripts/geo-atlas-transcribe-to-kb.cjs --rebuild    # 不调 API，只用缓存重建 HTML
 *
 * 产物:
 *   deliverables/<slug>.transcribe.json   逐页转写缓存（可断点续跑）
 *   deliverables/<slug>.import.html       交给 scripts/import-knowledge-html.cjs 的标准 HTML
 */
const fs = require('fs')
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true })

const ROOT = path.join(__dirname, '..')
const API_URL = 'https://api.deepseek.com/chat/completions'
const MODEL = 'deepseek-flash'

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) { args[key] = next; i++ } else { args[key] = true }
    } else args._.push(a)
  }
  return args
}

const args = parseArgs(process.argv)
const SLUG = args.slug || 'geography-required1'
const VISION_DIR = path.join(ROOT, args['vision-dir'] || path.join('tmp-geo-atlas', SLUG))
const PUBLIC_BASE = args['public-base'] || `/geo-atlas/${SLUG}`
const OUT_JSON = path.join(ROOT, args['out-json'] || path.join('deliverables', `${SLUG}.transcribe.json`))
const OUT_HTML = path.join(ROOT, args['out-html'] || path.join('deliverables', `${SLUG}.import.html`))
const TITLE = args.title || '地理图册 高中 必修 第一册（配湘教版）'
const BOOK = args.book || '地理图册'
const GRADE = args.grade || '必修 第一册'
const PUBLISHER = args.publisher || '星球地图出版社'
const CONCURRENCY = Number(args.concurrency || 3)
const FORCE = !!args.force
const REBUILD = !!args.rebuild

function selectPages() {
  const spec = typeof args.pages === 'string' ? args.pages : ''
  const ranges = spec.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = s.match(/^(\d+)(?:-(\d+))?$/)
    if (!m) throw new Error(`--pages 片段非法: ${s}`)
    return [Number(m[1]), Number(m[2] || m[1])]
  })
  return fs.readdirSync(VISION_DIR)
    .filter((f) => /^p\d{3}\.jpg$/.test(f))
    .sort()
    .map((f) => ({ file: f, n: Number(f.slice(1, 4)) }))
    .filter((p) => !ranges.length || ranges.some(([a, b]) => p.n >= a && p.n <= b))
}

const PROMPT = [
  '你是高中地理教材编辑。把这一页地理图册扫描页转写成可检索文本，供看不到图的 AI 使用。',
  '只写图面上能看到的信息，以及由图面直接得出的读图结论；不补充图外知识，不编造数字、地名或图例。',
  '看不清的内容写「不清」，宁缺毋滥。图名必须逐字照抄原文。',
  '',
  '只输出严格 JSON（不要 markdown 代码块、不要解释），字段：',
  '{',
  '  "page_type": "cover | toc | content | copyright | blank",',
  '  版权页/出版信息/图书在版编目/主编编辑名单一律记为 copyright。',
  '  "print_page": "页面印刷页码，没有则空字符串",',
  '  "unit": "页眉/标题上的章名，如 第一章 地球的运动；没有则空字符串",',
  '  "title": "本页最主要图件的完整图名原文；整页没有图名时用一句话概括本页主题",',
  '  "book_name": "仅封面页填书名，其余空字符串",',
  '  "publisher": "仅封面页填出版社，其余空字符串",',
  '  "figures": [',
  '    {',
  '      "name": "图名原文",',
  '      "legend": "图例要素，用中文逗号分隔",',
  '      "reading": "图面画了什么；分布/变化规律；读图要点；可能考查的知识点。260 字以内"',
  '    }',
  '  ],',
  '  "text_notes": "页面正文、活动题、思考题、提示语等文字要点；没有则空字符串"',
  '}',
  'figures 最多 4 项，按重要性排序；没有图件时为空数组。',
  '图例超过 20 项时只列主要类别，其余概括为「等」；图廓外的国家/地区序号表只写「图廓外附国家/地区序号表」，不要逐条罗列（figures 与 text_notes 同样适用）。',
].join('\n')

async function callVision(file) {
  const b64 = fs.readFileSync(path.join(VISION_DIR, file)).toString('base64')
  let lastErr
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.API_KEY_DEEPSEEK}`,
        },
        body: JSON.stringify({
          model: MODEL,
          thinking: { type: 'disabled' },
          temperature: 0.1,
          max_tokens: 2000,
          messages: [
            { role: 'system', content: PROMPT },
            {
              role: 'user',
              content: [
                { type: 'text', text: `这是第 ${Number(file.slice(1, 4))} 页。` },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
              ],
            },
          ],
        }),
      })
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`)
      const j = await res.json()
      if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${JSON.stringify(j).slice(0, 200)}`)
      const msg = j.choices?.[0]?.message || {}
      const raw = (msg.content || '').trim()
      if (!raw) throw new Error('空响应')
      return parseJson(raw)
    } catch (err) {
      lastErr = err
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1200 * attempt))
    }
  }
  throw lastErr
}

function parseJson(raw) {
  let s = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a >= 0 && b > a) s = s.slice(a, b + 1)
  return JSON.parse(s)
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function clip(s, n) {
  const v = String(s || '').replace(/\s+/g, ' ').trim()
  return v.length > n ? v.slice(0, n) + '…' : v
}

function isJunkPage(rec) {
  if (!rec || rec.page_type !== 'content') return true
  const t = rec.title || ''
  if (/版权|出版信息|图书在版编目|主编|编辑人员|ISBN/i.test(t)) return true
  if (!(rec.figures || []).length && /ISBN|责任编辑|印张|定价/.test(rec.text_notes || '')) return true
  return false
}

function pageToHtml(rec) {
  if (isJunkPage(rec)) return ''
  const p = rec.pdfPage
  const pageNo = rec.print_page || ''
  const label = pageNo ? `P${pageNo}` : `前置页 ${p}`
  const img = `![图册 ${label}](${PUBLIC_BASE}/p${String(p).padStart(3, '0')}.jpg)`
  const title = clip(rec.title || `图册第 ${p} 页`, 40)
  const out = []
  out.push(`<h3>${label} · ${esc(title)}</h3>`)
  if (rec.unit) out.push(`<p>所属单元：${esc(rec.unit)}</p>`)
  for (const fig of (rec.figures || []).slice(0, 4)) {
    if (fig.name) out.push(`<p>【图】${esc(fig.name)}</p>`)
    if (fig.legend) out.push(`<p>图例：${esc(fig.legend)}</p>`)
    if (fig.reading) out.push(`<p>${esc(fig.reading)}</p>`)
  }
  if (rec.text_notes) out.push(`<p>【页内文字】${esc(rec.text_notes)}</p>`)
  out.push(`<p>【教材原页】${label}（PDF 第 ${p} 页） ${img}</p>`)
  return out.join('\n')
}

function buildHtml(cache) {
  const recs = Object.values(cache).sort((a, b) => a.pdfPage - b.pdfPage)
  const cover = recs.find((r) => r.page_type === 'cover' && (r.book_name || '').trim()) || recs.find((r) => r.page_type === 'cover') || {}
  const book = BOOK
  const publisher = cover.publisher || PUBLISHER
  const body = []
  body.push(`<div class="cover"><h1 class="book-name">${esc(book)}</h1><p class="grade">${esc(GRADE)}</p><p class="publisher">${esc(publisher)}</p></div>`)
  let lastUnit = null
  let contentPages = 0
  for (const rec of recs) {
    if (isJunkPage(rec)) continue
    const unit = (rec.unit || '').replace(/\s+/g, ' ').trim()
    const titleKey = (rec.title || '').replace(/\s+/g, '').trim()
    const unitKey = unit.replace(/\s+/g, '')
    const isSectionUnit = /^第[一二三四五六七八九十百]+节/.test(unitKey)
    if (unit && !isSectionUnit && unitKey !== titleKey && unitKey !== lastUnit) {
      body.push(`<h2 class="chapter-title">${esc(unit)}</h2>`)
      lastUnit = unitKey
    }
    body.push(pageToHtml(rec))
    contentPages++
  }
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(TITLE)}</title></head><body>\n${body.join('\n')}\n</body></html>\n`
  return { html, contentPages, book, publisher }
}

async function main() {
  if (!process.env.API_KEY_DEEPSEEK) {
    console.error('缺少 API_KEY_DEEPSEEK')
    process.exit(1)
  }
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true })
  const cache = fs.existsSync(OUT_JSON) ? JSON.parse(fs.readFileSync(OUT_JSON, 'utf-8')) : {}

  if (!REBUILD) {
    const pages = selectPages()
    console.log(`共 ${pages.length} 页待处理，并发 ${CONCURRENCY}`)
    let idx = 0
    let done = 0
    const save = () => fs.writeFileSync(OUT_JSON, JSON.stringify(cache, null, 1), 'utf-8')
    const worker = async () => {
      while (idx < pages.length) {
        const { file, n } = pages[idx++]
        if (cache[file] && !FORCE) { done++; continue }
        try {
          const rec = await callVision(file)
          cache[file] = { pdfPage: n, ...rec }
          done++
          save()
          const figs = (rec.figures || []).map((f) => f.name).filter(Boolean).join(' / ')
          console.log(`[${done}/${pages.length}] P${n} ${rec.page_type} ${clip(figs || rec.title, 60)}`)
        } catch (err) {
          console.error(`[失败] P${n}: ${err.message}`)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pages.length) }, worker))
    save()
  } else if (!fs.existsSync(OUT_JSON)) {
    console.error(`--rebuild 需要已有缓存: ${OUT_JSON}`)
    process.exit(1)
  }

  const { html, contentPages, book, publisher } = buildHtml(cache)
  fs.mkdirSync(path.dirname(OUT_HTML), { recursive: true })
  fs.writeFileSync(OUT_HTML, html, 'utf-8')
  const all = Object.values(cache)
  const types = all.reduce((m, r) => ((m[r.page_type] = (m[r.page_type] || 0) + 1), m), {})
  console.log(`\n缓存: ${all.length} 页 ${JSON.stringify(types)}`)
  console.log(`入库页: ${contentPages} 页 | 书名: ${book} | 出版社: ${publisher}`)
  console.log(`HTML: ${OUT_HTML}`)
  console.log(`导入: node scripts/import-knowledge-html.cjs "${path.relative(ROOT, OUT_HTML)}" --subject geography --title "${TITLE}"`)
}

main().catch((err) => { console.error(err); process.exit(1) })
