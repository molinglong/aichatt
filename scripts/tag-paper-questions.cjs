/**
 * 试卷考点打标脚本（第一波）：PaperQuestion.topics ← 受控词表（学考提纲章节）
 *
 * 词表来源：KnowledgeDoc(subject=<科目>) 下标题含「学考复习提纲」的 KnowledgeChunk.section
 * （形如「1.3 并集、交集、补集的运算」）。AI 只能按节号从词表选 1-3 个，
 * 节号精确回写规范全名 → 「考了几次」零同义分裂。词表装不下的题输出空数组并进待复核清单。
 *
 * 模型：DeepSeek 直连（.env API_KEY_DEEPSEEK，OpenAI 兼容 /chat/completions）。
 * 脚本环境不依赖应用内模型注册表（TS 代码不可 require）。
 *
 * 用法:
 *   node scripts/tag-paper-questions.cjs <slug> [--user admin@qq.com] [--dry] [--batch 10]
 *   --dry 调 LLM 打印结果但不写库
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
const BATCH = Math.max(1, Number(args.batch) || 10)

if (!SLUG) {
  console.error('用法: node scripts/tag-paper-questions.cjs <slug> [--user email] [--dry] [--batch 10]')
  process.exit(1)
}

const DEEPSEEK_KEY = process.env.API_KEY_DEEPSEEK
if (!DEEPSEEK_KEY) { console.error('缺 API_KEY_DEEPSEEK'); process.exit(1) }
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'
const MODEL = 'deepseek-chat'

const SYSTEM =
  '你是试卷考点打标助手。给你一份考点词表（每行「序号 考点名」）和若干道题。' +
  '给每道题从词表中选 1-3 个最贴切的考点，输出严格 JSON：' +
  '{"results":[{"number":题号,"sections":["1.3","2.1"]}]}。' +
  '规则：只准用词表里存在的序号；按贴合程度排序，最多 3 个；' +
  '纯计算/图像题若词表实在装不下就给空数组 []。只输出 JSON，不要围栏和解释。'

/** 学考提纲词表：[{no:"1.3", name:"并集、交集、补集的运算", chapter:"第一章 …"}] */
async function loadVocabulary(pool, subject) {
  const r = await pool.query(
    `SELECT DISTINCT c.chapter, c.section
       FROM "KnowledgeChunk" c JOIN "KnowledgeDoc" d ON d.id = c."docId"
      WHERE d.subject = $1 AND d.title LIKE '%学考复习提纲%' AND c.section IS NOT NULL
      ORDER BY c.section`,
    [subject]
  )
  return r.rows.map((row) => {
    const m = row.section.match(/^(\d+(?:\.\d+)?)\s*(.+)$/)
    return m ? { no: m[1], name: m[2], chapter: row.chapter } : { no: row.section, name: row.section, chapter: row.chapter }
  })
}

async function callLLM(prompt) {
  const resp = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 2000,
    }),
    signal: AbortSignal.timeout(180000),
  })
  if (!resp.ok) throw new Error(`DeepSeek ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
  const data = await resp.json()
  const text = (data.choices?.[0]?.message?.content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  return JSON.parse(text)
}

function questionBlock(q) {
  const lines = [`【第 ${q.number} 题｜${q.kind === 'choice' ? '选择题' : '解答/填空题'}】`, q.stem]
  if (q.options.length) lines.push(q.options.join('  '))
  return lines.join('\n')
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    const u = await pool.query(`SELECT id FROM "User" WHERE email = $1`, [USER_EMAIL])
    if (!u.rowCount) { console.error(`用户不存在: ${USER_EMAIL}`); process.exit(1) }
    const userId = u.rows[0].id
    const paper = await pool.query(`SELECT id, title, subject FROM "Paper" WHERE "userId" = $1 AND slug = $2`, [userId, SLUG])
    if (!paper.rowCount) { console.error(`试卷不存在: ${SLUG}`); process.exit(1) }
    const { id: paperId, title, subject } = paper.rows[0]

    const vocab = await loadVocabulary(pool, subject)
    if (!vocab.length) { console.error(`词表为空：subject=${subject} 找不到学考提纲`); process.exit(1) }
    const vocabMap = new Map(vocab.map((v) => [v.no, v]))
    console.log(`试卷: ${title}\n词表: ${vocab.length} 个考点（学考提纲）`)

    const untagged = await pool.query(
      `SELECT number, kind, stem, options FROM "PaperQuestion"
        WHERE "paperId" = $1 AND topics = '{}' ORDER BY number`,
      [paperId]
    )
    console.log(`待打标: ${untagged.rowCount} 题`)
    if (!untagged.rowCount) { console.log('全部已打标，无事可做'); return }

    const vocabText = vocab.map((v) => `${v.no} ${v.name}`).join('\n')
    const questions = untagged.rows
    const results = [] // {number, sections[]}
    for (let i = 0; i < questions.length; i += BATCH) {
      const batch = questions.slice(i, i + BATCH)
      const prompt = `考点词表：\n${vocabText}\n\n题目（共 ${batch.length} 道）：\n\n${batch.map(questionBlock).join('\n\n')}\n\nJSON:`
      console.log(`批次 ${i / BATCH + 1}: Q${batch[0].number}–Q${batch[batch.length - 1].number} …`)
      const parsed = await callLLM(prompt)
      for (const item of parsed.results || []) {
        const sections = (item.sections || []).filter((s) => vocabMap.has(s)).slice(0, 3)
        results.push({ number: item.number, sections, raw: item.sections || [] })
      }
    }

    // 汇总报告
    const outOfVocab = results.filter((r) => (r.raw || []).some((s) => !vocabMap.has(s)))
    const empty = results.filter((r) => !r.sections.length)
    const done = results.filter((r) => r.sections.length)
    console.log(`\n打标结果: ${done.length} 题有标签 / ${empty.length} 题空（词表装不下）/ ${outOfVocab.length} 题含词表外序号`)
    for (const r of results) {
      const names = r.sections.map((s) => `${s} ${vocabMap.get(s).name}`).join('；')
      console.log(`  Q${r.number}: ${names || '（空）'}`)
    }
    if (outOfVocab.length) console.log('词表外序号(已丢弃): ' + outOfVocab.map((r) => `Q${r.number}:[${r.raw.join(',')}]`).join(' '))

    if (DRY) { console.log('\n--dry 完成，未写库'); return }

    for (const r of results) {
      const topics = r.sections.map((s) => `${s} ${vocabMap.get(s).name}`)
      await pool.query(`UPDATE "PaperQuestion" SET topics = $1 WHERE "paperId" = $2 AND number = $3`, [topics, paperId, r.number])
    }
    console.log(`\n已回写 ${results.length} 题的 topics`)
  } finally {
    await pool.end()
  }
}

main().catch((e) => { console.error('FAIL:', e.message); process.exitCode = 1 })
