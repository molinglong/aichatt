'use client'

import { useEffect, useRef } from 'react'
import type { UIMessage } from 'ai'
import {
  YELLOW_FISH_WATCH_TOOL_NAME,
  YELLOW_FISH_TOOL_NAME,
  type YellowFishWatchToolOutput,
} from '@/lib/ai/yellow-fish-tool'
import { extractToolCallViews } from './ToolCallCard'

/**
 * 闲鱼监控「爬完自动回报」（isomorphic 纯函数部分 + 客户端轮询 hook）。
 *
 * 背景：add_yellow_fish_watch 在工具内最多等 90s，超时返回软状态（crawlPending=true），
 * 爬虫仍在 monitor 后台跑。本模块让前端接棒：轮询 /api/yellow-fish/watch/status，
 * 行情落地后自动发一条【监控回报】开头的 user 消息，让模型当场调 get_yellow_fish_market
 * 补报行情——用户不用手动追问。与验收门（verify-gate）同款"固定标签 user 消息"机制，
 * 消息照常入库、跨端回流，渲染端识别标签显示为 chip。
 *
 * 护栏：
 * - 只认 crawlPending===true 的 watch 结果（失败/空样本终态/已出数据不跟进）；
 * - 与 watch 工具同款闸门：爬虫增量写库，要「有样本 && 任务已不在跑」才回报，
 *   半截数据不报（任务在跑时继续等）；
 * - 历史里已有同关键词的自动回报不重发（覆盖"回报后刷新重进"场景）；
 * - 生成中（canSend=false）延迟到下一轮 tick 再发；
 * - 20 分钟仍无完整数据静默放弃（刷新重进会话时仍有补报兜底）。
 */

/** 自动回报消息固定标签（发出与渲染识别都靠它） */
export const YELLOW_FISH_AUTO_FOLLOW_TAG = '【监控回报】'

/** 轮询周期 */
const POLL_INTERVAL_MS = 15_000
/** 从登记起的最长跟进时长，超时静默放弃（慢爬虫实测可超 10 分钟，放弃后重进会话仍有补报） */
const GIVE_UP_MS = 20 * 60_000
/** 任务已不在跑后再等的缓冲（给落盘/接口留时间），到期即发"抓完了"回报 */
const FINISHED_GRACE_MS = 30_000

interface WatchStatusResp {
  ok: boolean
  hasSamples?: boolean
  snapshotTime?: string | null
  taskFound?: boolean
  taskRunning?: boolean
}

/** 构造自动回报消息正文（模型读到后应立即调 get_yellow_fish_market 查该关键词） */
export function buildYellowFishAutoFollowMessage(keyword: string): string {
  return (
    YELLOW_FISH_AUTO_FOLLOW_TAG +
    ` 关键词「${keyword}」的监控抓取已完成。请立即调用 get_yellow_fish_market 查询该关键词的闲鱼行情并讲给用户；` +
    '若返回没有有效样本，就如实说明这轮没抓到数据。不要编造价格。'
  )
}

/** 是否为自动回报注入的用户消息（渲染成 chip，不按普通气泡） */
export function isYellowFishAutoFollowText(text: string): boolean {
  return text.startsWith(YELLOW_FISH_AUTO_FOLLOW_TAG)
}

interface UseYellowFishAutoFollowOpts {
  messages: UIMessage[]
  /** 是否允许此刻发出（非生成中/非远端续显） */
  canSend: boolean
  /** 会话 prop：变化（真实切换会话）时清空跟踪 */
  conversationId?: string
  /** 发送通道：ChatPanel 传 handleSend(text, undefined, undefined, true) */
  onFire: (text: string) => void
}

export function useYellowFishAutoFollow({ messages, canSend, conversationId, onFire }: UseYellowFishAutoFollowOpts) {
  // 待跟进关键词 → 登记时刻
  const pendingRef = useRef<Map<string, number>>(new Map())
  // 已终结关键词（已回报/已放弃/已人工查到）：防 messages 重扫描重复登记
  const doneRef = useRef<Set<string>>(new Set())
  const canSendRef = useRef(canSend)
  const onFireRef = useRef(onFire)
  const messagesRef = useRef(messages)
  useEffect(() => { canSendRef.current = canSend }, [canSend])
  useEffect(() => { onFireRef.current = onFire }, [onFire])
  useEffect(() => { messagesRef.current = messages }, [messages])

  // 会话切换：清空本会话的跟踪状态
  useEffect(() => {
    pendingRef.current.clear()
    doneRef.current.clear()
  }, [conversationId])

  // 扫描工具结果：watch 软状态（crawlPending）登记待跟进；market 已查到数据则销单。
  // 用 extractToolCallViews 同时覆盖流式 parts 与历史 metadata.toolCalls 两个来源
  // （刷新/重进会话后 crawl 落地也能补报，不丢跟进）。
  useEffect(() => {
    for (const m of messages) {
      if (m.role !== 'assistant') continue
      for (const view of extractToolCallViews(m)) {
        if (view.state !== 'output-available') continue
        if (view.tool === YELLOW_FISH_WATCH_TOOL_NAME) {
          const out = view.output as YellowFishWatchToolOutput | undefined
          if (!out || out.error || out.available || out.crawlPending !== true) continue
          const key = out.keyword.trim()
          if (!key || doneRef.current.has(key) || pendingRef.current.has(key)) continue
          pendingRef.current.set(key, Date.now())
        } else if (view.tool === YELLOW_FISH_TOOL_NAME) {
          const out = view.output as { available?: boolean; keyword?: string } | undefined
          const key = out?.keyword?.trim()
          if (out?.available && key && pendingRef.current.has(key)) {
            pendingRef.current.delete(key)
            doneRef.current.add(key)
          }
        }
      }
    }
  }, [messages])

  // 轮询：到点即发【监控回报】消息，由模型查行情补报
  useEffect(() => {
    let alive = true
    const inflight = new Set<string>()

    const settleSilent = (key: string) => {
      pendingRef.current.delete(key)
      doneRef.current.add(key)
    }
    const fire = (key: string) => {
      if (!canSendRef.current) return // 生成中：留给下一轮 tick
      // 防重：历史里已有同关键词的自动回报（如回报后 15 分钟内刷新重进）不补发
      const already = messagesRef.current.some((m) => {
        if (m.role !== 'user') return false
        return m.parts.some((p) => {
          const t = p as { type?: string; text?: string }
          return (
            t.type === 'text' &&
            typeof t.text === 'string' &&
            t.text.startsWith(YELLOW_FISH_AUTO_FOLLOW_TAG) &&
            t.text.includes(`「${key}」`)
          )
        })
      })
      if (already) {
        settleSilent(key)
        return
      }
      pendingRef.current.delete(key)
      doneRef.current.add(key)
      onFireRef.current(buildYellowFishAutoFollowMessage(key))
    }

    const tick = () => {
      if (!alive || pendingRef.current.size === 0) return
      for (const [key, registeredAt] of Array.from(pendingRef.current.entries())) {
        if (inflight.has(key)) continue
        inflight.add(key)
        void (async () => {
          try {
            const res = await fetch(`/api/yellow-fish/watch/status?keyword=${encodeURIComponent(key)}`)
            if (!res.ok || !alive) return
            const data = (await res.json()) as WatchStatusResp
            if (!data?.ok || !alive) return
            const elapsed = Date.now() - registeredAt
            // 与 watch 工具同款闸门：爬虫增量写库，"有样本"≠"爬完"。
            // 只有「有样本 && 任务已不在跑」才是完整行情；只在跑有样本时继续等。
            if (data.hasSamples && data.taskRunning === false) {
              fire(key)
            } else if (!data.hasSamples && data.taskFound && !data.taskRunning && elapsed > FINISHED_GRACE_MS) {
              // 抓取已结束但没样本：照发，让行情工具如实汇报"没抓到"
              fire(key)
            } else if (elapsed > GIVE_UP_MS) {
              settleSilent(key)
            }
          } catch {
            // 网络抖动 / monitor 未起：下一轮再试
          } finally {
            inflight.delete(key)
          }
        })()
      }
    }

    const timer = setInterval(tick, POLL_INTERVAL_MS)
    void tick()
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])
}
