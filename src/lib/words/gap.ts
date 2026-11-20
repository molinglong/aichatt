/**
 * 词填空判分与正文切分（短文读后默写 / 对话逐句闯关共用）——
 * 产物来自 /api/words/passage 与 /api/words/dialogue：正文用 **双星号** 标目标词，
 * words 附 { w: 原形, form: 文中形式 }。
 *
 * 判定口径（2026-11-17 定案）：答案 = 文中形式 form + 原形 w 双白名单，
 * 大小写 / 首尾空格 / 尾部标点归一后精确匹配；不做同义改写判定——
 * 填空不接 FSRS（语境用法不是词级最小回忆单元，误判噪音不进排期），
 * 看答案 = 没想起，只影响当次体验。
 */

export interface GapWord {
  /** 原形（词库 lemma） */
  w: string
  /** 文中形式（含 -s/-ed/-ing 变形） */
  form: string
}

/** 归一：trim + 小写 + 去尾部中英文标点（不破词内撇号 I'm / don't） */
export function normAnswer(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:'"()（）。，！？；：、“”'’‘]+$/g, '')
}

/** 单空判定：'empty' 未填 / 'ok' 命中白名单 / 'bad' 想岔了 */
export function judgeGap(input: string, word: GapWord): 'empty' | 'ok' | 'bad' {
  const v = normAnswer(input)
  if (!v) return 'empty'
  return [word.form, word.w].map(normAnswer).includes(v) ? 'ok' : 'bad'
}

/** 把 "… **took** …" 切成普通文本 / 目标词两段（与纸质卷 splitBold 同口径） */
export function splitBold(text: string): { text: string; bold: boolean }[] {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .filter((p) => p !== '')
    .map((p) =>
      p.startsWith('**') && p.endsWith('**') && p.length > 4
        ? { text: p.slice(2, -2), bold: true }
        : { text: p, bold: false },
    )
}

/** 默写题单去重：原形相同只考一次（run/runs 都出现时只留一个空） */
export function dedupeGapWords(words: GapWord[]): GapWord[] {
  return words.filter((x, i, arr) => arr.findIndex((y) => y.w === x.w) === i)
}

/** 中文提示截断：义项首段、去 ①② 序号、逗号/分号/括号前截断、≤14 字（对齐拼写卡释义口径） */
export function shortTrans(s: string | null | undefined): string {
  const t = (s ?? '')
    .split(/[，,；;（(。]/)[0]
    .trim()
    .replace(/^[①-⑳Ⓐ-Ⓩ\s]+/, '')
    .trim()
  if (!t) return ''
  return t.length > 14 ? `${t.slice(0, 13)}…` : t
}
