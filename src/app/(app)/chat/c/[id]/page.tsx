'use client'

import { useCallback, useEffect, useMemo, useRef, useState, Suspense } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import type { UIMessage } from 'ai'
import { ChatPanel } from '@/components/chat/ChatPanel'
import { AuthErrorBoundary } from '@/components/AuthErrorBoundary'
import { ClientOnly } from '@/components/ClientOnly'
import { useChatStore } from '@/store/chat-store'
import { getErrorMessage } from '@/lib/chat-errors'
import { queryKeys, STALE } from '@/lib/query/keys'
import { providersModelsQuery } from '@/lib/query/providers'
import { fetchJson, AuthorizationError, NotFoundError, type FetchJsonOptions } from '@/lib/query/fetcher'
import type { Attachment } from '@/lib/attachment-types'

// ── Types ────────────────────────────────────────────────────────
interface ApiMessage {
  id: string
  role: string
  content: string
  reasoning?: string | null
  model?: string | null
  groupId?: string | null
  attachments: unknown[]
  /** 后端写入的结构化 UI 提示: { kind: 'branch_summary', sourceId, sourceTitle, ... } */
  metadata?: unknown
  /** A 流式恢复: 服务端仍在生成(草稿行快照中)的 assistant 消息 */
  streaming?: boolean
  /** 收藏状态:已收藏时为 Favorite.id,未收藏为 null(消息操作栏星标用) */
  favoriteId?: string | null
  promptTokens?: number | null
  completionTokens?: number | null
  createdAt?: string | Date
}

function parseMessageMetadata(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return raw as Record<string, unknown>
}

interface ApiConversation {
  id: string
  title: string
  model: string
  mode: 'single' | 'compare'
  styleOffset: number
  stylePreset: string | null
  replyLength?: string | null
  maskId: string | null
  compareModels: string[]
  /** 学习模式会话:普通聊天页据此改道 /study?c=id */
  studyMode?: boolean
  /** E 对比模式投票: 最新一轮投票(对比模式回显高亮用) */
  latestVote?: { groupId: string; votedModel: string } | null
  messages: ApiMessage[]
  /** 首屏分页(单聊):未归档消息总数与更早续载游标;对比模式恒全量下发 */
  totalMessageCount?: number
  earlierCount?: number
  hasEarlier?: boolean
  earlierCursorId?: string | null
}

// ── QueryFn ──────────────────────────────────────────────────────
async function fetchConversation(id: string, opts?: FetchJsonOptions): Promise<ApiConversation> {
  return fetchJson<ApiConversation>(`/api/conversations/${id}`, opts)
}

/** 更早页(游标之前最近 60 行;游标是已下发最早一条,服务端严格早于它取,可见过滤在本页做) */
async function fetchEarlierPage(
  id: string,
  before: string,
  opts?: FetchJsonOptions
): Promise<{ messages: ApiMessage[]; hasEarlier: boolean; earlierCursorId: string | null }> {
  return fetchJson(`/api/conversations/${id}/messages?before=${before}`, opts)
}

// ── UIMessage adapter ────────────────────────────────────────────
function toUIMessage(msg: ApiMessage): UIMessage {
  const parts: UIMessage['parts'] = []
  if (msg.reasoning) {
    parts.push({ type: 'reasoning' as const, text: msg.reasoning, state: 'done' as const })
  }
  parts.push({ type: 'text' as const, text: msg.content, state: 'done' as const })

  const attachments =
    Array.isArray(msg.attachments) && msg.attachments.length > 0
      ? (msg.attachments as Attachment[]).filter(
          (a): a is Attachment =>
            !!a &&
            typeof (a as Attachment).url === 'string' &&
            typeof (a as Attachment).name === 'string'
        )
      : undefined

  // A 流式恢复: streaming 标记合入 metadata,供 ChatPanel 启动轮询续显
  const baseMeta = parseMessageMetadata(msg.metadata)
  const mergedMeta = msg.streaming ? { ...(baseMeta ?? {}), streaming: true } : baseMeta

  return {
    id: msg.id,
    role: msg.role as 'user' | 'assistant' | 'system',
    parts,
    createdAt: msg.createdAt ? new Date(msg.createdAt) : undefined,
    ...(attachments ? { attachments } : {}),
    ...(mergedMeta ? { metadata: mergedMeta } : {}),
    ...(msg.promptTokens != null || msg.completionTokens != null
      ? { tokens: { prompt: msg.promptTokens ?? 0, completion: msg.completionTokens ?? 0 } }
      : {}),
    favoriteId: msg.favoriteId ?? null,
  } as UIMessage
}

// ── Page ────────────────────────────────────────────────────────
export default function ConversationClientPage() {
  // providers 由 TopBar 在 hover/click 时预热,这里改用 useSuspenseQuery:
  //   - cache hit → 直接读 cache,同步渲染,无空白帧
  //   - cache miss → 抛 promise → Next.js Router Suspense 兜底到 loading.tsx
  const providersContent = (
    <ConversationClientContent />
  )
  return (
    <AuthErrorBoundary>
      <Suspense>
        <ClientOnly>
          {providersContent}
        </ClientOnly>
      </Suspense>
    </AuthErrorBoundary>
  )
}

function ConversationClientContent() {
  const params = useParams<{ id: string }>()
  const id = params?.id
  const router = useRouter()
  const { status } = useSession()
  const setCurrentConversationId = useChatStore((s) => s.setCurrentConversationId)
  const setConversationTitle = useChatStore((s) => s.setConversationTitle)
  const setConversationStylePreset = useChatStore((s) => s.setConversationStylePreset)

  // 会话详情 — 仍用 useQuery,因为要处理 401/404 触发 redirect 副作用
  // (Suspense 抛错只会被 ErrorBoundary 接住,不能 redirect)
  const conversationQuery = useQuery({
    queryKey: queryKeys.conversations.detail(id ?? ''),
    queryFn: ({ signal }) => fetchConversation(id!, { signal }),
    enabled: status === 'authenticated' && !!id,
    staleTime: STALE.conversation,
    gcTime: 30 * 60 * 1000,
  })

  // 模型列表 — Suspense 版本,切会话瞬间从 cache 命中,无网络等待。
  // TopBar 在 hover / 点击其他 tab 时已经把这一项预热。
  const { data: allModels } = useSuspenseQuery(providersModelsQuery)

  // 鉴权:未登录跳 /login
  useEffect(() => {
    if (status === 'unauthenticated') {
      router.replace('/login')
    }
  }, [status, router])

  // 错误转化为导航或提示。
  useEffect(() => {
    const err = conversationQuery.error
    if (!err) return
    if (err instanceof AuthorizationError) {
      router.replace('/login')
      return
    }
    if (err instanceof NotFoundError) {
      // 会话不存在 / 无权限 → 回列表
      router.replace('/chat')
    }
  }, [conversationQuery.error, router])

  const conversation = conversationQuery.data

  // 学习模式 v2 起学习会话走独立体系(/study);旧的 studyMode 会话已弃用,
  // 普通聊天地址遇到它们一律回学习台(不带参数,旧会话不续),避免被当成消息流打开。
  const redirectToStudy = conversation?.studyMode === true
  useEffect(() => {
    if (!redirectToStudy || !conversation) return
    router.replace('/study')
  }, [redirectToStudy, conversation, router])

  // ── 首屏分页:更早消息续载(仅单聊;对比模式端点恒全量下发) ──
  // 已加载的更早页缓存在组件本地(不进 useQuery 详情缓存,避免缓存膨胀),
  // 与最新窗口详情拼接后交给 initialMessages;ChatPanel remount(key=id)时自然清空。
  const [accumulated, setAccumulated] = useState<ApiMessage[]>([])
  const accumulatedRef = useRef<ApiMessage[]>([])
  accumulatedRef.current = accumulated
  const [accumulatedCursor, setAccumulatedCursor] = useState<string | null | undefined>(undefined)
  const cursorRef = useRef<string | null | undefined>(undefined)
  cursorRef.current = accumulatedCursor

  useEffect(() => {
    setAccumulated([])
    accumulatedRef.current = []
    setAccumulatedCursor(undefined)
  }, [id])

  useEffect(() => {
    if (!conversation) return
    // 只在未初始化(或切换会话重置后)播种;后台 refetch 不覆盖已推进的游标
    setAccumulatedCursor((prev) => (prev === undefined ? conversation.earlierCursorId ?? null : prev))
  }, [conversation])

  const loadEarlier = useCallback(async (): Promise<UIMessage[]> => {
    const convId = conversation?.id
    const cursor = cursorRef.current
    if (!convId || !cursor) return []
    const page = await fetchEarlierPage(convId, cursor)
    const raw = page.messages
    const mode = conversation?.mode ?? 'single'
    // 可见过滤与 initialState 同一口径(单聊:非当前模型的其他 model 回复不下发)
    const visible =
      mode === 'compare'
        ? raw
        : raw.filter((m) => m.role === 'user' || m.groupId == null || m.model === conversation?.model)
    const ui = visible.map(toUIMessage)
    // ref 即时镜像:同帧连点两次不至于重复下发同一页
    accumulatedRef.current = [...raw, ...accumulatedRef.current]
    setAccumulated(accumulatedRef.current)
    setAccumulatedCursor(page.hasEarlier ? page.earlierCursorId : null)
    return ui
  }, [conversation])

  // 鉴权:未登录跳 /login

  // 把当前会话元数据同步到 chat-store,让 TopBar 标题、Sidebar 高亮等保持一致
  useEffect(() => {
    if (!conversation) return
    setCurrentConversationId(conversation.id)
    setConversationTitle(conversation.title)
    if (conversation.stylePreset) {
      setConversationStylePreset(conversation.stylePreset)
    } else {
      const o = conversation.styleOffset ?? 50
      if (o <= 20) setConversationStylePreset('scholar')
      else if (o <= 45) setConversationStylePreset('practical')
      else if (o <= 65) setConversationStylePreset('balanced')
      else if (o <= 85) setConversationStylePreset('editor')
      else setConversationStylePreset('humorous')
    }
  }, [conversation, setCurrentConversationId, setConversationTitle, setConversationStylePreset])

  // 派生: 单聊/对比模式的消息分发(更早页拼在最新窗口前,首屏一次给全已加载部分)
  const initialState = useMemo(() => {
    if (!conversation) {
      return {
        initialMessages: [] as UIMessage[],
        laneInitialMessages: undefined as UIMessage[][] | undefined,
      }
    }
    const mode = conversation.mode ?? 'single'
    const rawAll = [...accumulated, ...conversation.messages]
    const uiMessages = rawAll.map(toUIMessage)
    const visibleMessages =
      mode === 'compare'
        ? uiMessages
        : uiMessages.filter((_, i) => {
            const m = rawAll[i]
            return m.role === 'user' || m.groupId == null || m.model === conversation.model
          })

    if (mode === 'compare' && conversation.compareModels.length >= 2) {
      const lanes = conversation.compareModels.map((modelId) =>
        rawAll.filter((m) => m.role === 'user' || m.model === modelId).map(toUIMessage)
      )
      return { initialMessages: visibleMessages, laneInitialMessages: lanes }
    }
    return { initialMessages: visibleMessages, laneInitialMessages: undefined }
  }, [conversation, accumulated])

  // ── 渲染分支 ─────────────────────────────────────────────────
  // 1) 鉴权中(query 尚未允许启动) → 保留 loading 骨架
  // 2) 首次无缓存 + 还在请求中(且没报错) → loading 骨架
  // 3) 有缓存 + 后台 refetching → 直接展示旧数据,不显示骨架
  const showSkeleton =
    redirectToStudy ||
    status === 'loading' ||
    (!conversation && conversationQuery.isPending)

  if (showSkeleton) {
    return (
      <div className="flex h-full items-center justify-center text-content-muted">
        <div className="flex items-center gap-3">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-content-muted border-t-transparent" />
          <span>加载会话中…</span>
        </div>
      </div>
    )
  }

  if (conversationQuery.error && !conversation) {
    const info = getErrorMessage(
      conversationQuery.error instanceof Error
        ? conversationQuery.error
        : new Error(String(conversationQuery.error))
    )
    return (
      <div className="flex h-full items-center justify-center">
        <div className="max-w-md rounded-lg border border-line bg-surface p-6 text-center">
          <p className="mb-2 font-medium text-content-primary">会话加载失败</p>
          <p className="text-sm text-content-secondary">{info.message}</p>
          <button
            type="button"
            onClick={() => router.replace('/chat')}
            className="mt-4 rounded-md bg-accent px-4 py-2 text-sm text-accent-foreground hover:bg-accent-hover"
          >
            返回对话列表
          </button>
        </div>
      </div>
    )
  }

  if (!conversation) {
    return null
  }

  // 更早入口:端点只报首屏口径(hasEarlier/游标),续载后由游标是否耗尽决定收摊
  const serverEarlier = conversation.hasEarlier === true && !!conversation.earlierCursorId
  const showEarlierEntry =
    conversation.mode !== 'compare' && (accumulatedCursor === undefined ? serverEarlier : !!accumulatedCursor)
  const remainingEarlierCount = Math.max(
    0,
    (conversation.earlierCount ?? 0) - accumulated.length
  )

  return (
    // key={conversation.id} 让 React 在切换会话时干净地卸载/重建 ChatPanel,
    // 避免 useChat 的 messages 流污染到上一个会话。同时配合 useQuery 缓存,
    // 命中缓存时 page.tsx 同步返回 data,ChatPanel key 切换几乎无感知。
    <ChatPanel
      key={conversation.id}
      conversationId={conversation.id}
      conversationTitle={conversation.title}
      initialMessages={initialState.initialMessages}
      earlierCount={remainingEarlierCount}
      onLoadEarlier={showEarlierEntry ? loadEarlier : undefined}
      initialModel={conversation.model}
      allModels={allModels}
      mode={conversation.mode}
      compareModels={
        conversation.mode === 'compare' && conversation.compareModels.length >= 2
          ? conversation.compareModels
          : undefined
      }
      laneInitialMessages={initialState.laneInitialMessages}
      initialStylePreset={conversation.stylePreset ?? undefined}
      initialReplyLength={conversation.replyLength ?? undefined}
      initialMaskId={conversation.maskId ?? undefined}
      initialCompareVote={conversation.latestVote ?? null}
    />
  )
}
