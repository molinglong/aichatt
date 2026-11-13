/**
 * 试卷答案 AI 补解脚本：PaperQuestion.answer ← AI 参考答案（answerSource='ai'）
 *
 * 纪律：只填 answer IS NULL 的题（UPDATE 带 WHERE answer IS NULL 双保险），绝不覆盖
 * 官方答案/手批补录；stem 含 [图N] 的图题直接跳过（没有图解不了，宁缺勿猜）。
 * 选择题双模型比对（deepseek-chat × qwen-max）一致才落库，不一致留空进报告；
 * 解答/填空单模型直填。全部标注 answerSource='ai'，卷面答案页逐题挂「AI」标注，
 * 后续补录官方答案时把 answerSource 改回 'official' 即可。
 *
 * 模型直连（.env：API_KEY_DEEPSEEK / API_KEY_BAILIAN，OpenAI 兼容协议）。
 * 用法:
 *   node scripts/solve-paper-answers.cjs <slug> [--user admin@qq.com] [--dry] [--batch 8]
 */
const fs = require('fs')
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
const { Pool } = require('pg')

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) { args[a.slice(2)] = next; i++ } else { args[a.slice(2)] = true }
    } else args._.push(a)
  }
  return args
}

const args = parseArgs(process.argv)
const SLUG = args._[0]
const USER_EMAIL = args.user || 'admin@qq.com'
const DRY = !!args.dry
const BATCH = Math.max(1, Number(args.batch) || 8)

if (!SLUG) {
  console.error('用法: node scripts/solve-paper-answers.cjs <slug> [--user email] [--dry] [--batch 8]')
  process.exit(1)
}

const DEEPSEEK_KEY = process.env.API_KEY_DEEPSEEK
if (!DEEPSEEK_KEY) { console.error('缺 API_KEY_DEEPSEEK'); process.exit(1) }
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'
// 第二模型原定 qwen-max(百炼),其免费额度耗尽(403,2026-11-13),改用 deepseek-reasoner:
// 独立权重(R1 推理),数学验算比 chat 更强,代价是推理 token 较慢。reasoner 的
// max_tokens 含推理过程,给大防截断。
const MODEL_A = 'deepseek-chat'
const MODEL_B = 'deepseek-reasoner'

const CHOICE_SYSTEM =
  '你是解题助手。给你若干道选择题（题干含 $...$ LaTeX，[图N] 表示此处有图）。' +
  '逐题独立求解，输出严格 JSON：{"results":[{"number":题号,"answer":"A"}]}，' +
  '多选题 answer 给全部正确字母（如 "ABD"）。规则：字母只能来自该题选项；' +
  '依赖图中信息才能作答的题 answer 给 "?"。只输出 JSON，不要围栏和解释。'

const ANSWER_SYSTEM =
  '你是解题与讲解助手。给解答题/填空题写参考答案：解答题给完整解答步骤' +
  '（文字说明+演算，公式用行内 $...$ LaTeX，与题干格式一致），填空题给最终值与必要的一句理由。' +
  '开头不要写题号。若题目依赖图中信息无法作答，输出 {"answer":null}。' +
  '输出严格 JSON：{"answer":"..."}，answer 内换行用 \\n。只输出 JSON，不要围栏和解释。'

async function callModel(url, key, model, system, prompt, maxTokens = 4000) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(240000),
  })
  if (!resp.ok) throw new Error(`${model} ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
  const data = await resp.json()
  const text = (data.choices?.[0]?.message?.content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  return JSON.parse(text)
}

const callA = (system, prompt) => callModel(DEEPSEEK_URL, DEEPSEEK_KEY, MODEL_A, system, prompt)
const callB = (system, prompt) => callModel(DEEPSEEK_URL, DEEPSEEK_KEY, MODEL_B, system, prompt, 8000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function questionBlock(q) {
  const lines = [`【第 ${q.number} 题｜${q.multiple ? '多选题' : '单选题'}】`, q.stem]
  if (q.options.length) lines.push(q.options.join('  '))
  return lines.join('\n')
}

const hasFigure = (q) => /\[图\d+\]/.test(q.stem) || q.options.some((o) => /\[图\d+\]/.test(o))

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const report = { slug: SLUG, filled: [], skippedFigure: [], disagree: [], failed: [], dry: DRY, at: new Date().toISOString() }
  try {
    const u = await pool.query(`SELECT id FROM "User" WHERE email = $1`, [USER_EMAIL])
    if (!u.rowCount) { console.error(`用户不存在: ${USER_EMAIL}`); process.exit(1) }
    const userId = u.rows[0].id
    const paper = await pool.query(`SELECT id, title FROM "Paper" WHERE "userId" = $1 AND slug = $2`, [userId, SLUG])
    if (!paper.rowCount) { console.error(`试卷不存在: ${SLUG}`); process.exit(1) }
    const { id: paperId, title } = paper.rows[0]

    const missing = await pool.query(
      `SELECT id, number, kind, multiple, stem, options FROM "PaperQuestion"
        WHERE "paperId" = $1 AND answer IS NULL ORDER BY number`,
      [paperId]
    )
    console.log(`试卷: ${title}\n缺答案: ${missing.rowCount} 题`)
    if (!missing.rowCount) { console.log('全部有答案，无事可做'); return }

    const choices = missing.rows.filter((q) => q.kind === 'choice')
    const answers = missing.rows.filter((q) => q.kind !== 'choice')
    const skip = (q) => { report.skippedFigure.push(q.number); console.log(`  跳过 Q${q.number}（图题）`) }

    // ── 选择题：分批双模型比对 ──
    for (const q of choices) if (hasFigure(q)) skip(q)
    const figFreeChoices = choices.filter((q) => !hasFigure(q))
    for (let i = 0; i < figFreeChoices.length; i += BATCH) {
      const batch = figFreeChoices.slice(i, i + BATCH)
      const prompt = `题目（共 ${batch.length} 道）：\n\n${batch.map(questionBlock).join('\n\n')}\n\nJSON:`
      console.log(`选择题批次 ${i / BATCH + 1}: Q${batch[0].number}–Q${batch[batch.length - 1].number}（${MODEL_A} × ${MODEL_B}）…`)
      let aRes, bRes
      try { aRes = await callA(CHOICE_SYSTEM, prompt) } catch (e) { for (const q of batch) report.failed.push({ number: q.number, err: String(e.message).slice(0, 120) }); continue }
      await sleep(600)
      try { bRes = await callB(CHOICE_SYSTEM, prompt) } catch (e) { for (const q of batch) report.failed.push({ number: q.number, err: String(e.message).slice(0, 120) }); continue }
      const aMap = new Map((aRes.results || []).map((r) => [Number(r.number), String(r.answer || '')]))
      const bMap = new Map((bRes.results || []).map((r) => [Number(r.number), String(r.answer || '')]))
      for (const q of batch) {
        const a = (aMap.get(q.number) || '').toUpperCase().replace(/[^A-H]/g, '')
        const b = (bMap.get(q.number) || '').toUpperCase().replace(/[^A-H]/g, '')
        if (!a || !b || a === '?' || b === '?') { report.failed.push({ number: q.number, err: `模型未给出有效字母（A=${a || '?'} B=${b || '?'}）` }); continue }
        const sortUniq = (s) => Array.from(new Set(s.split(''))).sort().join('')
        if (sortUniq(a) !== sortUniq(b)) { report.disagree.push({ number: q.number, a, b }); console.log(`  不一致 Q${q.number}: ${MODEL_A}=${a} ${MODEL_B}=${b} → 留空`); continue }
        const value = `${q.number}. ${sortUniq(a)}`
        if (DRY) { console.log(`  一致 Q${q.number}: ${sortUniq(a)}（dry 不落库）`); report.filled.push({ number: q.number, value, source: 'choice-2model' }); continue }
        const upd = await pool.query(
          `UPDATE "PaperQuestion" SET answer = $1, "answerSource" = 'ai' WHERE id = $2 AND answer IS NULL`,
          [value, q.id]
        )
        if (upd.rowCount) { report.filled.push({ number: q.number, value, source: 'choice-2model' }); console.log(`  一致 Q${q.number}: ${sortUniq(a)} ✓`) }
        else console.log(`  Q${q.number} 已被并发写入，跳过`)
      }
      await sleep(600)
    }

    // ── 解答/填空：单模型直填 ──
    for (const q of answers) {
      if (hasFigure(q)) { skip(q); continue }
      console.log(`解答题 Q${q.number}（${MODEL_A}）…`)
      try {
        const res = await callA(ANSWER_SYSTEM, questionBlock(q))
        const text = res.answer == null ? null : String(res.answer).trim()
        if (!text) { report.failed.push({ number: q.number, err: '模型判定依赖图/无法作答' }); continue }
        const value = `${q.number}. ${text}`
        if (DRY) { console.log(`  Q${q.number}（dry 不落库）: ${value.slice(0, 80).replace(/\n/g, ' ')}…`); report.filled.push({ number: q.number, value, source: 'answer-1model' }); continue }
        const upd = await pool.query(
          `UPDATE "PaperQuestion" SET answer = $1, "answerSource" = 'ai' WHERE id = $2 AND answer IS NULL`,
          [value, q.id]
        )
        if (upd.rowCount) { report.filled.push({ number: q.number, value, source: 'answer-1model' }); console.log(`  Q${q.number} ✓ ${value.slice(0, 60).replace(/\n/g, ' ')}…`) }
        else console.log(`  Q${q.number} 已被并发写入，跳过`)
      } catch (e) {
        report.failed.push({ number: q.number, err: String(e.message).slice(0, 120) })
        console.log(`  Q${q.number} 失败: ${String(e.message).slice(0, 120)}`)
      }
      await sleep(600)
    }
  } finally {
    await pool.end()
  }

  console.log(`\n==== 汇总（${DRY ? 'DRY' : '落库'}）====`)
  console.log(`填入 ${report.filled.length} 题（选择题双模型一致 ${report.filled.filter((f) => f.source === 'choice-2model').length} / 解答填空单模型 ${report.filled.filter((f) => f.source === 'answer-1model').length}）`)
  console.log(`图题跳过 ${report.skippedFigure.length}：${report.skippedFigure.join(',') || '无'}`)
  console.log(`双模型不一致 ${report.disagree.length}：${report.disagree.map((d) => `Q${d.number}(${d.a}|${d.b})`).join(' ') || '无'}`)
  console.log(`失败 ${report.failed.length}：${report.failed.map((f) => `Q${f.number}`).join(',') || '无'}`)
  const out = path.join(__dirname, '..', 'data', 'exam-papers', SLUG, 'solve-report-20261113.json')
  fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf-8')
  console.log(`报告: ${out}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
