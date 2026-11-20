/**
 * PDF 录题共享类型与纯函数(客户端/服务端两用):
 * 候选题三态(wait/done/skip)、题干归一化指纹与相似度(去重用)、逐页文本分块。
 * 服务端 IO/AI 逻辑见同目录 pdf-import.server.ts。
 */

export type ImportCandidateState = 'wait' | 'done' | 'skip'

/** 一道候选题(切题产物 + 人工状态)。key 是候选内部主键(nanoid),入库映射见 server finish */
export interface ImportCandidate {
  key: string
  /** 卷内题号;AI 拆不出时给 0(展示用「?」) */
  number: number
  /** 所在大题,如「一、选择题」 */
  section: string
  kind: 'choice' | 'answer'
  multiple: boolean
  score: number
  stem: string
  /** 选项原文(不带 A. 前缀);非选择题为空 */
  options: string[]
  /** 答案+解析;空串 = 缺答案 */
  answer: string
  /** paper=卷面答案区抽到 | ai=AI 解 | 空=缺答案 */
  answerSource: 'paper' | 'ai' | ''
  /** 考点短语,空=未标 */
  topic: string
  /** 起始页码(1-based) */
  page: number
  state: ImportCandidateState
  /** 去重命中描述,如「相似 92% ·《卷名》第 7 题」;空 = 未命中 */
  dup: string
}

/** AI 从卷头抽的元信息,抽不到的字段为 null */
export interface ImportMeta {
  title: string | null
  year: string | null
  examType: string | null
  totalScore: number | null
  durationMin: number | null
}

export const EMPTY_IMPORT_META: ImportMeta = {
  title: null,
  year: null,
  examType: null,
  totalScore: null,
  durationMin: null,
}

/** GET /api/papers/pdf-import/[id] 返回(不回传 pageTexts,可能很大且客户端不需要) */
export interface ImportJobDto {
  id: string
  status: 'splitting' | 'ready' | 'finished' | 'failed'
  fileName: string
  subject: string
  title: string
  pageCount: number
  mode: 'text' | 'scan'
  meta: ImportMeta
  candidates: ImportCandidate[]
  error: string | null
  paperId: string | null
  createdAt: string
  /** 切题中才带:客户端按块顺序驱动的分块计划(页码 1-based 含端点) */
  chunks?: Array<{ from: number; to: number }>
}

/** 题干归一化:去空白/标点/题号前缀,留 CJK+字母数字,转小写(去重指纹口径) */
export function normalizeStem(stem: string): string {
  return stem
    .replace(/^\s*\d{1,3}\s*[.、．)]\s*/, '')
    .replace(/[\s，。、；：？！「」『』()（）【】\[\]{}"'`~·\-—_+*=\\|/<>^$%#!?.,;:?!]/g, '')
    .toLowerCase()
}

/** 字符 bigram 集合(相似度用;单字题干退化为字集) */
function bigrams(s: string): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
  if (s.length === 1) out.add(s)
  return out
}

/** Jaccard 相似度 0~1 */
export function stemSimilarity(a: string, b: string): number {
  const A = bigrams(a)
  const B = bigrams(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const g of Array.from(A)) if (B.has(g)) inter++
  return inter / (A.size + B.size - inter)
}

export const DUP_SIMILAR_THRESHOLD = 0.82

/** 逐页文本分块:按页边界聚合,每块 ≤ maxChars(CJK 切题单次调用的舒适上限) */
export function chunkPages(pageTexts: string[], maxChars = 3500): Array<{ from: number; to: number; chars: number }> {
  const chunks: Array<{ from: number; to: number; chars: number }> = []
  let start = 0
  let acc = 0
  for (let i = 0; i < pageTexts.length; i++) {
    const len = pageTexts[i].length
    if (acc > 0 && acc + len > maxChars) {
      chunks.push({ from: start + 1, to: i, chars: acc })
      start = i
      acc = 0
    }
    acc += len
  }
  if (acc > 0) chunks.push({ from: start + 1, to: pageTexts.length, chars: acc })
  return chunks
}

/** 候选统计(审核台顶栏/完成确认共用) */
export function candidateCounts(candidates: ImportCandidate[]) {
  const done = candidates.filter((c) => c.state === 'done')
  const wait = candidates.filter((c) => c.state === 'wait')
  const skip = candidates.filter((c) => c.state === 'skip')
  return {
    total: candidates.length,
    done: done.length,
    wait: wait.length,
    skip: skip.length,
    dup: candidates.filter((c) => c.dup).length,
    noAnswer: candidates.filter((c) => !c.answer).length,
    /** 可批量入库的「干净题」:待审 + 有答案 + 未命中重复 */
    cleanWait: wait.filter((c) => c.answer && !c.dup).length,
    /** 练题池最终入库数:已入库且答案非空 */
    poolReady: done.filter((c) => c.answer).length,
  }
}
