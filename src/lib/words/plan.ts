/**
 * 词汇学习核心（server-only）：计划取词 → 今日队列 → 卡型分配。
 *
 * 取词口径（2026-11-15 定案）：
 *   - 复习：dueAt <= now 且未暂停，按 dueAt 升序，上限 plan.dailyReview（防某天没来之后爆量）；
 *   - 新词：按计划词单的 position 从 plan.cursor 往后取，跳过「我的词」里已有的 lemma
 *     （跨词单去重：同一个词只学一次），上限 dailyNew - 今天已经推过的数量；
 *   - 推进即落库：被取到的词立刻建 UserWord（dueAt=now）并推进 cursor，
 *     不预先给整份词单建行——表不涨，改计划零成本。
 *   - 混排：开头放 2 个新词暖场，之后每 4 张里插 1 个新词，其余按到期顺序。
 */
import { prisma } from '@/lib/db'
import type { Prisma } from '@/generated/prisma/client'
import { defaultCardType, newWordCardFields } from './fsrs'
import type { WordQueue, WordQueueItem, WordQueueSummary } from './types'

export type { WordQueue, WordQueueItem, WordQueueSummary, WordCardType } from './types'

export const DEFAULT_DAILY_NEW = 15
export const DEFAULT_DAILY_REVIEW = 100

/** 今日 0 点（本地时区；计划是「按天」的概念，必须按用户本地日切） */
export function startOfToday(now = new Date()) {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d
}


type UserWordWithEntry = Prisma.UserWordGetPayload<{ include: { entry: true } }>

/** 取当前生效计划；首次访问时自动建一条，尽量挂到最近导入的词单上 */
export async function getActivePlan(userId: string) {
  const existing = await prisma.wordPlan.findFirst({
    where: { userId, active: true },
    orderBy: { startedAt: 'desc' },
    include: { list: true },
  })
  if (existing) return existing

  // 默认词单取最早导入的那份（2026-11-16 定案「统一从高频词开始」）：
  // 频级分册的书（闪过等）总是高频册先导入库，最早导入 = 高频词；
  // 原来取「最近导入」，中频词后导进来，新计划就默认挂到了中频。
  const list = await prisma.dictList.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true, name: true } })
  return prisma.wordPlan.create({
    data: {
      userId,
      name: list ? `${list.name} · 每日计划` : '我的背词计划',
      listId: list?.id ?? null,
      dailyNew: DEFAULT_DAILY_NEW,
      dailyReview: DEFAULT_DAILY_REVIEW,
    },
    include: { list: true },
  })
}

/**
 * 按计划推进新词：从 cursor 往后找 count 个「还没进过我的词」的词，建 UserWord 并推进游标。
 * 返回新建的行（带 entry），用于拼队列。
 */
async function seedNewWords(
  userId: string,
  plan: { id: string; listId: string | null; cursor: number },
  count: number,
): Promise<UserWordWithEntry[]> {
  if (count <= 0 || !plan.listId) return []

  const owned = new Set(
    (await prisma.userWord.findMany({ where: { userId }, select: { lemma: true } })).map((r) => r.lemma),
  )
  const candidates = await prisma.dictListItem.findMany({
    where: { listId: plan.listId, position: { gte: plan.cursor } },
    orderBy: { position: 'asc' },
    take: Math.max(count * 4, 40),
    include: { entry: true },
  })

  const picked: typeof candidates = []
  let nextCursor = plan.cursor
  for (const c of candidates) {
    if (picked.length >= count) break
    nextCursor = Math.max(nextCursor, c.position + 1)
    if (owned.has(c.entry.lemma)) continue
    picked.push(c)
    owned.add(c.entry.lemma)
  }

  const init = newWordCardFields()
  await prisma.$transaction([
    prisma.userWord.createMany({
      data: picked.map((c) => ({
        userId,
        entryId: c.entryId,
        headword: c.entry.headword,
        lemma: c.entry.lemma,
        source: 'plan',
        ...init,
      })),
      skipDuplicates: true,
    }),
    // 游标一律前进（哪怕这次一个都没取到），避免到底后每次全表扫
    prisma.wordPlan.update({ where: { id: plan.id }, data: { cursor: nextCursor } }),
  ])

  if (!picked.length) return []
  const rows = await prisma.userWord.findMany({
    where: { userId, lemma: { in: picked.map((c) => c.entry.lemma) } },
    include: { entry: true },
  })
  // 按词单顺序回排：findMany 不保证顺序，直接返回会让「按书背」变成随机顺序
  const byLemma = new Map(rows.map((r) => [r.lemma, r]))
  return picked.map((c) => byLemma.get(c.entry.lemma)).filter((r): r is UserWordWithEntry => !!r)
}

function toItem(w: UserWordWithEntry, isNew: boolean): WordQueueItem {
  const e = w.entry
  return {
    id: w.id,
    entryId: w.entryId,
    card: defaultCardType(w.reps, w.mastery, e?.isPhrase ?? false),
    headword: e?.headword ?? w.headword,
    lemma: w.lemma,
    isPhrase: e?.isPhrase ?? /\s/.test(w.headword),
    phoneticUs: e?.phoneticUs ?? null,
    phoneticUk: e?.phoneticUk ?? null,
    pos: e?.pos ?? null,
    trans: e?.trans ?? w.trans ?? null,
    definition: e?.definition ?? null,
    exchange: e?.exchange ?? null,
    senses: e?.senses ?? null,
    examples: e?.examples ?? null,
    collocations: e?.collocations ?? null,
    mnemonic: e?.mnemonic ?? null,
    tags: e?.tags ?? [],
    reps: w.reps,
    lapses: w.lapses,
    mastery: w.mastery,
    isNew,
  }
}

/** 队列分组顺序(Alan 范式):先复习旧词清旧债,再学新词 —— 不再 2 新 4 复混插 */

/** 组装今日队列（含按计划推进新词） */
export async function buildQueue(userId: string): Promise<WordQueue> {
  const plan = await getActivePlan(userId)
  const now = new Date()
  const dayStart = startOfToday(now)

  const [dueRows, todayNewDone, learning, mastered] = await Promise.all([
    // 复习桶只收「学过至少一遍」的词:新词卡初始 due=now,不过滤 reps=0 时,
    // 二次进队(评完一轮再进/中途退出再进)的新词会全部掉进复习桶,以复习身份出现。
    prisma.userWord.findMany({
      where: { userId, suspended: false, dueAt: { lte: now }, reps: { gt: 0 } },
      orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
      take: plan.dailyReview,
      include: { entry: true },
    }),
    prisma.userWord.count({ where: { userId, source: 'plan', createdAt: { gte: dayStart } } }),
    prisma.userWord.count({ where: { userId, reps: { gt: 0 } } }),
    prisma.userWord.count({ where: { userId, mastery: { gte: 0.8 } } }),
  ])

  const freshCount = Math.max(0, plan.dailyNew - todayNewDone)
  const freshRows = await seedNewWords(userId, plan, freshCount)

  // 新词桶 = 刚推进的 + 之前入队但还没学过(reps=0)的;上限对齐复习桶,防历史积压一次灌爆
  const pendingNewRows = await prisma.userWord.findMany({
    where: { userId, suspended: false, reps: 0 },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 100,
    include: { entry: true },
  })

  const dueItems = dueRows.map((w) => toItem(w, false))
  const freshItems = pendingNewRows.map((w) => toItem(w, true))

  return {
    items: [...dueItems, ...freshItems],
    summary: {
      planId: plan.id,
      planName: plan.name,
      listName: plan.list?.name ?? null,
      dailyNew: plan.dailyNew,
      dailyReview: plan.dailyReview,
      todayNewDone: todayNewDone + freshRows.length,
      due: dueRows.length,
      fresh: pendingNewRows.length,
      learning,
      mastered,
    },
  }
}
