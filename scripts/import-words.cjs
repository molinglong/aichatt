/**
 * 词库导入器 —— 把常见词表文件灌进 Word / WordBook / WordBookItem。
 *
 * 支持格式（按扩展名选解析器，内容再做格式嗅探）：
 *   .csv / .tsv / .txt  分隔符自动识别（逗号/制表符/分号/竖线），带引号字段可含逗号与换行
 *   .xlsx / .xls        Excel，取第一个工作表，首行当表头
 *   .json               ①对象数组 ②字符串数组 ③{name, words:[...]}（qwerty-learner 词库形状）
 *                       ④ECDICT 风格对象数组（word/phonetic/translation/pos/collins/tag/bnc/frq/exchange）
 *
 * 列名认中英文别名（word/单词/headword、trans/translation/释义/中文…），见 COLUMN_ALIAS。
 * 没有表头时按位置兜底：第 1 列单词，第 2 列释义。
 * 编码自动识别 UTF-8 / UTF-8 BOM / GBK（Excel 导出的中文 CSV 常是 GBK）。
 *
 * 幂等：同一本书（词单 slug）重复导入不产生第二份，也不清已学的 FSRS 进度：
 *   - 词条按 lemma 合并：**默认只补空、不覆盖**（已有释义/音标/例句一律保留）；
 *     要让文件覆盖即有时加 --force；
 *   - 词单条目按 (listId, entryId) 覆盖 position/unit；
 *   - 同一文件重复导入 = 结果不变。
 *
 * 用法：
 *   node scripts/import-words.cjs <文件> [--book 词单名] [--slug 自定义slug] [--level 高考]
 *                                 [--dry] [--limit N] [--force]
 *   node scripts/import-words.cjs --list    # 看已导入的字典词单
 *   node scripts/import-words.cjs --help
 *
 * 示例：
 *   npm run words:import -- "D:\词库\高考3500.csv" --book "高考 3500" --level 高考
 *   npm run words:import -- "D:\词库\ecdict.csv" --book "ECDICT 核心" --limit 5000
 *   npm run words:list
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })
const { Pool } = require('pg')

const BATCH = 400 // 单条 INSERT 的行数上限（19 列 × 400 仍远低于 PG 参数上限）

// ───────────────────────── 参数 ─────────────────────────
function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') { args.help = true; continue }
    if (a === '--list') { args.list = true; continue }
    if (a === '--dry') { args.dry = true; continue }
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

const USAGE = `词库导入器

用法:
  node scripts/import-words.cjs <文件> [--book 词单名] [--slug slug] [--level 高考]
                                [--dry] [--limit N] [--force]
  node scripts/import-words.cjs --list
  node scripts/import-words.cjs --help

支持: .csv .tsv .txt .json .xlsx .xls
列名: word/单词/headword/name、trans/translation/释义/中文、phonetic/音标、pos/词性、
      tag/tags/标签、exchange/词形、unit/单元、frq/词频 等（中英文别名都认）
无表头: 第 1 列当单词，第 2 列当释义

示例:
  npm run words:import -- "D:\\词库\\高考3500.csv" --book "高考 3500" --level 高考
  npm run words:import -- "D:\\词库\\wordlist.xlsx" --dry
  npm run words:list`

const args = parseArgs(process.argv)
if (args.help) { console.log(USAGE); process.exit(0) }
const FILE = args._[0]

// ───────────────────────── 列名别名 ─────────────────────────
/** 归一化表头：小写、去空格/下划线/连字符/BOM */
function normKey(k) {
  return String(k ?? '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_\-（）()【】\[\].]/g, '')
}

const COLUMN_ALIAS = {
  headword: ['word', 'words', 'headword', '单词', '词条', '词', 'term', 'entry', 'name', 'vocab', 'vocabulary', 'spelling', 'english', '词形'],
  lemma: ['lemma', '原形', '词根', '基础词'],
  trans: ['trans', 'translation', 'translations', 'meaning', '释义', '中文', '中文释义', '意思', '词义', 'gloss', 'zh', 'cn', 'chinese', '中文意思', 'translate', '释义中文', '解释'],
  definition: ['definition', 'def', '英文释义', '英释', '英文解释', 'englishmeaning'],
  phoneticUs: ['usphone', 'phoneticus', 'phonetic_us', 'usphonetic', '美音', '美式音标', 'america', 'american'],
  phoneticUk: ['ukphone', 'phoneticuk', 'phonetic_uk', 'ukphonetic', '英音', '英式音标', 'british', 'britain'],
  phonetic: ['phonetic', '音标', 'ipa', 'pron', 'pronunciation', '发音', '读音'],
  pos: ['pos', '词性', 'partofspeech', '词类', '词性标注'],
  tags: ['tag', 'tags', '标签', '考试', 'category', '分类', '类型', '归属'],
  collins: ['collins', '柯林斯', '柯林斯星级'],
  bncFreq: ['bnc', 'bncfreq', 'bnc词频'],
  freqRank: ['frq', 'freq', 'frequency', 'rank', '词频', '序号', 'no', 'index', 'num', '编号'],
  exchange: ['exchange', '词形变化', '变形', '变化', '词形变换'],
  mnemonic: ['助记', 'mnemonic', '记忆', '联想', '口诀', '记忆法'],
  isPhrase: ['短语', 'phrase', 'isphrase', 'is_phrase', '是否短语', '短语标记'],
  examples: ['example', 'examples', '例句', 'sentence', 'sentences', '示例'],
  unit: ['unit', '单元', 'list', 'lesson', '课', '组', '分组', '单元号'],
}

/** 表头 → 字段名（认不出返回 null） */
function fieldOf(header) {
  const k = normKey(header)
  if (!k) return null
  for (const [field, aliases] of Object.entries(COLUMN_ALIAS)) {
    if (aliases.some((a) => normKey(a) === k)) return field
  }
  return null
}

/** ECDICT tag 码 → 中文标签（认不出的原样保留） */
const ECDICT_TAGS = {
  zk: '中考', gk: '高考', cet4: '四级', cet6: '六级', ky: '考研',
  toefl: '托福', ielts: '雅思', gre: 'GRE', cet: '四六级',
}

/** slug 化：中文名保留可读性，空格转连字符 */
function slugify(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'words'
}

// ───────────────────────── 解码 ─────────────────────────
function decodeBuffer(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.slice(3).toString('utf8'), enc: 'utf-8 (BOM)' }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), enc: 'utf-8' }
  } catch {
    try {
      return { text: new TextDecoder('gbk').decode(buf), enc: 'gbk' }
    } catch {
      return { text: buf.toString('utf8'), enc: 'utf-8（有损）' }
    }
  }
}

// ───────────────────────── 分隔符解析 ─────────────────────────
/** 状态机解析 CSV/TSV：支持字段内引号、引号转义("")、字段内换行 */
function parseDelimited(text, delim) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else { inQuotes = false }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delim) {
      row.push(field); field = ''
    } else if (ch === '\n') {
      row.push(field); rows.push(row); row = []; field = ''
    } else if (ch === '\r') {
      // 忽略，等 \n 收行
    } else {
      field += ch
    }
  }
  row.push(field)
  if (row.some((c) => c.trim())) rows.push(row)
  return rows
}

/** 取第一行（非空）猜分隔符 */
function detectDelimiter(text) {
  const sample = text.split(/\r?\n/).find((l) => l.trim()) || ''
  const counts = { ',': 0, '\t': 0, ';': 0, '|': 0 }
  let inQuotes = false
  for (const ch of sample) {
    if (ch === '"') inQuotes = !inQuotes
    else if (!inQuotes && ch in counts) counts[ch]++
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
  return best[1] > 0 ? best[0] : ','
}

// ───────────────────────── 纯文本词表 ─────────────────────────
const CJK = /[\u4e00-\u9fa5]/
const POS_ABBR = /^[a-z]{1,5}\.$/i

/** 拆一行：开头连续英文词当词条（最多 4 段，遇 /音标/、词性缩写、中文就停），其余当释义 */
function splitPlainLine(line) {
  const tokens = line.split(/\s+/).filter(Boolean)
  const headParts = []
  let consumed = 0
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (!/^[A-Za-z][A-Za-z'’\-]*$/.test(t)) break
    if (headParts.length >= 4) break
    headParts.push(t)
    consumed = i + 1
    const next = tokens[i + 1]
    if (!next) break
    if (POS_ABBR.test(next)) break
    if (/^[\/\[(（]/.test(next)) break
    if (CJK.test(next)) break
    if (!/^[A-Za-z][A-Za-z'’\-]*$/.test(next)) break
  }
  if (!headParts.length) return { head: line, rest: '' }
  return { head: headParts.join(' '), rest: tokens.slice(consumed).join(' ') }
}

function parsePlainText(text) {
  const rows = []
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.replace(/^\uFEFF/, '').trim()
    if (!line || line.startsWith('#')) continue
    // 去掉序号前缀：1. / 1、/ 1)
    line = line.replace(/^\d+\s*[.、)）]\s*/, '')
    if (!line) continue
    let head = ''
    let rest = ''
    if (line.includes('\t')) {
      const p = line.split('\t'); head = p[0]; rest = p.slice(1).join(' ')
    } else if (/\s[—–]\s|：|\s:\s/.test(line)) {
      const m = line.match(/^(.+?)(?:\s+[—–]\s+|：|\s:\s+)(.+)$/)
      if (m) { head = m[1]; rest = m[2] } else { head = line }
    } else {
      const sp = splitPlainLine(line)
      head = sp.head; rest = sp.rest
    }
    head = head.trim()
    rest = rest.replace(/\s+/g, ' ').trim()
    // 从释义段里抽音标 /.../
    let phonetic = null
    const pm = rest.match(/\/([^/\n]{2,40})\//)
    if (pm) { phonetic = pm[1].trim(); rest = rest.replace(pm[0], '').trim() }
    rows.push([head, rest, phonetic || ''])
  }
  return rows
}

// ───────────────────────── 字段清洗 ─────────────────────────
function cleanText(v) {
  if (v == null) return null
  if (Array.isArray(v)) v = v.join('；')
  const s = String(v).replace(/\s+/g, ' ').trim()
  return s || null
}

/** 音标清洗：去首尾 / [ ]，得到不带外壳的 IPA */
function cleanPhonetic(v) {
  const s = cleanText(v)
  if (!s) return null
  return s.replace(/^[\/\[\s]+|[\/\]\s]+$/g, '') || null
}

function splitTags(v) {
  if (v == null) return []
  const parts = Array.isArray(v) ? v : String(v).split(/[\s,;|/、，]+/)
  const out = []
  for (const p0 of parts) {
    const p = String(p0).trim()
    if (!p) continue
    const mapped = ECDICT_TAGS[p.toLowerCase()] || p
    if (!out.includes(mapped)) out.push(mapped)
  }
  return out
}

/** 标签清洗：去纯数字噪声（列错位时常见），最多留 8 个 */
function cleanTags(tags) {
  return tags.filter((t) => t && !/^\d+$/.test(t)).slice(0, 8)
}

function toInt(v) {
  if (v == null || v === '') return null
  const m = String(v).replace(/,/g, '').match(/-?\d+/)
  return m ? parseInt(m[0], 10) : null
}

/** 「短语」列的宽松真值：1/true/是/短语…都算，空与 0/false/否 不算 */
function isTruthyFlag(v) {
  if (v == null || v === '') return false
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  const s = String(v).trim().toLowerCase()
  return ['1', 'true', 'yes', 'y', '是', '短语', 'phrase', '对', '✓'].includes(s)
}

/** 例句列：支持纯文本（按换行/分号切）或 JSON 数组 */
function parseExamples(v) {
  if (v == null || v === '') return null
  if (Array.isArray(v)) {
    const out = v
      .map((x) => {
        if (typeof x === 'string') return { en: x.trim() }
        if (x && (x.en || x.text)) return { en: String(x.en || x.text).trim(), zh: cleanText(x.zh || x.cn) }
        return null
      })
      .filter((x) => x && x.en)
    return out.length ? out : null
  }
  const s = String(v).trim()
  if (s.startsWith('[') || s.startsWith('{')) {
    try { return parseExamples(JSON.parse(s)) } catch { /* 落到文本切分 */ }
  }
  const parts = s.split(/\n|；|;\s*|\|/).map((x) => x.trim()).filter(Boolean)
  return parts.length ? parts.slice(0, 6).map((en) => ({ en })) : null
}

/** 归一化 lemma：小写、合并空白、去首尾标点 */
function toLemma(headword) {
  return String(headword)
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'.]+|[\s"'.]+$/g, '')
    .trim()
}

const VALID_HEAD = /[A-Za-z]/
const HEADER_NOISE = new Set(['word', 'words', 'headword', '单词', '词条', 'term', 'name', 'vocabulary', 'vocab'])

/** 行对象 → Word 行（无效返回 {error}） */
function toWordRow(obj, position) {
  const headword = cleanText(obj.headword)
  if (!headword) return { error: '缺少单词' }
  if (headword.length > 80) return { error: `单词过长(${headword.length})` }
  if (!VALID_HEAD.test(headword)) return { error: '不含英文字母' }
  if (HEADER_NOISE.has(headword.toLowerCase()) && position === 0) return { error: '表头行' }

  const lemma = toLemma(obj.lemma ? cleanText(obj.lemma) : headword)
  if (!lemma) return { error: '单词归一后为空' }

  const trans = cleanText(obj.trans)
  const definition = cleanText(obj.definition)
  let pos = cleanText(obj.pos)
  // 词性若混在释义开头（如 "v. 放弃" / "n. & v. 记录"），抽出来给 pos，释义保留原文
  if (!pos && trans) {
    const m = trans.match(/^([a-z]{1,5}\.(?:\s*&\s*[a-z]{1,5}\.)?)\s+/i)
    if (m) pos = m[1].replace(/\s+/g, '')
  }
  if (pos) pos = pos.replace(/[.,;，。；]+$/, '') || null

  if (!trans && !definition) return { error: '缺少释义' }

  return {
    headword,
    lemma,
    // 短语判定：多词 headword（含空格）即为短语；文件里显式给了「短语/phrase/isPhrase」列时以它为准
    isPhrase: isTruthyFlag(obj.isPhrase) || /\s/.test(headword),
    phoneticUs: cleanPhonetic(obj.phoneticUs) || cleanPhonetic(obj.phonetic),
    phoneticUk: cleanPhonetic(obj.phoneticUk),
    pos,
    trans,
    definition,
    exchange: cleanText(obj.exchange),
    mnemonic: cleanText(obj.mnemonic),
    examples: parseExamples(obj.examples),
    tags: cleanTags(splitTags(obj.tags)),
    collins: toInt(obj.collins),
    bncFreq: toInt(obj.bncFreq),
    freqRank: toInt(obj.freqRank) ?? toInt(obj.bncFreq),
    raw: obj.raw ?? null,
    unit: cleanText(obj.unit) || null,
  }
}

/** 数组行 + 表头 → 对象 */
function rowsToObjects(rows, headerRow) {
  const fields = headerRow.map(fieldOf)
  const hasHeader = fields.some(Boolean)
  const dataStart = hasHeader ? 1 : 0
  const map = hasHeader ? fields : ['headword', 'trans', 'phonetic']
  const out = []
  for (let i = dataStart; i < rows.length; i++) {
    const cells = rows[i]
    if (!cells || !cells.some((c) => String(c || '').trim())) continue
    const obj = {}
    const raw = {}
    let known = 0
    for (let c = 0; c < cells.length; c++) {
      const field = map[c]
      const val = cells[c]
      if (!field) {
        if (String(val || '').trim()) raw[headerRow[c] || `col${c}`] = val
        continue
      }
      known++
      if (obj[field] == null || obj[field] === '') obj[field] = val
    }
    obj.raw = Object.keys(raw).length ? raw : null
    // 全列都没认出（无表头且列数很多），按位置兜底
    if (!known && cells.length) { obj.headword = cells[0]; obj.trans = cells[1] }
    out.push(obj)
  }
  return out
}

// ───────────────────────── 读文件 → 词对象数组 ─────────────────────────
function readWordObjects(file) {
  const ext = path.extname(file).toLowerCase()

  if (ext === '.xlsx' || ext === '.xls') {
    const XLSX = require('xlsx')
    const wb = XLSX.readFile(file)
    const sheet = wb.Sheets[wb.SheetNames[0]]
    if (!sheet) throw new Error('Excel 里没有工作表')
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' })
    const header = (rows[0] || []).map(String)
    return { fmt: 'xlsx', enc: '—', objs: rowsToObjects(rows.map((r) => r.map((c) => (c == null ? '' : c))), header) }
  }

  if (ext === '.json') {
    const { text, enc } = decodeBuffer(fs.readFileSync(file))
    let data = JSON.parse(text)
    if (data && !Array.isArray(data)) {
      if (Array.isArray(data.words)) data = data.words
      else if (Array.isArray(data.list)) data = data.list
      else if (Array.isArray(data.data)) data = data.data
      else data = [data]
    }
    const objs = data.map((item) => {
      if (typeof item === 'string' || typeof item === 'number') return { headword: String(item) }
      const o = {}
      for (const [k, v] of Object.entries(item || {})) {
        const f = fieldOf(k)
        if (f) { if (o[f] == null) o[f] = v } else { (o.raw ||= {})[k] = v }
      }
      return o
    })
    return { fmt: 'json', enc, objs }
  }

  // 纯文本类：csv / tsv / txt / 无扩展名
  const { text, enc } = decodeBuffer(fs.readFileSync(file))
  const delim = ext === '.tsv' ? '\t' : detectDelimiter(text)
  const looksDelimited = ext === '.csv' || ext === '.tsv' || delim !== ','
  const rows = looksDelimited ? parseDelimited(text, delim) : null
  // 有表头或每行列数稳定 → 当表格；否则当纯词表
  if (rows && rows.length) {
    const header = rows[0].map(String)
    const headerHits = header.filter((h) => fieldOf(h)).length
    const widths = new Set(rows.slice(0, 20).map((r) => r.length))
    if (headerHits >= 1 || widths.size === 1) {
      const dlabel = delim === '\t' ? '制表符' : delim === ';' ? '分号' : delim === '|' ? '竖线' : '逗号'
      return { fmt: `${ext.replace('.', '') || 'txt'}（${dlabel}分隔）`, enc, objs: rowsToObjects(rows, header) }
    }
  }
  const plainRows = parsePlainText(text)
  return {
    fmt: `${ext.replace('.', '') || 'txt'}（逐行）`,
    enc,
    objs: plainRows.map(([head, trans, phonetic]) => ({ headword: head, trans, phonetic })),
  }
}

// ───────────────────────── 去重 ─────────────────────────
function dedupe(objs) {
  const seen = new Map()
  let dup = 0
  for (const o of objs) {
    const lemma = toLemma(cleanText(o.headword) || '')
    const key = lemma || `__empty${seen.size}`
    const prev = seen.get(key)
    if (!prev) { seen.set(key, { ...o }); continue }
    dup++
    // 合并：补空字段 + 并标签
    for (const k of ['trans', 'definition', 'phonetic', 'phoneticUs', 'phoneticUk', 'pos', 'exchange', 'examples', 'unit']) {
      if ((prev[k] == null || prev[k] === '') && o[k]) prev[k] = o[k]
    }
    prev.tags = [...new Set([...splitTags(prev.tags), ...splitTags(o.tags)])]
    if (prev.freqRank == null && o.freqRank != null) prev.freqRank = o.freqRank
  }
  return { objs: [...seen.values()], dup }
}

// ───────────────────────── 库操作 ─────────────────────────
/** 词单：全局唯一 slug，重复导入覆盖不新建 */
async function upsertList(pool, { name, slug, level, sourceFile }) {
  const r = await pool.query(
    `INSERT INTO "DictList" ("id","slug","name","kind","level","sourceFile","updatedAt")
     VALUES ($1,$2,$3,'imported',$4,$5, now())
     ON CONFLICT ("slug") DO UPDATE
       SET "name" = EXCLUDED."name",
           "level" = COALESCE(EXCLUDED."level", "DictList"."level"),
           "sourceFile" = EXCLUDED."sourceFile",
           "updatedAt" = now()
     RETURNING "id", "name", (xmax = 0) AS inserted`,
    [crypto.randomUUID(), slug, name, level || null, sourceFile || null],
  )
  return r.rows[0]
}

/**
 * 词条批插：按全局 lemma 合并。
 * 合并口径（2026-11-15 改）：默认**只补空、不覆盖**——已有释义/音标/例句一律保留，
 * 避免「随手导一份测试词表」把之前精心整理的释义冲掉（踩过：according to 被覆盖）。
 * 需要让文件覆盖即有时，显式加 --force。
 */
async function upsertEntries(pool, words, force) {
  let insertedCount = 0
  // 合并字段的取值口径：force=文件值优先；默认=库里已有值优先，空才用文件值
  const keep = (col) => (force ? `EXCLUDED."${col}"` : `COALESCE("DictEntry"."${col}", EXCLUDED."${col}")`)
  for (let i = 0; i < words.length; i += BATCH) {
    const slice = words.slice(i, i + BATCH)
    const cols = 20 // id/headword/lemma/isPhrase/…/mnemonic/raw；createdAt 有默认值，updatedAt 用 now()
    const values = []
    const params = []
    slice.forEach((w, idx) => {
      const base = idx * cols
      const ph = Array.from({ length: cols }, (_, k) => `$${base + k + 1}`).join(',')
      values.push(`(${ph}, now())`)
      params.push(
        crypto.randomUUID(),
        w.headword,
        w.lemma,
        Boolean(w.isPhrase),
        w.phoneticUs,
        w.phoneticUk,
        w.pos,
        w.trans,
        w.definition,
        w.exchange,
        null, // senses：结构化释义留给后续 AI 补
        w.examples ? JSON.stringify(w.examples) : null,
        null, // collocations 留给 AI 补
        w.mnemonic,
        w.tags ?? [],
        w.collins,
        w.bncFreq,
        w.freqRank,
        'import',
        w.raw ? JSON.stringify(w.raw) : null,
      )
    })
    const sql = `
      INSERT INTO "DictEntry" ("id","headword","lemma","isPhrase","phoneticUs","phoneticUk","pos","trans",
                               "definition","exchange","senses","examples","collocations","mnemonic","tags",
                               "collins","bncFreq","freqRank","source","raw","updatedAt")
      VALUES ${values.join(',')}
      ON CONFLICT ("lemma") DO UPDATE SET
        "headword"   = EXCLUDED."headword",
        "isPhrase"   = EXCLUDED."isPhrase",
        "phoneticUs" = ${keep('phoneticUs')},
        "phoneticUk" = ${keep('phoneticUk')},
        "pos"        = ${keep('pos')},
        "trans"      = ${keep('trans')},
        "definition" = ${keep('definition')},
        "exchange"   = ${keep('exchange')},
        "senses"     = ${keep('senses')},
        "examples"   = ${keep('examples')},
        "mnemonic"   = ${keep('mnemonic')},
        "tags"       = ARRAY(SELECT DISTINCT unnest("DictEntry"."tags" || EXCLUDED."tags")),
        "collins"    = ${keep('collins')},
        "bncFreq"    = ${keep('bncFreq')},
        "freqRank"   = ${keep('freqRank')},
        "raw"        = ${keep('raw')},
        "updatedAt"  = now()
      RETURNING (xmax = 0) AS inserted`
    const r = await pool.query(sql, params)
    insertedCount += r.rows.filter((row) => row.inserted).length
  }
  return insertedCount
}

/**
 * 词单条目：**位置要全局唯一且稳定**。
 * 踩过的坑：往同一本书里再导一份新文件时，position 从 0 重来，与旧条目撞号，
 * 「第 1–15 词」这种按序号取词的逻辑就会一次取出 45 个。
 * 规则：已在书里的词保留原位置；新词从「现有最大位置 + 1」往后排。
 */
async function upsertItems(pool, listId, pairs) {
  const existingRows = await pool.query(`SELECT "entryId", "position" FROM "DictListItem" WHERE "listId" = $1`, [listId])
  const existing = new Map(existingRows.rows.map((r) => [r.entryId, r.position]))
  let nextPos = existingRows.rows.reduce((max, r) => Math.max(max, r.position + 1), 0)

  const resolved = pairs.map((p) => ({
    ...p,
    position: existing.has(p.entryId) ? existing.get(p.entryId) : nextPos++,
  }))

  for (let i = 0; i < resolved.length; i += BATCH) {
    const slice = resolved.slice(i, i + BATCH)
    // 5 列参数：id / listId / entryId / position / unit
    const values = []
    const params = []
    slice.forEach((p, idx) => {
      const base = idx * 5
      values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5})`)
      params.push(crypto.randomUUID(), listId, p.entryId, p.position, p.unit ?? null)
    })
    await pool.query(
      `INSERT INTO "DictListItem" ("id","listId","entryId","position","unit")
       VALUES ${values.join(',')}
       ON CONFLICT ("listId","entryId") DO UPDATE
         SET "position" = EXCLUDED."position", "unit" = EXCLUDED."unit"`,
      params,
    )
  }
}

async function listLists(pool) {
  const r = await pool.query(
    `SELECT l."name", l."slug", l."level", l."sourceFile",
            COUNT(i."id")::int AS items
       FROM "DictList" l
       LEFT JOIN "DictListItem" i ON i."listId" = l."id"
      GROUP BY l."id"
      ORDER BY l."createdAt" DESC`,
  )
  const t = await pool.query(
    `SELECT (SELECT COUNT(*) FROM "DictEntry")::int AS entries,
            (SELECT COUNT(*) FROM "UserWord")::int AS mine,
            (SELECT COUNT(*) FROM "UserWord" WHERE "dueAt" <= now() AND NOT "suspended")::int AS due`,
  )
  if (!r.rows.length) {
    console.log('字典还是空的。用 npm run words:import -- <文件> 导入一份词单。')
  } else {
    console.log(`共 ${r.rows.length} 份词单：\n`)
    for (const b of r.rows) {
      console.log(`  ${b.name}  [${b.slug}]${b.level ? '  ' + b.level : ''}  ${b.items} 词`)
      if (b.sourceFile) console.log(`    来源 ${b.sourceFile}`)
    }
  }
  console.log(`\n字典词条 ${t.rows[0].entries}｜我的词 ${t.rows[0].mine}｜今日已到期 ${t.rows[0].due}`)
}

// ───────────────────────── 主流程 ─────────────────────────
async function main() {
  if (!process.env.DATABASE_URL) throw new Error('.env 里没有 DATABASE_URL')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    if (args.list) {
      await listLists(pool)
      return
    }

    if (!FILE) { console.log(USAGE); process.exitCode = 1; return }
    if (!fs.existsSync(FILE)) throw new Error(`文件不存在：${FILE}`)

    const stat = fs.statSync(FILE)
    const listName = String(args.book || path.basename(FILE, path.extname(FILE))).trim()
    const slug = slugify(args.slug || listName)
    console.log(`文件: ${FILE} (${(stat.size / 1024).toFixed(0)} KB)`)
    console.log(`词单: ${listName}  [${slug}]`)

    const { fmt, enc, objs } = readWordObjects(FILE)
    console.log(`格式: ${fmt}｜编码: ${enc || '—'}｜原始行: ${objs.length}`)

    const { objs: deduped, dup } = dedupe(objs)
    const valid = []
    const skipped = []
    deduped.forEach((o, i) => {
      const w = toWordRow(o, i)
      if (w.error) skipped.push({ head: cleanText(o.headword) || '(空)', reason: w.error })
      else valid.push(w)
    })
    const limited = args.limit ? valid.slice(0, parseInt(args.limit, 10)) : valid
    console.log(`去重后: ${deduped.length}（文件内重复 ${dup}）｜有效: ${valid.length}｜跳过: ${skipped.length}${args.limit ? `｜按 --limit 取前 ${limited.length}` : ''}`)
    if (skipped.length) {
      console.log('跳过的行（前 5 条）:')
      for (const s of skipped.slice(0, 5)) console.log(`  - ${s.head}：${s.reason}`)
    }
    if (!limited.length) throw new Error('没有可导入的有效词条，检查列名或文件内容')

    if (args.dry) {
      console.log('\n[dry] 未写库。前 3 条预览：')
      for (const w of limited.slice(0, 3)) console.log(' ', JSON.stringify(w))
      return
    }

    const list = await upsertList(pool, { name: listName, slug, level: args.level, sourceFile: path.basename(FILE) })
    console.log(`词单${list.inserted ? '已新建' : '已存在，重导合并'}（${list.id}）`)

    const newCount = await upsertEntries(pool, limited, Boolean(args.force))
    const idRows = await pool.query(
      `SELECT "id","lemma" FROM "DictEntry" WHERE "lemma" = ANY($1::text[])`,
      [limited.map((w) => w.lemma)],
    )
    const idByLemma = new Map(idRows.rows.map((r) => [r.lemma, r.id]))
    const pairs = limited
      .map((w, idx) => ({ entryId: idByLemma.get(w.lemma), position: idx, unit: w.unit }))
      .filter((p) => p.entryId)
    await upsertItems(pool, list.id, pairs)

    await pool.query(
      `UPDATE "DictList" SET "wordCount" = (SELECT COUNT(*)::int FROM "DictListItem" WHERE "listId" = $1), "updatedAt" = now() WHERE "id" = $1`,
      [list.id],
    )

    console.log(`\n完成：新增词条 ${newCount}，合并既有 ${limited.length - newCount}，词单条目 ${pairs.length}`)
    console.log('下一步：npm run words:list 看字典现状')
  } finally {
    await pool.end()
  }
}

main().catch((e) => {
  console.error('\n导入失败：' + (e && e.message ? e.message : e))
  process.exit(1)
})
