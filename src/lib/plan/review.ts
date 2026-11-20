import type { PlanItem, ReviewResult } from "./types"
import { listForDay } from "./scheduler"

/**
 * 日终复盘(原 plan/server/review.ts 的 Prisma 版):全部是规则,不调 AI。
 *
 * 复盘是每天都要看的东西,稳定比聪明重要;而且这几条判断(顺延太多次、
 * 排得比 8 小时还满)本来就是规则问题,不需要模型。等真需要「为什么今天
 * 崩了」的归因再上 AI。
 */

function nowMinutes() {
  const d = new Date()
  return d.getHours() * 60 + d.getMinutes()
}

function minutesOf(item: PlanItem) {
  if (item.startMin == null || item.endMin == null) return 0
  return Math.max(0, item.endMin - item.startMin)
}

export async function reviewDay(date: string, userId: string): Promise<ReviewResult> {
  const items = await listForDay(date, userId)
  const scheduled = items.filter((i) => i.startMin != null && i.endMin != null)
  const planned = scheduled.length
  const done = scheduled.filter((i) => i.done).length
  const now = nowMinutes()

  // 只统计「已经到点但没勾」的:还没到的块不算失败
  const skipped = scheduled.filter((i) => !i.done && (i.endMin ?? 0) < now).length
  const plannedMinutes = scheduled.reduce((sum, i) => sum + minutesOf(i), 0)
  const doneMinutes = scheduled
    .filter((i) => i.done)
    .reduce((sum, i) => sum + minutesOf(i), 0)
  const rate = planned ? Math.round((done / planned) * 100) : 0

  const postponed = items
    .filter((i) => !i.done && (i.postponeCount ?? 0) >= 2)
    .map((i) => ({ id: i.id, title: i.title, count: i.postponeCount ?? 0 }))
    .sort((a, b) => b.count - a.count)

  const remaining = items.filter((i) => i.status === "inbox" && i.kind !== "memo" && !i.done).length

  let headline: string
  if (planned === 0) headline = "今天还没有排好的计划"
  else if (rate >= 80) headline = "今天基本按计划走完了"
  else if (rate >= 60) headline = "大部分完成了，剩下的是被挤掉的"
  else if (rate >= 30) headline = "完成了一半左右，可能排得比实际满"
  else headline = "今天没怎么动，先看看计划是不是太重"

  const tips: string[] = []

  const top = postponed[0]
  if (top && top.count >= 3) {
    tips.push(`「${top.title}」已经顺延 ${top.count} 次，要么拆小，要么就别做了`)
  } else if (top) {
    tips.push(`「${top.title}」顺延了 ${top.count} 次，明天换个时间试试`)
  }

  if (skipped > 0 && now > 12 * 60) {
    tips.push(
      now > 16 * 60
        ? `有 ${skipped} 项过了时间没勾，别急着补，明天重新排`
        : `已经过了 ${skipped} 项的时间，下午还剩几块，先做手边那个`
    )
  }

  if (plannedMinutes > 8 * 60) {
    tips.push(`今天排了 ${(plannedMinutes / 60).toFixed(1)} 小时，超过 8 小时就不叫计划了`)
  }

  if (remaining > 3) {
    tips.push(`待安排里还有 ${remaining} 项，明天别想着一口气排完`)
  }

  if (tips.length === 0) {
    if (planned === 0) tips.push("先往待安排里记两件小事，再排一次")
    else if (done === 0) tips.push("先挑最小的一件做掉，别从最难的开始")
    else if (planned === done) tips.push("节奏刚好，明天可以再加一点点")
    else tips.push("留白是功能，不是欠账")
  }

  return {
    date,
    planned,
    done,
    skipped,
    rate,
    plannedMinutes,
    doneMinutes,
    remaining,
    postponed,
    headline,
    tips,
  }
}
