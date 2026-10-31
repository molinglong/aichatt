import { z } from 'zod'

/**
 * get_current_time —— 实时时间工具（isomorphic 常量模块）。
 *
 * 为什么需要：system 里的「当前时间」段只是本轮请求开始时的快照，
 * 长对话跨了几小时后模型就分不清"此刻"；而联网搜索既慢又不保证准确，
 * 还会白烧普通对话 5 步的工具预算（线上实例：查日期 → 再删再建待办）。
 * 有了这个工具，模型按需取一次真实服务端时间即可。
 *
 * 拆分铁律：本文件零服务端依赖，客户端 ToolCallCard 只允许 import 本模块。
 */

export const TIME_TOOL_NAME = 'get_current_time'

/** 应用统一时区口径：待办、额度日限、学情都按北京时间算，工具默认也钉死它。 */
export const TIME_DEFAULT_TIMEZONE = 'Asia/Shanghai'

export const TIME_TOOL_PROMPT = [
  '## 实时时间 get_current_time',
  '你拥有 get_current_time 工具（返回真实服务端时间，默认北京时间，可传 IANA 时区）。以下场景**直接调用它**：',
  '- 用户问「现在几点 / 今天几号 / 星期几 / 现在什么时候」',
  '- 任务依赖精确到分钟的当前时刻：倒计时、距某时间还有多久、跨天判断、跨时区换算',
  '- 对话已经持续很久，你需要确认「此刻」而不是本轮请求开始时的快照',
  '- **禁止用 web_search 查当前时间**：搜索又慢又可能返回旧结果，还会白烧工具预算。',
  'system 里的「当前时间」段是本轮请求开始时的快照；用户明确要「现在/此刻」时以工具返回值为准。',
  '调用后在正文自然引用结果即可，不要复述"我调用了工具"；用户没问时间时不要主动报时。',
].join('\n')

/** zod 字段集合（isomorphic，服务端工厂用 z.object 包成 inputSchema） */
export const TIME_INPUT_SCHEMA = {
  timezone: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('IANA 时区名，如 Asia/Shanghai、America/New_York；省略时用北京时间（Asia/Shanghai）'),
}

/** 工具 output 形状（服务端 execute 返回，前端卡片渲染） */
export interface TimeToolOutput {
  /** 实际采用的 IANA 时区 */
  timezone: string
  /** 本地日期 YYYY-MM-DD */
  date: string
  /** 本地时间 HH:mm:ss */
  time: string
  /** 星期几（中文） */
  weekday: string
  /** UTC 偏移，如 +08:00 */
  utcOffset: string
  /** 带偏移的 ISO 8601，如 2026-10-27T20:15:32+08:00 */
  iso: string
  /** UTC 时刻 */
  utc: string
  /** 一句话可直接引用的时间描述 */
  human: string
  error?: string
  note?: string
}
