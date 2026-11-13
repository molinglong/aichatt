/**
 * 拟卷多源出题服务:课本拟题(textbook)/AI 举一反三变式(ai-variant)。
 * 输出 InlineQuestionDef(题干/选项/答案/溯源),由 compose 引擎写入内联槽——
 * 卷面按来源标注(课本·xx / AI 拟题),真题槽不受影响。
 * 模型走 resolveChatModel 同口径;生成失败抛错,引擎降级为缺口(绝不静默编题)。
 */
import { generateText } from 'ai'
import { resolveChatModel } from './model-resolver.server'
import { searchKnowledgeChunks } from './knowledge-tool-server'

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

/** 从模型输出里抠 JSON 数组(容忍 ```json 围栏与前后废话) */
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

/** 宽松归一:stem/answer 必须非空;有 ≥2 个选项判为选择题;sourceRef 强制用真实溯源(不信任模型编的) */
function normalizeItems(items: Array<Record<string, unknown>>, fallbackRef: string, source: InlineQuestionDef['source']): InlineQuestionDef[] {
  const out: InlineQuestionDef[] = []
  for (const it of items) {
    const stem = typeof it.stem === 'string' ? it.stem.trim() : ''
    const answer = typeof it.answer === 'string' ? it.answer.trim() : ''
    if (!stem || !answer) continue
    const options = Array.isArray(it.options) ? it.options.filter((o): o is string => typeof o === 'string' && !!o.trim()) : []
    const kind: 'choice' | 'answer' = options.length >= 2 ? 'choice' : 'answer'
    out.push({
      stem,
      options: kind === 'choice' ? options : [],
      answer,
      kind,
      score: kind === 'choice' ? CHOICE_SCORE : ANSWER_SCORE,
      source,
      sourceRef: fallbackRef,
    })
  }
  return out
}

async function genModel(userId: string, modelId: string) {
  const r = await resolveChatModel({ userId, modelId, logTag: '[paper-gen]' })
  if (!r.ok) throw new Error('model_resolve_failed')
  return r.provider(r.realModelId)
}

const JSON_FORMAT =
  '只输出一个 JSON 数组,不要输出任何其他文字或代码围栏。每个元素:{"stem":"题干","options":["A. …","B. …","C. …","D. …"],"answer":"答案字母\\n解析:…"}。' +
  '选择题 options 给 4 个;解答/填空题 options 给空数组 []。答案必须自带简要解析。'

/** 课本拟题:按考点检索课本库章节内容 → 依据内容出题(答案可从内容推出),溯源到书名+节 */
export async function generateTextbookQuestions(opts: {
  userId: string
  subject: string
  topic: string
  count: number
  modelId: string
}): Promise<InlineQuestionDef[]> {
  // 检索词用考点滑窗分词:整串 LIKE 命中不了复合考点(「不等式性质求范围」整串 0 命中,滑窗 35)
  const searchQuery = topicTokens([opts.topic]).slice(0, 5).join(' ')
  const hits = await searchKnowledgeChunks(opts.userId, searchQuery, opts.subject, 'textbook')
  if (!hits.length) throw new Error('no_textbook_content')
  const context = hits
    .slice(0, 2)
    .map((h) => `【${h.doc}${h.section ? `·${h.section}` : h.chapter ? `·${h.chapter}` : ''}】\n${h.content.slice(0, 1200)}`)
    .join('\n\n')
  const ref = `${hits[0].doc}${hits[0].section ? `·${hits[0].section}` : hits[0].chapter ? `·${hits[0].chapter}` : ''}`

  const model = await genModel(opts.userId, opts.modelId)
  const { text } = await generateText({
    model,
    system:
      '你是试卷出题助手。依据给定的课本内容出题:紧扣内容、题意完整、答案必须能从内容推出或计算得到。' + JSON_FORMAT,
    prompt: `依据下面的课本内容,出 ${opts.count} 道「${opts.topic}」相关的题目(以选择题为主,可含至多 1 道解答/填空题,题目之间不重复):\n\n${context}`,
  })
  return normalizeItems(extractJsonArray(text), `课本·${ref}`, 'textbook').slice(0, opts.count)
}

/** AI 举一反三:围绕考点(可选种子题)出同考点变式题,答案为 AI 拟答(卷面会标注) */
export async function generateVariantQuestions(opts: {
  userId: string
  subject: string
  topic: string
  seedStem?: string
  count: number
  modelId: string
}): Promise<InlineQuestionDef[]> {
  const model = await genModel(opts.userId, opts.modelId)
  const { text } = await generateText({
    model,
    system:
      '你是试卷出题助手,擅长举一反三:基于考点(或原题)出同考点变式题——变情境、变数字、变问法,但不改变考点与难度,题目之间不重复。' + JSON_FORMAT,
    prompt: `围绕「${opts.topic}」出 ${opts.count} 道变式题。${opts.seedStem ? `参考原题(只参考考点与难度,不要照抄):\n${opts.seedStem.slice(0, 600)}` : '学科:' + opts.subject}`,
  })
  return normalizeItems(extractJsonArray(text), `AI 变式·${opts.topic}`, 'ai-variant').slice(0, opts.count)
}
