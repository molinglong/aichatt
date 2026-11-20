/**
 * 在线做题(PaperAttempt)服务端核心:载荷净化 + 判分引擎。
 *
 * 判分口径(design/preview-online-exam.html 定稿):
 * - 单选:字母精确匹配;多选:集合精确匹配(漏选/多选判错,附 note);
 * - 填空:归一化匹配(全半角/负号/空格/$..$/分数↔小数),标准答案支持「或」多答案;
 * - 解答/证明/作文:pending,交卷后人工自评(或后续 AI 阅卷)回填 selfScores;
 * - 标准答案来自 PaperQuestion.answer 官方文本,头部解析(「29. $x=-1$（由…）」→「-1」),
 *   解析段落不参与判分。
 * 判分只进 attempt.result 快照,不回写 PaperQuestion/Question(与拟卷同一隔离原则)。
 */
import { prisma } from "@/lib/db"
import { parseObjectiveAnswer } from "./answer-parse"

export interface AttemptQuestion {
  id: string
  number: number
  section: string | null
  kind: string
  multiple: boolean
  score: number
  stem: string
  options: string[]
  images: string[]
  topics: string[]
}

export type QuestionVerdict = "correct" | "wrong" | "unanswered" | "pending"

export interface QuestionGrade {
  number: number
  kind: string
  multiple: boolean
  max: number
  verdict: QuestionVerdict
  /** 判定得分:客观题判完即定;主观题=selfScores 回填(未回填为 0) */
  score: number
  /** 客观题的标准答案(展示用);主观题无 */
  expected?: string
  /** 判错原因简述(漏选 C / 多选 D / 未答) */
  note?: string
  topics: string[]
  section: string | null
}

export interface SectionStat {
  name: string
  numbers: number[]
  max: number
  /** 已判得分(不含待判题) */
  got: number
  /** 该大题是否存在待判(主观)题 */
  pending: boolean
}

export interface AttemptResult {
  gradedAt: string
  perQuestion: QuestionGrade[]
  sections: SectionStat[]
  /** 客观题已判得分 */
  objectiveScore: number
  /** 参与客观判分题的满分合计 */
  objectiveMax: number
  /** 待判(主观)题满分合计 */
  subjectiveMax: number
  /** 主观题自评合计(selfScores 求和,可能小于 subjectiveMax) */
  selfScore: number
  /** 判错的客观题号(喂学校考试记录 wrongNumbers) */
  wrongNumbers: number[]
  /** 考点丢分(判错题聚合,丢分降序) */
  topicLoss: Array<{ topic: string; count: number; loss: number }>
  /** 交卷自动生成的学校考试记录 id(自评分变更时同步其 score) */
  autoRecordId?: string
}

/** 交卷后回传给报告页的完整载荷(含标准答案) */
export interface AttemptReportPayload {
  attempt: {
    id: string
    status: string
    startedAt: string
    submittedAt: string | null
    durationSec: number | null
    answers: Record<string, string>
    result: AttemptResult | null
  }
  paper: { id: string; slug: string; title: string; subject: string; totalScore: number; durationMin: number }
  questions: Array<AttemptQuestion & { answer: string | null }>
}

/** 开考/续考载荷:正在进行时不含答案(防泄漏) */
export interface AttemptRunPayload {
  attempt: {
    id: string
    status: string
    startedAt: string
    durationSec: number | null
    answers: Record<string, string>
  }
  paper: { id: string; slug: string; title: string; subject: string; totalScore: number; durationMin: number }
  questions: AttemptQuestion[]
}

const MAX_ANSWER_CHARS = 32_000

function normalizeAnswers(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d{1,3}$/.test(k)) continue
    if (typeof v === "string" && v.length <= 2000) out[k] = v
  }
  return out
}

/** 卷内题号 → 作答文本的收敛读取(PATCH 全量覆盖口径) */
export function readAnswers(raw: unknown): Record<string, string> {
  const map = normalizeAnswers(raw)
  let size = 0
  for (const v of Object.values(map)) size += v.length
  return size <= MAX_ANSWER_CHARS ? map : {}
}

/** 开考/恢复载荷:题目剥掉 answer/answerSource(防泄漏) */
export async function loadAttemptQuestions(paperId: string): Promise<AttemptQuestion[]> {
  const rows = await prisma.paperQuestion.findMany({
    where: { paperId, flagged: false },
    orderBy: { number: "asc" },
    select: {
      id: true,
      number: true,
      section: true,
      kind: true,
      multiple: true,
      score: true,
      stem: true,
      options: true,
      images: true,
      topics: true,
    },
  })
  return rows
}

/** 是否客观可判:选择题一律可判;非选择题里「填空题」大题按客观判,其余(解答/证明/作文)主观待判 */
export function isObjectiveQuestion(q: { kind: string; section: string | null }): boolean {
  if (q.kind === "choice") return true
  return !!q.section && q.section.includes("填空")
}

/** 标准答案头部解析已抽至 answer-parse.ts(客户端今晚测验共用同一判分口径) */

/** 填空归一化:全半角/$..$/空格/负号/π 写法统一,再比对(含分数↔小数等价) */
function normalizeBlank(input: string): string {
  let s = input.trim()
  s = s.replace(/\$([^$]*)\$/g, "$1").replace(/\\[()]/g, "")
  s = s.replace(/[，、。]/g, "").replace(/－/g, "-").replace(/\s+/g, "")
  s = s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
  s = s.replace(/\\left|\\right/g, "").replace(/\\dfrac|\\frac/g, "").replace(/[{}]/g, "")
  return s.toLowerCase()
}

function blankEquals(a: string, b: string): boolean {
  const na = normalizeBlank(a)
  const nb = normalizeBlank(b)
  if (!na || !nb) return false
  if (na === nb) return true
  const va = parseNumeric(na)
  const vb = parseNumeric(nb)
  return va !== null && vb !== null && Math.abs(va - vb) < 1e-9
}

/** "3/4" → 0.75;"-0.75" → -0.75;其余 null(不走数值比较) */
function parseNumeric(s: string): number | null {
  const frac = s.match(/^(-?\d+)\/(\d+)$/)
  if (frac) {
    const d = Number(frac[2])
    if (d !== 0) return Number(frac[1]) / d
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  return null
}

function gradeChoice(q: AttemptQuestion & { answer: string | null }, raw: string): QuestionGrade {
  const expectedList = parseObjectiveAnswer(q)
  const expected = expectedList[0] ?? ""
  const picked = (raw.toUpperCase().match(/[A-D]/g) ?? []).filter((v, i, arr) => arr.indexOf(v) === i).join("")
  const base: QuestionGrade = {
    number: q.number,
    kind: q.kind,
    multiple: q.multiple,
    max: q.score,
    verdict: "wrong",
    score: 0,
    topics: q.topics,
    section: q.section,
  }
  if (!picked) return { ...base, verdict: "unanswered", expected, note: "未答" }
  if (!expected) return { ...base, verdict: "pending", note: "缺标准答案" }
  if (picked === expected) return { ...base, verdict: "correct", score: q.score, expected }
  const expectedLetters: string[] = expected.match(/[A-D]/g) ?? []
  const pickedLetters: string[] = picked.split("")
  const miss = expectedLetters.filter((c) => !pickedLetters.includes(c))
  const extra = pickedLetters.filter((c) => !expectedLetters.includes(c))
  // 多选部分分:本库合格考卷规则「全部选对得满分,部分选对得满分−1,有选错得 0」(如 3 分题部分对得 2)
  if (q.multiple && extra.length === 0 && miss.length > 0 && q.score >= 2) {
    return {
      ...base,
      verdict: "wrong",
      score: q.score - 1,
      expected,
      note: `漏选 ${miss.join("")} · 部分分`,
    }
  }
  const parts: string[] = []
  if (q.multiple && miss.length) parts.push(`漏选 ${miss.join("")}`)
  if (extra.length) parts.push(`多选 ${extra.join("")}`)
  return { ...base, verdict: "wrong", expected, note: parts.join(" · ") || "答案不符" }
}

function gradeBlank(q: AttemptQuestion & { answer: string | null }, raw: string): QuestionGrade {
  const expectedList = parseObjectiveAnswer(q)
  const base: QuestionGrade = {
    number: q.number,
    kind: q.kind,
    multiple: false,
    max: q.score,
    verdict: "wrong",
    score: 0,
    topics: q.topics,
    section: q.section,
  }
  if (!raw.trim()) return { ...base, verdict: "unanswered", expected: expectedList[0] ?? "", note: "未答" }
  if (!expectedList.length) return { ...base, verdict: "pending", note: "缺标准答案" }
  const ok = expectedList.some((e) => blankEquals(e, raw))
  return {
    ...base,
    verdict: ok ? "correct" : "wrong",
    score: ok ? q.score : 0,
    expected: expectedList[0],
    note: ok ? undefined : "答案不符",
  }
}

function gradeSubjective(q: AttemptQuestion, raw: string, selfScore: number | null): QuestionGrade {
  return {
    number: q.number,
    kind: q.kind,
    multiple: false,
    max: q.score,
    verdict: "pending",
    score: Math.max(0, Math.min(q.score, selfScore ?? 0)),
    topics: q.topics,
    section: q.section,
    note: raw.trim() ? undefined : "未作答",
  }
}

/** 判分主入口:answers=题号→作答;selfScores=主观题题号→自评分(未回填按 0,verdict 仍 pending) */
export function gradeAttempt(
  questions: Array<AttemptQuestion & { answer: string | null }>,
  answers: Record<string, string>,
  selfScores: Record<string, number> = {}
): AttemptResult {
  const perQuestion: QuestionGrade[] = []
  let objectiveScore = 0
  let objectiveMax = 0
  let subjectiveMax = 0
  const wrongNumbers: number[] = []
  const lossMap = new Map<string, { topic: string; count: number; loss: number }>()

  for (const q of questions) {
    const raw = answers[String(q.number)] ?? ""
    if (!isObjectiveQuestion(q)) {
      const self = selfScores[String(q.number)]
      const grade = gradeSubjective(q, raw, typeof self === "number" && Number.isFinite(self) ? Math.round(self) : null)
      perQuestion.push(grade)
      subjectiveMax += q.score
      continue
    }
    objectiveMax += q.score
    const grade = q.kind === "choice" ? gradeChoice(q, raw) : gradeBlank(q, raw)
    perQuestion.push(grade)
    objectiveScore += grade.score
    if (grade.verdict === "wrong") {
      wrongNumbers.push(q.number)
      const lost = q.score - grade.score
      if (lost > 0) {
        for (const t of q.topics) {
          const e = lossMap.get(t) ?? { topic: t, count: 0, loss: 0 }
          e.count += 1
          e.loss += lost
          lossMap.set(t, e)
        }
      }
    }
  }

  // 大题小计:按 section 首现顺序聚合
  const sections: SectionStat[] = []
  const byName = new Map<string, SectionStat>()
  for (const g of perQuestion) {
    const name = g.section ?? "(未分组)"
    let s = byName.get(name)
    if (!s) {
      s = { name, numbers: [], max: 0, got: 0, pending: false }
      byName.set(name, s)
      sections.push(s)
    }
    s.numbers.push(g.number)
    s.max += g.max
    s.got += g.score
    if (g.verdict === "pending") s.pending = true
  }

  const selfScore = Object.entries(selfScores).reduce((acc, [n, v]) => {
    const q = questions.find((x) => String(x.number) === n)
    if (!q || typeof v !== "number" || !Number.isFinite(v)) return acc
    return acc + Math.max(0, Math.min(q.score, Math.round(v)))
  }, 0)

  return {
    gradedAt: new Date().toISOString(),
    perQuestion,
    sections,
    objectiveScore,
    objectiveMax,
    subjectiveMax,
    selfScore,
    wrongNumbers,
    topicLoss: Array.from(lossMap.values()).sort((a, b) => b.loss - a.loss).slice(0, 8),
  }
}

/** 交卷日期串(服务器本地时区 'YYYY-MM-DD',躲 UTC slice 偏一天坑) */
export function attemptDate(): string {
  return new Date().toLocaleDateString("sv-SE")
}

/* ── 载荷构建(归属校验:attempt 只归本人,卷子走 libraryScopes 读路径) ── */

async function loadAttemptPaper(userId: string, attemptId: string) {
  const attempt = await prisma.paperAttempt.findFirst({
    where: { id: attemptId, userId },
    include: {
      paper: {
        select: { id: true, slug: true, title: true, subject: true, totalScore: true, durationMin: true },
      },
    },
  })
  return attempt
}

/** 进行中载荷(题目剥答案)。不存在/无权 → null */
export async function loadAttemptRun(userId: string, attemptId: string): Promise<AttemptRunPayload | null> {
  const attempt = await loadAttemptPaper(userId, attemptId)
  if (!attempt) return null
  const questions = await loadAttemptQuestions(attempt.paperId)
  return {
    attempt: {
      id: attempt.id,
      status: attempt.status,
      startedAt: attempt.startedAt.toISOString(),
      durationSec: attempt.durationSec,
      answers: readAnswers(attempt.answers),
    },
    paper: attempt.paper,
    questions,
  }
}

/** 报告载荷(交卷后:含标准答案 + 判分快照)。不存在/无权 → null */
export async function loadAttemptReport(userId: string, attemptId: string): Promise<AttemptReportPayload | null> {
  const attempt = await loadAttemptPaper(userId, attemptId)
  if (!attempt) return null
  const questions = await prisma.paperQuestion.findMany({
    where: { paperId: attempt.paperId, flagged: false },
    orderBy: { number: "asc" },
    select: {
      id: true,
      number: true,
      section: true,
      kind: true,
      multiple: true,
      score: true,
      stem: true,
      options: true,
      images: true,
      topics: true,
      answer: true,
    },
  })
  return {
    attempt: {
      id: attempt.id,
      status: attempt.status,
      startedAt: attempt.startedAt.toISOString(),
      submittedAt: attempt.submittedAt ? attempt.submittedAt.toISOString() : null,
      durationSec: attempt.durationSec,
      answers: readAnswers(attempt.answers),
      result: (attempt.result as AttemptResult | null) ?? null,
    },
    paper: attempt.paper,
    questions,
  }
}
