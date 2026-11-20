/**
 * 词汇 FSRS 封装（4 档评级）——与 lib/study/fsrs.ts 同一套 ts-fsrs 调度器，
 * 差别只在评级口径：错题本是 2 键自评（想起/卡住），单词是 4 档
 * （Again=忘记 / Hard=模糊 / Good=认识 / Easy=秒答），拼写卡由程序判分映射到同一口径。
 *
 * 掌握度规则：Again -0.25 / Hard -0.10 / Good +0.15 / Easy +0.25，夹在 0..1。
 */
import { createEmptyCard, fsrs, generatorParameters, Rating, type Card } from 'ts-fsrs'

/** 1=Again 2=Hard 3=Good 4=Easy（与 ts-fsrs Rating 枚举同值） */
export type WordRating = 1 | 2 | 3 | 4

export const WORD_RATING_LABELS: Record<WordRating, string> = {
  1: '忘记',
  2: '模糊',
  3: '认识',
  4: '秒答',
}

/** UserWord 行里参与 FSRS 计算的字段（直接传 prisma 行） */
export interface WordFsrsInput {
  mastery: number
  stability: number | null
  difficulty: number | null
  state: number
  dueAt: Date | null
  lastReviewAt: Date | null
  reps: number
  lapses: number
}

const scheduler = fsrs(generatorParameters({ enable_fuzz: true }))

const MASTERY_DELTA: Record<WordRating, number> = { 1: -0.25, 2: -0.1, 3: 0.15, 4: 0.25 }

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n))
}

/** DB 行 → ts-fsrs Card（与错题本同一重建口径） */
export function toWordCard(f: WordFsrsInput): Card {
  return {
    due: f.dueAt ?? new Date(),
    stability: f.stability ?? 0,
    difficulty: f.difficulty ?? 0,
    elapsed_days: 0,
    scheduled_days: 0,
    reps: f.reps,
    lapses: f.lapses,
    learning_steps: 0,
    state: (f.state ?? 0) as Card['state'],
    last_review: f.lastReviewAt ?? undefined,
  }
}

/** 新词进队时的初始 FSRS 字段（due=now，当天即可复习） */
export function newWordCardFields(now = new Date()) {
  const c = createEmptyCard(now)
  return {
    stability: c.stability,
    difficulty: c.difficulty,
    state: c.state as number,
    dueAt: c.due,
    reps: 0,
    lapses: 0,
  }
}

/** 评级 → 新调度状态 + 掌握度 + 落库用字段 */
export function scheduleWord(f: WordFsrsInput, rating: WordRating, now = new Date()) {
  const card = toWordCard(f)
  const next = scheduler.repeat(card, now)[rating].card
  const mastery = clamp01(f.mastery + MASTERY_DELTA[rating])
  return {
    stability: next.stability,
    difficulty: next.difficulty,
    state: next.state as number,
    dueAt: next.due,
    lastReviewAt: now,
    reps: next.reps,
    lapses: next.lapses,
    mastery,
    ratingValue: rating as number,
    scheduledDays: next.scheduled_days,
  }
}

/**
 * 拼写卡判分 → 评级：
 *   拼错 = 忘记；拼对但超过 8 秒 = 模糊；4~8 秒 = 认识；4 秒内 = 秒答。
 * 阈值先按经验定，之后用 WordReviewLog 的实际数据校准。
 */
export function deriveSpellRating(correct: boolean, elapsedMs: number): WordRating {
  if (!correct) return 1
  if (elapsedMs > 8000) return 2
  if (elapsedMs > 4000) return 3
  return 4
}

/**
 * 卡型选择：新词先认（flip），复习词掌握度到 0.4 才考拼写（spell）。
 * 短语（多词条目）一律不考拼写——默写整句短语意义不大，且空格/连写规则各家不一，
 * 只会制造假错；短语走快认 + 例句语境。
 */
export function defaultCardType(reps: number, mastery: number, isPhrase = false): 'flip' | 'spell' {
  if (isPhrase) return 'flip'
  if (reps === 0) return 'flip'
  return mastery >= 0.4 ? 'spell' : 'flip'
}
