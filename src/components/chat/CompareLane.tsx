'use client'

import { useRef, useEffect, useMemo } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import type { UIMessage } from 'ai'
import { MessageSquarePlus, RotateCw, ThumbsUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { bumpFocusMsgCount, getFocusLockState } from '@/lib/focus-lock-store'
import { ChatErrorBanner } from './ChatErrorBanner'
import { MessageList } from './MessageList'
import { pinScrollToBottom } from './chat-list-bridge'
import { PROVIDER_DOT } from './ModelSelector'
import { getErrorMessage } from '@/lib/chat-errors'
import type { ModelDefinition } from '@/lib/ai/types'
import { useChatStore } from '@/store/chat-store'
import type { Attachment } from './FileUpload'

export interface LaneApi {
  send: (text: string, attachments?: Attachment[]) => void
  stop: () => void
  regenerate: () => void
}

interface CompareLaneProps {
  modelId: string
  modelDef: ModelDefinition
  initialMessages: UIMessage[]
  conversationIdRef: React.MutableRefObject<string | null>
  groupIdRef: React.MutableRefObject<string>
  stylePreset: string
  /** 面具 id(由 ComparePanel 统一控制,每个泳道都带上) */
  maskId: string | null
  deepThink: boolean
  /** 联网搜索开关(由 ComparePanel 统一控制,每个泳道都带上) */
  webSearch: boolean
  onConvIdFromHeader: (newConvId: string, newConvTitle?: string | null) => void
  registerApi: (api: LaneApi | null) => void
  onLoadingChange: (isLoading: boolean) => void
  /** 请求与当前泳道模型单独继续聊天(由父级弹窗确认) */
  onRequestSolo?: (modelId: string) => void
  /** E 对比模式投票: 本泳道是否为最新一轮的胜出者 */
  isVoted?: boolean
  /** E 对比模式投票: 给本泳道最新一轮回答投票 */
  onVote?: (modelId: string) => void
}

export function CompareLane({
  modelId,
  modelDef,
  initialMessages,
  conversationIdRef,
  groupIdRef,
  stylePreset,
  maskId,
  deepThink,
  webSearch,
  onConvIdFromHeader,
  registerApi,
  onLoadingChange,
  onRequestSolo,
  isVoted,
  onVote,
}: CompareLaneProps) {
  // 每个泳道独立持有自己的 attachmentsRef —— 避免父组件共享 ref 导致多泳道并发 fetch 时
  // 第一个泳道把 ref 清掉、后续泳道 fetch 时读到 undefined 的竞态
  const transportAttachmentsRef = useRef<Attachment[] | undefined>(undefined)

  // 用 ref 持有最新的 props,避免 transport body 闭包捕获旧值。
  // 即使 useChat 内部缓存了 transport,body getter 在请求时才读取,
  // 也能拿到最新的 stylePreset / deepThink / webSearch。
  // useRef() 声明和 .current 赋值严格分开,避免 render 体直接写 .current 触发并发更新循环。
  const stylePresetRef = useRef(stylePreset)
  const maskIdRef = useRef(maskId)
  const deepThinkRef = useRef(deepThink)
  const webSearchRef = useRef(webSearch)
  useEffect(() => {
    stylePresetRef.current = stylePreset
    maskIdRef.current = maskId
    deepThinkRef.current = deepThink
    webSearchRef.current = webSearch
  }, [stylePreset, maskId, deepThink, webSearch])

  // Create transport with dynamic body getters so values are read at send time.
  // 用 useMemo 收敛创建,避免每次 render 都新建 transport。
  const transport = useMemo(
    () =>
      new DefaultChatTransport<UIMessage>({
        api: '/api/chat',
        body: {
          model: modelId,
          get conversationId() {
            return conversationIdRef.current
          },
          get groupId() {
            return groupIdRef.current
          },
          get stylePreset() {
            return stylePresetRef.current
          },
          // 长度档直接读 store(请求时取值,同 ChatPanel 的 settingsSnapshot 写法),
          // 避免为它再铺一层 prop + ref
          get replyLength() {
            return useChatStore.getState().conversationReplyLength
          },
          get maskId() {
            return maskIdRef.current
          },
          get deepThink() {
            return deepThinkRef.current
          },
          get webSearch() {
            return webSearchRef.current
          },
          get attachments() {
            return transportAttachmentsRef.current
          },
          // 监管模式锁定期标记:服务端据此注入监工段(与 ChatPanel 同口径);
          // countUp=正计时档(endsAtMs 恒 0,服务端按标记注入不带剩余时间的监工文案)
          get focusLock() {
            const fl = getFocusLockState()
            return fl.locked ? { endsAtMs: fl.endsAtMs, countUp: fl.countUp } : undefined
          },
        },
        // 兜底: 若客户端预创建会话失败,以服务端返回头为准
        fetch: async (url, options) => {
          const response = await fetch(url, options)
          // 锁中发送成功计数(R5 解锁回执数据源;非锁定期空操作)
          if (getFocusLockState().locked && response.ok) bumpFocusMsgCount()
          const newConvId = response.headers.get('X-Conversation-Id')
          const newConvTitle = response.headers.get('X-Conversation-Title')
          if (newConvId) {
            onConvIdFromHeader(newConvId, newConvTitle)
          }
          return response
        },
      }),
    // modelId 由父组件按 key 重挂保证不漂移,onConvIdFromHeader 在父组件已 useCallback 稳定,
    // 其余可变值都通过 ref 读取,transport 仅在挂载时创建一次
    [modelId, onConvIdFromHeader]
  )

  // Ref to setMessages,避免在 useChat 初始化器内部自引用导致循环依赖
  const setMessagesRef = useRef<((updater: UIMessage[] | ((prev: UIMessage[]) => UIMessage[])) => void) | null>(null)

  const { messages, sendMessage, setMessages, stop, status, error, clearError, regenerate } = useChat<UIMessage>({
    // 流式 UI 更新节流(AI SDK 官方机制): 不节流时每个 chunk 都触发强制同步重渲染,
    // 快速流式下会累积 React nestedUpdateCount 至 50 抛 "Maximum update depth exceeded",
    // 传 throttle 后通知频率与渲染耗时脱钩,配合打字机视觉平滑度不受影响。
    throttle: 50,
    transport,
    messages: initialMessages,
    onFinish: async ({ message, isError, isAbort }) => {
      if (isError || isAbort) return
      const convId = conversationIdRef.current
      if (!convId) return
      try {
        // 仅拉取本模型最新的助手消息(含图片替换后的最终内容)
        const res = await fetch(
          `/api/conversations/${convId}/messages?limit=1&model=${encodeURIComponent(modelId)}`
        )
        if (!res.ok) return
        const data = await res.json()
        const latest = data.messages?.[0]
        if (!latest || latest.role !== 'assistant' || typeof latest.content !== 'string') return
        setMessagesRef.current?.((prev: UIMessage[]) =>
          prev.map((m) => {
            if (m.id !== message.id) return m
            return {
              ...m,
              // 以库中最终数据为准:reasoning 可能被兜底拆分(答案从推理尾部移入正文)
              parts: [
                ...(typeof latest.reasoning === 'string' && latest.reasoning.trim()
                  ? [{ type: 'reasoning' as const, text: latest.reasoning, state: 'done' as const }]
                  : []),
                { type: 'text' as const, text: latest.content, state: 'done' as const },
              ],
            }
          })
        )
      } catch (err) {
        console.error('Failed to sync final message content:', err)
      }
    },
  })

  // 本泳道自己的待注入附件 ref(共享 ref 会被多泳道竞争,不能用于 UI 注入)
  const pendingAttachmentsRef = useRef<Attachment[] | undefined>(undefined)

  // 把 setMessages 同步到 ref,供 onFinish 回调异步时拿到最新引用。
  // 必须在 useEffect 里赋值,而不是 render 体 —— 后者会触发 React
  // "Cannot update a component while rendering" / hook inputs 不一致的级联。
  useEffect(() => {
    setMessagesRef.current = setMessages
  }, [setMessages])

  // 发送后把附件挂到最后一条用户消息上,保证当前会话中即时展示(与服务端落库一致)
  useEffect(() => {
    const atts = pendingAttachmentsRef.current
    if (!atts || atts.length === 0) return
    setMessages((prev) => {
      const next = [...prev]
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].role === 'user') {
          next[i] = { ...next[i], attachments: atts } as UIMessage
          break
        }
      }
      return next
    })
    pendingAttachmentsRef.current = undefined
  }, [messages, setMessages])

  const isLoading = status === 'submitted' || status === 'streaming'

  // 进入历史会话定位到最新一条(与 ChatPanel 同款):泳道滚动容器挂载时停在顶部,
  // 而顶部是最早的用户提问。移动端未激活泳道是 display:none(clientHeight=0),
  // 贴底对它无意义,跳过即可。
  const laneScrollRef = useRef<HTMLDivElement | null>(null)
  const lanePinnedRef = useRef(false)
  useEffect(() => {
    if (lanePinnedRef.current) return
    const el = laneScrollRef.current
    if (!el || !el.clientHeight || isLoading || messages.length === 0) return
    lanePinnedRef.current = true
    pinScrollToBottom(el)
  }, [isLoading, messages.length])

  // 向父级注册/注销本泳道 API;卸载时重置加载状态避免父级卡在 loading
  useEffect(() => {
    registerApi({
      send: (text, attachments) => {
        // 写本泳道私有的 transport ref(供请求体 getter 在 fetch 时读取)
        // 同时也写 pendingAttachmentsRef(供 UI 注入最后一条 user message)
        transportAttachmentsRef.current = attachments
        pendingAttachmentsRef.current = attachments
        sendMessage({ text })
      },
      stop,
      regenerate,
    })
    return () => {
      registerApi(null)
      onLoadingChange(false)
    }
  }, [sendMessage, stop, regenerate, registerApi, onLoadingChange])

  useEffect(() => {
    onLoadingChange(isLoading)
  }, [isLoading, onLoadingChange])

  const handleRegenerate = () => {
    clearError()
    regenerate()
  }

  const errorInfo = error ? getErrorMessage(error) : null

  return (
    <div className="flex flex-col min-w-0 h-full">
      {/* Lane header: model name + regenerate */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-line/60 shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className={cn(
              'w-1.5 h-1.5 rounded-full shrink-0',
              PROVIDER_DOT[modelDef.provider] ?? 'bg-content-muted'
            )}
          />
          <span className="text-xs font-medium text-content-primary truncate" title={modelDef.name}>
            {modelDef.name}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {onVote && (
            <button
              onClick={() => onVote(modelId)}
              disabled={isLoading || !conversationIdRef.current}
              className={cn(
                'inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0',
                isVoted
                  ? 'text-accent bg-accent-soft'
                  : 'text-content-muted hover:text-accent hover:bg-accent-soft'
              )}
              title="这个模型的回答更好"
              aria-label="投票"
              aria-pressed={isVoted}
            >
              <ThumbsUp className="w-3.5 h-3.5" />
              {isVoted ? '已选' : '更好'}
            </button>
          )}
          <button
            onClick={handleRegenerate}
            disabled={isLoading}
            className="p-1 rounded-md text-content-muted hover:text-content-primary hover:bg-surface-subtle transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
            title="重新生成"
            aria-label="重新生成"
          >
            <RotateCw className="w-3.5 h-3.5" />
          </button>
        </div>
        {onRequestSolo && conversationIdRef.current && (
          <button
            onClick={() => onRequestSolo(modelId)}
            disabled={isLoading}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-content-muted hover:text-accent hover:bg-accent-soft transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
            title="与这个模型单独继续聊天"
            aria-label="单独聊"
          >
            <MessageSquarePlus className="w-3.5 h-3.5" />
            单独聊
          </button>
        )}
      </div>

      {/* Lane error banner */}
      {error && errorInfo && (
        <ChatErrorBanner
          info={errorInfo}
          size="compact"
          provider={modelDef.provider}
          modelId={modelId}
          onRetry={() => {
            clearError()
            regenerate()
          }}
        />
      )}

      {/* Lane messages (对比模式内禁用编辑用户消息) */}
      {/* md:pt-12: 桌面端浮动工具簇无底板悬在右上,泳道首条消息须让位;
          padding 放滚动容器内,滚动时随内容移出 —— 裁切线保持 y=0,TopFade 渐隐行为不变 */}
      <div ref={laneScrollRef} className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 md:pt-12">
        <MessageList
          messages={messages}
          isStreaming={isLoading}
          isPending={status === 'submitted'}
          className="min-h-full"
          onRegenerate={handleRegenerate}
        />
      </div>
    </div>
  )
}
