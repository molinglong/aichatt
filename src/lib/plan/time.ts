/**
 * 今日计划时间工具(原 plan/src/lib/time.ts 整搬)。
 *
 * DAY_START=6:00 / DAY_END=24:00 与时间轴刻度、排程窗口、quick-parse 共用。
 */

export const DAY_START = 6 * 60
export const DAY_END = 24 * 60

export function fmtTime(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export function fmtDuration(min: number): string {
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m ? `${h}h${m}m` : `${h}h`
}

export function nowMinutes(): number {
  const d = new Date()
  return d.getHours() * 60 + d.getMinutes()
}

export function todayParts() {
  const d = new Date()
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
  return {
    md: `${d.getMonth() + 1}月${d.getDate()}日`,
    week,
  }
}

/** 本地时区的 YYYY-MM-DD,不能用 toISOString(会按 UTC 跨天) */
export function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`
}

/** "HH:MM" → 当日分钟数;非法输入返回 null */
export function parseTimeInput(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return null
  const h = Number(match[1])
  const m = Number(match[2])
  if (h > 23 || m > 59) return null
  return h * 60 + m
}

/** 新建固定事件的默认时段:下一个整/半点,避开深夜 */
export function defaultEventRange(): { startMin: number; endMin: number } {
  const now = nowMinutes()
  let start = Math.ceil(now / 30) * 30
  if (start < 9 * 60) start = 9 * 60
  if (start >= 23 * 60) start = 19 * 60
  return { startMin: start, endMin: Math.min(DAY_END, start + 60) }
}

export interface FreeGap {
  startMin: number
  endMin: number
}

/** 从当前时刻起找下一段成块空档;找不到返回 null */
export function nextFreeGap(
  items: { startMin?: number; endMin?: number }[],
  minMinutes = 20
): FreeGap | null {
  let cursor = Math.max(nowMinutes(), DAY_START)
  if (cursor >= DAY_END) return null

  const busy = items
    .filter((i) => i.startMin != null && i.endMin != null)
    .map((i) => ({ startMin: i.startMin!, endMin: i.endMin! }))
    .sort((a, b) => a.startMin - b.startMin)

  for (const block of busy) {
    if (block.endMin <= cursor) continue
    if (block.startMin - cursor >= minMinutes) {
      return { startMin: cursor, endMin: Math.min(block.startMin, DAY_END) }
    }
    cursor = Math.max(cursor, block.endMin)
    if (cursor >= DAY_END) return null
  }

  if (DAY_END - cursor >= minMinutes) return { startMin: cursor, endMin: DAY_END }
  return null
}

export function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && aEnd > bStart
}
