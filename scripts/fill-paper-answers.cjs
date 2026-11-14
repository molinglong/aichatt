/**
 * 试卷答案批量补录（官方答案卷 / 手批转录）
 *
 * 纪律（与 scripts/solve-paper-answers.cjs 一致）：
 *   - 只填 answer IS NULL 的题，UPDATE 带 WHERE answer IS NULL 双保险，绝不覆盖已有答案；
 *   - 默认 dry-run，必须显式 --apply 才写库；
 *   - --apply 前把该卷全部题目快照备份到 data/exam-papers/<slug>/answer-backup-<时间戳>.csv；
 *   - 答案统一存成「<题号>. <答案正文>」，与卷面答案页格式一致。
 *
 * 输入 CSV 列（必需）：slug, number, answer
 *   可选：source（official|ai，缺省取 --source，默认 official）
 *   其余列（title/kind/score/stem_head…）忽略，方便直接用「待补答案模板」。
 *   答案含逗号/换行时用双引号包起来（标准 CSV），也支持 Excel 另存的 UTF-8 CSV。
 *
 * 用法:
 *   node scripts/fill-paper-answers.cjs deliverables/待补答案模板-20261113.csv              # 预演
 *   node scripts/fill-paper-answers.cjs <填好的.csv> --apply                              # 落库
 *   node scripts/fill-paper-answers.cjs <填好的.csv> --apply --source ai --user admin@qq.com
 */
const fs = require('fs')
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
const { Pool } = require('pg')

const ROOT = path.join(__dirname, '..')

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) { args[a.slice(2)] = next; i++ } else args[a.slice(2)] = true
    } else args._.push(a)
  }
  return args
}

// 支持引号包裹、字段内逗号/换行、"" 转义、UTF-8 BOM
function parseCsv(text) {
  text = text.replace(/^\uFEFF/, '')
  const rows = []
  let row = [], field = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (c !== '\r') field += c
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  if (!rows.length) return []
  const header = rows.shift().map((h) => h.trim())
  return rows
    .filter((r) => r.length && r.some((v) => String(v).trim() !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])))
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const stamp = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const FILE = args._[0]
  const APPLY = !!args.apply
  const USER_EMAIL = args.user || 'admin@qq.com'
  const DEFAULT_SOURCE = args.source || 'official'
  if (!FILE) {
    console.error('用法: node scripts/fill-paper-answers.cjs <答案.csv> [--apply] [--source official|ai] [--user email]')
    process.exit(1)
  }
  if (!['official', 'ai'].includes(DEFAULT_SOURCE)) { console.error('--source 只能是 official 或 ai'); process.exit(1) }
  const csvPath = path.isAbsolute(FILE) ? FILE : path.join(ROOT, FILE)
  if (!fs.existsSync(csvPath)) { console.error(`文件不存在: ${csvPath}`); process.exit(1) }
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'))
  if (!rows.length) { console.error('CSV 没有数据行'); process.exit(1) }
  for (const col of ['slug', 'number', 'answer']) {
    if (!(col in rows[0])) { console.error(`CSV 缺列: ${col}（表头需含 slug,number,answer）`); process.exit(1) }
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const report = { file: path.relative(ROOT, csvPath), apply: APPLY, user: USER_EMAIL, filled: [], skipped: [], errors: [], backups: [], at: new Date().toISOString() }
  try {
    const u = await pool.query(`SELECT id FROM "User" WHERE email = $1`, [USER_EMAIL])
    if (!u.rowCount) { console.error(`用户不存在: ${USER_EMAIL}`); process.exit(1) }
    const userId = u.rows[0].id

    // 按卷分组，一卷一次查询/一次备份
    const bySlug = new Map()
    rows.forEach((r, i) => {
      const answer = (r.answer || '').trim()
      if (!answer) return // 模板里没填的行直接跳过
      const key = r.slug.trim()
      if (!bySlug.has(key)) bySlug.set(key, [])
      bySlug.get(key).push({ ...r, line: i + 2, answer })
    })
    if (!bySlug.size) {
      console.log('CSV 里没有任何已填写的答案（answer 列全空）。请先填答案，或确认列名为 answer。')
      return
    }

    for (const [slug, items] of bySlug) {
      const p = await pool.query(`SELECT id, title FROM "Paper" WHERE "userId" = $1 AND slug = $2`, [userId, slug])
      if (!p.rowCount) { items.forEach((r) => report.errors.push({ slug, number: r.number, err: '试卷不存在' })); console.error(`✗ ${slug}: 试卷不存在`); continue }
      const paperId = p.rows[0].id
      const qs = await pool.query(`SELECT id, number, answer, "answerSource" FROM "PaperQuestion" WHERE "paperId" = $1 ORDER BY number`, [paperId])
      const byNumber = new Map(qs.rows.map((q) => [q.number, q]))

      const candidates = []
      for (const r of items) {
        const num = Number(r.number)
        if (!Number.isInteger(num)) { report.errors.push({ slug, number: r.number, err: '题号不是整数' }); continue }
        const q = byNumber.get(num)
        if (!q) { report.errors.push({ slug, number: num, err: '该卷无此题号' }); continue }
        if (q.answer !== null) { report.skipped.push({ slug, number: num, reason: '已有答案，不覆盖' }); continue }
        const src = (r.source || DEFAULT_SOURCE).trim()
        if (!['official', 'ai'].includes(src)) { report.errors.push({ slug, number: num, err: `source 非法: ${src}` }); continue }
        const body = new RegExp(`^${num}\\.\\s`).test(r.answer) ? r.answer : `${num}. ${r.answer}`
        candidates.push({ q, num, body, src })
      }
      if (!candidates.length) { console.log(`· ${slug}: 无可填题目`); continue }

      if (APPLY) {
        const backupPath = path.join(ROOT, 'data', 'exam-papers', slug, `answer-backup-${stamp()}.csv`)
        const head = 'id,number,kind,score,paperId,answer,answerSource\n'
        const full = await pool.query(`SELECT id, number, kind, score, "paperId", answer, "answerSource" FROM "PaperQuestion" WHERE "paperId" = $1 ORDER BY number`, [paperId])
        const body = full.rows.map((q) => [q.id, q.number, q.kind, q.score, q.paperId, q.answer ?? '', q.answerSource].map(csvCell).join(',')).join('\n')
        fs.mkdirSync(path.dirname(backupPath), { recursive: true })
        fs.writeFileSync(backupPath, '\uFEFF' + head + body + '\n', 'utf8')
        report.backups.push(path.relative(ROOT, backupPath))
        console.log(`  备份: ${path.relative(ROOT, backupPath)}`)
      }

      for (const c of candidates) {
        if (!APPLY) {
          report.filled.push({ slug, number: c.num, preview: c.body.slice(0, 90), source: c.src })
          console.log(`  [预演] ${slug} Q${c.num} ← ${c.src}: ${c.body.slice(0, 70).replace(/\n/g, ' ')}…`)
          continue
        }
        const upd = await pool.query(
          `UPDATE "PaperQuestion" SET answer = $1, "answerSource" = $2 WHERE id = $3 AND answer IS NULL`,
          [c.body, c.src, c.q.id]
        )
        if (upd.rowCount) { report.filled.push({ slug, number: c.num, source: c.src }); console.log(`  ✓ ${slug} Q${c.num} (${c.src})`) }
        else report.skipped.push({ slug, number: c.num, reason: '并发写入/已有答案' })
      }
    }
  } finally {
    await pool.end()
  }

  console.log(`\n==== 汇总（${APPLY ? '已落库' : 'DRY 预演，未写库'}）====`)
  console.log(`可填 ${report.filled.length} 题 | 跳过 ${report.skipped.length} | 错误 ${report.errors.length} | 备份 ${report.backups.length} 份`)
  if (report.errors.length) console.log('错误:', JSON.stringify(report.errors.slice(0, 10)))
  if (!APPLY && report.filled.length) console.log('确认无误后加 --apply 落库。')
  if (APPLY) {
    const out = path.join(ROOT, 'deliverables', `fill-answers-report-${stamp()}.json`)
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8')
    console.log(`报告: ${path.relative(ROOT, out)}`)
  }
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1) })
