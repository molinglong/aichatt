/**
 * 试卷库检索/统计——服务端核心（server-only，依赖 prisma）。
 *
 * 数据层次：Paper(整卷元数据) / PaperPage(整卷原件) / PaperQuestion(逐题索引层)。
 * 本文件提供三个能力：
 *   - searchPaperQuestions: 真题检索（题干/考点/选项 ILIKE，粗筛+加权精排，范式同 searchKnowledgeChunks）
 *   - getPaperTopicStats:   考点考次统计（「考了几次」；口径=一题多考点各计一次）
 *   - getPaperOverview:     试卷清单+题型分布（整理报告用）
 * chat 工具（search_papers）与日后的整理/规划指令共用本文件，保证口径一致。
 * 禁止被客户端组件引用；isomorphic 的工具 schema/类型在 paper-tool.ts（wave 2）。
 */
import { prisma } from '@/lib/db'
import { libraryScopes } from '@/lib/library-scope'
import { Prisma } from '@/generated/prisma/client'
import {
  paperSearchInputSchema,
  paperAnalyzeInputSchema,
  composePaperInputSchema,
  type PaperQuestionHit,
  type PaperSearchOutput,
  type PaperTopicCount,
  type PaperOverviewItem,
  type PaperTopicStat,
  type PaperWeakTopic,
  type PaperAnalyzeOutput,
  type ComposePaperOutput,
} from './paper-tool'
import { composePaper, getComposedPaper } from '@/lib/papers/compose'
import { tool } from 'ai'

/** 检索返回题数上限 */
const RESULT_LIMIT = 8
/** 题干返回给模型的截断长度 */
const HIT_STEM_LIMIT = 400
/** 答案返回给模型的截断长度 */
const HIT_ANSWER_LIMIT = 500

type RawTopicStatRow = { topic: string; count: number; refs: string[]; subject: string }
type RawOverviewRow = Omit<PaperOverviewItem, never>
type RawQuestionRow = {
  number: number
  section: string | null
  kind: string
  multiple: boolean
  score: number
  stem: string
  options: string[]
  images: string[]
  topics: string[]
  answer: string | null
  paperTitle: string
  paperSlug: string
  year: string | null
  region: string | null
  examType: string | null
}

const esc = (t: string) => t.replace(/[\\%_]/g, (m) => `\\${m}`)
const like = (t: string) => `%${esc(t)}%`

/**
 * 真题检索：整串+分词(空格拆,最多4个) OR 粗筛（题干/选项/考点 ILIKE，
 * pg_trgm GIN on stem），按命中强度加权精排（考点整串6/题干整串4/考点词3/题干词2/选项词1），
 * 同分按题号升序。subject 可选过滤。
 */
export async function searchPaperQuestions(
  userId: string,
  query: string,
  subject?: string,
  limit = RESULT_LIMIT
): Promise<PaperQuestionHit[]> {
  const keywords = query.split(/\s+/).filter(Boolean).slice(0, 4)
  const terms = [query, ...keywords].filter((t, i, arr) => arr.indexOf(t) === i)
  const topicsText = Prisma.sql`array_to_string(pq.topics, ' ')`
  const optionsText = Prisma.sql`array_to_string(pq.options, ' ')`
  const hitExpr = Prisma.join(
    terms.map(
      (t) => Prisma.sql`(CASE WHEN ${topicsText} ILIKE ${like(t)} THEN 2 WHEN pq.stem ILIKE ${like(t)} THEN 1 ELSE 0 END)`
    ),
    ' + '
  )
  const rows = await prisma.$queryRaw<RawQuestionRow[]>(Prisma.sql`
    SELECT pq.number, pq.section, pq.kind, pq.multiple, pq.score, pq.stem,
           pq.options, pq.images, pq.topics, pq.answer,
           p.title AS "paperTitle", p.slug AS "paperSlug", p.year, p.region, p."examType"
    FROM "PaperQuestion" pq
    JOIN "Paper" p ON p.id = pq."paperId"
    WHERE pq."userId" IN (${Prisma.join(await libraryScopes(userId))})
      ${subject ? Prisma.sql`AND p.subject = ${subject}` : Prisma.empty}
      AND (${Prisma.join(
        terms.map((t) => Prisma.sql`(pq.stem ILIKE ${like(t)} OR ${topicsText} ILIKE ${like(t)} OR ${optionsText} ILIKE ${like(t)})`),
        ' OR '
      )})
    ORDER BY (${hitExpr}) DESC, p."createdAt" DESC, pq.number ASC
    LIMIT ${limit}
  `)
  return rows.map((r) => ({
    ...r,
    stem: r.stem.slice(0, HIT_STEM_LIMIT),
    answer: r.answer ? r.answer.slice(0, HIT_ANSWER_LIMIT) : null,
  }))
}

/**
 * 考点考次统计：unnest(topics) 按考点聚合。口径=一题多考点各计一次，
 * 报告展示时须注明。chapter 由学考提纲的节号→章映射补全。
 */
export async function getPaperTopicStats(userId: string, subject?: string): Promise<PaperTopicStat[]> {
  const rows = await prisma.$queryRaw<RawTopicStatRow[]>(Prisma.sql`
    SELECT unnest(pq.topics) AS topic,
           count(*)::int AS count,
           array_agg(DISTINCT p.title || ' · 第' || pq.number || '题') AS refs,
           max(p.subject)::text AS subject
    FROM "PaperQuestion" pq
    JOIN "Paper" p ON p.id = pq."paperId"
    WHERE pq."userId" IN (${Prisma.join(await libraryScopes(userId))})
      ${subject ? Prisma.sql`AND p.subject = ${subject}` : Prisma.empty}
    GROUP BY topic
    ORDER BY count DESC, topic ASC
  `)
  if (!rows.length) return []
  // 节号 → 课本章（学考提纲词表的副产品）。键必须带科目：不同科目的提纲节号会撞号
  // （如数学 8.5 空间平行 vs 物理 8.5 机械能守恒实验），聚合行自带 subject 供精确取用。
  const chunks = await prisma.knowledgeChunk.findMany({
    where: { section: { not: null }, doc: { title: { contains: '学考复习提纲' } } },
    select: { chapter: true, section: true, doc: { select: { subject: true } } },
  })
  const chapterMap = new Map<string, string>()
  for (const c of chunks) {
    const m = (c.section || '').match(/^(\d+(?:\.\d+)?)/)
    if (m && c.chapter && !chapterMap.has(`${c.doc.subject}:${m[1]}`)) {
      chapterMap.set(`${c.doc.subject}:${m[1]}`, c.chapter)
    }
  }
  return rows.map((r) => ({
    topic: r.topic,
    count: r.count,
    chapter: chapterMap.get(`${r.subject}:${r.topic.split(' ')[0]}`) ?? null,
    refs: r.refs,
  }))
}

/** 试卷清单+题型分布（整理报告的骨架数据） */
export async function getPaperOverview(userId: string, subject?: string): Promise<PaperOverviewItem[]> {
  const rows = await prisma.$queryRaw<RawOverviewRow[]>(Prisma.sql`
    SELECT p.slug, p.title, p.subject, p.year, p.region, p."examType",
           p."totalScore", p."durationMin", p."pageCount",
           count(pq.id)::int AS questions,
           count(pq.id) FILTER (WHERE pq.kind = 'choice')::int AS choice,
           count(pq.id) FILTER (WHERE pq.multiple)::int AS "multiChoice",
           count(pq.id) FILTER (WHERE pq.kind = 'answer')::int AS "answerQ",
           count(pq.id) FILTER (WHERE pq.answer IS NOT NULL)::int AS answered,
           count(pq.id) FILTER (WHERE array_length(pq.topics, 1) > 0)::int AS tagged
    FROM "Paper" p
    LEFT JOIN "PaperQuestion" pq ON pq."paperId" = p.id
    WHERE p."userId" IN (${Prisma.join(await libraryScopes(userId))})
      ${subject ? Prisma.sql`AND p.subject = ${subject}` : Prisma.empty}
    GROUP BY p.id
    ORDER BY p."createdAt" DESC
  `)
  return rows
}

/** 归属(自己+公共库)下是否存在逐题索引（物理级注入闸门：一张卷都没录则 search_papers 不挂载） */
export async function hasPaperQuestions(userId: string): Promise<boolean> {
  const row = await prisma.paperQuestion.findFirst({ where: { userId: { in: await libraryScopes(userId) } }, select: { id: true } })
  return !!row
}

/** 考次口径与结果使用纪律（note 随结果注入模型上下文） */
function buildPaperResultNote(results: PaperQuestionHit[], topicCounts: PaperTopicCount[], query: string): string {
  if (!results.length && !topicCounts.length) {
    return `真题库中未找到与「${query}」相关的内容。请如实告知用户试卷库里没有这部分（可建议把相关试卷拍照发来录入），不要编造考次或真题。`
  }
  return [
    '以上为用户试卷库中的真题(逐题索引)。使用纪律:',
    '- 题干含 $...$ LaTeX 公式与 [图N] 占位(images 为图链 URL):向用户展示题目时原样保留公式,配图用 ![图N](URL) 内联;选项原样保留,不要改写数据。',
    '- answer 为 null = 官方答案缺失:必须明确告知该题暂无官方答案,不得编造;answer 非空时讲解以官方答案为准。',
    `- 考次口径:topicCounts 按考点标签计数,一题多考点各计一次(${topicCounts.length} 个考点命中)。用户问「考过几次」时优先引用 topicCounts 的数字与出处;问的是题干词而非考点名时,基于 results 如实说明命中题数,并提示按考点名查询更准。`,
  ].join('\n')
}

/**
 * 创建真题检索工具（search_papers）。数据=当前用户试卷库的逐题索引，
 * 返回真题命中 + 相关考点考次统计（「考了几次」的直接答案）。
 */
export function createPaperSearchTool(userId: string) {
  return tool({
    description:
      '真题检索工具。检索用户录入的试卷库(逐题索引:卷名/年份/题号/分值/题干/选项/考点标签)。用户问某考点考过几次/是不是高频考点、想要真题或例题、要求翻某套卷找题时使用。输入 2-4 个考点词(优先用考纲考点名,如「解三角形」「命题的否定」),返回真题原文与考点考次统计。',
    inputSchema: paperSearchInputSchema,
    execute: async ({ query, subject }): Promise<PaperSearchOutput> => {
      try {
        let results = await searchPaperQuestions(userId, query, subject)
        // 学科归错时自愈回退查全部(与 search_knowledge 同纪律)
        if (!results.length && subject) results = await searchPaperQuestions(userId, query)
        const stats = await getPaperTopicStats(userId, subject)
        const terms = [query, ...query.split(/\s+/).filter(Boolean)]
          .map((t) => t.toLowerCase())
          .filter((t, i, arr) => arr.indexOf(t) === i)
        const topicCounts: PaperTopicCount[] = stats
          .filter((s) => terms.some((t) => s.topic.toLowerCase().includes(t)))
          .map((s) => ({ topic: s.topic, count: s.count, refs: s.refs.slice(0, 6) }))
        return {
          query,
          results,
          topicCounts,
          note: buildPaperResultNote(results, topicCounts, query),
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : '未知检索错误'
        console.error('[paper-tool]', message)
        return {
          query,
          results: [],
          topicCounts: [],
          error: message,
          note: '真题检索暂时不可用。请按你自己的知识回答用户，不要提及检索失败细节。',
        }
      }
    },
  })
}

/**
 * 错题本弱点联动：StudyNote.topic（自由词，如「十字相乘」）与考点标签（规范名
 * 「6.2 解三角形」）模糊匹配后按考点聚合。匹配在 JS 侧做双向 includes——两边
 * 词表来源不同（AI 打标 vs 错题打标），SQL 精确 join 命中率反而低。
 * 只聚合能对上考点标签的卡片；对不上的不硬凑（weakTopics 为空时 note 会说明）。
 */
async function getWeakTopics(userId: string, topicStats: PaperTopicStat[], subject?: string): Promise<PaperWeakTopic[]> {
  if (!topicStats.length) return []
  const notes = await prisma.studyNote.findMany({
    where: { userId, topic: { not: null }, ...(subject ? { subject } : {}) },
    select: { topic: true, mastery: true, dueAt: true },
  })
  if (!notes.length) return []
  const now = Date.now()
  const matched = new Map<string, { noteTopic: string; count: number; masterySum: number; due: number }>()
  for (const n of notes) {
    const nt = (n.topic || '').trim()
    if (!nt) continue
    const ntLower = nt.toLowerCase()
    // 双向包含即认为同考点：「解三角形」↔「6.2 解三角形」、「十字相乘」↔「3.2 十字相乘法」
    const stat = topicStats.find((s) => {
      const name = s.topic.split(' ').slice(1).join(' ') || s.topic
      const tLower = s.topic.toLowerCase()
      return tLower.includes(ntLower) || name.toLowerCase().includes(ntLower) || ntLower.includes(name.toLowerCase())
    })
    if (!stat) continue
    const cur = matched.get(stat.topic) || { noteTopic: nt, count: 0, masterySum: 0, due: 0 }
    cur.count++
    cur.masterySum += n.mastery
    if (n.dueAt && n.dueAt.getTime() <= now) cur.due++
    matched.set(stat.topic, cur)
  }
  return Array.from(matched.entries())
    .map(([topic, m]) => ({
      topic,
      noteTopic: m.noteTopic,
      noteCount: m.count,
      avgMastery: m.count ? m.masterySum / m.count : 0,
      dueCount: m.due,
    }))
    .sort((a, b) => a.avgMastery - b.avgMastery || b.noteCount - a.noteCount)
}

/** 整理报告/复习规划的使用纪律（note 随结果注入模型上下文） */
function buildAnalyzeNote(overview: PaperOverviewItem[], weakTopics: PaperWeakTopic[], flaggedCount: number): string {
  const unanswered = overview.reduce((acc, p) => acc + (p.questions - p.answered), 0)
  return [
    '以上为用户试卷库的全量分析数据。两种用法:',
    '1)「整理试卷」报告:按 ①试卷清单(卷名/年份/题量/题型分布/总分) ②考点考次排行(注明口径=一题多考点各计一次,出处带卷名·题号) ③未覆盖考点/缺答案提示 的结构输出;answered < questions 的卷子要提醒官方答案缺失。',
    '2)「复习规划」:按 高频考点(topicStats) × 薄弱程度(weakTopics 的 avgMastery 低/dueCount 高优先) × 课本章定位(topicStats.chapter) 排优先级,每条给出「考点 + 考了几次 + 对应课本章节 + 建议动作」;用户同意后用 manage_todo 落成待办,不要未经同意直接写。',
    weakTopics.length
      ? `- 错题本联动:${weakTopics.length} 个考点在错题本中有卡片,规划时优先照顾 avgMastery 低且 dueCount 高的。`
      : '- 错题本中没有能对上考点标签的卡片:规划只按考频与课本章节排,不要编造薄弱点。',
    unanswered
      ? `- 共 ${unanswered} 题官方答案缺失(answer=null):涉及其的讲解要披露,不得编造答案。`
      : '',
    flaggedCount
      ? `- 共 ${flaggedCount} 题被用户标记「存疑」并已退出拟卷题池;涉及这些题的讲解要提示以原卷原件为准。`
      : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * 创建试卷整理工具（analyze_papers）。一次调用打包三块数据:
 * 试卷清单+题型分布 / 考点考次排行(带课本章) / 错题本弱点联动,
 * 「整理试卷」与「出复习规划」两类指令共用,保证口径一致。
 */
export function createPaperAnalyzeTool(userId: string) {
  return tool({
    description:
      '试卷库整理/分析工具。用户要求「整理试卷」「分析卷子」「看看试卷情况」「总结考点分布」「出复习规划」「安排复习计划」时调用。返回:试卷清单(题量/题型/答案与打标状态)、考点考次排行(带课本章节定位)、错题本弱点考点联动。出复习规划时先调本工具再给结论。注意:「拼卷/拟卷/组卷」类请求不要调用本工具，直接用 compose_paper(自带题源校验)；本工具只服务整理报告与复习规划。',
    inputSchema: paperAnalyzeInputSchema,
    execute: async ({ subject }): Promise<PaperAnalyzeOutput> => {
      try {
        const overview = await getPaperOverview(userId, subject)
        const stats = await getPaperTopicStats(userId, subject)
        const topicStats = stats.slice(0, 15)
        const weakTopics = await getWeakTopics(userId, stats, subject)
        const flaggedCount = await prisma.paperQuestion.count({
          where: { userId: { in: await libraryScopes(userId) }, flagged: true, ...(subject ? { paper: { subject } } : {}) },
        })
        const note =
          overview.length || topicStats.length
            ? buildAnalyzeNote(overview, weakTopics, flaggedCount)
            : '试卷库还没有录入任何试卷。请如实告知用户（可建议把试卷拍照/发文件来录入），不要编造数据。'
        return { overview, topicStats, weakTopics, note }
      } catch (err) {
        const message = err instanceof Error ? err.message : '未知整理错误'
        console.error('[paper-analyze]', message)
        return {
          overview: [],
          topicStats: [],
          weakTopics: [],
          error: message,
          note: '试卷整理暂时不可用。请按你自己的知识回答用户，不要提及检索失败细节。',
        }
      }
    },
  })
}

// ===================== compose_paper 智能拟卷（真题重组卷） =====================

/** 拟卷挂载闸门：归属(自己+公共库)下存在「有官方答案」的题才挂载（重组卷只用有答案池，没答案=不可用） */
export async function hasAnsweredPaperQuestions(userId: string): Promise<boolean> {
  const row = await prisma.paperQuestion.findFirst({
    where: { userId: { in: await libraryScopes(userId) }, answer: { not: null }, flagged: false },
    select: { id: true },
  })
  return !!row
}

/**
 * 创建智能拟卷工具（compose_paper）。同位换题组卷：以一套有官方答案的卷为底，
 * 逐槽从其他有答案卷同桶(section/kind/score)换题；候选池只含有官方答案且未拉黑的题，
 * 结构自检(答案编号对位/选项字母范围)不过的题不进池。写入类工具：临时/对比模式不挂载。
 */
export function createComposePaperTool(userId: string) {
  return tool({
    description:
      '智能拟卷工具（真题重组卷）。用户要求「拼一套卷/拟一张卷/出一张卷子做/组卷/重新拼一张」时调用。' +
      '从用户试卷库的有官方答案的真题里同位换题组卷：卷子结构仿底卷真题、每题带官方答案、可打印。' +
      '难度定位（学考/期末/高考）决定底卷与题源——用户未明确难度时先问清再调用，明确了就把同难度段真题的 slug 传 baseSlug。' +
      '用户给出明确结构/大纲（如「选择10道各3分+解答3道各12分」「学考结构，只出函数」）时解析成 slotDefs 走大纲模式，底卷失效。' +
      '题源与答案零 AI 编造；组卷后在卷面页可换题/删题/加题/整卷重摇（大纲卷无底卷、重摇不可用）。',
    inputSchema: composePaperInputSchema,
    execute: async ({ subject, onlyChoice, baseSlug, slotDefs, title, allowAiAnswers }): Promise<ComposePaperOutput> => {
      try {
        const result = await composePaper(userId, { subject, onlyChoice, baseSlug, slotDefs, title, allowAiAnswers })
        if (!result.ok) {
          return {
            ok: false,
            reason: result.reason,
            note:
              result.reason === 'bad_outline'
                ? '大纲槽位定义无效（题型/分值/题数不合法或全为空）。请与用户确认大纲后重新解析，不要编造卷子。'
                : '该学科试卷库里还没有带官方答案的题，组不了卷。请如实告知用户（可建议把官方答案卷拍照/发文件来录入后再组）；' +
                  '并询问用户是否接受 AI 参考答案组卷——参考答案由 AI 解题生成、非官方，卷面答案页会逐题标注；' +
                  '用户明确接受后以 allowAiAnswers=true 重试。不要编造卷子或题；也不要转为在聊天里手拟题目冒充重组卷。',
          }
        }
        const paper = result.composedId ? await getComposedPaper(userId, result.composedId) : null
        const aiCount = paper ? paper.slots.filter((s) => s.answerSource === 'ai').length : 0
        const officialCount = (paper?.slots.length ?? 0) - aiCount
        const shortageNote = (result.shortages ?? [])
          .map((s) => `${s.kind === 'choice' ? '选择题' : '解答/填空题'}${s.score}分:要 ${s.requested} 道,真题池只有 ${s.filled} 道`)
          .join('；')
        return {
          ok: true,
          composedId: result.composedId,
          url: result.composedId ? `/papers/composed/${result.composedId}` : undefined,
          title: result.title,
          questionCount: paper?.slots.length ?? 0,
          totalScore: paper?.totalScore ?? 0,
          durationMin: paper?.durationMin ?? 0,
          sources: paper?.sources ?? [],
          shortages: result.shortages,
          note: [
            '组卷完成。使用纪律:',
            aiCount > 0
              ? `- 题目出自真题卷原文;答案:${officialCount} 题官方、${aiCount} 题 AI 参考答案(非官方,答案页已逐题标注)。给用户的话术必须披露这一点,不得只说「官方答案」。`
              : '- 全部题目与答案均出自官方答案卷原文,零 AI 拟题;来源卷清单已随结果返回。',
            '- 给用户卷面入口(标题+题数/总分/时长),引导点开卷面页;**不要在聊天里重复贴整卷内容**,卷面页里有完整排版与打印按钮。',
            '- 卷面页支持:换一题/移除/加一题/整卷重摇/「这题有误」报错(报错题全局退池,以后不再入卷)。用户要调整时引导去卷面页操作,或用户明确说「第N题换一题」时可用 PATCH 接口代操作。',
            '- 答案页在卷面末尾,打印时自动随卷输出。',
            ...(shortageNote
              ? [`- 大纲有缺口(已有多少放多少):${shortageNote}。如实告知用户,可建议改大纲或补录带官方答案的真题,不要硬凑。`]
              : []),
            ...(slotDefs?.length ? ['- 本卷走大纲模式:无底卷,整卷重摇不可用;用户要调整结构建议重建一张。'] : []),
          ].join('\n'),
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : '未知组卷错误'
        console.error('[paper-compose]', message)
        return {
          ok: false,
          error: message,
          note: '组卷暂时不可用。请如实告知用户稍后再试，不要编造卷子，不要提及失败细节。',
        }
      }
    },
  })
}
