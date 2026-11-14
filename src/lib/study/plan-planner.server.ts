/**
 * 冲刺计划排期引擎(阶段四方案A「AI 排期 + 学习台任务条」)。
 *
 * 候选池 = 错题本按考点聚合(均掌握度/卡数/可重做数/题库可变式数),掌握度低的先出场。
 * 编排两级:①AI(沿用用户最近对话模型,tagging.ts 同款解析范式)生成逐日任务,
 * 严格校验候选池内合法;②任何失败(AI 不可用/欠费/JSON 不合法)降级确定性摊排——
 * 每天固定 3 项,考点按掌握度升序轮转,cards/redo/variant 依素材可用性取舍。
 * 所以 DeepSeek 欠费 / 无可用模型时功能照常,只是排法退化为纯算法。
 */
import { generateText } from 'ai'
import { resolveStudyModel } from '@/lib/study/tagging'

export interface PlannerTopic {
  topic: string
  masteryAvg: number
  cards: number
  redo: number
  variants: number
}

export interface PlannedItem {
  /** 归属日本地 0 点 */
  date: Date
  topic: string
  kind: 'cards' | 'redo' | 'variant'
  target: number
}

const PER_DAY = 3
const MAX_DAYS = 21

/** 单考点的候选任务形态(按掌握度决定出场顺序:弱的先重做,强的先过卡) */
function itemsForTopic(t: PlannerTopic): Array<{ kind: PlannedItem['kind']; target: number }> {
  const weak = t.masteryAvg < 0.45
  const raw: Array<{ kind: PlannedItem['kind']; target: number }> = []
  if (t.cards > 0) raw.push({ kind: 'cards', target: Math.min(t.cards, 6) })
  if (t.redo > 0) raw.push({ kind: 'redo', target: Math.min(t.redo, 5) })
  if (t.variants > 0) raw.push({ kind: 'variant', target: Math.min(t.variants, 3) })
  return weak ? [raw[1], raw[0], raw[2]].filter(Boolean) : raw
}

/** 确定性摊排:考点升序展开成任务流,按天切片;池不够则整池重循环(同日尽量不重考点) */
export function planDeterministically(topics: PlannerTopic[], days: number): PlannedItem[] {
  const sorted = [...topics].sort((a, b) => a.masteryAvg - b.masteryAvg)
  const pool = sorted.flatMap((t) => itemsForTopic(t).map((it) => ({ topic: t.topic, ...it })))
  if (pool.length === 0) return []
  const out: PlannedItem[] = []
  let cursor = 0
  for (let d = 0; d < days; d++) {
    const date = new Date()
    date.setHours(0, 0, 0, 0)
    date.setDate(date.getDate() + d)
    const usedTopics = new Set<string>()
    let placed = 0
    // 每天最多扫两圈池子,凑满 PER_DAY 或确认无可排;同一天不重复同一考点
    for (let scan = 0; scan < pool.length * 2 && placed < PER_DAY; scan++) {
      const cand = pool[cursor % pool.length]
      cursor++
      if (usedTopics.has(cand.topic)) continue
      usedTopics.add(cand.topic)
      out.push({ date: new Date(date), topic: cand.topic, kind: cand.kind, target: cand.target })
      placed++
    }
  }
  return out
}

/** AI 编排:输出严格 JSON,校验全部通过才采用;失败/越界返回 null(调用方降级) */
export async function planWithAI(
  userId: string,
  topics: PlannerTopic[],
  days: number,
  examName: string | null,
): Promise<PlannedItem[] | null> {
  let model = null
  try {
    model = await resolveStudyModel(userId)
  } catch {
    model = null
  }
  if (!model || topics.length === 0) return null
  const dayList: string[] = []
  for (let d = 0; d < days; d++) {
    const date = new Date()
    date.setHours(0, 0, 0, 0)
    date.setDate(date.getDate() + d)
    dayList.push(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`)
  }
  const system =
    '你是复习计划排期助手。根据给出的考点统计(掌握度越低越急)和可用素材量,为考前每一天编排复习任务。' +
    '输出严格的 JSON:{"items":[{"date":"YYYY-MM-DD","topic":"考点","kind":"cards|redo|variant","target":数量}]}。' +
    '规则:date 只能用给出的日期列表;topic 只能用给出的考点;kind 取值 cards(翻卡自评)/redo(重做题库原题)/variant(同考点变式),' +
    '且该考点对应素材数为 0 的形态不许排;target 不超过对应素材量;每天 3 项;掌握度低的考点尽早出现。只输出 JSON。'
  const prompt =
    `考试:${examName ?? ' upcoming exam'};今天起的排期日:${dayList.join(',')}。\n` +
    `考点统计(JSON):${JSON.stringify(topics.map((t) => ({ topic: t.topic, mastery: Math.round(t.masteryAvg * 100) + '%', 翻卡素材: t.cards, 可重做: t.redo, 可变式: t.variants })))}\n\nJSON:`
  try {
    const { text } = await generateText({ model, system, prompt, temperature: 0.2 })
    const raw = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
    const parsed = JSON.parse(raw) as { items?: Array<{ date?: string; topic?: string; kind?: string; target?: number }> }
    if (!Array.isArray(parsed.items) || parsed.items.length === 0) return null
    const validTopics = new Set(topics.map((t) => t.topic))
    const daySet = new Set(dayList)
    const poolByTopic = new Map(topics.map((t) => [t.topic, t]))
    const out: PlannedItem[] = []
    for (const it of parsed.items.slice(0, MAX_DAYS * PER_DAY)) {
      if (!it.date || !it.topic || !daySet.has(it.date) || !validTopics.has(it.topic)) return null
      const kind = it.kind === 'cards' || it.kind === 'redo' || it.kind === 'variant' ? it.kind : null
      if (!kind) return null
      const stat = poolByTopic.get(it.topic)!
      const cap = kind === 'cards' ? stat.cards : kind === 'redo' ? stat.redo : stat.variants
      if (cap <= 0) return null
      const target = Math.max(1, Math.min(Number(it.target) || cap, cap))
      const [y, m, d] = it.date.split('-').map(Number)
      out.push({ date: new Date(y, m - 1, d), topic: it.topic, kind, target })
    }
    return out.length > 0 ? out : null
  } catch (err) {
    console.error('[plan-planner] AI arrange failed, fallback deterministic:', err)
    return null
  }
}
