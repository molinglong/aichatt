/**
 * 突击测试题源组装 + 概念出题(server-only)。
 *
 * 配额口径(design/surprise-quiz-plan.md §5,数字是调参旋钮):目标 3 题,
 * 三池各占 1 席——错题本(池内按权重抽)/课本(随机章节)/事件(ScratchNote 主题,
 * 退路近 3 天学习事件);某池无料或生成失败则顺延给仍有料的池(同池最多 2 席)。
 * 冷却:7 天内上过场的错题卡/课本章节/便签主题不再抽。
 *
 * 生成统一走「概念选择题」模式:以概念理解为主,最多一步以内小计算,
 * 干扰项用常见误解;模型解析沿用 resolveStudyModel 范式,任何失败降级顺延。
 * sourceChunkId 是内部字段:随题目快照落 attempt,供课本章节冷却,不进 UI。
 */
import { generateText, type LanguageModel } from 'ai'
import { prisma } from '@/lib/db'
import { resolveStudyModel } from './tagging'

export type SurpriseSource = 'wrong_note' | 'textbook' | 'scratch'

/** 前后端通用的单题结构(答完原样回传 complete,服务端按字段白名单落库) */
export interface SurpriseItem {
  source: SurpriseSource
  /** 考点/主题短语(≤12 字),来源徽标文案也用它 */
  topic: string
  stem: string
  options: { letter: 'A' | 'B' | 'C' | 'D'; text: string }[]
  answer: 'A' | 'B' | 'C' | 'D'
  /** 当场解析(答错展示用) */
  analysis: string
  /** 错题本源:StudyNote.id,答对要写 FSRS good */
  sourceNoteId?: string
  /** 课本源:出处(§x.x 标题);事件源:便签 topic / 学习记录 */
  sourceRef?: string
  /** 内部字段:课本章节 id,落 attempt 快照供 7 天冷却 */
  sourceChunkId?: string
}

const QUIZ_TOTAL = 3
const COOLDOWN_DAYS = 7
/** 池空顺延时同一池最多占几席 */
const PER_POOL_CAP = 2
/** 顺延优先级:错题本 > 课本 > 事件 */
const PRIORITY: SurpriseSource[] = ['wrong_note', 'textbook', 'scratch']

const GEN_SYSTEM = [
  '你是突击测验出题助手。把给定的材料改编成 1 道概念选择题,核心规则:',
  '- 以概念理解为主:定义辨析/性质判断/口径理解;最多允许一步以内的小计算,禁止多步综合题',
  '- 4 个选项 A-D,干扰项用该考点的常见误解;正确答案恰好一个',
  '- 输出严格的 JSON,不要任何其他文字或代码围栏,格式:',
  '{"stem":"题干","options":[{"letter":"A","text":"..."},{"letter":"B","text":"..."},{"letter":"C","text":"..."},{"letter":"D","text":"..."}],"answer":"A","analysis":"当场解析:为什么对、其他项错在哪(不超过80字)","topic":"考点短语(不超过12字)"}',
  '- 难度以「提醒一下就想得起来」为准,不要设阅读陷阱',
].join('\n')

interface GenResult {
  topic: string
  stem: string
  options: { letter: 'A' | 'B' | 'C' | 'D'; text: string }[]
  answer: 'A' | 'B' | 'C' | 'D'
  analysis: string
}

function pool<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

/** LLM 生成一道概念选择题;解析/校验失败返回 null(调用方顺延) */
async function genConceptItem(model: LanguageModel, material: string): Promise<GenResult | null> {
  try {
    const { text } = await generateText({
      model,
      system: GEN_SYSTEM,
      prompt: `## 材料\n${material.slice(0, 1800)}\n\n严格按系统格式输出 1 道概念选择题的 JSON:`,
      temperature: 0.5,
    })
    const raw = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
    const p = JSON.parse(raw) as Partial<GenResult>
    const letters = ['A', 'B', 'C', 'D'] as const
    const options = (Array.isArray(p.options) ? p.options : [])
      .filter((o) => !!o && typeof o.text === 'string' && !!o.text.trim())
      .slice(0, 4)
      .map((o, i) => ({ letter: letters[i], text: String(o.text).trim().slice(0, 160) }))
    if (options.length !== 4) return null
    const answer = String(p.answer ?? '').trim().toUpperCase()
    if (!(letters as readonly string[]).includes(answer)) return null
    if (typeof p.stem !== 'string' || !p.stem.trim()) return null
    return {
      topic: (typeof p.topic === 'string' && p.topic.trim() ? p.topic.trim() : '概念').slice(0, 12),
      stem: p.stem.trim().slice(0, 400),
      options,
      answer: answer as (typeof letters)[number],
      analysis: (typeof p.analysis === 'string' && p.analysis.trim() ? p.analysis.trim() : '答错后可在错题本里复盘。').slice(0, 200),
    }
  } catch {
    return null
  }
}

// ── 三池取材(只负责挑出「这一席用哪份材料」,不生成)────────────────

interface WrongNoteCandidate {
  noteId: string
  content: string
  analysis: string | null
  topic: string | null
  subject: string | null
}

/** 错题本池:7 天冷却外的卡按权重抽一张;权重 w=(1−mastery)+0.5·lapses,到期卡 ×2 */
async function pickWrongNote(userId: string, excludeNoteIds: string[]): Promise<WrongNoteCandidate | null> {
  const rows = await prisma.studyNote.findMany({
    where: { userId, id: { notIn: excludeNoteIds } },
    select: {
      id: true, content: true, analysis: true, topic: true, subject: true,
      mastery: true, lapses: true, dueAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  })
  if (!rows.length) return null
  const now = Date.now()
  const weights = rows.map((r) => Math.max((1 - (r.mastery ?? 0)) + 0.5 * (r.lapses ?? 0) + (r.dueAt && r.dueAt.getTime() <= now ? 2 : 0), 0.05))
  const total = weights.reduce((s, w) => s + w, 0)
  let roll = Math.random() * total
  let idx = rows.length - 1
  for (let i = 0; i < rows.length; i++) {
    roll -= weights[i]
    if (roll <= 0) {
      idx = i
      break
    }
  }
  const r = rows[idx]
  return { noteId: r.id, content: r.content, analysis: r.analysis, topic: r.topic, subject: r.subject }
}

/** 课本池:随机抽一节 textbook 章节正文做材料 */
async function pickTextbookChunk(userId: string, excludeChunkIds: string[]) {
  const chunks = await prisma.knowledgeChunk.findMany({
    where: {
      userId,
      doc: { kind: 'textbook' },
      id: { notIn: excludeChunkIds },
    },
    select: { id: true, content: true, heading: true, section: true, chapter: true, doc: { select: { title: true } } },
    take: 400,
  })
  if (!chunks.length) return null
  const c = pool(chunks)
  // 展示用出处:书名·章·节 (+截短标题),避免 heading 长文整段拼进徽标
  const parts = [c.doc.title, c.chapter, c.section].filter((x): x is string => !!x)
  const head = (c.heading || '').slice(0, 12)
  if (head && !parts.some((p) => p.includes(head))) parts.push(head)
  return { chunkId: c.id, content: c.content, sourceRef: parts.join('·').slice(0, 40) }
}

/** 事件池:未过期 ScratchNote 优先,退路取近 3 天学习事件文本 */
async function pickScratch(userId: string, excludeTopics: string[]) {
  const notes = await prisma.scratchNote.findMany({
    where: { userId, expiresAt: { gt: new Date() }, topic: { notIn: excludeTopics } },
    orderBy: { updatedAt: 'desc' },
    take: 20,
  })
  if (notes.length) {
    const n = pool(notes)
    return { topic: n.topic, content: n.content, fromEvent: false }
  }
  const since = new Date(Date.now() - 3 * 24 * 3600 * 1000)
  const events = await prisma.studyEvent.findMany({
    where: { userId, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })
  if (!events.length) return null
  const e = pool(events)
  return { topic: `最近学习`, content: e.text, fromEvent: true }
}

// ── 组装入口 ─────────────────────────────────────────────────────

export interface AssembledQuiz {
  items: SurpriseItem[]
  /** 各池是否有料的快照(前端空态文案用) */
  missing: SurpriseSource[]
}

/** 7 天冷却清单:近期 attempt.items 里出现过的 sourceNoteId / sourceChunkId / 便签 topic */
async function cooldownKeys(userId: string): Promise<{ noteIds: string[]; chunkIds: string[]; topics: string[] }> {
  const since = new Date(Date.now() - COOLDOWN_DAYS * 24 * 3600 * 1000)
  const attempts = await prisma.surpriseQuizAttempt.findMany({
    where: { userId, createdAt: { gte: since }, escaped: false },
    select: { items: true },
    take: 60,
  })
  const noteIds: string[] = []
  const chunkIds: string[] = []
  const topics: string[] = []
  for (const a of attempts) {
    const arr = Array.isArray(a.items) ? (a.items as Record<string, unknown>[]) : []
    for (const it of arr) {
      if (typeof it.sourceNoteId === 'string') noteIds.push(it.sourceNoteId)
      if (typeof it.sourceChunkId === 'string') chunkIds.push(it.sourceChunkId)
      if (it.source === 'scratch' && typeof it.topic === 'string') topics.push(it.topic)
    }
  }
  return { noteIds, chunkIds, topics }
}

/** 一席的生成器:材料固定,生成失败返回 null */
type SlotMaker = (model: LanguageModel) => Promise<SurpriseItem | null>

function wrongNoteMaker(cand: WrongNoteCandidate): SlotMaker {
  return async (model) => {
    const gen = await genConceptItem(model, [
      `这是一道学生之前做错的高中题(考点:${cand.topic ?? '未知'},学科:${cand.subject ?? '未知'}):`,
      cand.content.slice(0, 1200),
      cand.analysis ? `\n当时的讲解:${cand.analysis.slice(0, 500)}` : '',
      '\n请围绕它当初考的概念出一道概念辨析题(换一个问法,不要原题照搬)。',
    ].join('\n'))
    return gen ? { source: 'wrong_note', ...gen, sourceNoteId: cand.noteId } : null
  }
}

/**
 * 组一套突击测验。任何一池取材或生成失败都顺延给下一池;
 * 三池全空 / 无可用模型时返回空 items + missing 快照。
 */
export async function assembleSurpriseQuiz(userId: string): Promise<AssembledQuiz> {
  const model = await resolveStudyModel(userId)
  const missing: SurpriseSource[] = []
  if (!model) return { items: [], missing: [...PRIORITY] }

  const cd = await cooldownKeys(userId)
  const wrongCand = await pickWrongNote(userId, cd.noteIds)
  const chunkCand = await pickTextbookChunk(userId, cd.chunkIds)
  const scratchCand = await pickScratch(userId, cd.topics)
  if (!wrongCand) missing.push('wrong_note')
  if (!chunkCand) missing.push('textbook')
  if (!scratchCand) missing.push('scratch')
  if (!wrongCand && !chunkCand && !scratchCand) return { items: [], missing }

  // 有料池各建一席
  const makers = new Map<SurpriseSource, SlotMaker>()
  if (wrongCand) makers.set('wrong_note', wrongNoteMaker(wrongCand))
  if (chunkCand) {
    makers.set('textbook', async (model) => {
      const gen = await genConceptItem(model, `课本原文(出处:${chunkCand.sourceRef}):\n${chunkCand.content.slice(0, 1500)}\n\n请基于这段原文出一道概念理解题。`)
      return gen ? { source: 'textbook', ...gen, sourceRef: chunkCand.sourceRef, sourceChunkId: chunkCand.chunkId } : null
    })
  }
  if (scratchCand) {
    const srcRef = scratchCand.fromEvent ? '学习记录' : `便签·${scratchCand.topic}`
    makers.set('scratch', async (model) => {
      const gen = await genConceptItem(model, [
        `学生最近记录了一条学习动态,主题「${scratchCand.topic}」,内容:${scratchCand.content.slice(0, 400)}`,
        `\n请围绕主题「${scratchCand.topic}」出 1 道最基础的概念题(定义/常识/公式记忆级别即可,不必拘泥于动态原文)。`,
      ].join('\n'))
      return gen ? { source: 'scratch', ...gen, sourceRef: srcRef } : null
    })
  }

  // 席位序列:有料池各 1 席 → 空席按顺延优先级补给仍有料的池(同池上限 2)
  const plan: SurpriseSource[] = Array.from(makers.keys())
  const counts: Record<SurpriseSource, number> = { wrong_note: 0, textbook: 0, scratch: 0 }
  for (const s of plan) counts[s]++
  while (plan.length < QUIZ_TOTAL) {
    const next = PRIORITY.find((s) => makers.has(s) && counts[s] < PER_POOL_CAP)
    if (!next) break
    plan.push(next)
    counts[next]++
  }

  // 逐席生成;同源第二席(顺延来的)重挑材料,避免同卡一卷两题
  const items: SurpriseItem[] = []
  const usedNoteIds = new Set<string>()
  for (const source of plan) {
    if (items.length >= QUIZ_TOTAL) break
    let maker = makers.get(source)!
    if (source === 'wrong_note' && usedNoteIds.size > 0) {
      const fresh = await pickWrongNote(userId, [...cd.noteIds, ...Array.from(usedNoteIds)])
      if (fresh) maker = wrongNoteMaker(fresh)
    }
    const item = await maker(model)
    if (item?.sourceNoteId) usedNoteIds.add(item.sourceNoteId)
    if (item) items.push(item)
  }
  if (items.length < QUIZ_TOTAL && wrongCand && !items.some((i) => i.source === 'wrong_note')) {
    const exclude = [...cd.noteIds, wrongCand.noteId]
    const retry = await pickWrongNote(userId, exclude)
    if (retry) {
      const item = await wrongNoteMaker(retry)(model)
      if (item) items.push(item)
    }
  }

  return { items: items.slice(0, QUIZ_TOTAL), missing }
}
