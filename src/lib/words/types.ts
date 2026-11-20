/**
 * 词汇学习的前后端共享类型（不含 server-only 依赖，客户端可安全 import）。
 */

export type WordCardType = 'flip' | 'spell'

/** 队列里的一张卡（前端只吃这些，不暴露 FSRS 内部字段） */
export interface WordQueueItem {
  id: string
  /** 对应的字典词条 id；自由词（字典里没有的）为 null，助记等字段也就无处可存 */
  entryId: string | null
  card: WordCardType
  headword: string
  lemma: string
  /** 短语/多词条目（如 according to）:卡面按短语排版、不考拼写 */
  isPhrase: boolean
  phoneticUs: string | null
  phoneticUk: string | null
  pos: string | null
  trans: string | null
  definition: string | null
  exchange: string | null
  /** 结构化释义 [{pos, meaning, core?}];core=常考义项(卡面高亮) */
  senses: unknown
  examples: unknown
  collocations: unknown
  /** 助记：一句话联想/口诀（短语尤其需要） */
  mnemonic: string | null
  tags: string[]
  reps: number
  lapses: number
  mastery: number
  isNew: boolean
}

export interface WordQueueSummary {
  planId: string
  planName: string
  listName: string | null
  dailyNew: number
  dailyReview: number
  /** 今天已经推进过的新词数 */
  todayNewDone: number
  /** 本次队列里的到期词 / 新词数 */
  due: number
  fresh: number
  /** 已进入学习的词 / 掌握度 >= 0.8 的词 */
  learning: number
  mastered: number
}

export interface WordQueue {
  items: WordQueueItem[]
  summary: WordQueueSummary
}

/** 入口卡用的概况（GET /api/words/summary） */
export interface WordSummary {
  hasDictionary: boolean
  listCount: number
  listName: string | null
  listTotal: number
  cursor: number
  dailyNew: number
  dailyReview: number
  due: number
  todayNewDone: number
  learning: number
  mastered: number
}

/** 例句结构（DictEntry.examples 是 JSON，来源不统一，渲染前归一） */
export interface WordExample {
  en: string
  zh?: string
}

export function asExamples(v: unknown): WordExample[] {
  if (!Array.isArray(v)) return []
  return v
    .map((x): WordExample | null => {
      if (typeof x === 'string') return { en: x }
      if (x && typeof x === 'object') {
        const o = x as Record<string, unknown>
        const en = typeof o.en === 'string' ? o.en : typeof o.text === 'string' ? o.text : ''
        const zh = typeof o.zh === 'string' ? o.zh : typeof o.cn === 'string' ? o.cn : undefined
        return en ? { en, zh } : null
      }
      return null
    })
    .filter((x): x is WordExample => !!x)
}

/** 助记短语(闪过「用」块):core=常考短语(星标,进卡面);其余扩展默认折叠 */
export interface WordCollocation {
  en: string
  zh?: string
  core?: boolean
}

export function asCollocations(v: unknown): WordCollocation[] {
  const arr = Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? [v] : []
  const out: WordCollocation[] = []
  for (const x of arr) {
    if (typeof x === 'string') {
      const en = x.trim()
      if (en) out.push({ en })
    } else if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>
      const en = typeof o.en === 'string' ? o.en : typeof o.text === 'string' ? o.text : ''
      const zh = typeof o.zh === 'string' ? o.zh : undefined
      if (en) out.push({ en, zh, core: o.core === true || undefined })
    }
  }
  return out
}

/** 结构化义项(导入器按 ①② 编号拆出);core=常考义项(卡面高亮) */
export interface WordSense {
  pos?: string
  meaning: string
  core?: boolean
}

export function asSenses(v: unknown): WordSense[] {
  if (!Array.isArray(v)) return []
  const out: WordSense[] = []
  for (const x of v) {
    if (!x || typeof x !== 'object') continue
    const o = x as Record<string, unknown>
    const meaning = typeof o.meaning === 'string' ? o.meaning.trim() : ''
    if (!meaning) continue
    const pos = typeof o.pos === 'string' && o.pos.trim() ? o.pos.trim() : undefined
    out.push({ pos, meaning, core: o.core === true || undefined })
  }
  return out
}

/**
 * 释义展示：词条常把词性写进释义（"v. 放弃；抛弃"），卡面已单独显示词性时去掉前缀，
 * 免得出现「v」+「v. 放弃」两遍。
 */
export function meaningText(trans: string | null | undefined, pos: string | null | undefined): string {
  const t = (trans ?? '').trim()
  if (!t || !pos) return t
  const head = `${pos.toLowerCase()}.`
  return t.toLowerCase().startsWith(head) ? t.slice(head.length).trim() : t
}

/** 拼写小测卡提示释义：每个义项最多保留的字数（标点处截断），三个义项约两三行 */
const SENSE_CLIP_MAX = 14

/** 标点处截断 + 半括号配平（与 pruneForPrint 尾段同算法） */
function clipSense(seg: string): string {
  let out = seg
  // 中文括注：去掉之后还剩 ≥6 个字才去（保住「（文章的）段」这类必要括注）
  for (let guard = 0; guard < 4; guard++) {
    const segs = out.match(/（[^）]{1,12}）/g)
    if (!segs) break
    let removed = false
    for (const sg of segs) {
      if (out.length - sg.length >= 6) {
        out = out.replace(sg, '')
        removed = true
      }
    }
    if (!removed) break
  }
  out = out
    .replace(/\s+/g, ' ')
    .replace(/[；;、，,\s]+$/, '')
    .trim()
  if (out.length > SENSE_CLIP_MAX) {
    const head = out.slice(0, SENSE_CLIP_MAX)
    const at = Math.max(head.lastIndexOf('；'), head.lastIndexOf('、'), head.lastIndexOf('，'), head.lastIndexOf(' '))
    out = (at > SENSE_CLIP_MAX - 10 ? head.slice(0, at) : head).replace(/[；;、，,\s]+$/, '') + '…'
  }
  // 兜底配平：不要留半个「（性质、特…」
  const open = (out.match(/（/g) || []).length
  const close = (out.match(/）/g) || []).length
  if (open > close) {
    const cut = out.lastIndexOf('（')
    out = cut > 0 ? out.slice(0, cut).replace(/[；;、，,\s]+$/, '') + '…' : out
  }
  return out
}

/**
 * 拼写小测卡的提示释义（design/preview-spell-meaning.html B 案，2026-11-16 挑中）：
 * 打印单 pruneForPrint 同款压缩（去英文括注 / 语法标记 / 词性 / 短中文括注），
 * 保留 ①②③ 编号、只取前 max 个有实义的义项；纯语法括注段（如「（与名词连用…）」）
 * 去掉括注后无字，跳过不占名额（编号会顺延，卡面上能看到 ② 直接到 ④）。
 * 预处理正则与 pruneForPrint 同源——改动需两处同步。
 * 返回数组按序对应编号；为空时调用方回退 meaningText / definition。
 */
export function spellSenses(trans: string | null | undefined, max = 3): string[] {
  if (!trans) return []
  let s = ` ${trans} `
  s = s.replace(/（[^）]*[A-Za-z][^）]*）/g, '') // 含英文的括注整段去掉
  s = s.replace(/\[[^\]]*\]/g, '') // [U] [C] [sing.] 等语法标记
  s = s.replace(/\b(vi|vt|v|n|adj|adv|prep|conj|pron|aux|num)\b\.?-?/gi, '')
  s = s.replace(/v\.-link\./gi, '')
  s = s.replace(/（\s*）/g, ' ')
  // 按 ①②③… 切义项（带捕获组，编号随段保留）；无编号的短语释义整条算一段
  const parts = s.split(/\s*([①②③④⑤⑥⑦⑧⑨⑩])\s*/)
  const out: string[] = []
  for (let i = 0; i < parts.length && out.length < max; ) {
    if (i === 0) {
      const t = parts[i]!.replace(/\s+/g, ' ').trim()
      if (t) out.push(clipSense(t))
      i++
    } else {
      const no = parts[i]!
      const text = (parts[i + 1] ?? '').replace(/\s+/g, ' ').trim()
      if (text) {
        const bare = text.replace(/（[^）]*）/g, '').replace(/[\s，,；;、.。·-]+/g, '')
        if (bare) out.push(`${no}${clipSense(text)}`)
      }
      i += 2
    }
  }
  return out
}
