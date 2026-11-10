/**
 * 导入脚本(试卷库)：按页 HTML -> Paper + PaperPage
 *
 * 输入目录约定(与试卷录入契约一致):
 *   data/exam-papers/<slug>/page-NN.html   每页一个文件，内含 <article class="exam-paper" …>
 *   data/exam-papers/<slug>/images/*.png   figure 引用的裁图(相对 src="images/…")
 *
 * 做的事:
 *   1) 按文件名数字排序读页，校验各页 article 元数据一致(subject/title/总分/时长)
 *   2) 汇总题号、题型、分值，校验题号无重复、总分与卷头一致(可 --allow-score-mismatch 降级)
 *   3) 图片复制到 public/exam-papers/<slug>/ 并把 src 改写为 /exam-papers/<slug>/…，
 *      使 PaperPage.html 脱离源目录也能直接渲染
 *   4) 幂等落库：同用户同 slug 更新元数据、删旧页、插新页(单事务)
 *   5) 逐题解析：按契约抽取每道 div.question 的题干/选项/图/答案 → PaperQuestion 一题一行
 *      (检索/考点统计的投影层；PaperPage 仍是整卷原件。缺答案题 answer=null，不回填 Question)
 *
 * 题目写入 PaperQuestion(逐题索引层)而非 Question：卷面答案缺失(answer=null)，
 * 与练题池隔离；官方答案齐备后由回填脚本搬运进 Question。
 *
 * 用法:
 *   node scripts/import-exam-paper.cjs data/exam-papers/guangxi-math-mock-1
 *        [--user admin@qq.com] [--slug 覆盖目录名] [--dry]
 *        [--allow-gaps] [--allow-score-mismatch] [--allow-empty-pages]
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
const { Pool } = require('pg')

const ROOT = path.join(__dirname, '..')
const PUBLIC_DIR = path.join(ROOT, 'public')
const SUBJECTS = ['math', 'chinese', 'english', 'physics', 'chemistry', 'biology', 'history', 'politics', 'geography', 'other']

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
const INPUT_DIR = args._[0] ? path.resolve(ROOT, args._[0]) : null
const USER_EMAIL = args.user || 'admin@qq.com'
const DRY = !!args.dry
const ALLOW_GAPS = !!args['allow-gaps']
const ALLOW_SCORE_MISMATCH = !!args['allow-score-mismatch']
const ALLOW_EMPTY_PAGES = !!args['allow-empty-pages']

if (!INPUT_DIR || !fs.existsSync(INPUT_DIR)) {
  console.error('用法: node scripts/import-exam-paper.cjs data/exam-papers/<slug> [--user email] [--slug 名] [--dry] [--allow-gaps] [--allow-score-mismatch] [--allow-empty-pages]')
  process.exit(1)
}

const SLUG = typeof args.slug === 'string' ? args.slug : path.basename(INPUT_DIR)
if (!/^[a-z0-9][a-z0-9-]*$/.test(SLUG)) {
  console.error(`slug 只能用小写字母/数字/连字符: ${SLUG}`)
  process.exit(1)
}
const SOURCE_DIR = path.relative(ROOT, INPUT_DIR).split(path.sep).join('/')
const PUBLIC_SLUG_DIR = path.join(PUBLIC_DIR, 'exam-papers', SLUG)

// —— HTML 工具 ——
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', mdash: '—', ndash: '–', hellip: '…' }
function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m)
}
function attr(tag, name) {
  const m = tag.match(new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=\\s*"([^"]*)"', 'i'))
  return m ? decodeEntities(m[1]).trim() : null
}
function classList(tag) {
  const m = tag.match(/\bclass\s*=\s*"([^"]*)"/i)
  return m ? m[1].split(/\s+/).filter(Boolean) : []
}
function intAttr(tag, name) {
  const v = attr(tag, name)
  if (v === null || v === '') return null
  const n = Number(v)
  return Number.isInteger(n) ? n : NaN
}

/** 取 <article class="exam-paper"> 整段(含标签)；找不到返回 null */
function extractArticle(html) {
  const openRe = /<article\b[^>]*>/gi
  let m
  while ((m = openRe.exec(html))) {
    if (!classList(m[0]).includes('exam-paper')) continue
    const close = html.lastIndexOf('</article>')
    if (close < openRe.lastIndex) return null
    return { openTag: m[0], body: html.slice(openRe.lastIndex, close), raw: html.slice(m.index, close + '</article>'.length) }
  }
  return null
}

/** 页面文件名里的页码 */
function readPages() {
  const entries = fs.readdirSync(INPUT_DIR)
  const pages = []
  for (const name of entries) {
    const m = name.match(/^page-(\d+)\.html$/i)
    if (!m) continue
    pages.push({ pageNo: Number(m[1]), file: path.join(INPUT_DIR, name), name })
  }
  pages.sort((a, b) => a.pageNo - b.pageNo)
  if (!pages.length) {
    console.error(`目录内没有 page-NN.html: ${INPUT_DIR}`)
    process.exit(1)
  }
  const dup = pages.find((p, i) => i > 0 && p.pageNo === pages[i - 1].pageNo)
  if (dup) {
    console.error(`页码重复: page-${dup.pageNo}`)
    process.exit(1)
  }
  return pages
}

function parsePages(pages) {
  const parsed = []
  for (const p of pages) {
    const html = fs.readFileSync(p.file, 'utf8')
    const art = extractArticle(html)
    if (!art) {
      console.error(`${p.name}: 未找到 <article class="exam-paper">`)
      process.exit(1)
    }
    const meta = {
      subject: attr(art.openTag, 'data-subject'),
      year: attr(art.openTag, 'data-year') || null,
      region: attr(art.openTag, 'data-region') || null,
      examType: attr(art.openTag, 'data-exam-type') || null,
      title: attr(art.openTag, 'data-title'),
      totalScore: intAttr(art.openTag, 'data-total-score'),
      durationMin: intAttr(art.openTag, 'data-duration-min'),
    }
    if (!meta.title) { console.error(`${p.name}: 缺少 data-title`); process.exit(1) }
    if (!SUBJECTS.includes(meta.subject)) { console.error(`${p.name}: data-subject 非法 (${meta.subject})`); process.exit(1) }
    if (!Number.isInteger(meta.totalScore) || meta.totalScore <= 0) { console.error(`${p.name}: data-total-score 非法`); process.exit(1) }
    if (!Number.isInteger(meta.durationMin) || meta.durationMin <= 0) { console.error(`${p.name}: data-duration-min 非法`); process.exit(1) }

    // 卷头页码与文件名页码交叉校验(只告警，不阻断：部分卷无页脚)
    const metaLine = art.body.match(/<p[^>]*class="[^"]*paper-meta[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
    if (metaLine) {
      const pm = decodeEntities(metaLine[1].replace(/<[^>]+>/g, '')).match(/第\s*(\d+)\s*页/)
      if (pm && Number(pm[1]) !== p.pageNo) {
        console.warn(`  警告: ${p.name} 卷头写「第 ${pm[1]} 页」，与文件名页码 ${p.pageNo} 不一致`)
      }
    }

    // 题目：按出现顺序收集 question 容器
    const questions = []
    const qRe = /<div\b[^>]*>/gi
    let qm
    while ((qm = qRe.exec(art.body))) {
      if (!classList(qm[0]).includes('question')) continue
      const number = intAttr(qm[0], 'data-number')
      const score = intAttr(qm[0], 'data-score')
      const kind = attr(qm[0], 'data-kind')
      if (!Number.isInteger(number)) {
        console.error(`${p.name}: 有 question 缺少合法 data-number`)
        process.exit(1)
      }
      if (!Number.isInteger(score)) {
        console.error(`${p.name}: 第 ${number} 题缺少合法 data-score`)
        process.exit(1)
      }
      if (!['choice', 'answer'].includes(kind)) {
        console.error(`${p.name}: 第 ${number} 题 data-kind 非法 (${kind})`)
        process.exit(1)
      }
      questions.push({ number, score, kind })
    }
    if (!questions.length) {
      const msg = `${p.name}: 未解析出任何题目`
      if (!ALLOW_EMPTY_PAGES) { console.error(msg + '；纯语料页(整页阅读材料无题目)确认无误再加 --allow-empty-pages'); process.exit(1) }
      console.warn('  警告: ' + msg)
    }

    const answerMissing = (art.body.match(/data-answer-missing="true"/g) || []).length
    const images = []
    const imgRe = /<img\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/gi
    let im
    while ((im = imgRe.exec(art.body))) {
      const src = im[2].trim()
      if (!src || /^(https?:|data:|\/)/i.test(src)) continue
      if (!images.includes(src)) images.push(src)
    }

    parsed.push({ ...p, meta, questions, answerMissing, images, article: art })
  }

  // 各页元数据必须一致
  const first = parsed[0].meta
  for (const p of parsed.slice(1)) {
    for (const key of ['subject', 'title', 'totalScore', 'durationMin']) {
      if (p.meta[key] !== first[key]) {
        console.error(`${p.name}: ${key} 与第 ${parsed[0].pageNo} 页不一致 (${p.meta[key]} ≠ ${first[key]})`)
        process.exit(1)
      }
    }
    for (const key of ['year', 'region', 'examType']) {
      if (p.meta[key] !== first[key]) console.warn(`  警告: ${p.name}: ${key} 与首页不一致，以首页为准`)
    }
  }

  // 页码完整性
  const pageNos = parsed.map((p) => p.pageNo)
  const maxPage = Math.max(...pageNos)
  const missingPages = []
  for (let i = 1; i <= maxPage; i++) if (!pageNos.includes(i)) missingPages.push(i)
  if (missingPages.length) {
    const msg = `页码不连续，缺第 ${missingPages.join('、')} 页`
    if (!ALLOW_GAPS) { console.error(msg + '；确认是残卷再加 --allow-gaps'); process.exit(1) }
    console.warn('  警告: ' + msg)
  }

  // 题号完整性
  const allQ = parsed.flatMap((p) => p.questions)
  const seen = new Set()
  for (const q of allQ) {
    if (seen.has(q.number)) { console.error(`题号重复: ${q.number}`); process.exit(1) }
    seen.add(q.number)
  }
  const maxQ = Math.max(...seen)
  const missingQ = []
  for (let i = 1; i <= maxQ; i++) if (!seen.has(i)) missingQ.push(i)
  if (missingQ.length) {
    const msg = `题号不连续，缺第 ${missingQ.join('、')} 题`
    if (!ALLOW_GAPS) { console.error(msg + '；确认是残卷再加 --allow-gaps'); process.exit(1) }
    console.warn('  警告: ' + msg)
  }

  const scoreSum = allQ.reduce((n, q) => n + q.score, 0)
  if (scoreSum !== first.totalScore) {
    const msg = `分值合计 ${scoreSum} 与卷头总分 ${first.totalScore} 不一致`
    if (!ALLOW_SCORE_MISMATCH) { console.error(msg + '；确认卷头无误再加 --allow-score-mismatch'); process.exit(1) }
    console.warn('  警告: ' + msg)
  }

  return { parsed, allQ, scoreSum }
}

/** 图片复制 + src 改写；返回改写后的 article html */
function materializeImages(p) {
  let html = p.article.raw
  for (const src of p.images) {
    const abs = path.resolve(INPUT_DIR, src)
    const rel = path.relative(INPUT_DIR, abs)
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      console.error(`${p.name}: 图片路径越界 ${src}`)
      process.exit(1)
    }
    if (!fs.existsSync(abs)) {
      console.error(`${p.name}: 图片不存在 ${src}`)
      process.exit(1)
    }
    const dest = path.join(PUBLIC_SLUG_DIR, rel)
    if (!DRY) {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(abs, dest)
    }
    const publicSrc = `/exam-papers/${SLUG}/${rel.split(path.sep).join('/')}`
    html = html.split(`src="${src}"`).join(`src="${publicSrc}"`).split(`src='${src}'`).join(`src='${publicSrc}'`)
  }
  return html
}

// —— 逐题解析（PaperQuestion 投影层）——

/** 去标签转文本：表格转行(单元格用全角｜分隔,防 Markdown 管道符冲突)、小问/材料/换行处理；
 *  其余标签剥掉，实体最后解码(防 &lt;p&gt; 被当标签误删)；LaTeX $...$ 原样保留 */
function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_, inner) => {
        const rows = []
        const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
        let tr
        while ((tr = trRe.exec(inner))) {
          const cells = []
          const tdRe = /<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi
          let td
          while ((td = tdRe.exec(tr[1]))) cells.push(htmlToText(td[1]).replace(/\s+/g, ' ').trim())
          rows.push(cells.join('｜'))
        }
        return '\n' + rows.join('\n') + '\n'
      })
      .replace(/<p\b[^>]*class="[^"]*subquestion[^"]*"[^>]*>/gi, (tag) => {
        const no = attr(tag, 'data-no')
        return '\n' + (no ? `(${no}) ` : '')
      })
      .replace(/<blockquote\b[^>]*>/gi, '\n【材料】')
      .replace(/<\/blockquote>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/** figure → [图N] / [缺图: caption] 占位标记；img src 收进 images 数组 */
function markFigures(html, images) {
  return html.replace(/<figure\b([^>]*)>([\s\S]*?)<\/figure>/gi, (_, fAttrs, inner) => {
    if (/figure-missing/.test(fAttrs)) {
      const capHtml = (inner.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i) || [])[1] || ''
      const cap = htmlToText(capHtml).trim()
      return `\n[缺图: ${cap || '图'}]\n`
    }
    const label = attr('<figure' + fAttrs + '>', 'data-label') || '图'
    const srcM = inner.match(/<img\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/i)
    if (srcM && srcM[2].trim()) images.push(srcM[2].trim())
    return `\n[${label}]\n`
  })
}

/** 平衡扫描：从 startIdx 处的 <div …> 开标签起取整个 div（嵌套安全），返回 {inner, end} */
function extractDivBlock(html, startIdx) {
  const openEnd = html.indexOf('>', startIdx)
  if (openEnd < 0) return null
  const re = /<\/?div\b[^>]*>/g
  re.lastIndex = openEnd + 1
  let depth = 1
  let m
  while ((m = re.exec(html))) {
    if (/^<div/i.test(m[0])) depth++
    else {
      depth--
      if (depth === 0) return { inner: html.slice(openEnd + 1, m.index), end: re.lastIndex }
    }
  }
  return null
}

/** 取 html 内第一个 class 含 className 的 div，返回 {openTag, inner} | null */
function extractDivByClass(html, className) {
  const re = /<div\b[^>]*>/gi
  let m
  while ((m = re.exec(html))) {
    if (!classList(m[0]).includes(className)) continue
    const blk = extractDivBlock(html, m.index)
    return blk ? { openTag: m[0], inner: blk.inner } : null
  }
  return null
}

/** 解析单个 question div 块 → PaperQuestion 行字段（不含 id/paperId/userId/topics） */
function parseQuestionBlock(pageNo, section, openTag, block, errors) {
  const number = intAttr(openTag, 'data-number')
  const kind = attr(openTag, 'data-kind')
  const score = intAttr(openTag, 'data-score')
  const label = `page-${pageNo} Q${number}`
  if (!Number.isInteger(number) || !['choice', 'answer'].includes(kind) || !Number.isInteger(score)) {
    errors.push(`${label}: 开标签缺合法 data-number/kind/score`)
    return null
  }
  const images = []
  const marked = markFigures(block, images)

  const stemDiv = extractDivByClass(marked, 'stem')
  const stem = stemDiv ? htmlToText(stemDiv.inner) : ''
  if (!stem) errors.push(`${label}: 题干为空(缺 div.stem?)`)

  const options = []
  const olM = marked.match(/<ol\b[^>]*class="[^"]*options[^"]*"[^>]*>([\s\S]*?)<\/ol>/i)
  if (olM) {
    const liRe = /<li\b([^>]*)>([\s\S]*?)<\/li>/gi
    let li
    while ((li = liRe.exec(olM[1]))) {
      const letter = attr('<li' + li[1] + '>', 'data-letter') || ''
      const text = htmlToText(li[2]).trim()
      options.push(letter ? `${letter}. ${text}` : text)
    }
  }

  const ansDiv = extractDivByClass(marked, 'answer')
  let answer = null
  if (ansDiv) {
    const ansMissing = attr(ansDiv.openTag, 'data-answer-missing') === 'true'
    const ansText = htmlToText(ansDiv.inner).trim()
    if (!ansMissing && ansText) {
      const anaDiv = extractDivByClass(marked, 'analysis')
      const anaText = anaDiv ? htmlToText(anaDiv.inner).trim() : ''
      answer = anaText ? `${ansText}\n解析：${anaText}` : ansText
    }
  }

  if (kind === 'choice' && options.length < 2) errors.push(`${label}: 选择题选项不足(${options.length})`)
  if (kind === 'answer' && options.length) errors.push(`${label}: 非选择题却带 ${options.length} 个选项`)

  return { number, section, kind, multiple: attr(openTag, 'data-multiple') === 'true', score, stem, options, images, answer }
}

/** 逐题抽取一页（须传入图片路径已改写的 article html，images 直接是可路由 URL） */
function extractQuestionsFromPage(p, articleHtml, errors) {
  const out = []
  const re = /<section\b[^>]*>|<div\b[^>]*>/gi
  let curSection = null
  let m
  while ((m = re.exec(articleHtml))) {
    if (/^<section/i.test(m[0])) {
      const s = attr(m[0], 'data-section')
      if (s) curSection = s
      continue
    }
    if (!classList(m[0]).includes('question')) continue
    const blk = extractDivBlock(articleHtml, m.index)
    if (!blk) { errors.push(`page-${p.pageNo}: question div 未闭合`); break }
    const q = parseQuestionBlock(p.pageNo, curSection, m[0], articleHtml.slice(m.index, blk.end), errors)
    if (q) out.push(q)
    re.lastIndex = blk.end
  }
  return out
}

async function main() {
  const pages = readPages()
  const { parsed, allQ, scoreSum } = parsePages(pages)
  const meta = parsed[0].meta

  console.log(`试卷: ${meta.title}`)
  console.log(`目录: ${SOURCE_DIR}  slug=${SLUG}`)
  console.log(`页数: ${parsed.length}  题数: ${allQ.length}  分值合计: ${scoreSum}/${meta.totalScore}  时长: ${meta.durationMin} 分钟`)
  parsed.forEach((p) => {
    const range = p.questions.length ? `Q${p.questions[0].number}–Q${p.questions[p.questions.length - 1].number}` : '无题(纯语料页)'
    console.log(`  page-${String(p.pageNo).padStart(2, '0')}: ${range}  ${p.questions.length} 题  ${p.images.length} 图  ${p.answerMissing} 题标缺答案`)
  })
  if (meta.year === null) console.log('  提示: data-year 为空，年份留空')

  // 图片校验/复制先做，任何一张缺失都在落库前失败
  const pageHtml = parsed.map((p) => ({ pageNo: p.pageNo, html: materializeImages(p) }))
  if (!DRY && parsed.some((p) => p.images.length)) {
    console.log(`图片已复制到: ${path.relative(ROOT, PUBLIC_SLUG_DIR).split(path.sep).join('/')}/`)
  }

  // 逐题解析（在图片路径改写后做，images 直接是可路由 URL）
  const parseErrors = []
  const paperQuestions = []
  for (const p of parsed) {
    const pageRow = pageHtml.find((x) => x.pageNo === p.pageNo)
    paperQuestions.push(...extractQuestionsFromPage(p, pageRow.html, parseErrors))
  }
  const parsedNos = new Set(paperQuestions.map((q) => q.number))
  if (paperQuestions.length !== allQ.length) parseErrors.push(`解析题数 ${paperQuestions.length} ≠ 卷面题数 ${allQ.length}`)
  for (const q of allQ) if (!parsedNos.has(q.number)) parseErrors.push(`第 ${q.number} 题未被解析出`)
  if (parseErrors.length) {
    parseErrors.forEach((e) => console.error('  解析错误: ' + e))
    process.exit(1)
  }
  const noAnswer = paperQuestions.filter((q) => q.answer === null).length
  const imgTotal = paperQuestions.reduce((n, q) => n + q.images.length, 0)
  console.log(`逐题解析: ${paperQuestions.length} 题（选择 ${paperQuestions.filter((q) => q.kind === 'choice').length} / 解答填空 ${paperQuestions.filter((q) => q.kind === 'answer').length}），缺答案 ${noAnswer}，题图 ${imgTotal} 张`)

  if (DRY) {
    const sample = paperQuestions.find((q) => q.images.length && q.options.length) || paperQuestions[0]
    const tableQ = paperQuestions.find((q) => q.stem.includes('｜'))
    console.log(`\n样例 Q${sample.number}（含图/选项）:\n` + JSON.stringify({ ...sample, stem: sample.stem.slice(0, 120) }, null, 1))
    if (tableQ) console.log(`\n表格题样例 Q${tableQ.number} stem:\n` + tableQ.stem)
    console.log('\n--dry 完成，未写数据库')
    return
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    const u = await pool.query(`SELECT id FROM "User" WHERE email = $1`, [USER_EMAIL])
    if (!u.rowCount) { console.error(`用户不存在: ${USER_EMAIL}`); process.exit(1) }
    const userId = u.rows[0].id

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const found = await client.query(`SELECT id FROM "Paper" WHERE "userId" = $1 AND slug = $2`, [userId, SLUG])
      let paperId
      if (found.rowCount) {
        paperId = found.rows[0].id
        await client.query(
          `UPDATE "Paper" SET title=$3, subject=$4, year=$5, region=$6, "examType"=$7,
             "totalScore"=$8, "durationMin"=$9, "questionCount"=$10, "pageCount"=$11,
             "sourceDir"=$12, "updatedAt"=CURRENT_TIMESTAMP
           WHERE id=$1 AND "userId"=$2`,
          [paperId, userId, meta.title, meta.subject, meta.year, meta.region, meta.examType,
            meta.totalScore, meta.durationMin, allQ.length, pageHtml.length, SOURCE_DIR]
        )
        await client.query(`DELETE FROM "PaperPage" WHERE "paperId" = $1`, [paperId])
        console.log(`\n已存在 slug=${SLUG}，更新元数据并重建页面`)
      } else {
        paperId = crypto.randomUUID()
        await client.query(
          `INSERT INTO "Paper" (id, "userId", slug, title, subject, year, region, "examType",
             "totalScore", "durationMin", "questionCount", "pageCount", "sourceDir", "updatedAt")
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,CURRENT_TIMESTAMP)`,
          [paperId, userId, SLUG, meta.title, meta.subject, meta.year, meta.region, meta.examType,
            meta.totalScore, meta.durationMin, allQ.length, pageHtml.length, SOURCE_DIR]
        )
        console.log(`\n新建试卷记录`)
      }

      const COLS = 4
      const values = []
      const params = []
      pageHtml.forEach((p, i) => {
        const b = i * COLS
        values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4})`)
        params.push(crypto.randomUUID(), paperId, p.pageNo, p.html)
      })
      await client.query(
        `INSERT INTO "PaperPage" (id, "paperId", "pageNo", html) VALUES ${values.join(',')}`,
        params
      )
      // 逐题索引层：重建 PaperQuestion（与页面同事务，保持整卷幂等）
      await client.query(`DELETE FROM "PaperQuestion" WHERE "paperId" = $1`, [paperId])
      const QCOLS = 13
      const qValues = []
      const qParams = []
      paperQuestions.forEach((q, i) => {
        const b = i * QCOLS
        qValues.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${b + 13})`)
        qParams.push(crypto.randomUUID(), paperId, userId, q.number, q.section, q.kind, q.multiple, q.score, q.stem, q.options, q.images, q.answer, [])
      })
      await client.query(
        `INSERT INTO "PaperQuestion" (id, "paperId", "userId", number, section, kind, multiple, score, stem, options, images, answer, topics) VALUES ${qValues.join(',')}`,
        qParams
      )
      await client.query('COMMIT')
      console.log(`落库完成: Paper ${paperId}`)
      console.log(`归属用户: ${USER_EMAIL}；页面 ${pageHtml.length} 页；题目 ${allQ.length} 道`)
      console.log(`逐题索引已写入 PaperQuestion ${paperQuestions.length} 行（缺答案 ${noAnswer} 题）。`)
      console.log('未写入 Question：待官方答案齐备后回填 paperId/number/score。')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  } finally {
    await pool.end()
  }
}

main().catch((e) => { console.error('FAIL:', e.message); process.exitCode = 1 })
