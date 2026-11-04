import { NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import {
  monitorBase,
  listMonitorTasks,
  readYellowFishMarket,
  normKeywordLoose,
} from '@/lib/ai/yellow-fish-monitor.server'

export const dynamic = 'force-dynamic'

/**
 * GET /api/yellow-fish/watch/status?keyword=xxx
 *
 * 闲鱼监控「爬完自动回报」的轮询端点：add_yellow_fish_watch 超时返回软状态（crawlPending）
 * 后，客户端每 15s 打这里，满足「有样本 && 任务已不在跑」（或任务跑完但没样本）就
 * 自动发【监控回报】消息。爬虫增量写库，样本出现 ≠ 爬完，客户端按 taskRunning 闸门判断。
 * 只读聚合 monitor 的两个接口：行情样本（含快照时间）+ 任务在跑状态；
 * monitor 未连通时按「还没好」返回而不是报错，让客户端继续等。
 */
export async function GET(req: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: '未登录' }, { status: 401 })
  }
  const keyword = new URL(req.url).searchParams.get('keyword')?.trim() ?? ''
  if (!keyword) {
    return NextResponse.json({ ok: false, error: '缺少 keyword' }, { status: 400 })
  }
  const base = monitorBase()

  let hasSamples = false
  let snapshotTime: string | null = null
  try {
    const data = await readYellowFishMarket(base, keyword, 1)
    if (data) {
      hasSamples = data.hasSamples
      snapshotTime = data.market.snapshotTime ?? null
    }
  } catch {
    // monitor 未连通：保持 hasSamples=false，客户端当作还没好继续轮询
  }

  let taskFound = false
  let taskRunning = false
  try {
    const tasks = await listMonitorTasks(base)
    const want = normKeywordLoose(keyword)
    const hit = tasks.find(
      (t) => normKeywordLoose(t.keyword) === want || normKeywordLoose(t.taskName) === want,
    )
    if (hit) {
      taskFound = true
      taskRunning = hit.running
    }
  } catch {
    // 同上
  }

  return NextResponse.json({ ok: true, hasSamples, snapshotTime, taskFound, taskRunning })
}
