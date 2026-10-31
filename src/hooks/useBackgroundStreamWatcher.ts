'use client'

import { useEffect } from 'react'
import { useChatStore } from '@/store/chat-store'
import { tauri } from '@/lib/tauri'

/** 轮询间隔:后台完成提示不需要实时,5s 足够(蓝点最多延迟一个周期点亮) */
const POLL_INTERVAL = 5000

/**
 * 后台生成跟踪(修复:生成中切走的会话完成后蓝点不亮):
 * ChatPanel 卸载时若仍在生成,把会话注册进 store.backgroundStreaming;
 * 本 hook 由 Sidebar 常驻挂载,对注册的会话逐个轮询最新一条消息:
 *   - 最新是 assistant 且 streaming=false → 单聊草稿行已定格,生成完成
 *   - 最新是 user → 对比模式 assistant 尚未落库,仍在生成
 *   - 消息为空 / 会话 404 → 视为结束,停止跟踪
 * 完成后 bumpConversationVersion 触发列表刷新,updatedAt 前进,
 * ConversationItem 的 lastMessageAt > lastReadAt 判定即可点亮蓝点。
 * 服务端另有 10 分钟超时定格兜底(conversations/[id]/route.ts),
 * 即使流被孤儿化,轮询最终也会以"完成"收尾,不会无限轮询。
 */
export function useBackgroundStreamWatcher() {
  const backgroundStreaming = useChatStore((s) => s.backgroundStreaming)
  const unregisterBackgroundStreaming = useChatStore((s) => s.unregisterBackgroundStreaming)
  const bumpConversationVersion = useChatStore((s) => s.bumpConversationVersion)

  useEffect(() => {
    const ids = Object.keys(backgroundStreaming)
    if (ids.length === 0) return
    let cancelled = false
    const timer = setInterval(async () => {
      for (const id of ids) {
        if (cancelled) return
        try {
          const res = await fetch(`/api/conversations/${id}/messages?limit=1`)
          if (!res.ok) {
            // 已删除/无权限等:停止跟踪,状态交给正常列表刷新
            unregisterBackgroundStreaming(id)
            continue
          }
          const data = await res.json()
          const latest = data.messages?.[0]
          const done = !latest || (latest.role === 'assistant' && latest.streaming !== true)
          if (done) {
            unregisterBackgroundStreaming(id)
            bumpConversationVersion()
            // 系统通知:后台会话回复完成且窗口失焦时弹通知(仅桌面端;
            // 开关在设置-聊天行为,默认开)。latest 为空(会话清空)时不通知。
            if (latest?.role === 'assistant' && typeof latest.content === 'string' && latest.content.trim()) {
              void tauri.notifyReplyDone('AI 回复完成', latest.content)
            }
          }
        } catch {
          // 网络抖动:下个周期重试
        }
      }
    }, POLL_INTERVAL)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [backgroundStreaming, unregisterBackgroundStreaming, bumpConversationVersion])
}
