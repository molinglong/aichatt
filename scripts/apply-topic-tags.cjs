/**
 * 考点标签落库：data/topic-tagging/verdicts.json → PaperQuestion.topics
 *
 * 纪律（与 scripts/fill-paper-answers.cjs 一致）：
 *   - 只处理 accepted / edited 裁决（rejected/pending 不写，题保持无标签）；
 *   - UPDATE 带「topics 为空才写」双保险，绝不覆盖已有标签（math-mock-1 的 35 题库内标签不动）；
 *   - 默认 dry-run 预演，必须显式 --apply 才写库；
 *   - --apply 前把将被写入的题快照备份到 data/topic-tagging/topics-backup-<时间戳>.csv；
 *   - 写完输出全库覆盖统计（各考点题量 / 零题量考点 / 未打标余量），同时存 coverage-<时间戳>.json。
 *
 * 用法:
 *   node scripts/apply-topic-tags.cjs            # 预演
 *   node scripts/apply-topic-tags.cjs --apply    # 落库
 */
const fs = require('fs')
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
const { Pool } = require('pg')

const APPLY = process.argv.includes('--apply')
const ROOT = path.join(__dirname, '..')
const DATA_DIR = path.join(ROOT, 'data', 'topic-tagging')

const stamp = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
const csvCell = (v) => {
  const s = v == null ? '' : String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}` + `"` : s
}

async function main() {
  const verd = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'verdicts.json'), 'utf8'))
  const vocab = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'vocab.json'), 'utf8'))
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const report = { apply: APPLY, at: new Date().toISOString(), filled: [], skipped: [], errors: [], backup: null }

  try {
    // 1) 收集待写题（裁决有效 + 库内 topics 为空）
    const ids = Object.keys(verd).filter((k) => ['accepted', 'edited'].includes(verd[k].action) && (verd[k].topics || []).length)
    const check = await pool.query(
      `SELECT id, number, topics FROM "PaperQuestion" WHERE id = ANY($1) AND (topics IS NULL OR array_length(topics, 1) IS NULL)`,
      [ids]
    )
    const writable = new Map(check.rows.map((r) => [r.id, r]))
    for (const id of ids) {
      const v = verd[id]
      if (!writable.has(id)) { report.skipped.push({ slug: v.slug, number: v.number, reason: '已有库内标签' }); continue }
      report.filled.push({ id, slug: v.slug, number: v.number, topics: v.topics })
    }
    console.log(`待写 ${report.filled.length} 题 | 跳过 ${report.skipped.length}（已有标签）`)

    // 2) 备份
    if (APPLY && report.filled.length) {
      const backupPath = path.join(DATA_DIR, `topics-backup-${stamp()}.csv`)
      const head = 'id,slug,number,topics\n'
      const cur = await pool.query(
        `SELECT q.id, p.slug, q.number, q.topics FROM "PaperQuestion" q JOIN "Paper" p ON p.id = q."paperId" WHERE q.id = ANY($1)`,
        [report.filled.map((f) => f.id)]
      )
      const body = cur.rows.map((r) => [r.id, r.slug, r.number, (r.topics || []).join('|')].map(csvCell).join(',')).join('\n')
      fs.writeFileSync(backupPath, '\uFEFF' + head + body + '\n', 'utf8')
      report.backup = path.relative(ROOT, backupPath)
      console.log('备份:', report.backup)
    }

    // 3) 写库
    if (!APPLY) {
      for (const f of report.filled.slice(0, 8)) console.log(`  [预演] ${f.slug} Q${f.number} ← ${f.topics.join(' / ')}`)
      if (report.filled.length > 8) console.log(`  …共 ${report.filled.length} 题`)
      console.log('\nDRY 预演，未写库。确认后加 --apply。')
    } else {
      for (const f of report.filled) {
        const upd = await pool.query(
          `UPDATE "PaperQuestion" SET topics = $1 WHERE id = $2 AND (topics IS NULL OR array_length(topics, 1) IS NULL)`,
          [f.topics, f.id]
        )
        if (!upd.rowCount) { report.errors.push({ slug: f.slug, number: f.number, err: '并发/已有标签' }); continue }
        console.log(`  ✓ ${f.slug} Q${f.number} ← ${f.topics.join(' / ')}`)
      }
    }

    // 4) 覆盖统计（apply 后从 DB 读实际状态；dry-run 用裁决投影）
    let distRows
    if (APPLY) {
      distRows = (await pool.query(
        `SELECT p.subject, t.tag, COUNT(*) AS n
         FROM "PaperQuestion" q JOIN "Paper" p ON p.id = q."paperId", unnest(q.topics) AS t(tag)
         GROUP BY 1, 2 ORDER BY 1, n DESC`
      )).rows
    } else {
      // 预演投影：库内已有 + 裁决 topics
      const dbRows = (await pool.query(
        `SELECT p.subject, t.tag, COUNT(*) AS n
         FROM "PaperQuestion" q JOIN "Paper" p ON p.id = q."paperId", unnest(q.topics) AS t(tag)
         GROUP BY 1, 2`
      )).rows
      const map = new Map(dbRows.map((r) => [r.subject + '\u0000' + r.tag, { subject: r.subject, tag: r.tag, n: Number(r.n) }]))
      for (const f of report.filled) {
        const paperSubject = null // 预演模式不查卷表，标签归属按 verdict slug 前缀粗分不必要——只列总量
        void paperSubject
        for (const t of f.topics) {
          const key = '\u0000' + t
          const cur = map.get(key) || { subject: '*', tag: t, n: 0 }
          cur.n++
          map.set(key, cur)
        }
      }
      distRows = Array.from(map.values())
    }
    const untagged = (await pool.query(
      `SELECT COUNT(*) AS n FROM "PaperQuestion" WHERE topics IS NULL OR array_length(topics, 1) IS NULL`
    )).rows[0].n

    const subjName = { math: '数学', chinese: '语文', physics: '物理', politics: '政治' }
    const coverage = { at: report.at, apply: APPLY, untagged: Number(untagged), subjects: {} }
    console.log(`\n==== 覆盖统计（${APPLY ? 'DB 实况' : '预演投影'}）====`)
    console.log(`全库未打标余量: ${untagged} 题`)
    const zeroBySubj = {}
    for (const subj of ['math', 'chinese', 'physics', 'politics']) {
      const inLib = new Map()
      for (const r of distRows) if (r.subject === subj) inLib.set(r.tag, Number(r.n))
      const rows = Array.from(inLib.entries()).sort((a, b) => b[1] - a[1])
      const zeros = (vocab[subj] || []).filter((t) => !inLib.has(t))
      zeroBySubj[subj] = zeros
      coverage.subjects[subj] = { used: rows.map(([tag, n]) => ({ tag, n })), zero: zeros }
      console.log(`\n【${subjName[subj]}】词表 ${(vocab[subj] || []).length} 个，用了 ${rows.length} 个，零题量 ${zeros.length} 个`)
      for (const [tag, n] of rows) console.log(`  ${String(n).padStart(4)}  ${tag}`)
      if (zeros.length) console.log(`  零题量考点: ${zeros.join('、')}`)
    }
    if (APPLY) {
      coverage.subjects._note = 'zero = 词表内暂无题目命中的考点（组卷「单元专项」选它们会得空卷）'
      const out = path.join(DATA_DIR, `coverage-${stamp()}.json`)
      fs.writeFileSync(out, JSON.stringify(coverage, null, 2), 'utf8')
      console.log(`\n统计已存: ${path.relative(ROOT, out)}`)
      const rpath = path.join(DATA_DIR, `apply-report-${stamp()}.json`)
      fs.writeFileSync(rpath, JSON.stringify(report, null, 2), 'utf8')
      console.log(`报告已存: ${path.relative(ROOT, rpath)}`)
    }
  } finally {
    await pool.end()
  }
  if (report.errors.length) console.error('错误:', JSON.stringify(report.errors.slice(0, 10)))
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1) })
