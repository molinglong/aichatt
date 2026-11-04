import { tool } from 'ai'
import { z } from 'zod'
import {
  YELLOW_FISH_TOOL_NAME,
  YELLOW_FISH_MONITOR_BASE_DEFAULT,
  YELLOW_FISH_INPUT_SCHEMA,
  YELLOW_FISH_WATCH_TOOL_NAME,
  type YellowFishToolOutput,
} from './yellow-fish-tool'
import {
  monitorBase,
  readYellowFishMarket,
  YELLOW_FISH_FULL_DATA_SUFFIX,
} from './yellow-fish-monitor.server'

/**
 * get_yellow_fish_market 工具工厂 —— 服务端专用（直连本机闲鱼监控服务的只读接口）。
 *
 * 只读、无副作用，闸门与 get_current_time 一致（临时/对比常驻，游戏回合不注入）。
 * 接口细节见 yellow-fish-monitor.server.ts 顶部注释。
 * 服务没开 / 关键词没命中：优雅降级返回 available=false + note，绝不编造。
 * 关键词没命中时 note 引导模型改调 add_yellow_fish_watch 建监控闭环。
 */

function resolveBase(): string {
  const raw = (process.env.YELLOW_FISH_MONITOR_BASE_URL || YELLOW_FISH_MONITOR_BASE_DEFAULT).trim()
  return raw.replace(/\/+$/, '') || YELLOW_FISH_MONITOR_BASE_DEFAULT
}

export function createYellowFishTool() {
  return tool({
    description:
      '读取本机闲鱼监控服务已抓到的某个关键词的行情汇总（均价/中位/价格区间/每日走势/最近商品）。' +
      '当用户询问某个已监控关键词的闲鱼价格带、均价、走势或最近新上商品时调用。' +
      '数据是历史抓取汇总、非全站实时；关键词没有监控任务或服务未启动会返回 available=false，此时如实告知、不要编造价格。',
    inputSchema: z.object(YELLOW_FISH_INPUT_SCHEMA),
    execute: async ({ keyword, limit }): Promise<YellowFishToolOutput> => {
      const base = resolveBase()
      const kw = (keyword || '').trim()
      const n = limit ?? 5
      if (!kw) {
        return { keyword: kw, available: false, error: '关键词为空', note: '请提供闲鱼搜索关键词。' }
      }

      let data
      try {
        data = await readYellowFishMarket(base, kw, n)
      } catch (err) {
        const message = err instanceof Error ? err.message : '未知错误'
        console.error(`[${YELLOW_FISH_TOOL_NAME}] monitor unreachable`, base, message)
        return {
          keyword: kw,
          available: false,
          error: message,
          note: `闲鱼监控服务（${base}）未连通，无法取真实行情。请如实告知用户监控服务没有启动或访问不到，不要编造价格。`,
        }
      }

      if (!data) {
        return {
          keyword: kw,
          available: false,
          note:
            `监控服务里还没有「${kw}」这个关键词的监控数据。` +
            `请告知用户，并可以主动提议：调用 ${YELLOW_FISH_WATCH_TOOL_NAME} 给这个关键词建一次监控（约 1~3 分钟出数据）。不要编造价格。`,
        }
      }

      if (!data.hasSamples) {
        return {
          keyword: kw,
          available: false,
          matchedKeyword: data.matchedKeyword,
          recentItems: data.recentItems.length ? data.recentItems : undefined,
          note:
            `「${data.matchedKeyword}」的监控任务存在但还没有有效价格样本（可能刚建或尚未抓到数据）。` +
            `可提议调用 ${YELLOW_FISH_WATCH_TOOL_NAME} 立即触发一次抓取。请如实告知用户暂无数据，不要编造均价。`,
        }
      }

      const note =
        '以上是该监控关键词的历史抓取汇总（非闲鱼全站实时挂牌）。请结合成色/版本/电池健康判断，样本数偏少时提醒用户参考价值有限。'

      return {
        keyword: kw,
        available: true,
        matchedKeyword: data.matchedKeyword,
        market: data.market,
        history: data.history,
        dailyTrend: data.dailyTrend,
        recentItems: data.recentItems,
        note,
      }
    },
  })
}
