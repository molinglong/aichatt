import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'

/**
 * GET /api/study/stats - 复习统计(统计弹层数据源)
 * 返回:连击天数 / 今日已复习 / 待到期 / 近 7 日量 / 近半年热力图 / 考点掌握度排行(低的在前)。
 * 热力图口径:按复习日志 ratedAt(本地时区)计每日复习张数,固定回看 182 天(26 周,约半年)。
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }
  const userId = session.user.id

  try {
    const since = new Date(Date.now() - 182 * 86_400_000)
    const logs = await prisma.studyNoteReviewLog.findMany({
      where: { note: { userId }, ratedAt: { gte: since } },
      select: { ratedAt: true },
      orderBy: { ratedAt: 'asc' },
    })

    // 本地日历日 → 计数(ratedAt UTC → 本地 Y/M/D 再拼 key,避免 UTC 日界吞掉晚间复习)
    const dayKey = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const countByDay = new Map<string, number>()
    for (const log of logs) {
      const key = dayKey(new Date(log.ratedAt))
      countByDay.set(key, (countByDay.get(key) ?? 0) + 1)
    }

    // 182 天序列(旧→新),本地 0 点锚点
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const heatmap: Array<{ date: string; count: number }> = []
    for (let i = 181; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86_400_000)
      const key = dayKey(d)
      heatmap.push({ date: key, count: countByDay.get(key) ?? 0 })
    }

    // 连击:从今天(今天没复习则从昨天)往回数连续非零日
    let streakDays = 0
    const startOffset = (countByDay.get(dayKey(today)) ?? 0) > 0 ? 0 : 1
    for (let i = startOffset; i < 365; i++) {
      const d = new Date(today.getTime() - i * 86_400_000)
      if ((countByDay.get(dayKey(d)) ?? 0) > 0) streakDays++
      else break
    }

    const todayCount = countByDay.get(dayKey(today)) ?? 0
    let weekCount = 0
    for (let i = 0; i < 7; i++) {
      const d = new Date(today.getTime() - i * 86_400_000)
      weekCount += countByDay.get(dayKey(d)) ?? 0
    }

    const [dueCount, notes] = await Promise.all([
      prisma.studyNote.count({
        where: { userId, OR: [{ dueAt: { lte: new Date() } }, { dueAt: null }] },
      }),
      prisma.studyNote.findMany({
        where: { userId, topic: { not: null } },
        select: { topic: true, mastery: true, dueAt: true, sourceQuestionId: true },
      }),
    ])

    // 考点聚合:均掌握度 / 总卡数 / 到期数 / 可重做数,掌握度低的在前
    const byTopic = new Map<string, { total: number; due: number; redo: number; sum: number }>()
    for (const n of notes) {
      const key = n.topic as string
      const agg = byTopic.get(key) ?? { total: 0, due: 0, redo: 0, sum: 0 }
      agg.total++
      agg.sum += n.mastery
      if (n.dueAt && n.dueAt <= new Date()) agg.due++
      if (n.sourceQuestionId) agg.redo++
      byTopic.set(key, agg)
    }
    const topics = Array.from(byTopic.entries())
      .map(([topic, agg]) => ({
        topic,
        total: agg.total,
        due: agg.due,
        redo: agg.redo,
        masteryAvg: agg.total > 0 ? agg.sum / agg.total : 0,
      }))
      .sort((a, b) => a.masteryAvg - b.masteryAvg)

    return NextResponse.json({
      streakDays,
      todayCount,
      weekCount,
      dueCount,
      heatmap,
      topics,
    })
  } catch (err) {
    console.error('[study/stats] failed:', err)
    return NextResponse.json({ error: '获取复习统计失败' }, { status: 500 })
  }
}
