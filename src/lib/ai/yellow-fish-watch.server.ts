import { tool } from 'ai'
import { z } from 'zod'
import {
  YELLOW_FISH_WATCH_TOOL_NAME,
  YELLOW_FISH_WATCH_INPUT_SCHEMA,
  YELLOW_FISH_WATCH_POLL_SECONDS,
  type YellowFishWatchToolOutput,
} from './yellow-fish-tool'
import {
  monitorBase,
  listMonitorTasks,
  createKeywordTask,
  startMonitorTask,
  readYellowFishMarket,
  normKeywordLoose,
} from './yellow-fish-monitor.server'

/**
 * add_yellow_fish_watch 工具工厂 —— 给关键词建监控任务并立即抓一次的完整闭环。
 *
 * 流程（实测 2026-11-04，keyword 模式 1 页 ~86s 落盘）：
 *   1. 现成结果有样本 → 直接返回行情（reused，不建不跑）
 *   2. 无样本 → 查重任务列表：在跑=already_running；闲置任务触发重跑=rerun
 *   3. 没任务 → 建 keyword 模式任务（零额度）+ 立即启动 = created
 *   4. 轮询行情出现（10s 间隔，上限 90s）；超时如实返回"已开爬，稍后再问"，绝不编造
 *
 * 护栏：查重后才建、单次 execute 只建 1 个任务；写操作面只暴露给 !isGameMask 回合。
 */
export function createYellowFishWatchTool() {
  return tool({
    description:
      '给一个闲鱼关键词建立监控并立即抓取一次行情（自动创建任务→开爬→等数据，约 1~3 分钟）。' +
      '当用户问的闲鱼关键词还没有行情数据、且用户同意建监控时调用。' +
      '会自动查重复用已有任务；成功时返回与行情查询相同的价格数据，超时返回"正在爬"，绝不编造价格。',
    inputSchema: z.object(YELLOW_FISH_WATCH_INPUT_SCHEMA),
    execute: async ({ keyword, maxPages, minPrice, maxPrice, personalOnly, region }): Promise<YellowFishWatchToolOutput> => {
      const base = monitorBase()
      const kw = (keyword || '').trim()
      const n = 5
      const fail = (partial: Partial<YellowFishWatchToolOutput> & { error: string; note: string }): YellowFishWatchToolOutput => ({
        keyword: kw,
        action: 'created',
        available: false,
        ...partial,
      })

      if (!kw) {
        return fail({ error: '关键词为空', note: '请提供闲鱼搜索关键词。' })
      }

      // 0) 连通检查（顺带拿任务列表）
      let tasks
      try {
        tasks = await listMonitorTasks(base)
      } catch (err) {
        const message = err instanceof Error ? err.message : '未知错误'
        console.error(`[${YELLOW_FISH_WATCH_TOOL_NAME}] monitor unreachable`, base, message)
        return fail({
          error: message,
          note: `闲鱼监控服务（${base}）未连通，无法建监控。请如实告知用户监控服务没有启动或访问不到，不要编造价格。`,
        })
      }

      // 1) 现成结果已有样本 → 直接返回（不建不跑）
      let reused: Awaited<ReturnType<typeof readYellowFishMarket>> = null
      try {
        reused = await readYellowFishMarket(base, kw, n)
      } catch {
        reused = null
      }
      if (reused?.hasSamples) {
        return {
          keyword: kw,
          action: 'reused',
          available: true,
          matchedKeyword: reused.matchedKeyword,
          market: reused.market,
          history: reused.history,
          dailyTrend: reused.dailyTrend,
          recentItems: reused.recentItems,
          note: '该关键词已有监控数据（历史抓取汇总，非全站实时挂牌），直接使用、未新建任务。',
        }
      }

      // 2) 任务查重（宽松：去空格小写，任务名或关键词任一命中）
      const want = normKeywordLoose(kw)
      const existing = tasks.find(
        (t) => normKeywordLoose(t.keyword) === want || normKeywordLoose(t.taskName) === want,
      )

      if (existing && existing.running) {
        return {
          keyword: kw,
          action: 'already_running',
          available: false,
          crawlPending: true,
          taskId: existing.id,
          note: `监控服务里「${existing.taskName || kw}」的任务正在爬取中，约 1~3 分钟出数据。抓完前端会自动把行情回报到对话里，不要编造价格。`,
        }
      }

      let taskId: number
      let action: YellowFishWatchToolOutput['action']
      if (existing) {
        // 已有闲置任务：触发重跑（不改它的关键词/价格设置）
        action = 'rerun'
        taskId = existing.id
        try {
          await startMonitorTask(base, taskId)
        } catch (err) {
          const message = err instanceof Error ? err.message : '未知错误'
          console.error(`[${YELLOW_FISH_WATCH_TOOL_NAME}] start failed`, taskId, message)
          return {
            keyword: kw,
            action: 'rerun',
            available: false,
            taskId,
            error: message,
            note: `「${existing.taskName || kw}」的监控任务已存在，但触发抓取失败（${message}）。请如实告知用户，不要编造价格。`,
          }
        }
      } else {
        // 3) 新建 keyword 模式任务（零额度）+ 启动
        action = 'created'
        try {
          taskId = await createKeywordTask(base, {
            keyword: kw,
            maxPages: maxPages ?? 3,
            minPrice: minPrice ?? null,
            maxPrice: maxPrice ?? null,
            personalOnly: personalOnly ?? true,
            region: region?.trim() || null,
          })
          await startMonitorTask(base, taskId)
        } catch (err) {
          const message = err instanceof Error ? err.message : '未知错误'
          console.error(`[${YELLOW_FISH_WATCH_TOOL_NAME}] create/start failed`, kw, message)
          return fail({
            error: message,
            note: `给「${kw}」建监控任务失败（${message}）。请如实告知用户建任务没成功，不要编造价格。`,
          })
        }
      }

      // 4) 轮询行情出现（10s 间隔）。
      // 关键闸门：爬虫是增量写库的（实测样本数 2→58 持续增长），样本刚出现 ≠ 爬完。
      // 必须等「有样本 && 任务已不在跑」才认定完成，否则会把半截数据当首轮结果报出去。
      const deadline = Date.now() + YELLOW_FISH_WATCH_POLL_SECONDS * 1000
      let lastData: Awaited<ReturnType<typeof readYellowFishMarket>> = null
      let stillRunning = true
      while (Date.now() < deadline) {
        await new Promise((res) => setTimeout(res, 10_000))
        try {
          const fresh = await listMonitorTasks(base)
          stillRunning = fresh.find((t) => t.id === taskId)?.running ?? false
        } catch {
          stillRunning = true // 状态查不到时按还在爬处理，宁可多等不早报
        }
        try {
          lastData = await readYellowFishMarket(base, kw, n)
        } catch {
          lastData = null
        }
        if (lastData?.hasSamples && !stillRunning) break
      }

      if (lastData?.hasSamples && !stillRunning) {
        return {
          keyword: kw,
          action,
          available: true,
          taskId,
          matchedKeyword: lastData.matchedKeyword,
          market: lastData.market,
          history: lastData.history,
          dailyTrend: lastData.dailyTrend,
          recentItems: lastData.recentItems,
          note:
            action === 'created'
              ? '刚为该关键词建好监控并完成首轮抓取（历史汇总、非全站实时挂牌）。样本数偏少时提醒用户参考价值有限。'
              : '已触发该关键词重新抓取，以上是最新一轮数据（历史汇总、非全站实时挂牌）。',
        }
      }

      if (lastData?.hasSamples && stillRunning) {
        // 样本已出现但爬取未结束（增量写库）：按软状态返回，前端轮询等爬完自动回报完整行情
        return {
          keyword: kw,
          action,
          available: false,
          crawlPending: true,
          taskId,
          note: `监控任务已${action === 'created' ? '建好' : '开跑'}，已抓到 ${lastData.market.sampleCount} 条样本，爬取还在继续。请告知用户：完整行情抓完后会自动回报到对话里，期间不要把当前的部分样本当成最终行情，更不要编造价格。`,
        }
      }

      // 超时/无样本：如实告知已开爬
      if (lastData && !lastData.hasSamples) {
        // 结果集在但样本为空，且任务已不在跑 → 可能登录态失效或被过滤光，交给正文如实解释
        if (!stillRunning) {
          return {
            keyword: kw,
            action,
            available: false,
            taskId,
            matchedKeyword: lastData.matchedKeyword,
            note: `「${kw}」的抓取已跑完但没抓到有效商品样本（可能登录状态失效、过滤条件太严或该词暂无在售）。请如实告知用户这轮没抓到数据，不要编造价格。`,
          }
        }
      }

      return {
        keyword: kw,
        action,
        available: false,
        crawlPending: true,
        taskId,
        note: `监控任务已${action === 'created' ? '建好' : '开跑'}，还在抓取中（约 1~3 分钟）。抓完后前端会自动把行情回报到对话里，无需用户追问；期间绝不编造价格。`,
      }
    },
  })
}
