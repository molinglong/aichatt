/**
 * 当前时间锚点（isomorphic，纯计算无依赖，客户端/服务端均可 import）。
 *
 * 为什么必须有：模型自身不知道"今天"是哪一天，而 manage_todo 的 dueAt 要 ISO 8601
 * 绝对时间，"周五/明天"的换算也必须有基准。缺失时的线上形态（2026-10-27 实例）：
 * 用户说"今天的晚上8" → 模型删待办重建 → 才想起要查日期 → 调 web_search
 * → 再删再建，普通对话 5 步工具预算被吃得一步不剩，最后只剩"回复「继续」"。
 *
 * 时区钉死 Asia/Shanghai：待办、额度日限（lib/quota.ts）、学情（lib/profile/academic.ts）
 * 都以北京时间为口径，不能跟着服务器 TZ 漂。
 */

import { TIME_TOOL_NAME } from './time-tool'

function pad(n: string): string {
  return n.padStart(2, '0')
}

/** 生成注入 system prompt 的「当前时间」段（每次请求现算，不缓存） */
export function buildTimeAnchorPrompt(now: Date = new Date()): string {
  // hourCycle: 'h23' 避免部分 locale 在 hour12:false 下把午夜输出成 24:00。
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  const date = `${get('year')}-${get('month')}-${pad(get('day'))}`
  const time = `${pad(get('hour'))}:${pad(get('minute'))}`
  const weekday = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    weekday: 'long',
  }).format(now)

  return [
    '## 当前时间',
    `现在是北京时间 ${date} ${time}（${weekday}，UTC+8）。`,
    '- 涉及「今天/明天/本周五/几号」等相对时间时，一律以上面这个时间为基准直接推算，不要为查日期调用联网搜索（搜不到还会白烧工具预算）。',
    `- 用户要「现在/此刻」的精确时间，或对话跨了很久需要刷新时刻时，调用 ${TIME_TOOL_NAME}（纯只读），同样不要走联网搜索。`,
    '- 待办 dueAt 等需要绝对时间的字段，直接按这个基准换算成 ISO 8601（带 +08:00）。',
  ].join('\n')
}
