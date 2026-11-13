/**
 * 智能拟卷——真题重组卷引擎（server-only，依赖 prisma）。
 *
 * 组卷口径（2026-11-11 与用户定案）：
 * - 同位换题：以一套「有官方答案」的卷为底，逐槽从其他有答案卷的同桶(section/kind/score)
 *   选题替换；候选池永远只含有官方答案(answer != null)且未 flagged 的题——零幻觉，产出的
 *   卷每题都带官方答案，答案页随槽位自动跟随。
 * - 卷面自洽：总分/题量/大题说明/题号全部由槽位实时重算，不写死（删一题卷头就少 3 分）。
 * - 三道错误防线：①结构自检(答案编号对位/选项字母范围/分值>0)不过的题不进池；
 *   ②用户「这题有误」→ PaperQuestion.flagged=true 全局拉黑；③修复走 PaperPage 原件，
 *   不走 AI（本文件不做任何内容改写）。
 * - 与 Paper 真题库严格分表：重组卷不进考频统计、不算试卷清单。
 */
import { prisma } from '@/lib/db'
import { Prisma } from '@/generated/prisma/client'
import { generateTextbookQuestions, generateVariantQuestions, topicTokens } from '@/lib/ai/paper-question-generator'

/** 学科中文标签（卷面标题用；与 Note 学科枚举对齐） */
const SUBJECT_LABELS: Record<string, string> = {
  math: '数学', chinese: '语文', english: '英语', physics: '物理', chemistry: '化学',
  biology: '生物', history: '历史', geography: '地理', politics: '政治', other: '综合',
}

export function subjectLabel(subject: string): string {
  return SUBJECT_LABELS[subject] ?? subject
}

// ===================== 结构自检（第一道防线） =====================

/**
 * 结构自检：只查「自洽性」，不判内容对错。返回问题代码数组（空数组=通过）。
 * - score：分值非正
 * - options：选择题选项不足 2 个
 * - alignment：答案以「N.」编号开头但 N ≠ 题号（录入错位的确定性特征）
 * - letter：选择题答案首字母超出该题选项范围
 * 宽容原则：answer 缺编号前缀时跳过对位检查（老格式兼容），宁可漏报不误报。
 */
export function getIntegrityIssues(q: {
  kind: string
  score: number
  options: string[]
  answer: string | null
  number?: number
}): string[] {
  const issues: string[] = []
  if (!q.answer) return issues
  if (!(q.score > 0)) issues.push('score')
  if (q.kind === 'choice' && q.options.length < 2) issues.push('options')

  const ans = q.answer.trim()
  const numMatch = /^(\d+)\s*[.、．]/.exec(ans)
  if (numMatch && q.number && Number(numMatch[1]) !== q.number) issues.push('alignment')

  if (q.kind === 'choice') {
    const stripped = numMatch ? ans.slice(numMatch[0].length) : ans
    const letterMatch = /^\s*[.、．:：]?\s*([A-Z])\b/.exec(stripped)
    if (letterMatch) {
      const idx = letterMatch[1].charCodeAt(0) - 65
      if (idx >= q.options.length) issues.push('letter')
    }
  }
  return issues
}

// ===================== 候选池 =====================

/** 池内题（自检通过后），paper 元数据随行（溯源/分组用） */
interface PoolItem {
  id: string
  number: number
  section: string | null
  kind: string
  score: number
  stem: string
  options: string[]
  answer: string
  answerSource: string
  paperSlug: string
  paperTitle: string
}

/** 加载候选池：有答案 + 未 flagged + 结构自检通过，按学科过滤。
 *  allowAi=false 只取官方答案（answerSource=official）；true 放行 AI 参考答案题 */
async function loadPool(userId: string, subject: string, allowAi = false): Promise<PoolItem[]> {
  const rows = await prisma.paperQuestion.findMany({
    where: {
      userId,
      answer: { not: null },
      flagged: false,
      ...(allowAi ? {} : { answerSource: 'official' }),
      paper: { subject },
    },
    select: {
      id: true, number: true, section: true, kind: true, score: true,
      stem: true, options: true, answer: true, answerSource: true,
      paper: { select: { slug: true, title: true } },
    },
    orderBy: [{ paperId: 'asc' }, { number: 'asc' }],
  })
  return rows
    .filter((r) => r.answer !== null)
    .filter((r) => getIntegrityIssues(r).length === 0)
    .map((r) => ({
      id: r.id, number: r.number, section: r.section, kind: r.kind, score: r.score,
      stem: r.stem, options: r.options, answer: r.answer as string,
      answerSource: r.answerSource,
      paperSlug: r.paper.slug, paperTitle: r.paper.title,
    }))
}

/** 桶键：同桶 = 同大题、同题型、同分值（学考卷跨卷同构的前提） */
const bucketOf = (q: { section: string | null; kind: string; score: number }) =>
  `${q.section ?? ''}|${q.kind}|${q.score}`
/** 兜底桶：section 文案跨卷有出入时退到 题型+分值 */
const fallbackBucketOf = (q: { kind: string; score: number }) => `${q.kind}|${q.score}`

const randOf = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]

// ===================== 针对我复习(考点匹配) =====================
// topicTokens/相关度:token 化函数在 paper-question-generator(与课本检索共用滑窗口径)
/** 考点相关度:题干+选项里命中的考点词数 */
function relevanceOf(q: PoolItem, tokens: string[]): number {
  const hay = `${q.stem}\n${q.options.join('\n')}`
  let n = 0
  for (const t of tokens) if (hay.includes(t)) n++
  return n
}

// ===================== 组卷 =====================

export interface ComposeInput {
  subject: string
  baseSlug?: string
  onlyChoice?: boolean
  /** 放行 AI 参考答案题(answerSource=ai)入池;缺省 false=纯官方池。落库到卷上,槽位操作沿用 */
  allowAiAnswers?: boolean
  /** 大纲组卷模式:结构来自用户大纲的槽位定义,不再依赖底卷 */
  slotDefs?: OutlineSlotDef[]
  /** 自定义卷名(大纲模式生效;不传自动命名) */
  title?: string
  /** 针对我复习:按这些考点词匹配真题填充(题干/选项关键词命中打分,优先命中题;命中不足如实缺口,不用无关题凑)。与 slotDefs 同传=模板结构+针对我内容 */
  focusTopics?: string[]
  /** 针对我复习(无 slotDefs 时):每个考点取几道,默认 2 */
  perTopic?: number
  /** 针对我复习:考点题之外,卷尾「巩固练习」再随机抽几道未用过的题(0=不补;默认 0) */
  extraRandom?: number
  /** 针对我复习:真题不够时用课本/AI 变式补齐的配比(不传=不补,如实缺口) */
  fillInline?: { textbook?: number; aiVariant?: number }
  /** 内联题生成用的模型(表单传默认公共池模型) */
  modelId?: string
}

export interface OutlineSlotDef {
  /** 大题名,如「一、选择题」;不传按题型命名 */
  section?: string
  kind: 'choice' | 'answer'
  score: number
  count: number
}

export interface ComposeResult {
  ok: boolean
  reason?: 'no_pool' | 'no_base' | 'bad_outline'
  composedId?: string
  title?: string
  /** 大纲模式:某桶池不够,有多少放多少,缺口如实带出(工具层转告用户) */
  shortages?: Array<{ kind: string; score: number; requested: number; filled: number }>
  /** 针对我复习:真题不够时用内联题补齐的数量(卷面按来源标注) */
  filledInline?: { textbook: number; aiVariant: number }
}

/**
 * 大纲组卷:结构来自用户大纲的槽位定义,真题池逐桶填充——仍只用有官方答案且未拉黑的题,
 * 零拟题。桶不够有多少放多少,缺口如实带出(shortages)。
 * baseSlug 置空:无底卷,整卷重摇不可用(卷面页对大纲卷隐藏重摇按钮)。
 */
async function composeFromOutline(
  userId: string,
  subject: string,
  slotDefs: OutlineSlotDef[],
  title?: string,
  allowAi = false,
  focusTopics?: string[]
): Promise<ComposeResult> {
  const defs = slotDefs
    .filter((d) => d.count > 0 && d.score > 0 && (d.kind === 'choice' || d.kind === 'answer'))
    .slice(0, 12)
  if (!defs.length) return { ok: false, reason: 'bad_outline' }

  const pool = await loadPool(userId, subject, allowAi)
  if (!pool.length) return { ok: false, reason: 'no_pool' }

  const tokens = focusTopics?.length ? topicTokens(focusTopics) : null
  const used = new Set<string>()
  const slots: Array<{ section: string | null; kind: string; score: number; paperQuestionId: string | null; historyIds: string[]; inlineStem?: string; inlineOptions?: string[]; inlineAnswer?: string; source?: string; sourceRef?: string }> = []
  const shortages: NonNullable<ComposeResult['shortages']> = []
  for (const def of defs) {
    const section = def.section?.trim() || null
    // 桶 = 题型+分值(大纲的大题名是用户自定义标签,不参与抽题)
    const bucket = pool.filter((q) => q.kind === def.kind && q.score === def.score && !used.has(q.id))
    let picks: PoolItem[]
    if (tokens) {
      // 针对我模式:桶内按考点相关度取;命中不足不再拿无关题凑 → 如实缺口
      picks = bucket
        .map((q) => ({ q, r: relevanceOf(q, tokens) }))
        .filter((x) => x.r > 0)
        .sort((a, b) => b.r - a.r)
        .slice(0, def.count)
        .map((x) => x.q)
    } else {
      picks = []
      for (let n = 0; n < def.count && bucket.length > 0; n++) {
        const idx = Math.floor(Math.random() * bucket.length)
        const [pick] = bucket.splice(idx, 1)
        picks.push(pick)
      }
    }
    let filled = 0
    for (const pick of picks) {
      used.add(pick.id)
      slots.push({ section, kind: def.kind, score: def.score, paperQuestionId: pick.id, historyIds: [pick.id] })
      filled++
    }
    if (filled < def.count) shortages.push({ kind: def.kind, score: def.score, requested: def.count, filled })
  }
  if (!slots.length) return { ok: false, reason: 'no_pool' }

  const totalScore = slots.reduce((acc, s) => acc + s.score, 0)
  const finalTitle = title?.trim() || `${subjectLabel(subject)}大纲卷 ${new Date().getMonth() + 1}-${new Date().getDate()}`

  const composed = await prisma.composedPaper.create({
    data: {
      userId, title: finalTitle, subject, baseSlug: '',
      allowAiAnswers: allowAi,
      onlyChoice: false,
      totalScore, durationMin: 0,
      slots: { create: slots.map((s, i) => ({ ...s, position: i })) },
    },
    select: { id: true },
  })
  return { ok: true, composedId: composed.id, title, shortages: shortages.length ? shortages : undefined }
}

/**
 * 针对我复习:按用户薄弱考点逐个从真题池匹配(考点词在题干/选项的命中打分),
 * 每考点一组(大题名 = 考点名),每考点取 perTopic 道。命中不足有多少放多少,
 * 缺口如实带出(shortages.kind = 考点名,score 置 0 表示按考点计);全无命中 → 只建命中题。
 * 与 slotDefs 同传时(模板+针对我):结构走模板,填充在 composeFromOutline 内按考点择优。
 */
async function composeForReview(
  userId: string,
  subject: string,
  focusTopics: string[],
  perTopic: number,
  title?: string,
  allowAi = false,
  extraRandom = 0,
  fillInline?: { textbook?: number; aiVariant?: number },
  modelId?: string
): Promise<ComposeResult> {
  const topics = focusTopics.map((t) => t.trim()).filter(Boolean).slice(0, 8)
  if (!topics.length) return { ok: false, reason: 'bad_outline' }
  const per = Math.min(10, Math.max(1, Math.round(perTopic) || 2))

  const pool = await loadPool(userId, subject, allowAi)
  if (!pool.length) return { ok: false, reason: 'no_pool' }

  const used = new Set<string>()
  const slots: Array<{ section: string | null; kind: string; score: number; paperQuestionId: string | null; historyIds: string[]; inlineStem?: string; inlineOptions?: string[]; inlineAnswer?: string; source?: string; sourceRef?: string }> = []
  const shortages: NonNullable<ComposeResult['shortages']> = []
  for (const topic of topics) {
    const tokens = topicTokens([topic])
    const matched = pool
      .filter((q) => !used.has(q.id))
      .map((q) => ({ q, r: relevanceOf(q, tokens) }))
      .filter((x) => x.r > 0)
      .sort((a, b) => b.r - a.r)
      .slice(0, per)
    for (const { q } of matched) {
      used.add(q.id)
      slots.push({ section: topic, kind: q.kind, score: q.score, paperQuestionId: q.id, historyIds: [q.id] })
    }
    if (matched.length < per) shortages.push({ kind: topic, score: 0, requested: per, filled: matched.length })
  }
  // 真题不够 → 按配比用课本/AI 变式内联题补齐(生成失败降级为缺口,绝不编题)
  const filledInline = { textbook: 0, aiVariant: 0 }
  const budget = fillInline && modelId ? { textbook: fillInline.textbook ?? 0, aiVariant: fillInline.aiVariant ?? 0, modelId } : null
  if (budget && (budget.textbook > 0 || budget.aiVariant > 0)) {
    for (const sh of shortages) {
      const need = sh.requested - sh.filled
      if (need <= 0) continue
      let tb = 0
      if (budget.textbook > 0) {
        const n = Math.min(need, budget.textbook - filledInline.textbook)
        if (n > 0) {
          try {
            const qs = await generateTextbookQuestions({ userId, subject, topic: sh.kind, count: n, modelId: budget.modelId })
            for (const q of qs) {
              slots.push({ section: sh.kind, kind: q.kind, score: q.score, paperQuestionId: null, historyIds: [], inlineStem: q.stem, inlineOptions: q.options, inlineAnswer: q.answer, source: q.source, sourceRef: q.sourceRef })
              filledInline.textbook++
              tb++
            }
          } catch (err) {
            console.error('[compose] textbook fill failed:', err instanceof Error ? err.message : err)
          }
        }
      }
      const remain = need - tb
      if (remain > 0 && budget.aiVariant > 0) {
        const n = Math.min(remain, budget.aiVariant - filledInline.aiVariant)
        if (n > 0) {
          try {
            const qs = await generateVariantQuestions({ userId, subject, topic: sh.kind, count: n, modelId: budget.modelId })
            for (const q of qs) {
              slots.push({ section: sh.kind, kind: q.kind, score: q.score, paperQuestionId: null, historyIds: [], inlineStem: q.stem, inlineOptions: q.options, inlineAnswer: q.answer, source: q.source, sourceRef: q.sourceRef })
              filledInline.aiVariant++
            }
          } catch (err) {
            console.error('[compose] ai-variant fill failed:', err instanceof Error ? err.message : err)
          }
        }
      }
      sh.filled = sh.filled + tb + (filledInline.aiVariant > 0 ? 0 : 0)
    }
  }
  // 卷尾随机巩固节:从未用题里随机抽,穿插间隔学习用
  const extra = Math.min(20, Math.max(0, Math.round(extraRandom) || 0))
  if (extra > 0) {
    const rest = pool.filter((q) => !used.has(q.id))
    for (let n = 0; n < extra && rest.length > 0; n++) {
      const idx = Math.floor(Math.random() * rest.length)
      const [pick] = rest.splice(idx, 1)
      used.add(pick.id)
      slots.push({ section: '巩固练习', kind: pick.kind, score: pick.score, paperQuestionId: pick.id, historyIds: [pick.id] })
    }
  }
  if (!slots.length) return { ok: false, reason: 'no_pool' }

  const totalScore = slots.reduce((acc, s) => acc + s.score, 0)
  const finalTitle = title?.trim() || `${subjectLabel(subject)}薄弱点复习卷 ${new Date().getMonth() + 1}-${new Date().getDate()}`

  const composed = await prisma.composedPaper.create({
    data: {
      userId, title: finalTitle, subject, baseSlug: '',
      allowAiAnswers: allowAi,
      onlyChoice: false,
      totalScore, durationMin: 0,
      slots: { create: slots.map((s, i) => ({ ...s, position: i })) },
    },
    select: { id: true },
  })
  return { ok: true, composedId: composed.id, title: finalTitle, shortages: shortages.length ? shortages : undefined, filledInline }
}

/**
 * 组卷：底卷（默认该科池内题最多的最新卷）逐槽同桶换题。
 * 每槽选题优先级：异卷同桶 > 同卷异题 > 保留底卷原题（池薄时优雅退化）。
 */
export async function composePaper(userId: string, input: ComposeInput): Promise<ComposeResult> {
  // 传了 slotDefs(即使过滤后为空)即大纲模式:空/无效定义走 bad_outline,绝不静默回退底卷模式
  if (input.slotDefs) return composeFromOutline(userId, input.subject, input.slotDefs, input.title, !!input.allowAiAnswers, input.focusTopics)
  // 针对我复习(无结构):按薄弱考点逐组匹配,大题名 = 考点名;extraRandom>0 时卷尾补随机巩固节
  if (input.focusTopics?.length)
    return composeForReview(userId, input.subject, input.focusTopics, input.perTopic ?? 2, input.title, !!input.allowAiAnswers, input.extraRandom ?? 0, input.fillInline, input.modelId)
  const pool = await loadPool(userId, input.subject, !!input.allowAiAnswers)
  if (!pool.length) return { ok: false, reason: 'no_pool' }

  // 底卷：池内题数最多（并列取最新）的卷
  const byPaper = new Map<string, { title: string; count: number; createdAt: Date }>()
  const slugCreatedAt = await prisma.paper.findMany({
    where: { userId, subject: input.subject },
    select: { slug: true, createdAt: true },
  })
  const createdAtOf = new Map(slugCreatedAt.map((p) => [p.slug, p.createdAt]))
  for (const q of pool) {
    const cur = byPaper.get(q.paperSlug)
    if (cur) cur.count++
    else byPaper.set(q.paperSlug, { title: q.paperTitle, count: 1, createdAt: createdAtOf.get(q.paperSlug) ?? new Date(0) })
  }
  const baseSlug =
    input.baseSlug && byPaper.has(input.baseSlug)
      ? input.baseSlug
      : Array.from(byPaper.entries()).sort((a, b) => b[1].count - a[1].count || b[1].createdAt.getTime() - a[1].createdAt.getTime())[0][0]
  if (!byPaper.has(baseSlug)) return { ok: false, reason: 'no_base' }

  const baseDuration = (await prisma.paper.findFirst({
    where: { userId, slug: baseSlug },
    select: { durationMin: true },
  }))?.durationMin ?? 0

  const slots = await buildSlots(pool, baseSlug, !!input.onlyChoice)
  if (!slots.length) return { ok: false, reason: 'no_pool' }

  const totalScore = slots.reduce((acc, s) => acc + s.score, 0)
  const title = `${subjectLabel(input.subject)}重组卷 ${new Date().getMonth() + 1}-${new Date().getDate()}`

  const composed = await prisma.composedPaper.create({
    data: {
      userId, title, subject: input.subject, baseSlug,
      onlyChoice: !!input.onlyChoice,
      allowAiAnswers: !!input.allowAiAnswers,
      totalScore, durationMin: baseDuration,
      slots: { create: slots.map((s, i) => ({ ...s, position: i })) },
    },
    select: { id: true },
  })
  return { ok: true, composedId: composed.id, title }
}

/** 逐槽同桶换题的核心（composePaper 与 reshuffle 共用） */
async function buildSlots(pool: PoolItem[], baseSlug: string, onlyChoice: boolean) {
  const base = pool.filter((q) => q.paperSlug === baseSlug && (!onlyChoice || q.kind === 'choice'))
  base.sort((a, b) => a.number - b.number)

  const used = new Set<string>()
  const out: Array<{ section: string | null; kind: string; score: number; paperQuestionId: string; historyIds: string[] }> = []
  for (const slotDef of base) {
    const usedArr = Array.from(used)
    // 同桶候选：排除本卷已用；优先异卷来源
    const bucket = pool.filter(
      (q) => bucketOf(q) === bucketOf(slotDef) && !usedArr.includes(q.id)
    )
    const foreign = bucket.filter((q) => q.paperSlug !== baseSlug)
    const sameDiff = bucket.filter((q) => q.paperSlug === baseSlug && q.id !== slotDef.id)
    const pick = foreign.length ? randOf(foreign) : sameDiff.length ? randOf(sameDiff) : slotDef
    used.add(pick.id)
    out.push({
      section: pick.section, kind: pick.kind, score: pick.score,
      paperQuestionId: pick.id, historyIds: [pick.id],
    })
  }
  return out
}

// ===================== 槽位操作（换/删/加/报错/重摇/改名） =====================

async function loadOwnedPaper(userId: string, composedId: string) {
  return prisma.composedPaper.findFirst({
    where: { id: composedId, userId },
    include: { slots: { orderBy: { position: 'asc' }, include: { paperQuestion: { select: { id: true } } } } },
  })
}

/** 事务内整体重排 position（0..n-1），并重算总分写回 */
async function renumberAndSync(composedId: string, orderedIds: string[]) {
  await prisma.$transaction(async (tx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await tx.composedSlot.update({ where: { id: orderedIds[i] }, data: { position: i } })
    }
    const agg = await tx.composedSlot.aggregate({ where: { composedPaperId: composedId }, _sum: { score: true } })
    await tx.composedPaper.update({
      where: { id: composedId },
      data: { totalScore: agg._sum.score ?? 0 },
    })
  })
}

/** 拖拽排序:orderedIds 必须是现有槽位的完整排列(逐字对位),仅重排 position */
export async function reorderSlots(userId: string, composedId: string, orderedIds: string[]) {
  const paper = await loadOwnedPaper(userId, composedId)
  if (!paper) return { ok: false as const, reason: 'not_found' }
  const existing = paper.slots.map((s) => s.id)
  const valid =
    orderedIds.length === existing.length &&
    new Set(orderedIds).size === orderedIds.length &&
    [...orderedIds].sort().join('|') === [...existing].sort().join('|')
  if (!valid) return { ok: false as const, reason: 'bad_order' }
  await renumberAndSync(composedId, orderedIds)
  return { ok: true as const }
}

/** 换一题：同桶重摇，排除全卷已用 + 本槽 historyIds（防连点循环） */
export async function replaceSlot(userId: string, composedId: string, slotId: string) {
  const paper = await loadOwnedPaper(userId, composedId)
  if (!paper) return { ok: false as const, reason: 'not_found' }
  const slot = paper.slots.find((s) => s.id === slotId)
  if (!slot) return { ok: false as const, reason: 'slot_not_found' }

  const pool = await loadPool(userId, paper.subject, paper.allowAiAnswers)
  const currentIds = paper.slots.map((s) => s.paperQuestion?.id).filter((x): x is string => !!x)
  const def = { section: slot.section, kind: slot.kind, score: slot.score }

  const pickFrom = (cands: PoolItem[]) => {
    const usable = cands.filter((q) => !currentIds.includes(q.id) && !slot.historyIds.includes(q.id))
    return usable.length ? randOf(usable) : null
  }
  const picked =
    pickFrom(pool.filter((q) => bucketOf(q) === bucketOf(def))) ??
    pickFrom(pool.filter((q) => fallbackBucketOf(q) === fallbackBucketOf(def)))
  if (!picked) return { ok: false as const, reason: 'no_candidate' }

  await prisma.composedSlot.update({
    where: { id: slot.id },
    data: {
      paperQuestionId: picked.id,
      section: picked.section,
      kind: picked.kind,
      score: picked.score,
      historyIds: [...slot.historyIds, picked.id].slice(-50),
    },
  })
  return { ok: true as const, pickedId: picked.id }
}

/** 移除一题：删槽 + 整体重排 + 重算总分 */
export async function removeSlot(userId: string, composedId: string, slotId: string) {
  const paper = await loadOwnedPaper(userId, composedId)
  if (!paper) return { ok: false as const, reason: 'not_found' }
  const slot = paper.slots.find((s) => s.id === slotId)
  if (!slot) return { ok: false as const, reason: 'slot_not_found' }

  await prisma.composedSlot.delete({ where: { id: slot.id } })
  const rest = paper.slots.filter((s) => s.id !== slotId).map((s) => s.id)
  await renumberAndSync(composedId, rest)
  return { ok: true as const }
}

/**
 * 报错拉黑：PaperQuestion.flagged=true（全局退池）+ 本卷移除该槽。
 * 原卷数据永不动；修复对照原件后手动解标记。
 */
export async function flagSlot(userId: string, composedId: string, slotId: string) {
  const paper = await loadOwnedPaper(userId, composedId)
  if (!paper) return { ok: false as const, reason: 'not_found' }
  const slot = paper.slots.find((s) => s.id === slotId)
  if (!slot) return { ok: false as const, reason: 'slot_not_found' }
  if (slot.paperQuestionId) {
    await prisma.paperQuestion.update({ where: { id: slot.paperQuestionId }, data: { flagged: true } })
  }
  return removeSlot(userId, composedId, slotId)
}

/** 加一题：校验该题在池内（有答案/未拉黑/自检过）。默认插到大题组末尾；
 *  传 afterSlotId = 中途加题,插到该槽正后方（大纲卷无大题头时的唯一加题入口） */
export async function insertSlot(userId: string, composedId: string, paperQuestionId: string, afterSlotId?: string) {
  const paper = await loadOwnedPaper(userId, composedId)
  if (!paper) return { ok: false as const, reason: 'not_found' }

  const q = await prisma.paperQuestion.findFirst({
    where: {
      id: paperQuestionId, userId, answer: { not: null }, flagged: false,
      ...(paper.allowAiAnswers ? {} : { answerSource: 'official' }),
      paper: { subject: paper.subject },
    },
    select: { id: true, section: true, kind: true, score: true, options: true, answer: true, number: true },
  })
  if (!q || getIntegrityIssues(q).length) return { ok: false as const, reason: 'not_in_pool' }

  const slots = paper.slots
  let insertAt: number
  let section: string | null = q.section
  if (afterSlotId) {
    const idx = slots.findIndex((s) => s.id === afterSlotId)
    if (idx < 0) return { ok: false as const, reason: 'slot_not_found' }
    insertAt = idx + 1
    // 中途加题继承锚点槽的大题名:不把源卷大题名带进大纲卷/不搅乱现有分组
    section = slots[idx].section
  } else {
    // 默认插到同 section 组末尾；该 section 不在卷里则追加到整卷末尾
    insertAt = slots.length
    for (let i = slots.length - 1; i >= 0; i--) {
      if (slots[i].section === q.section) { insertAt = i + 1; break }
      if (slots[i].section === null) break
    }
  }
  // 先落位到队尾之外避免 position 撞键，再按显式顺序整体重排
  const created = await prisma.composedSlot.create({
    data: {
      composedPaperId: composedId, position: slots.length + 1000,
      section, kind: q.kind, score: q.score,
      paperQuestionId: q.id, historyIds: [q.id],
    },
    select: { id: true },
  })
  const ordered = [
    ...slots.slice(0, insertAt).map((s) => s.id),
    created.id,
    ...slots.slice(insertAt).map((s) => s.id),
  ]
  await renumberAndSync(composedId, ordered)
  return { ok: true as const, slotId: created.id }
}

/** 整卷重摇：按组卷参数（底卷/onlyChoice）整体重建槽位 */
export async function reshufflePaper(userId: string, composedId: string) {
  const paper = await loadOwnedPaper(userId, composedId)
  if (!paper) return { ok: false as const, reason: 'not_found' }
  const pool = await loadPool(userId, paper.subject, paper.allowAiAnswers)
  if (!pool.length) return { ok: false as const, reason: 'no_pool' }
  const slots = await buildSlots(pool, paper.baseSlug, paper.onlyChoice)
  if (!slots.length) return { ok: false as const, reason: 'no_pool' }

  await prisma.$transaction([
    prisma.composedSlot.deleteMany({ where: { composedPaperId: composedId } }),
    prisma.composedPaper.update({ where: { id: composedId }, data: { updatedAt: new Date() } }),
    ...slots.map((s, i) =>
      prisma.composedSlot.create({ data: { composedPaperId: composedId, position: i, ...s } })
    ),
  ])
  const agg = await prisma.composedSlot.aggregate({ where: { composedPaperId: composedId }, _sum: { score: true } })
  await prisma.composedPaper.update({ where: { id: composedId }, data: { totalScore: agg._sum.score ?? 0 } })
  return { ok: true as const }
}

/** 改卷名 */
export async function retitlePaper(userId: string, composedId: string, title: string) {
  const clean = title.trim().slice(0, 60)
  if (!clean) return { ok: false as const, reason: 'empty_title' }
  const row = await prisma.composedPaper.findFirst({ where: { id: composedId, userId }, select: { id: true } })
  if (!row) return { ok: false as const, reason: 'not_found' }
  await prisma.composedPaper.update({ where: { id: composedId }, data: { title: clean } })
  return { ok: true as const }
}

/** 改某题分值（1..30），重算总分。题目本身不动 */
export async function updateSlotScore(userId: string, composedId: string, slotId: string, score: number) {
  if (!Number.isInteger(score) || score < 1 || score > 30) return { ok: false as const, reason: 'bad_score' }
  const paper = await loadOwnedPaper(userId, composedId)
  if (!paper) return { ok: false as const, reason: 'not_found' }
  const slot = paper.slots.find((s) => s.id === slotId)
  if (!slot) return { ok: false as const, reason: 'slot_not_found' }
  if (slot.score === score) return { ok: true as const }
  await prisma.composedSlot.update({ where: { id: slot.id }, data: { score } })
  const agg = await prisma.composedSlot.aggregate({ where: { composedPaperId: composedId }, _sum: { score: true } })
  await prisma.composedPaper.update({ where: { id: composedId }, data: { totalScore: agg._sum.score ?? 0 } })
  return { ok: true as const, oldScore: slot.score }
}

/** 移动某题到卷面第 toNumber 题的位置（1-based；移动后题号 = 顺序号自动重排） */
export async function moveSlot(userId: string, composedId: string, slotId: string, toNumber: number) {
  const paper = await loadOwnedPaper(userId, composedId)
  if (!paper) return { ok: false as const, reason: 'not_found' }
  const slot = paper.slots.find((s) => s.id === slotId)
  if (!slot) return { ok: false as const, reason: 'slot_not_found' }
  const orderedIds = paper.slots.map((s) => s.id)
  const fromIdx = orderedIds.indexOf(slotId)
  const toIdx = Math.min(Math.max(Math.round(toNumber) - 1, 0), orderedIds.length - 1)
  if (fromIdx === toIdx) return { ok: true as const }
  orderedIds.splice(fromIdx, 1)
  orderedIds.splice(toIdx, 0, slotId)
  await renumberAndSync(composedId, orderedIds)
  return { ok: true as const }
}

/** 改大题名：该 section 整组槽位改名（section 是底卷题的快照，不影响组卷对位） */
export async function retitleSection(userId: string, composedId: string, fromSection: string, toSection: string) {
  const from = fromSection.trim()
  const to = toSection.trim().slice(0, 30)
  if (!from || !to) return { ok: false as const, reason: 'bad_section' }
  if (from === to) return { ok: true as const }
  const paper = await loadOwnedPaper(userId, composedId)
  if (!paper) return { ok: false as const, reason: 'not_found' }
  const hits = paper.slots.filter((s) => s.section === from)
  if (!hits.length) return { ok: false as const, reason: 'section_not_found' }
  await prisma.composedSlot.updateMany({
    where: { id: { in: hits.map((s) => s.id) } },
    data: { section: to },
  })
  return { ok: true as const, renamed: hits.length }
}

/** 改考试时长（分钟） */
export async function updateDuration(userId: string, composedId: string, durationMin: number) {
  if (!Number.isInteger(durationMin) || durationMin < 5 || durationMin > 300) return { ok: false as const, reason: 'bad_duration' }
  const row = await prisma.composedPaper.findFirst({ where: { id: composedId, userId }, select: { id: true } })
  if (!row) return { ok: false as const, reason: 'not_found' }
  await prisma.composedPaper.update({ where: { id: composedId }, data: { durationMin } })
  return { ok: true as const }
}

/** 题源闸门：切换本卷是否放行 AI 参考答案题（answerSource=ai）入池。
 *  由 AI 助手在用户明确同意后调用；换题/加题/重摇沿用本卷记录口径 */
export async function setAllowAi(userId: string, composedId: string, allow: boolean) {
  const row = await prisma.composedPaper.findFirst({ where: { id: composedId, userId }, select: { id: true } })
  if (!row) return { ok: false as const, reason: 'not_found' }
  await prisma.composedPaper.update({ where: { id: composedId }, data: { allowAiAnswers: allow } })
  return { ok: true as const }
}

// ===================== 读取（卷面页/聊天卡数据源） =====================

export interface ComposedPaperFull {
  id: string
  title: string
  subject: string
  baseSlug: string
  onlyChoice: boolean
  totalScore: number
  durationMin: number
  createdAt: Date
  slots: Array<{
    slotId: string
    section: string | null
    kind: string
    score: number
    number: number // 卷面题号 = 顺序号（index+1），渲染层直接用
    stem: string | null
    options: string[]
    images: string[]
    answer: string | null
    multiple: boolean
    /** 答案来源：official=官方，ai=AI 参考答案（答案页挂标注） */
    answerSource: string
    sourceTitle: string | null
    sourceSlug: string | null
    sourceYear: string | null
    sourceNumber: number | null
    /** 非真题槽的来源标记:textbook/ai-variant(真题槽为 null) */
    inlineSource: string | null
    /** 非真题槽溯源 */
    sourceRef: string | null
  }>
  /** 当前在卷题目的来源卷名清单（答案页来源声明用，按卷名字典序） */
  sources: string[]
}

/** 全量读取：槽位 join 题目全文；题号=顺序号；空槽(题被删)跳过渲染但保留位置? ——直接过滤 */
export async function getComposedPaper(userId: string, composedId: string): Promise<ComposedPaperFull | null> {
  const paper = await prisma.composedPaper.findFirst({
    where: { id: composedId, userId },
    include: {
      slots: {
        orderBy: { position: 'asc' },
        include: {
          paperQuestion: {
            select: {
              stem: true, options: true, images: true, answer: true, multiple: true, number: true, answerSource: true,
              paper: { select: { title: true, slug: true, year: true } },
            },
          },
        },
      },
    },
  })
  if (!paper) return null
  const slots = paper.slots
    .filter((s) => s.paperQuestion !== null || !!s.inlineStem)
    .map((s, i) => {
      const inline = !s.paperQuestion && !!s.inlineStem
      return {
      slotId: s.id,
      section: s.section,
      kind: s.kind,
      score: s.score,
      number: i + 1,
      stem: inline ? s.inlineStem! : s.paperQuestion!.stem,
      options: inline ? s.inlineOptions ?? [] : s.paperQuestion!.options,
      images: inline ? [] : s.paperQuestion!.images,
      answer: inline ? s.inlineAnswer ?? null : s.paperQuestion!.answer,
      multiple: inline ? false : s.paperQuestion!.multiple,
      answerSource: inline ? (s.source === 'textbook' ? 'textbook' : 'ai') : s.paperQuestion!.answerSource,
      sourceTitle: inline ? s.sourceRef ?? null : s.paperQuestion!.paper.title,
      sourceSlug: inline ? null : s.paperQuestion!.paper.slug,
      sourceYear: inline ? null : s.paperQuestion!.paper.year,
      sourceNumber: inline ? null : s.paperQuestion!.number,
      sourceRef: inline ? s.sourceRef ?? null : null,
      inlineSource: inline ? s.source ?? 'ai-variant' : null,
    }
  })
  const sources = Array.from(new Set(slots.map((s) => s.sourceTitle).filter((t): t is string => !!t))).sort()
  return {
    id: paper.id, title: paper.title, subject: paper.subject, baseSlug: paper.baseSlug,
    onlyChoice: paper.onlyChoice, totalScore: paper.totalScore, durationMin: paper.durationMin,
    createdAt: paper.createdAt, slots, sources,
  }
}

/** 池构成统计（助手题源闸门用）：official=带官方答案题数,ai=带 AI 参考答案题数 */
export async function loadPoolStats(userId: string, subject: string) {
  const full = await loadPool(userId, subject, true)
  return {
    official: full.filter((q) => q.answerSource === 'official').length,
    ai: full.filter((q) => q.answerSource === 'ai').length,
  }
}

/** 加题候选：同桶优先 + 题干关键词搜索（只搜池内），排除本卷已用，截 20 条。
 *  另返回全量池构成 poolStats（official/ai 各多少），助手据此判断官方池是否够用 */
export async function listCandidates(
  userId: string,
  composedId: string,
  opts: { section?: string; kind?: string; score?: number; q?: string }
) {
  const paper = await prisma.composedPaper.findFirst({ where: { id: composedId, userId }, select: { id: true, subject: true, allowAiAnswers: true } })
  if (!paper) return null
  const fullPool = await loadPool(userId, paper.subject, true)
  const poolStats = {
    official: fullPool.filter((q) => q.answerSource === 'official').length,
    ai: fullPool.filter((q) => q.answerSource === 'ai').length,
  }
  const pool = paper.allowAiAnswers ? fullPool : fullPool.filter((q) => q.answerSource === 'official')
  const currentIds = await prisma.composedSlot.findMany({
    where: { composedPaperId: composedId }, select: { paperQuestionId: true },
  }).then((rows) => rows.map((r) => r.paperQuestionId).filter((x): x is string => !!x))

  let cands = pool.filter((q) => !currentIds.includes(q.id))
  const kw = (opts.q ?? '').trim().toLowerCase()
  if (kw) {
    // 搜索模式：题干/选项关键词，全池范围
    cands = cands.filter((q) => q.stem.toLowerCase().includes(kw) || q.options.some((o) => o.toLowerCase().includes(kw)))
  } else if (opts.kind) {
    // 桶模式：同 section 优先，不足退 兜底桶
    const want = `${opts.section ?? ''}|${opts.kind}|${opts.score ?? -1}`
    const fb = `${opts.kind}|${opts.score ?? -1}`
    const same = cands.filter((q) => bucketOf(q) === want)
    cands = same.length ? same : cands.filter((q) => fallbackBucketOf(q) === fb)
  }
  return {
    poolStats,
    candidates: cands.slice(0, 20).map((q) => ({
      id: q.id,
      stem: q.stem.length > 120 ? q.stem.slice(0, 120) + '…' : q.stem,
      kind: q.kind, score: q.score, section: q.section,
      paperTitle: q.paperTitle, number: q.number,
      answerSource: q.answerSource,
    })),
  }
}
