/**
 * 拟卷多源出题服务:组卷 AI 兜底(generateFillQuestions,四路资源 grounding)/
 * 举一反三指定原题变式(generateQuestionVariants,卷面面板用)。
 * 输出 InlineQuestionDef(题干/选项/答案/溯源),由 compose 引擎写入内联槽——
 * 卷面按来源标注(课本·xx / AI 拟题),真题槽不受影响。
 * 模型走 resolveChatModel 同口径;生成失败抛错,引擎降级为缺口(绝不静默编题)。
 */
import { generateText } from 'ai'
import { resolveChatModel } from './model-resolver.server'
import { searchKnowledgeChunks } from './knowledge-tool-server'
import { executeQianfanSearch } from './search-engines/qianfan'
import { executeTavilySearch } from './search-engines/tavily'
import { executeDeepseekSearch } from './search-engines/deepseek'

export interface InlineQuestionDef {
  stem: string
  options: string[]
  answer: string
  kind: 'choice' | 'answer'
  score: number
  source: 'textbook' | 'ai-variant' | 'web'
  sourceRef: string
}

const CHOICE_SCORE = 3
const ANSWER_SCORE = 8

/** 考点词切分:整串保留 + 分隔词 + 复合词的 3 字滑窗(compose 引擎与生成器共用) */
export function topicTokens(topics: string[]): string[] {
  const out = new Set<string>()
  for (const t of topics) {
    const st = t.trim()
    if (st.length >= 2) out.add(st)
    for (const w of st.split(/[s、/／,，;；+&·]+/)) {
      if (w.length >= 2) out.add(w)
      if (w.length >= 4) {
        for (let i = 0; i + 3 <= w.length; i++) out.add(w.slice(i, i + 3))
      }
    }
  }
  return Array.from(out)
}

function extractJsonArray(text: string): Array<Record<string, unknown>> {
  const m = text.match(/\[[\s\S]*\]/)
  if (!m) throw new Error('no_json_array')
  const parsed = JSON.parse(m[0])
  return Array.isArray(parsed) ? parsed : []
}

async function genModel(userId: string, modelId: string) {
  const r = await resolveChatModel({ userId, modelId, logTag: '[paper-gen]' })
  if (!r.ok) throw new Error('model_resolve_failed')
  return r.provider(r.realModelId)
}

/** 学科中文标签(生成器 prompt/检索词用;与 compose 引擎对齐,独立副本避免循环依赖) */
const SUBJECT_LABELS: Record<string, string> = {
  math: '数学', chinese: '语文', english: '英语', physics: '物理', chemistry: '化学',
  biology: '生物', history: '历史', geography: '地理', politics: '政治', other: '综合',
}
const subjectLabel = (subject: string) => SUBJECT_LABELS[subject] ?? subject

/** 选择题答案字母越界检查(与 compose 引擎 getIntegrityIssues 同口径:先剥「N.」编号再取首字母;
 *  无字母前缀宽容放行)。返回 false = 该题丢弃 */
function choiceLetterOk(answer: string, optionCount: number): boolean {
  const numMatch = /^(\d+)\s*[.、．]/.exec(answer)
  const stripped = numMatch ? answer.slice(numMatch[0].length) : answer
  const letterMatch = /^\s*[.、．:：]?\s*([A-Z])\b/.exec(stripped)
  return !letterMatch || letterMatch[1].charCodeAt(0) - 65 < optionCount
}

/** 四路资源上下文(组卷引擎每次组卷收集一次,拟题时作 grounding/风格/倾向输入):
 *  ①课本知识库(grounding)②真题库风格参考 ③错题本薄弱考点(倾向)④联网搜索(grounding fallback) */
export interface FillContext {
  /** 真题库风格参考(格式化好的题面文本,只学格式/难度/设问,不照抄) */
  styleRefs: string[]
  /** 错题本薄弱考点(按掌握度从低到高,≤6 个) */
  weakTopics: string[]
  /** 联网搜索配置(课本无内容时的第二级 grounding);null = 无可用引擎 key */
  web: { engine: 'qianfan' | 'tavily' | 'deepseek'; apiKey: string } | null
  /** 组卷表单「给 AI 的备注」(如「挑考得最多的题型」):原样进 prompt,用户口径优先但不违背题型/分值钉死 */
  userNote?: string
}

/** 单次联网 grounding:query = 学科+考点+题型,取前 3 条(标题+摘要)。失败/零结果 → null(降级为无溯源拟题) */
async function webGrounding(
  web: NonNullable<FillContext['web']>,
  subject: string,
  topic: string,
  kindLabel: string
): Promise<{ context: string; ref: string } | null> {
  const query = [subjectLabel(subject), topic, kindLabel, '典型例题'].filter(Boolean).join(' ').slice(0, 60)
  try {
    const results =
      web.engine === 'qianfan'
        ? await executeQianfanSearch(query, web.apiKey, 4)
        : web.engine === 'tavily'
          ? await executeTavilySearch(query, web.apiKey, 4)
          : await executeDeepseekSearch(query, web.apiKey, 4)
    const usable = results
      .filter((r) => (r.title ?? '').trim() || (r.snippet ?? '').trim())
      .slice(0, 3)
    if (!usable.length) return null
    return {
      context: usable.map((r) => `【${(r.title ?? '').trim()}】\n${(r.snippet ?? '').trim().slice(0, 400)}`).join('\n\n'),
      ref: `联网检索·${query.slice(0, 24)}`,
    }
  } catch {
    return null
  }
}

/** 严格按 kind 归一(与 getIntegrityIssues 同口径):选择题选项 <2 或字母越界丢弃;
 *  解答题一律清空 options;题型/分值/溯源钉死,不信任模型自报 */
function normalizeFillItems(
  items: Array<Record<string, unknown>>,
  kind: 'choice' | 'answer',
  score: number,
  ref: string,
  source: InlineQuestionDef['source']
): InlineQuestionDef[] {
  const out: InlineQuestionDef[] = []
  for (const it of items) {
    const stem = typeof it.stem === 'string' ? it.stem.trim() : ''
    const answer = typeof it.answer === 'string' ? it.answer.trim() : ''
    if (!stem || !answer) continue
    const options = Array.isArray(it.options) ? it.options.filter((o): o is string => typeof o === 'string' && !!o.trim()) : []
    if (kind === 'choice') {
      if (options.length < 2 || !choiceLetterOk(answer, options.length)) continue
      out.push({ stem, options: options.slice(0, 8), answer, kind, score, source, sourceRef: ref })
    } else {
      out.push({ stem, options: [], answer, kind, score, source, sourceRef: ref })
    }
  }
  return out
}

const FILL_CHUNK = 6
const FILL_MAX_ROUNDS = 8

/**
 * 组卷 AI 兜底拟题(四路资源齐上):课本 grounding → 联网 fallback →
 * 真题风格参考 + 错题本薄弱考点进 prompt。grounding='textbook-first' 时课本与联网都不可用
 * 抛 no_grounding(调用方降级到 grounding='none' 的纯 AI 举一反三,预算仍受控)。
 * 题型/分值钉死;分块 ≤6 防长输出截断;块间按题干去重。
 * 卷面溯源:课本 ground → source=textbook(ref 课本·书·节);联网 ground / 纯 AI → source=ai-variant(ref 联网检索·… / AI 拟题·…)。
 */
export async function generateFillQuestions(opts: {
  userId: string
  subject: string
  /** 考点(大题名清洗后);空 = 学科级泛出题 */
  topic: string
  kind: 'choice' | 'answer'
  score: number
  count: number
  modelId: string
  grounding: 'textbook-first' | 'none'
  ctx: FillContext
}): Promise<InlineQuestionDef[]> {
  const kindLabel = opts.kind === 'choice' ? '选择题' : '解答/填空题'
  const topicLabel = opts.topic || `${subjectLabel(opts.subject)}综合`
  const noGroundRef = `AI 拟题·${topicLabel.slice(0, 20)}`

  // grounding 一次定盘(同调用同考点,分块共用):课本命中 → 用课本;否则联网;都没有按 grounding 模式处理
  let grounded: { context: string; ref: string; source: InlineQuestionDef['source'] } | null = null
  let settled = false
  const settleGrounding = async () => {
    if (opts.grounding !== 'textbook-first' || settled) return grounded
    settled = true
    const searchQuery = topicTokens([opts.topic || subjectLabel(opts.subject)]).slice(0, 5).join(' ')
    try {
      const hits = await searchKnowledgeChunks(opts.userId, searchQuery, opts.subject, 'textbook')
      if (hits.length) {
        const h = hits[0]
        grounded = {
          context: hits
            .slice(0, 2)
            .map((x) => `【${x.doc}${x.section ? `·${x.section}` : x.chapter ? `·${x.chapter}` : ''}】\n${x.content.slice(0, 1200)}`)
            .join('\n\n'),
          ref: `课本·${h.doc}${h.section ? `·${h.section}` : h.chapter ? `·${h.chapter}` : ''}`,
          source: 'textbook',
        }
        return grounded
      }
    } catch {
      // 课本检索失败 → 联网兜底
    }
    const web = opts.ctx.web ? await webGrounding(opts.ctx.web, opts.subject, opts.topic, kindLabel) : null
    if (web) grounded = { context: web.context, ref: web.ref, source: 'ai-variant' }
    return grounded
  }

  const model = await genModel(opts.userId, opts.modelId)
  const styleBlock = opts.ctx.styleRefs.length
    ? `\n\n该科真题的风格参考(只参考格式/难度/设问方式,绝对不要照抄题目内容):\n${opts.ctx.styleRefs.join('\n\n').slice(0, 2000)}`
    : ''
  const weakBlock = opts.ctx.weakTopics.length
    ? `\n\n用户近期的薄弱考点(出题角度可自然向这些考点倾斜,不必生硬捆绑):${opts.ctx.weakTopics.join('、')}`
    : ''
  const noteBlock = opts.ctx.userNote?.trim()
    ? `\n\n用户的组卷备注(在不违背题型/分值/参考资料要求的前提下照办):「${opts.ctx.userNote.trim().slice(0, 100)}」`
    : ''

  const out: InlineQuestionDef[] = []
  const seenStems = new Set<string>()
  let remaining = Math.max(1, Math.round(opts.count))
  for (let round = 0; round < FILL_MAX_ROUNDS && remaining > 0; round++) {
    const g = await settleGrounding()
    if (opts.grounding === 'textbook-first' && !g) throw new Error('no_grounding')
    const n = Math.min(FILL_CHUNK, remaining)
    const source = g?.source ?? 'ai-variant'
    const ref = g?.ref ?? noGroundRef
    const { text } = await generateText({
      model,
      system:
        '你是试卷出题助手。要求:题意完整自洽,题干不出现「根据上文/如图」这类缺失材料的表述;' +
        (g
          ? '题目必须紧扣给定参考资料,答案要能从资料内容推出或计算得到;'
          : '') +
        (opts.kind === 'choice'
          ? '只输出一个 JSON 数组,不要输出任何其他文字或代码围栏。每个元素:{"stem":"题干","options":["A. …","B. …","C. …","D. …"],"answer":"答案字母\\n解析:…"}。options 给 4 个,答案必须是选项字母+简要解析。'
          : '只输出一个 JSON 数组,不要输出任何其他文字或代码围栏。每个元素:{"stem":"题干","options":[],"answer":"完整解答过程与最终答案"}。options 一律给空数组 [],answer 写完整解答。'),
      prompt:
        `出 ${n} 道「${topicLabel}」的${kindLabel},每道 ${opts.score} 分,题目之间不重复,出题角度多样化。` +
        (g ? `\n\n参考资料(必须紧扣):\n${g.context}` : '') +
        styleBlock +
        weakBlock +
        noteBlock,
    })
    const fresh = normalizeFillItems(extractJsonArray(text), opts.kind, opts.score, ref, source).filter((q) => {
      if (seenStems.has(q.stem)) return false
      seenStems.add(q.stem)
      return true
    })
    const produced = Math.min(fresh.length, remaining)
    out.push(...fresh.slice(0, produced))
    remaining -= produced
    // 模型一块连一道有效题都没给 → 止损,不无限重试
    if (fresh.length === 0) break
  }
  return out
}

const VARIANT_DIFFICULTIES = ['basic', 'medium', 'hard'] as const
export type VariantQuestionDef = InlineQuestionDef & { difficulty: (typeof VARIANT_DIFFICULTIES)[number] }

/** 举一反三(指定原题):以一道真题为种子出同考点同题型变式,难度递进(第 1 道与原题相当,后面逐道稍难)。
 *  与组卷兜底 generateFillQuestions(缺口维度)的区别:钉死原题题型/分值/设问结构,变式可直接加入同型槽位。
 *  答案为 AI 拟答;是否落库由调用方决定(面板预览 → 收进题库/加入本卷)。
 *  归一口径与 compose 引擎自检一致:选择题选项不足 2 或答案字母越界的丢弃,无字母前缀宽容放行。 */
export async function generateQuestionVariants(opts: {
  userId: string
  seed: { stem: string; options: string[]; answer: string; kind: string; score: number }
  count: number
  modelId: string
  /** 变式溯源(真实出处,不信任模型):如「举一反三 · 卷名 第N题」 */
  sourceRef: string
}): Promise<VariantQuestionDef[]> {
  const seed = opts.seed
  const isChoice = seed.kind === 'choice'
  const kindLabel = isChoice ? '选择题' : '解答/填空题'
  const model = await genModel(opts.userId, opts.modelId)
  const { text } = await generateText({
    model,
    system:
      `你是试卷出题助手,擅长举一反三:基于给定原题出同考点、同题型的变式题——变情境、变数字、变问法,` +
      `但保持${kindLabel}的题型与设问结构不变,不照抄原题的数字与情境;题目之间不重复,按难度递进排列(第 1 道与原题难度相当,后面逐道稍难)。` +
      '只输出一个 JSON 数组,不要输出任何其他文字或代码围栏。每个元素:' +
      '{"stem":"题干","options":["A. …","B. …","C. …","D. …"],"answer":"答案字母\\n解析:…","difficulty":"basic|medium|hard"}。' +
      '选择题 options 给 4 个;解答/填空题 options 给空数组 []。答案必须自带简要解析,difficulty 取 basic/medium/hard。',
    prompt:
      `参考下面的原题(题型:${kindLabel},分值 ${seed.score} 分),出 ${opts.count} 道变式题(只参考考点与题型,不要照抄):\n` +
      `${[seed.stem, ...seed.options].join('\n').slice(0, 900)}\n\n` +
      `(原题参考答案,供对齐答案格式与解析粒度,不要照抄答案内容:\n${seed.answer.slice(0, 400)})`,
  })
  const out: VariantQuestionDef[] = []
  for (const it of extractJsonArray(text)) {
    const stem = typeof it.stem === 'string' ? it.stem.trim() : ''
    const answer = typeof it.answer === 'string' ? it.answer.trim() : ''
    if (!stem || !answer) continue
    const options = Array.isArray(it.options) ? it.options.filter((o): o is string => typeof o === 'string' && !!o.trim()) : []
    if (isChoice && (options.length < 2 || !choiceLetterOk(answer, options.length))) continue
    const difficulty =
      typeof it.difficulty === 'string' && (VARIANT_DIFFICULTIES as readonly string[]).includes(it.difficulty)
        ? (it.difficulty as VariantQuestionDef['difficulty'])
        : 'medium'
    out.push({
      stem,
      options: isChoice ? options.slice(0, 8) : [],
      answer,
      kind: isChoice ? 'choice' : 'answer',
      score: seed.score > 0 ? seed.score : isChoice ? CHOICE_SCORE : ANSWER_SCORE,
      source: 'ai-variant',
      sourceRef: opts.sourceRef,
      difficulty,
    })
  }
  return out.slice(0, opts.count)
}
