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
 *
 * 题目暂不写入 Question：卷面答案为手写或缺失，空答案题进入抽题池会污染练习。
 *
 * 用法:
 *   node scripts/import-exam-paper.cjs data/exam-papers/guangxi-math-mock-1
 *        [--user admin@qq.com] [--slug 覆盖目录名] [--dry]
 *        [--allow-gaps] [--allow-score-mismatch]
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

if (!INPUT_DIR || !fs.existsSync(INPUT_DIR)) {
  console.error('用法: node scripts/import-exam-paper.cjs data/exam-papers/<slug> [--user email] [--slug 名] [--dry] [--allow-gaps] [--allow-score-mismatch]')
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
    if (!questions.length) { console.error(`${p.name}: 未解析出任何题目`); process.exit(1) }

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

async function main() {
  const pages = readPages()
  const { parsed, allQ, scoreSum } = parsePages(pages)
  const meta = parsed[0].meta

  console.log(`试卷: ${meta.title}`)
  console.log(`目录: ${SOURCE_DIR}  slug=${SLUG}`)
  console.log(`页数: ${parsed.length}  题数: ${allQ.length}  分值合计: ${scoreSum}/${meta.totalScore}  时长: ${meta.durationMin} 分钟`)
  parsed.forEach((p) => {
    console.log(`  page-${String(p.pageNo).padStart(2, '0')}: Q${p.questions[0].number}–Q${p.questions[p.questions.length - 1].number}  ${p.questions.length} 题  ${p.images.length} 图  ${p.answerMissing} 题标缺答案`)
  })
  if (meta.year === null) console.log('  提示: data-year 为空，年份留空')

  // 图片校验/复制先做，任何一张缺失都在落库前失败
  const pageHtml = parsed.map((p) => ({ pageNo: p.pageNo, html: materializeImages(p) }))
  if (!DRY && parsed.some((p) => p.images.length)) {
    console.log(`图片已复制到: ${path.relative(ROOT, PUBLIC_SLUG_DIR).split(path.sep).join('/')}/`)
  }

  if (DRY) {
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
      await client.query('COMMIT')
      console.log(`落库完成: Paper ${paperId}`)
      console.log(`归属用户: ${USER_EMAIL}；页面 ${pageHtml.length} 页；题目 ${allQ.length} 道`)
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
