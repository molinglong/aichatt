'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import {
  getIsTauri,
  listenDesktopEvent,
  takeDeepLinkAsk,
  type DeepLinkAskPayload,
} from '@/lib/tauri'
import {
  dispatchExtAsk,
  storePendingExtAsk,
  type ExtAskDetail,
} from '@/lib/input-bridge'
import { toast } from '@/lib/toast'

/** /uploads 单段平铺文件名(与 uploads 路由同口径:随机 id + 白名单扩展名) */
const UPLOAD_PATH_RE = /^\/uploads\/[A-Za-z0-9._-]{1,80}$/

const IMAGE_TYPE_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

/**
 * 桌面壳深链桥:aichatt://ask(浏览器扩展截图→服务器中转)→ 转发给聊天输入框。
 *
 * - 热唤起:Rust emit "deeplink://ask" → 本桥校验后 dispatchExtAsk(实时到)。
 * - 冷启动:webview 未就绪时事件会丢,Rust 落了 pending,挂载即 takeDeepLinkAsk 补领。
 * - 跨页兜底:payload 落 sessionStorage,ChatInput 挂载时补领(input-bridge.takePendingExtAsk)。
 * - 深链带图提问永远开新会话:不在 /chat 时先 router.push('/chat') 再由挂载补领。
 * - 校验:img 仅 /uploads/ 平铺路径;server 与当前 origin 不一致时只预填文本并提示。
 */
export function DeepLinkBridge() {
  const router = useRouter()

  useEffect(() => {
    if (!getIsTauri()) return
    let disposed = false

    async function handleAsk(payload: DeepLinkAskPayload) {
      if (disposed || !payload) return
      const id = payload.id || `${Date.now()}`
      const text = (payload.text || '').trim()
      if (!text && !payload.img) return

      let attachment: ExtAskDetail['attachment'] | undefined
      if (payload.img && UPLOAD_PATH_RE.test(payload.img)) {
        const server = (payload.server || '').replace(/\/+$/, '')
        if (server && server !== window.location.origin) {
          toast.warning('浏览器扩展指向的服务器与客户端不一致,已跳过截图预填')
          console.warn('[deeplink] server mismatch:', server, '≠', window.location.origin)
        } else {
          try {
            // GET 兼做 404 探测(孤儿清扫)与 size 补全;/uploads 无鉴权,cookie 不需要
            const res = await fetch(`${server}${payload.img}`)
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const blob = await res.blob()
            const ext = (payload.img.split('.').pop() || 'png').toLowerCase()
            attachment = {
              url: `${server}${payload.img}`,
              name: '浏览器截图',
              type: IMAGE_TYPE_BY_EXT[ext] || blob.type || 'image/png',
              size: blob.size,
            }
          } catch (err) {
            toast.warning('深链截图已失效(可能被清理),只预填了文字')
            console.warn('[deeplink] image fetch failed:', err)
          }
        }
      }

      const detail: ExtAskDetail = { id, text, attachment }
      storePendingExtAsk(detail)
      const path = window.location.pathname
      if (path === '/chat') {
        // 新会话页已挂载输入框:实时分发(消费成功后 ChatInput 会清掉兜底存储)
        dispatchExtAsk(detail)
      } else {
        // 会话页/其他 tab:回新会话页,由 ChatInput 挂载时补领 sessionStorage
        router.push('/chat')
      }
    }

    // 冷启动补领 + 热唤起监听
    void takeDeepLinkAsk().then((p) => {
      if (p) void handleAsk(p)
    })
    const cleanup = listenDesktopEvent('deeplink://ask', (p) => {
      void handleAsk(p as DeepLinkAskPayload)
    })

    return () => {
      disposed = true
      cleanup()
    }
  }, [router])

  return null
}
