#!/usr/bin/env node
/**
 * 动效审计（no-new-violations）
 *
 * 目标：防止业务组件重新手写面板开合，绕开 .panel-motion + usePanelPresence。
 *
 * 规则：
 *   1. 手写 presence：setTimeout + setRendered/Shown/Mounted(false)、
 *      双 RAF + setShown/Open(true)、SettingsModal 式 finish 兜底计时。
 *   2. 已接入 .panel-motion 的文件里禁止裸时长 / transition-all /
 *      180|260|420 硬编码退场计时。
 *
 * 存量按 .motion-audit-baseline.json 计数豁免；计数上涨即失败。
 * 迁移完一处后跑 `npm run audit:motion -- --update-baseline` 下调基线。
 *
 * 用法：
 *   npm run audit:motion
 *   npm run audit:motion -- --update-baseline
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'src')
const BASELINE_FILE = path.join(ROOT, '.motion-audit-baseline.json')
const UPDATE = process.argv.includes('--update-baseline')
const EXCLUDE_PRESENCE = new Set(['src/hooks/usePanelPresence.ts'])

const PRESENCE_RULES = [
  ['close-timer', /setTimeout\([^;]{0,160}?set(?:Rendered|Shown|Mounted)\(false\)/g],
  ['raf-show', /requestAnimationFrame\([^;]{0,160}?set(?:Shown|Open|Rendered|PickerShown)\(true\)/g],
  ['fallback-timer', /setTimeout\(\s*finish\s*,\s*\d+\s*\)/g],
]

const PANEL_RAW_RULES = [
  ['transition-all', /transition-all\b/g],
  ['raw-duration-class', /duration-\d{2,4}\b/g],
  ['raw-duration-arbitrary', /duration-\[[^\]]+\]/g],
  ['raw-duration-css', /(?:transition|animation)-duration\s*:\s*[^;]+/g],
  ['hardcoded-exit-timer', /setTimeout\([^;]{0,120}?,\s*(?:180|260|420)\s*\)/g],
]

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === 'public') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, files)
    else if (/\.(?:tsx?|jsx?)$/.test(entry.name)) files.push(full)
  }
  return files
}

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/')
}

function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++
  return line
}

function findMatches(text, rules) {
  const found = []
  for (const [id, source] of rules) {
    const re = new RegExp(source.source, source.flags)
    for (const match of text.matchAll(re)) {
      found.push({ id, index: match.index ?? 0, text: match[0].slice(0, 120).replace(/\s+/g, ' ') })
    }
  }
  return found.sort((a, b) => a.index - b.index)
}

function countByFile(files, rules, filter = () => true) {
  const counts = {}
  const hits = []
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
    const matches = findMatches(text, rules).filter(filter)
    if (!matches.length) continue
    const key = rel(file)
    counts[key] = matches.length
    for (const m of matches) hits.push({ file: key, line: lineOf(text, m.index), ...m })
  }
  return { counts, hits }
}

function loadBaseline() {
  if (!fs.existsSync(BASELINE_FILE)) return null
  try {
    return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'))
  } catch {
    return null
  }
}

function compare(group, current, baseline) {
  const expected = baseline?.[group] ?? {}
  const added = []
  const reduced = []
  for (const [file, count] of Object.entries(current)) {
    const allowed = expected[file] ?? 0
    if (count > allowed) added.push({ file, count, allowed })
    else if (count < allowed) reduced.push({ file, count, allowed })
  }
  return { added, reduced }
}

function printHits(hits, shown = 12) {
  for (const h of hits.slice(0, shown)) {
    console.log(`    ${h.file}:${h.line}  [${h.id}]  ${h.text}`)
  }
  if (hits.length > shown) console.log(`    …另有 ${hits.length - shown} 处`)
}

function main() {
  const files = walk(SRC)
  const presence = countByFile(
    files.filter((f) => !EXCLUDE_PRESENCE.has(rel(f))),
    PRESENCE_RULES
  )
  const panelFiles = files.filter((f) => {
    const text = fs.readFileSync(f, 'utf8')
    return text.includes('panel-motion') || text.includes('data-panel-state')
  })
  const panelRaw = countByFile(panelFiles, PANEL_RAW_RULES)

  console.log('动效审计')
  console.log(`  手写面板 presence: ${Object.keys(presence.counts).length} 个文件 / ${presence.hits.length} 处`)
  console.log(`  面板裸动效:       ${Object.keys(panelRaw.counts).length} 个文件 / ${panelRaw.hits.length} 处`)

  if (UPDATE) {
    const baseline = {
      generatedAt: new Date().toISOString(),
      note: 'legacy counts; lower them after migrating to usePanelPresence/.panel-motion',
      legacyPresence: presence.counts,
      panelRawMotion: panelRaw.counts,
    }
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + '\n', 'utf8')
    console.log(`\n已写入基线: ${rel(BASELINE_FILE)}`)
    return 0
  }

  const baseline = loadBaseline()
  if (!baseline) {
    console.error(`\n缺少基线文件 ${rel(BASELINE_FILE)}`)
    console.error('首次使用请运行: npm run audit:motion -- --update-baseline')
    return 1
  }

  const presenceDiff = compare('legacyPresence', presence.counts, baseline)
  const panelDiff = compare('panelRawMotion', panelRaw.counts, baseline)
  const presenceIds = new Set(PRESENCE_RULES.map(([id]) => id))
  const panelIds = new Set(PANEL_RAW_RULES.map(([id]) => id))
  const added = [
    ...presenceDiff.added.map((item) => ({ ...item, label: '手写 presence', ids: presenceIds })),
    ...panelDiff.added.map((item) => ({ ...item, label: '面板裸动效', ids: panelIds })),
  ]

  if (presenceDiff.reduced.length || panelDiff.reduced.length) {
    console.log('\n基线可下调（迁移已完成）：')
    for (const item of [...presenceDiff.reduced, ...panelDiff.reduced]) {
      console.log(`  ${item.file}: 现在 ${item.count}，基线 ${item.allowed}`)
    }
    console.log('  跑 npm run audit:motion -- --update-baseline 收口。')
  }

  if (!added.length) {
    console.log('\n✓ 无新增违规')
    return 0
  }

  console.error('\n✗ 新增违规：')
  for (const item of added) {
    console.error(`  [${item.label}] ${item.file}: 现在 ${item.count}，基线 ${item.allowed}`)
    printHits(
      [...presence.hits, ...panelRaw.hits].filter(
        (h) => h.file === item.file && item.ids.has(h.id)
      ),
      6
    )
  }
  console.error('\n处理：改用 usePanelPresence + .panel-motion；确属非面板用途时收窄正则或在基线中显式登记。')
  return 1
}

process.exitCode = main()
