import { tool } from 'ai'
import { z } from 'zod'
import {
  TIME_TOOL_NAME,
  TIME_DEFAULT_TIMEZONE,
  TIME_INPUT_SCHEMA,
  type TimeToolOutput,
} from './time-tool'

/**
 * get_current_time 工具工厂 —— 服务端专用（时间以服务端为准，不依赖客户端时钟）。
 *
 * 与 time-anchor 的分工：锚点是请求开始时的快照，本工具是模型按需取的"此刻"。
 * 纯只读、无副作用，闸门与 calculate 一致（临时/对比模式常驻，游戏回合不注入）。
 */

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 目标时区相对 UTC 的偏移分钟数（用该时区的墙钟时间反推，自动处理夏令时） */
function utcOffsetMinutes(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  const wall = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second')
  )
  const base = Math.floor(now.getTime() / 1000) * 1000
  return Math.round((wall - base) / 60000)
}

function snapshot(now: Date, timeZone: string): Omit<TimeToolOutput, 'note'> {
  // hourCycle: 'h23' 避免部分 locale 在 hour12:false 下把午夜输出成 24:00。
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  const date = `${get('year')}-${get('month')}-${get('day')}`
  const time = `${get('hour')}:${get('minute')}:${get('second')}`
  const weekday = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    weekday: 'long',
  }).format(now)

  const offset = utcOffsetMinutes(now, timeZone)
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  const utcOffset = `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  const offsetShort = abs % 60 === 0 ? `${sign}${abs / 60}` : `${sign}${Math.floor(abs / 60)}:${pad2(abs % 60)}`
  const zoneLabel = timeZone === TIME_DEFAULT_TIMEZONE ? '北京时间' : timeZone

  return {
    timezone: timeZone,
    date,
    time,
    weekday,
    utcOffset,
    iso: `${date}T${time}${utcOffset}`,
    utc: now.toISOString(),
    human: `${zoneLabel} ${date} ${time}（${weekday}，UTC${offsetShort}）`,
  }
}

export function createTimeTool() {
  return tool({
    description:
      '获取此刻的真实日期与时间（默认北京时间，可传 IANA 时区）。' +
      '用户问现在几点/今天几号/星期几，或任务依赖精确当前时刻、跨时区换算时调用；' +
      '不要用 web_search 查当前时间。',
    inputSchema: z.object(TIME_INPUT_SCHEMA),
    execute: async ({ timezone }): Promise<TimeToolOutput> => {
      const now = new Date()
      const tz = (timezone ?? TIME_DEFAULT_TIMEZONE).trim() || TIME_DEFAULT_TIMEZONE
      try {
        const snap = snapshot(now, tz)
        return {
          ...snap,
          note: '这是本次调用时刻的真实服务端时间，可直接引用；不要再调用 web_search 查时间。',
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : '未知错误'
        console.error(`[${TIME_TOOL_NAME}] invalid timezone`, tz, message)
        return {
          timezone: tz,
          date: '',
          time: '',
          weekday: '',
          utcOffset: '',
          iso: '',
          utc: now.toISOString(),
          human: '',
          error: `时区 ${tz} 无效`,
          note: `时区名必须是 IANA 格式（如 Asia/Shanghai、Asia/Tokyo）。请省略参数改用默认北京时间，或换成正确时区重试一次。`,
        }
      }
    },
  })
}
