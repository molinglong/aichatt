import { createHash } from 'node:crypto'
import { prisma } from '@/lib/db'

/**
 * 短文词集解析（server-only）：基础词 + 复习词 + 预习词 → 最终词集与缓存 key。
 *
 * 两个入口共用这一份逻辑，保证「App 里生成的」和「打印在纸上的」是同一组词、同一个 key：
 *   - POST /api/words/passage（弹层生成）
 *   - /papers/words（背词卷末尾附短文，直接读缓存）
 */

/** 默认掺词数：4 个到期复习词 + 3 个明日预习词（与弹层默认一致） */
export const PASSAGE_REVIEW_COUNT = 4
export const PASSAGE_PREVIEW_COUNT = 3

/** 词集指纹：排序 + 去重后 hash，同一组词不管顺序都命中同一条 */
export function passageKey(words: string[]): string {
  return createHash('sha256').update([...words].sort().join('\u0001')).digest('hex').slice(0, 32)
}

/** 复习词：学过（reps>0）、没暂停、不在今天这组里的，到期优先 */
async function pickReviewWords(userId: string, exclude: Set<string>, count: number): Promise<string[]> {
  if (count <= 0) return []
  const rows = await prisma.userWord.findMany({
    where: { userId, reps: { gt: 0 }, suspended: false, lemma: { notIn: Array.from(exclude) } },
    orderBy: [{ dueAt: 'asc' }, { lastReviewAt: 'asc' }],
    take: count * 3,
    select: { headword: true, lemma: true, entry: { select: { headword: true } } },
  })
  const out: string[] = []
  for (const r of rows) {
    if (r.lemma && exclude.has(r.lemma)) continue
    const w = r.entry?.headword ?? r.headword
    if (!w || exclude.has(w.toLowerCase())) continue
    out.push(w)
    if (out.length >= count) break
  }
  return out
}

/** 预习词：当前计划词单里还没学到的（cursor 之后） */
async function pickPreviewWords(userId: string, exclude: Set<string>, count: number): Promise<string[]> {
  if (count <= 0) return []
  const plan = await prisma.wordPlan.findFirst({
    where: { userId, active: true },
    orderBy: { startedAt: 'desc' },
    select: { listId: true, cursor: true },
  })
  if (!plan?.listId) return []
  const rows = await prisma.dictListItem.findMany({
    where: { listId: plan.listId },
    orderBy: [{ position: 'asc' }, { entryId: 'asc' }],
    skip: plan.cursor,
    take: count * 3,
    include: { entry: { select: { headword: true, lemma: true } } },
  })
  const out: string[] = []
  for (const r of rows) {
    const lemma = r.entry.lemma
    if (exclude.has(lemma)) continue
    out.push(r.entry.headword)
    if (out.length >= count) break
  }
  return out
}

export interface ResolvedPassageWords {
  /** 基础词（今天要背的） */
  base: string[]
  /** 最终词集：基础 + 复习 + 预习 */
  allWords: string[]
  reviewWords: string[]
  previewWords: string[]
  key: string
}

/** 把一批基础词补成「短文用的最终词集」并算好缓存 key */
export async function resolvePassageWords(
  userId: string,
  baseWords: string[],
  reviewCount = PASSAGE_REVIEW_COUNT,
  previewCount = PASSAGE_PREVIEW_COUNT,
): Promise<ResolvedPassageWords> {
  const base = Array.from(new Set(baseWords.map((w) => w.trim()).filter(Boolean))).slice(0, 30)
  const exclude = new Set(base.map((w) => w.toLowerCase()))
  const reviewWords = await pickReviewWords(userId, exclude, reviewCount)
  reviewWords.forEach((w) => exclude.add(w.toLowerCase()))
  const previewWords = await pickPreviewWords(userId, exclude, previewCount)
  const allWords = [...base, ...reviewWords, ...previewWords]
  return { base, allWords, reviewWords, previewWords, key: passageKey(allWords.map((w) => w.toLowerCase())) }
}
