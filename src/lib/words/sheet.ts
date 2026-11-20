/**
 * 打印用数据整形（纯函数，服务端/客户端都能用）。
 *
 * 为什么要压缩释义：这份词单的平均释义 212 字、最长 481 字（`hold` 一条），
 * 原样印出来一页放不下三个词。打印单只留「够用的一眼」：
 *   去英文括注 → 去语法标记/词性 → 只留前两个义项 → 能去的中文括注也去 → 标点处截断。
 * 详情仍留在 App 里（点词看全释义），纸上只做提示。
 */

export interface PrintWord {
  /** 单内序号（从 1 开始，对应词单位置） */
  no: number
  headword: string
  /** 音标（英音优先，美音兜底）：D 英译中版式用 */
  phonetic: string
  pos: string
  /** 已压缩的释义 */
  trans: string
  /** 助记（可能为空） */
  mnemonic: string
  /** 限量搭配短语（core 优先 2 条；A/D 版式印在词行下方，B/C 不印） */
  colls: { en: string; zh: string }[]
  isPhrase: boolean
  /** 所属单元（Word List N），页眉用来标明这一页在哪个 List */
  unit: string
  /** 混合卷（2026-11-18）节属：review=今日复习节 | new=今日新词节；非混合卷不设。
   *  渲染层据此切连续段、在节首画分节头；打乱词序（混合卷）也按它分节内洗。 */
  origin?: 'review' | 'new'
}

export function pruneForPrint(trans: string | null | undefined, max = 22): string {
  if (!trans) return ''
  let s = ` ${trans} `
  s = s.replace(/（[^）]*[A-Za-z][^）]*）/g, '') // 含英文的括注整段去掉
  s = s.replace(/\[[^\]]*\]/g, '') // [U] [C] [sing.] 等语法标记
  s = s.replace(/\b(vi|vt|v|n|adj|adv|prep|conj|pron|aux|num)\b\.?-?/gi, '')
  s = s.replace(/v\.-link\./gi, '')
  s = s.replace(/（\s*）/g, ' ')
  // 义项只留前两个（按 ②③… 切）
  const parts = s.split(/\s*[②③④⑤⑥⑦⑧⑨⑩]\s*/).filter(Boolean).slice(0, 2)
  let out = parts
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/^[①\s,，;；]+/, '')
    .trim()
  // 中文括注：去掉之后还剩 ≥6 个字才去（保住「（文章的）段」这类必要括注）
  for (let guard = 0; guard < 4; guard++) {
    const segs = out.match(/（[^）]{1,12}）/g)
    if (!segs) break
    let removed = false
    for (const seg of segs) {
      if (out.length - seg.length >= 6) {
        out = out.replace(seg, '')
        removed = true
      }
    }
    if (!removed) break
  }
  out = out
    .replace(/\s+/g, ' ')
    .replace(/[；;、，,\s]+$/, '')
    .trim()
  if (out.length > max) {
    const head = out.slice(0, max)
    const at = Math.max(head.lastIndexOf('；'), head.lastIndexOf('、'), head.lastIndexOf('，'), head.lastIndexOf(' '))
    out = (at > max - 10 ? head.slice(0, at) : head).replace(/[；;、，,\s]+$/, '') + '…'
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
 * 搭配短语限量挑选（2026-11-17 打印点单）：core 优先，最多 2 条。
 * collocations 是 Json 字段（unknown），结构异常一律安全返回空，不硬造。
 */
export function pickColls(raw: unknown, max = 2): { en: string; zh: string }[] {
  if (!Array.isArray(raw)) return []
  const items = raw
    .filter((x): x is { en?: unknown; zh?: unknown; core?: unknown } => !!x && typeof x === 'object')
    .map((x) => ({
      en: typeof x.en === 'string' ? x.en.trim() : '',
      zh: typeof x.zh === 'string' ? x.zh.trim() : '',
      core: x.core === true,
    }))
    .filter((x) => x.en && x.zh)
  items.sort((a, b) => Number(b.core) - Number(a.core))
  return items.slice(0, max).map(({ en, zh }) => ({ en, zh }))
}

/** 按每页词数切页 */
export function splitPages<T>(items: T[], perPage: number): T[][] {
  const size = Math.max(1, perPage)
  const pages: T[][] = []
  for (let i = 0; i < items.length; i += size) pages.push(items.slice(i, i + size))
  return pages.length ? pages : [[]]
}

/* ── 可复现随机（2026-11-16 对话页/打乱用） ──
 * 「生成对话」按钮与卷面渲染是两次独立请求，抽中的词必须一致缓存 key 才对得上——
 * 所以抽词必须由 seed 定版，不能用 Math.random。 */

/** mulberry32：小而稳的可复现伪随机 */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 有种子洗牌（Fisher-Yates）：同一 seed + 同一输入顺序 = 同一结果 */
export function shuffleWithSeed<T>(items: readonly T[], seed: number): T[] {
  const arr = [...items]
  const rnd = mulberry32(seed)
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

/** 从词表按 seed 定版抽 count 个。内部先排序消除输入顺序影响——
 *  卷面打乱词序（sh=1）后每次渲染顺序都会变，排序保证两端口径一致。 */
export function pickSeeded(words: readonly string[], count: number, seed: number): string[] {
  const pool = [...words].sort()
  return shuffleWithSeed(pool, seed).slice(0, Math.max(1, count))
}

/** 打印版式 */
export type SheetMode = 'A' | 'B' | 'C' | 'D'

/** 每栏可排行高预算（实测校准,2026-11-15）：
 *  A4 打印区 297mm − 卷面 padding 28mm − 页眉/页脚/间距 ≈ 909px;
 *  行高实测:A/B 半栏宽下释义两行 39.6~59.6px(均值 ~48-57),C 折叠行 37.1~55.1px。
 *  perPage 一律按「最坏行高 × 行数 < 预算」取整定档,宁空不溢 —— 溢出会把卷面
 *  冲破 page-break 断成两张无头无尾的纸(2026-11-15 修「背词卷打印分页乱」)。 */
export const SHEET_MODE_META: Record<
  SheetMode,
  { label: string; desc: string; perPage: number; perCol: number; collPerPage?: number }
> = {
  // A 对照单：英文 + 释义（+ 助记 + 搭配短语），>15 词自动双栏
  // collPerPage：印搭配短语时词行下方多一行短语（均值 ~84px/词），15 行/栏会冲破预算 → 降档 10 行/栏
  A: { label: '对照单', desc: '英文 + 释义 + 助记，拿着背', perPage: 30, perCol: 15, collPerPage: 20 },
  // B 默写纸：中文提示 + 右侧写英文的横线；助记/短语都不印——短语英文里含目标词（take notes），印了直接漏答案
  B: { label: '默写纸', desc: '中文提示 + 横线，课上自测', perPage: 30, perCol: 15 },
  // C 折叠单：整页左右各一半，对折遮一半（左右两栏同词表,行数即每侧行数）；
  // 不印短语：折叠行 16 行/侧已按最坏行高校准，短语行会把它冲破
  C: { label: '折叠单', desc: '左英右中，对折遮一半自测', perPage: 16, perCol: 16 },
  // D 英译中：英文 + 音标 + 词性，右侧横线写中文（2026-11-16 用户点单）；
  // 2026-11-16 加印助记、2026-11-17 加印搭配短语 → 行高同 A 档，collPerPage 同 A
  D: { label: '英译中', desc: '英文 + 音标 + 词性，横线写中文', perPage: 30, perCol: 15, collPerPage: 20 },
}
