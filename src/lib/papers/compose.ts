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
import { libraryScopes } from '@/lib/library-scope'
import { Prisma } from '@/generated/prisma/client'
import { generateFillQuestions, topicTokens, type FillContext } from '@/lib/ai/paper-question-generator'
import { decrypt } from '@/lib/crypto'

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
  /** 考点标签（导入后 AI 打标；加权检索的一等公民） */
  topics: string[]
  paperSlug: string
  paperTitle: string
}

/** 加载候选池：有答案 + 未 flagged + 结构自检通过，按学科过滤。
 *  allowAi=false 只取官方答案（answerSource=official）；true 放行 AI 参考答案题 */
async function loadPool(userId: string, subject: string, allowAi = false): Promise<PoolItem[]> {
  const rows = await prisma.paperQuestion.findMany({
    where: {
      userId: { in: await libraryScopes(userId) },
      answer: { not: null },
      flagged: false,
      ...(allowAi ? {} : { answerSource: 'official' }),
      paper: { subject },
    },
    select: {
      id: true, number: true, section: true, kind: true, score: true,
      stem: true, options: true, answer: true, answerSource: true, topics: true,
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
      answerSource: r.answerSource, topics: r.topics ?? [],
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

/** 内联槽草稿(composeFromOutline/composeForReview/fillShortagesInline 共用) */
type SlotDraft = {
  section: string | null
  kind: string
  score: number
  paperQuestionId: string | null
  historyIds: string[]
  inlineStem?: string
  inlineOptions?: string[]
  inlineAnswer?: string
  source?: string
  sourceRef?: string
}

/** 一次内联补齐任务:sh 引用组卷函数刚 push 的 shortage 条目,补齐数回写其 filled(缺口汇报如实) */
interface FillTask {
  /** 内联题落位的大题名 */
  section: string | null
  /** 拟题考点(大题名清洗编号后;空 = 学科级泛出题) */
  topic: string
  kind: 'choice' | 'answer'
  score: number
  need: number
  sh: { kind: string; score: number; requested: number; filled: number }
}

/** 补齐预算:两个来源各设上限(有溯源=课本/联网 grounding;纯 AI=举一反三),模型 id 必须有 */
interface InlineFillOpts {
  textbook: number
  aiVariant: number
  modelId: string
}

const SEARCH_ENGINE_ORDER = ['qianfan', 'tavily', 'deepseek'] as const

/**
 * 四路资源一次性收集(每次组卷最多一次,仅在真有缺口要补时调用):
 * ①真题库风格参考(有无答案都算,学格式不抄内容) ②错题本薄弱考点(掌握度低优先,≤6)
 * ③联网 key(按引擎顺序取第一个)——课本 grounding 在生成器内按考点现查,不在此收集。
 */
async function gatherFillContext(userId: string, subject: string, note?: string): Promise<FillContext> {
  const [recentQs, notes, keyRows] = await Promise.all([
    prisma.paperQuestion.findMany({
      where: { userId: { in: await libraryScopes(userId) }, paper: { subject } },
      select: {
        stem: true, options: true, kind: true, score: true, number: true,
        paper: { select: { title: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 4,
    }),
    prisma.studyNote.findMany({
      where: { userId, subject, topic: { not: null } },
      select: { topic: true },
      orderBy: { mastery: 'asc' },
      take: 40,
    }),
    prisma.searchApiKey.findMany({ where: { userId }, select: { engine: true, encryptedKey: true } }),
  ])
  const styleRefs = recentQs.map(
    (q) =>
      `【${q.paper.title} 第${q.number}题 · ${q.kind === 'choice' ? '选择题' : '解答/填空题'} ${q.score}分】\n` +
      `${q.stem.slice(0, 200)}${q.kind === 'choice' && q.options.length ? '\n' + q.options.slice(0, 4).join('  ') : ''}`
  )
  const seen = new Set<string>()
  const weakTopics: string[] = []
  for (const n of notes) {
    const t = (n.topic ?? '').trim()
    if (!t || seen.has(t)) continue
    seen.add(t)
    weakTopics.push(t)
    if (weakTopics.length >= 6) break
  }
  let web: FillContext['web'] = null
  for (const engine of SEARCH_ENGINE_ORDER) {
    const row = keyRows.find((r) => r.engine === engine)
    if (!row) continue
    try {
      web = { engine, apiKey: decrypt(row.encryptedKey) }
    } catch {
      web = null
    }
    break
  }
  return { styleRefs, weakTopics, web, userNote: note?.trim() || undefined }
}

/** 大题名 → 拟题考点:剥「一、」「(一)」「1.」编号前缀;纯题型词/空 → 学科级泛出题 */
const GENERIC_SECTION_RE = /^(选择题|解答题|填空题|判断题|简答题|论述题|非选择题|主观题|客观题|巩固练习)$/
function sectionToTopic(section: string | null): string {
  const cleaned = (section ?? '')
    .trim()
    .replace(/^[（(]?[0-9一二三四五六七八九十]{1,3}[）)]?\s*[.、．:：]?\s*/, '')
    .trim()
  if (!cleaned || GENERIC_SECTION_RE.test(cleaned)) return ''
  return cleaned.slice(0, 30)
}

/**
 * 缺口内联补齐:每任务先试有溯源出题(课本 grounding→联网兜底,耗 textbook 预算),
 * 不够再纯 AI 举一反三(耗 aiVariant 预算);生成失败降级为缺口,绝不编题充数。
 * 补齐数回写任务引用的 shortage.filled——修复点:旧实现漏计 aiVariant,缺口汇报虚高。
 */
async function fillShortagesInline(
  userId: string,
  subject: string,
  tasks: FillTask[],
  slots: SlotDraft[],
  opts: InlineFillOpts,
  note?: string
): Promise<{ textbook: number; aiVariant: number }> {
  const counts = { textbook: 0, aiVariant: 0 }
  const active = tasks.filter((t) => t.need > 0)
  if (!active.length) return counts
  const ctx = await gatherFillContext(userId, subject, note)
  for (const task of active) {
    let got = 0
    // 第一波:有溯源(课本 grounding,联网兜底)——耗 textbook 预算
    if (opts.textbook > counts.textbook) {
      const n = Math.min(task.need, opts.textbook - counts.textbook)
      try {
        const qs = await generateFillQuestions({
          userId, subject, topic: task.topic, kind: task.kind, score: task.score,
          count: n, modelId: opts.modelId, grounding: 'textbook-first', ctx,
        })
        for (const q of qs.slice(0, n)) {
          slots.push({ section: task.section, kind: q.kind, score: q.score, paperQuestionId: null, historyIds: [], inlineStem: q.stem, inlineOptions: q.options, inlineAnswer: q.answer, source: q.source, sourceRef: q.sourceRef })
          counts.textbook++
          got++
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // no_grounding = 课本与联网都拿不出内容,静默转纯 AI 波;其余错误记日志
        if (msg !== 'no_grounding') console.error('[compose] grounded fill failed:', msg)
      }
    }
    // 第二波:纯 AI 举一反三(无溯源)——耗 aiVariant 预算
    const remain = task.need - got
    if (remain > 0 && opts.aiVariant > counts.aiVariant) {
      const n = Math.min(remain, opts.aiVariant - counts.aiVariant)
      try {
        const qs = await generateFillQuestions({
          userId, subject, topic: task.topic, kind: task.kind, score: task.score,
          count: n, modelId: opts.modelId, grounding: 'none', ctx,
        })
        for (const q of qs.slice(0, n)) {
          slots.push({ section: task.section, kind: q.kind, score: q.score, paperQuestionId: null, historyIds: [], inlineStem: q.stem, inlineOptions: q.options, inlineAnswer: q.answer, source: q.source, sourceRef: q.sourceRef })
          counts.aiVariant++
          got++
        }
      } catch (err) {
        console.error('[compose] ai fill failed:', err instanceof Error ? err.message : err)
      }
    }
    task.sh.filled += got
  }
  return counts
}

/** 表单/工具传来的补齐参数 → 引擎预算:必须有模型;aiFillAll(整卷 AI 兜底)在表单没勾补齐时也给兜底预算 */
function resolveFillOpts(input: ComposeInput): InlineFillOpts | null {
  if (!input.modelId) return null
  const clamp = (v: unknown) => Math.min(40, Math.max(0, Math.round(Number(v) || 0)))
  const textbook = clamp(input.fillInline?.textbook)
  const aiVariant = clamp(input.fillInline?.aiVariant)
  if (input.aiFillAll) return { textbook: textbook > 0 ? textbook : 12, aiVariant: aiVariant > 0 ? aiVariant : 12, modelId: input.modelId }
  return textbook > 0 || aiVariant > 0 ? { textbook, aiVariant, modelId: input.modelId } : null
}

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
  /** 整卷 AI 兜底:真题池为空也放行组卷,全部缺口按 fillInline 预算用 AI 拟题补齐
   *  (四路资源 grounding;必须 modelId 同传;表单在用户确认一次性警告后才置 true) */
  aiFillAll?: boolean
  /** 表单「给 AI 的备注」(如「挑考得最多的题型」):真有缺口走 AI 补题时进生成 prompt;不落库 */
  note?: string
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
 * 大纲组卷:结构来自用户大纲的槽位定义,真题池逐桶填充——真题槽只用有官方答案且未拉黑的题。
 * 桶不够有多少放多少;缺口在 fill 预算内用内联 AI 拟题补齐(aiFillAll 整卷兜底/配比补齐都走这里),
 * 生成失败降级为缺口如实带出(shortages)。fill 缺省时保持旧口径:零拟题,池空直接 no_pool。
 * baseSlug 置空:无底卷,整卷重摇不可用(卷面页对大纲卷隐藏重摇按钮)。
 */
async function composeFromOutline(
  userId: string,
  subject: string,
  slotDefs: OutlineSlotDef[],
  title?: string,
  allowAi = false,
  focusTopics?: string[],
  fill?: InlineFillOpts | null,
  note?: string
): Promise<ComposeResult> {
  const defs = slotDefs
    .filter((d) => d.count > 0 && d.score > 0 && (d.kind === 'choice' || d.kind === 'answer'))
    .slice(0, 12)
  if (!defs.length) return { ok: false, reason: 'bad_outline' }

  const pool = await loadPool(userId, subject, allowAi)
  if (!pool.length && !fill) return { ok: false, reason: 'no_pool' }

  const tokens = focusTopics?.length ? topicTokens(focusTopics) : null
  const used = new Set<string>()
  const slots: SlotDraft[] = []
  const shortages: NonNullable<ComposeResult['shortages']> = []
  const fillTasks: FillTask[] = []
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
    if (filled < def.count) {
      shortages.push({ kind: def.kind, score: def.score, requested: def.count, filled })
      fillTasks.push({ section, topic: sectionToTopic(section), kind: def.kind, score: def.score, need: def.count - filled, sh: shortages[shortages.length - 1] })
    }
  }
  // 缺口内联补齐:整卷 AI 兜底(池空全靠它)/真题不够配比补齐,共用同一管线
  const filledInline = fill && fillTasks.length
    ? await fillShortagesInline(userId, subject, fillTasks, slots, fill, note)
    : { textbook: 0, aiVariant: 0 }
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
  return { ok: true, composedId: composed.id, title, shortages: shortages.length ? shortages : undefined, filledInline }
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
  fill?: InlineFillOpts | null,
  note?: string
): Promise<ComposeResult> {
  const topics = focusTopics.map((t) => t.trim()).filter(Boolean).slice(0, 8)
  if (!topics.length) return { ok: false, reason: 'bad_outline' }
  const per = Math.min(10, Math.max(1, Math.round(perTopic) || 2))

  const pool = await loadPool(userId, subject, allowAi)
  if (!pool.length && !fill) return { ok: false, reason: 'no_pool' }

  const used = new Set<string>()
  const slots: SlotDraft[] = []
  const shortages: NonNullable<ComposeResult['shortages']> = []
  const fillTasks: FillTask[] = []
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
    if (matched.length < per) {
      shortages.push({ kind: topic, score: 0, requested: per, filled: matched.length })
      // 拟题锚定:跟该考点下相关度最高的真题同题型/分值;无真题锚点 → 选择题 3 分
      const anchor = matched[0]?.q
      fillTasks.push({
        section: topic,
        topic,
        kind: anchor ? (anchor.kind === 'answer' ? 'answer' : 'choice') : 'choice',
        score: anchor && anchor.score > 0 ? anchor.score : anchor && anchor.kind === 'answer' ? 8 : 3,
        need: per - matched.length,
        sh: shortages[shortages.length - 1],
      })
    }
  }
  // 真题不够 → 课本/联网/AI 举一反三内联补齐(生成失败降级为缺口,绝不编题充数)
  const filledInline = fill && fillTasks.length
    ? await fillShortagesInline(userId, subject, fillTasks, slots, fill, note)
    : { textbook: 0, aiVariant: 0 }
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
  // 补齐预算(aiFillAll 整卷兜底 / 针对我配比补齐)统一在此归一:无模型 → 不补(保持零拟题口径)
  const fill = resolveFillOpts(input)
  // 传了 slotDefs(即使过滤后为空)即大纲模式:空/无效定义走 bad_outline,绝不静默回退底卷模式
  if (input.slotDefs) return composeFromOutline(userId, input.subject, input.slotDefs, input.title, !!input.allowAiAnswers, input.focusTopics, fill, input.note)
  // 针对我复习(无结构):按薄弱考点逐组匹配,大题名 = 考点名;extraRandom>0 时卷尾补随机巩固节
  if (input.focusTopics?.length)
    return composeForReview(userId, input.subject, input.focusTopics, input.perTopic ?? 2, input.title, !!input.allowAiAnswers, input.extraRandom ?? 0, fill, input.note)
  const pool = await loadPool(userId, input.subject, !!input.allowAiAnswers)
  if (!pool.length) return { ok: false, reason: 'no_pool' }

  // 底卷：池内题数最多（并列取最新）的卷
  const byPaper = new Map<string, { title: string; count: number; createdAt: Date }>()
  const slugCreatedAt = await prisma.paper.findMany({
    where: { userId: { in: await libraryScopes(userId) }, subject: input.subject },
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
    where: { userId: { in: await libraryScopes(userId) }, slug: baseSlug },
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
 * 公共库的题(非本人名下)对非主人只读：只做本卷移除，不动全局 flagged。
 */
export async function flagSlot(userId: string, composedId: string, slotId: string) {
  const paper = await loadOwnedPaper(userId, composedId)
  if (!paper) return { ok: false as const, reason: 'not_found' }
  const slot = paper.slots.find((s) => s.id === slotId)
  if (!slot) return { ok: false as const, reason: 'slot_not_found' }
  if (slot.paperQuestionId) {
    const pq = await prisma.paperQuestion.findUnique({
      where: { id: slot.paperQuestionId },
      select: { userId: true },
    })
    if (pq?.userId === userId) {
      await prisma.paperQuestion.update({ where: { id: slot.paperQuestionId }, data: { flagged: true } })
    }
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
      id: paperQuestionId, userId: { in: await libraryScopes(userId) }, answer: { not: null }, flagged: false,
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

/** 计算加题插入位置与继承的大题名(insertInlineSlot 用,规则与 insertSlot 相同):
 *  afterSlotId = 插到该槽正后方并继承其大题名;不传 = 同 section 组末尾(不在卷里则追加整卷末尾) */
function planInsertAt(
  slots: Array<{ id: string; section: string | null }>,
  section: string | null,
  afterSlotId?: string
): { ok: true; insertAt: number; section: string | null } | { ok: false; reason: 'slot_not_found' } {
  if (afterSlotId) {
    const idx = slots.findIndex((s) => s.id === afterSlotId)
    if (idx < 0) return { ok: false, reason: 'slot_not_found' }
    return { ok: true, insertAt: idx + 1, section: slots[idx].section }
  }
  let insertAt = slots.length
  for (let i = slots.length - 1; i >= 0; i--) {
    if (slots[i].section === section) { insertAt = i + 1; break }
    if (slots[i].section === null) break
  }
  return { ok: true, insertAt, section }
}

/**
 * 加一道 AI 拟题(内联槽):内容来自举一反三生成管线,不走真题池校验(它本来就不是真题)。
 * 卷面按 inlineSource=ai-variant 标注〔AI 拟题〕,答案页沿用 AI 参考答案标注体系。
 * 内容先过轻校验(题型/长度/选项数)防脏数据;定位规则与 insertSlot 相同。
 */
export async function insertInlineSlot(
  userId: string,
  composedId: string,
  inline: { stem: string; options: string[]; answer: string; kind: string; score: number; sourceRef?: string; section?: string },
  afterSlotId?: string
) {
  const stem = (inline.stem ?? '').trim()
  const answer = (inline.answer ?? '').trim()
  const kind = inline.kind === 'choice' ? 'choice' : inline.kind === 'answer' ? 'answer' : null
  const score = Math.round(inline.score)
  const options = (Array.isArray(inline.options) ? inline.options : [])
    .map((o) => String(o ?? '').trim())
    .filter(Boolean)
  if (!kind) return { ok: false as const, reason: 'bad_kind' }
  if (!stem || stem.length > 2000) return { ok: false as const, reason: 'bad_stem' }
  if (!answer || answer.length > 4000) return { ok: false as const, reason: 'bad_answer' }
  if (!Number.isInteger(score) || score < 1 || score > 30) return { ok: false as const, reason: 'bad_score' }
  if (kind === 'choice' && (options.length < 2 || options.length > 8 || options.some((o) => o.length > 300)))
    return { ok: false as const, reason: 'bad_options' }

  const paper = await loadOwnedPaper(userId, composedId)
  if (!paper) return { ok: false as const, reason: 'not_found' }
  const plan = planInsertAt(paper.slots, inline.section?.trim() || null, afterSlotId)
  if (!plan.ok) return plan

  const created = await prisma.composedSlot.create({
    data: {
      composedPaperId: composedId,
      position: paper.slots.length + 1000,
      section: plan.section,
      kind, score,
      paperQuestionId: null,
      historyIds: [],
      inlineStem: stem,
      inlineOptions: options,
      inlineAnswer: answer,
      source: 'ai-variant',
      sourceRef: inline.sourceRef?.trim().slice(0, 100) || null,
    },
    select: { id: true },
  })
  const ordered = [
    ...paper.slots.slice(0, plan.insertAt).map((s) => s.id),
    created.id,
    ...paper.slots.slice(plan.insertAt).map((s) => s.id),
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

/** 加题候选：题干关键词走考点加权检索（topics 整串 6/词 3、题干整串 4/词 2、选项词 1，
 *  与 paper-tool-server searchPaperQuestions 同口径），无关键词走同桶过滤，排除本卷已用。
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
  const kw = (opts.q ?? '').trim()
  if (kw) {
    // 搜索模式：考点/题干/选项加权打分（整串+分词），按命中强度降序
    const terms = [kw, ...kw.split(/\s+/).filter(Boolean).slice(0, 4)].filter((t, i, arr) => arr.indexOf(t) === i)
    const scored = cands
      .map((q) => ({ q, s: scoreByTerms(q, terms) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.q)
    cands = scored
  } else if (opts.kind) {
    // 桶模式：同 section 优先，不足退 兜底桶
    const want = `${opts.section ?? ''}|${opts.kind}|${opts.score ?? -1}`
    const fb = `${opts.kind}|${opts.score ?? -1}`
    const same = cands.filter((q) => bucketOf(q) === want)
    cands = same.length ? same : cands.filter((q) => fallbackBucketOf(q) === fb)
  }
  return {
    poolStats,
    matched: kw ? cands.length > 0 : null,
    candidates: cands.slice(0, 20).map((q) => ({
      id: q.id,
      stem: q.stem.length > 150 ? q.stem.slice(0, 150) + '…' : q.stem,
      kind: q.kind, score: q.score, section: q.section,
      topics: q.topics.slice(0, 4),
      answerBrief: q.answer.length > 60 ? q.answer.slice(0, 60) + '…' : q.answer,
      paperTitle: q.paperTitle, number: q.number,
      answerSource: q.answerSource,
    })),
  }
}

/** 考点加权检索打分（searchPaperQuestions 同口径的内存版）：
 *  topics 整串 6 / topics 词 3 / 题干整串 4 / 题干词 2 / 选项词 1 */
function scoreByTerms(q: PoolItem, terms: string[]): number {
  const stemLc = q.stem.toLowerCase()
  const optsLc = q.options.join('\n').toLowerCase()
  const topicsText = q.topics.join(' ').toLowerCase()
  let s = 0
  for (const t0 of terms) {
    const t = t0.toLowerCase()
    if (!t) continue
    if (q.topics.some((tp) => tp.toLowerCase().includes(t))) s += topicsText.includes(t) ? 6 : 3
    if (stemLc.includes(t)) s += t === terms[0].toLowerCase() ? 4 : 2
    if (optsLc.includes(t)) s += 1
  }
  return s
}

// ===================== 变更计划：应用与撤销 =====================

/** 计划操作输入（助手 propose_plan 产出的 ops 原样落这里；slotNumber 执行时逐条对位当前卷面） */
export interface PlanOp {
  op: 'replace' | 'remove' | 'insert' | 'retitle' | 'rescore' | 'move' | 'resection' | 'reduration'
  slotNumber?: number
  paperQuestionId?: string
  afterNumber?: number
  title?: string
  score?: number
  toNumber?: number
  fromSection?: string
  toSection?: string
  durationMin?: number
}

/** 槽位快照行（还原 ComposedSlot 用，字段与模型对齐） */
interface SlotSnapshot {
  id: string
  position: number
  section: string | null
  kind: string
  score: number
  paperQuestionId: string | null
  historyIds: string[]
  inlineStem: string | null
  inlineOptions: string[]
  inlineAnswer: string | null
  source: string | null
  sourceRef: string | null
}

/** 题号 → slotId（题号 = position+1，按当前槽位序） */
function slotIdByNumber(slots: Array<{ id: string; position: number }>, n?: number): string | null {
  if (!n) return null
  return slots.find((s) => s.position + 1 === n)?.id ?? null
}

/** 应用变更计划：先落整卷快照，再逐条执行 ops（顺序执行，题号按执行时点实时对位）。
 *  任一条失败不回滚（前几条已生效，快照可整卷撤销）；返回逐条回执 */
export async function applyPlan(userId: string, composedId: string, ops: PlanOp[]) {
  const paper = await loadOwnedPaper(userId, composedId)
  if (!paper) return { ok: false as const, reason: 'not_found' as const }
  if (!Array.isArray(ops) || ops.length === 0) return { ok: false as const, reason: 'empty_plan' as const }
  if (ops.length > 12) return { ok: false as const, reason: 'plan_too_large' as const }

  const snapshot: SlotSnapshot[] = paper.slots.map((s) => ({
    id: s.id, position: s.position, section: s.section, kind: s.kind, score: s.score,
    paperQuestionId: s.paperQuestionId, historyIds: [...s.historyIds],
    inlineStem: s.inlineStem, inlineOptions: [...(s.inlineOptions ?? [])], inlineAnswer: s.inlineAnswer,
    source: s.source, sourceRef: s.sourceRef,
  }))
  const snapId = `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await prisma.composedSnapshot.create({
    data: {
      id: snapId, composedId, userId,
      title: paper.title, durationMin: paper.durationMin, totalScore: paper.totalScore,
      slots: snapshot as unknown as Prisma.InputJsonValue,
    },
  })
  // 只留最近一份：应用新计划前清掉旧快照
  await prisma.composedSnapshot.deleteMany({ where: { composedId, id: { not: snapId } } })

  const results: Array<{ op: string; target?: string; ok: boolean; reason?: string; hint?: string; detail?: string }> = []
  const HINTS: Record<string, string> = {
    not_found: '卷子不存在', slot_not_found: '卷面上没有这个题号', no_candidate: '真题池里没有合适的候选题',
    not_in_pool: '该题不在候选池内(缺答案/已拉黑/不属于本卷学科/已放行口径不符)',
    empty_title: '新卷名为空', bad_title: '卷名不合法', bad_score: '分值无效(需 1-30 的整数)',
    bad_duration: '时长无效(需 5-300 的整数分钟)', bad_section: '大题名无效',
    section_not_found: '卷面上没有这个大题名', bad_order: '移动位置无效', bad_kind: '题型无效',
    bad_stem: '题干无效', bad_answer: '答案无效', bad_options: '选项无效',
    already_on_paper: '该题已在卷面上，不能重复加入', empty_plan: '计划为空', plan_too_large: '计划超过 12 条，请拆分',
  }
  for (const raw of ops) {
    const op = raw?.op
    const label = op === 'replace' ? `换题·第${raw.slotNumber ?? '?'}题`
      : op === 'remove' ? `移除·第${raw.slotNumber ?? '?'}题`
      : op === 'insert' ? '加题'
      : op === 'retitle' ? '改卷名'
      : op === 'rescore' ? `改分值·第${raw.slotNumber ?? '?'}题`
      : op === 'move' ? `移位·第${raw.slotNumber ?? '?'}题`
      : op === 'resection' ? '改大题名'
      : op === 'reduration' ? '调时长'
      : op ?? 'unknown'
    const record = (r: { ok: boolean; reason?: string } & Record<string, unknown>, target?: string) => {
      const reason = r.ok ? undefined : (r.reason ?? 'op_failed')
      results.push({
        op: label, target, ok: r.ok, reason,
        hint: reason ? (HINTS[reason] ?? '操作失败') : undefined,
        detail: r.ok ? (r.pickedId ? '已换入新题' : r.slotId ? '已加入卷面' : undefined) : undefined,
      })
    }
    // 每条现读槽位：前一条 remove/insert 会改题号，逐条对位避免整批错位
    const cur = await loadOwnedPaper(userId, composedId)
    if (!cur) { results.push({ op: label, ok: false, reason: 'not_found', hint: HINTS.not_found }); continue }
    try {
      switch (op) {
        case 'replace': {
          const slotId = slotIdByNumber(cur.slots, raw.slotNumber)
          if (!slotId || !raw.paperQuestionId) { record({ ok: false, reason: 'slot_not_found' }); break }
          const target = cur.slots.find((s) => s.id === slotId)
          const q = await prisma.paperQuestion.findFirst({
            where: {
              id: raw.paperQuestionId, userId: { in: await libraryScopes(userId) }, answer: { not: null }, flagged: false,
              ...(cur.allowAiAnswers ? {} : { answerSource: 'official' }),
              paper: { subject: cur.subject },
            },
            select: { id: true, section: true, kind: true, score: true, options: true, answer: true, number: true },
          })
          if (!q || getIntegrityIssues(q).length) { record({ ok: false, reason: 'not_in_pool' }); break }
          if (cur.slots.some((s) => s.paperQuestionId === q.id)) { record({ ok: false, reason: 'already_on_paper' }); break }
          await prisma.composedSlot.update({
            where: { id: slotId },
            data: {
              paperQuestionId: q.id, section: target?.section ?? q.section, kind: q.kind, score: q.score,
              historyIds: [...(target?.historyIds ?? []), q.id].slice(-50),
            },
          })
          record({ ok: true, pickedId: q.id }, target?.section ?? undefined)
          break
        }
        case 'remove': {
          const slotId = slotIdByNumber(cur.slots, raw.slotNumber)
          if (!slotId) { record({ ok: false, reason: 'slot_not_found' }); break }
          record(await removeSlot(userId, composedId, slotId))
          break
        }
        case 'insert': {
          if (!raw.paperQuestionId) { record({ ok: false, reason: 'not_in_pool' }); break }
          const afterSlotId = slotIdByNumber(cur.slots, raw.afterNumber) ?? undefined
          record(await insertSlot(userId, composedId, raw.paperQuestionId, afterSlotId))
          break
        }
        case 'retitle':
          record(await retitlePaper(userId, composedId, raw.title ?? ''))
          break
        case 'rescore': {
          const slotId = slotIdByNumber(cur.slots, raw.slotNumber)
          if (!slotId || !raw.score) { record({ ok: false, reason: 'bad_score' }); break }
          record(await updateSlotScore(userId, composedId, slotId, raw.score))
          break
        }
        case 'move': {
          const slotId = slotIdByNumber(cur.slots, raw.slotNumber)
          if (!slotId || !raw.toNumber) { record({ ok: false, reason: 'bad_order' }); break }
          record(await moveSlot(userId, composedId, slotId, raw.toNumber))
          break
        }
        case 'resection':
          record(raw.fromSection && raw.toSection
            ? await retitleSection(userId, composedId, raw.fromSection, raw.toSection)
            : { ok: false, reason: 'bad_section' })
          break
        case 'reduration':
          record(raw.durationMin
            ? await updateDuration(userId, composedId, raw.durationMin)
            : { ok: false, reason: 'bad_duration' })
          break
        default:
          record({ ok: false, reason: 'bad_kind' })
      }
    } catch {
      record({ ok: false, reason: 'op_failed' })
    }
  }
  return { ok: true as const, snapshotId: snapId, results }
}

/** 撤销最近一次计划应用：按快照整卷还原（删快照行），还原后重算总分 */
export async function undoLastPlan(userId: string, composedId: string) {
  const paper = await prisma.composedPaper.findFirst({ where: { id: composedId, userId }, select: { id: true } })
  if (!paper) return { ok: false as const, reason: 'not_found' as const }
  const snap = await prisma.composedSnapshot.findFirst({
    where: { composedId, userId },
    orderBy: { createdAt: 'desc' },
  })
  if (!snap) return { ok: false as const, reason: 'no_snapshot' as const }
  const rows = snap.slots as unknown as SlotSnapshot[]
  await prisma.$transaction([
    prisma.composedSlot.deleteMany({ where: { composedPaperId: composedId } }),
    ...rows.map((s) =>
      prisma.composedSlot.create({
        data: {
          id: s.id, composedPaperId: composedId, position: s.position, section: s.section,
          kind: s.kind, score: s.score, paperQuestionId: s.paperQuestionId,
          historyIds: s.historyIds ?? [], inlineStem: s.inlineStem, inlineOptions: s.inlineOptions ?? [],
          inlineAnswer: s.inlineAnswer, source: s.source, sourceRef: s.sourceRef,
        },
      })
    ),
    prisma.composedPaper.update({
      where: { id: composedId },
      data: { title: snap.title, durationMin: snap.durationMin, totalScore: snap.totalScore },
    }),
    prisma.composedSnapshot.delete({ where: { id: snap.id } }),
  ])
  return { ok: true as const }
}

// ===================== 审卷诊断（确定性计算，不走 AI） =====================

/** 卷面体检：考点覆盖（本卷 topics vs 本学科高频考频）、薄弱点命中（错题本 mastery 最低的考点）。
 *  全部查库现算，无模型成本；诊断条与助手 read_diagnosis 共用 */
export async function computeReview(userId: string, composedId: string) {
  const paper = await prisma.composedPaper.findFirst({
    where: { id: composedId, userId },
    select: { id: true, subject: true, slots: { orderBy: { position: 'asc' }, select: { paperQuestion: { select: { topics: true } } } } },
  })
  if (!paper) return null
  // 本卷覆盖考点（真题槽的 topics；内联槽不计）
  const covered = new Set<string>()
  for (const s of paper.slots) for (const t of s.paperQuestion?.topics ?? []) covered.add(t)
  // 高频考点（考频统计，count>=2 视为高频；重组卷不在 Paper 表、天然不进统计）。
  // 动态导入：paper-tool-server 反向依赖本文件，静态 import 会成环
  const { getPaperTopicStats } = await import('@/lib/ai/paper-tool-server')
  const stats = await getPaperTopicStats(userId, paper.subject)
  const highFreq = stats.filter((s) => s.count >= 2)
  const gaps = highFreq.filter((s) => !covered.has(s.topic)).slice(0, 6)
  // 薄弱点：错题本同学科 mastery<0.5 的考点，按 mastery 升序取前 5
  const weakNotes = await prisma.studyNote.findMany({
    where: { userId, subject: paper.subject, topic: { not: null }, mastery: { lt: 0.5 } },
    select: { topic: true, mastery: true },
    orderBy: { mastery: 'asc' },
    take: 40,
  })
  const weakMap = new Map<string, number>()
  for (const n of weakNotes) {
    if (!n.topic) continue
    const cur = weakMap.get(n.topic)
    if (cur === undefined || n.mastery < cur) weakMap.set(n.topic, n.mastery)
  }
  const weak = Array.from(weakMap.entries())
    .sort((a, b) => a[1] - b[1])
    .slice(0, 5)
    .map(([topic, mastery]) => ({ topic, mastery: Math.round(mastery * 100) / 100, onPaper: covered.has(topic) }))
  return {
    coveredCount: covered.size,
    highFreqCount: highFreq.length,
    gaps: gaps.map((g) => ({ topic: g.topic, count: g.count, chapter: g.chapter })),
    weak,
  }
}
