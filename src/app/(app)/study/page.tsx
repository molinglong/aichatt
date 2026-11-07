'use client'

import { useState, useEffect, useRef, Suspense, useMemo } from 'react'
import { BookOpen, CalendarClock, NotebookPen, Star, X } from 'lucide-react'
import { useSearchParams, usePathname, useRouter } from 'next/navigation'
import type { UIMessage } from 'ai'
import { ChatPanel } from '@/components/chat/ChatPanel'
import { NoteList } from '@/components/study/NoteList'
import { FavoriteList } from '@/components/study/FavoriteList'
import { ReviewCard } from '@/components/study/ReviewCard'
import { AuthErrorBoundary } from '@/components/AuthErrorBoundary'
import { ClientOnly } from '@/components/ClientOnly'
import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { useSession } from 'next-auth/react'
import { useChatStore } from '@/store/chat-store'
import { providersModelsQuery } from '@/lib/query/providers'
import { fetchJson, NotFoundError } from '@/lib/query/fetcher'
import { queryKeys, STALE } from '@/lib/query/keys'
import { clearStudyLesson, loadStudyLesson, patchStudyLesson } from '@/lib/study/lesson-session'
import type { Attachment } from '@/lib/attachment-types'
import { cn } from '@/lib/utils'

const CHIP =
  'px-2.5 py-1 rounded-full text-xs bg-surface-subtle/60 border border-line/60 text-content-secondary'

interface StudyMessageRow {
  id: string
  role: string
  content: string
  reasoning?: string | null
  model?: string | null
  groupId?: string | null
  streaming?: boolean
  attachments?: unknown
  metadata?: unknown
  favoriteId?: string | null
  createdAt?: string
}

interface StudyConversation {
  id: string
  title: string
  model: string
  messages: StudyMessageRow[]
}

/** 会话行 → UIMessage(与 /chat/c/[id] 的 adapter 同形,只保留学习室用得到的字段) */
function studyMessageToUI(msg: StudyMessageRow): UIMessage {
  const parts: UIMessage['parts'] = []
  if (msg.reasoning) parts.push({ type: 'reasoning' as const, text: msg.reasoning, state: 'done' as const })
  parts.push({ type: 'text' as const, text: msg.content ?? '', state: 'done' as const })
  const attachments = Array.isArray(msg.attachments)
    ? (msg.attachments as Attachment[]).filter(
        (a) => !!a && typeof a.url === 'string' && typeof a.name === 'string'
      )
    : []
  const meta =
    msg.metadata && typeof msg.metadata === 'object' && !Array.isArray(msg.metadata)
      ? (msg.metadata as Record<string, unknown>)
      : null
  const metadata = msg.streaming ? { ...(meta ?? {}), streaming: true } : meta
  return {
    id: msg.id,
    role: msg.role as 'user' | 'assistant' | 'system',
    parts,
    ...(msg.createdAt ? { createdAt: new Date(msg.createdAt) } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(metadata ? { metadata } : {}),
    favoriteId: msg.favoriteId ?? null,
  } as UIMessage
}

function StudyContent() {
  const { status } = useSession()
  // 与 /chat 同源的"开新课"信号:侧栏「新对话」bump 后本页面也重挂载回空白会话
  const newChatNonce = useChatStore((s) => s.newChatNonce)
  const setCurrentConversationId = useChatStore((s) => s.setCurrentConversationId)
  const setConversationTitle = useChatStore((s) => s.setConversationTitle)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerTab, setDrawerTab] = useState<'review' | 'notes' | 'favorites'>('notes')
  const searchParams = useSearchParams()
  const queryClient = useQueryClient()
  const refreshStudyCounts = () => {
    void queryClient.invalidateQueries({ queryKey: ['study', 'queue'] })
    void queryClient.invalidateQueries({ queryKey: ['study', 'notes-count'] })
    void queryClient.invalidateQueries({ queryKey: ['favorites', 'count'] })
  }

  // ── 续课:刷新后接着上同一道题 ─────────────────────────────────
  // 会话 id 优先取 URL(?c=,浏览器前进后退也成立),没有则回落本地快照
  // (直接重开 /study 时也能接上上次那堂课)。
  const [resumeId, setResumeId] = useState<string | null>(
    () => searchParams.get('c') || loadStudyLesson().conversationId
  )

  // 从侧栏历史直接切到另一堂课(/study?c= 变化)时换课:
  // resumeId 只在挂载时读一次,不跟着查询参数走就会停在上一堂课上。
  const urlConversationId = searchParams.get('c')
  useEffect(() => {
    if (!urlConversationId) return
    setResumeId((prev) => (prev === urlConversationId ? prev : urlConversationId))
  }, [urlConversationId])

  // 开新课信号(侧栏「新对话」/结课「再学一道」)→ 丢弃续课。
  // 侧栏「新对话」还会把页面导航去 /chat,那种情况只清快照,不能反手把地址栏改回 /study
  const pathname = usePathname()
  const nonceRef = useRef(newChatNonce)
  useEffect(() => {
    if (nonceRef.current === newChatNonce) return
    nonceRef.current = newChatNonce
    clearStudyLesson()
    setResumeId(null)
    if (pathname !== '/study') return
    const panel = searchParams.get('panel')
    window.history.replaceState(null, '', panel ? `/study?panel=${panel}` : '/study')
  }, [newChatNonce, searchParams, pathname])

  const conversationQuery = useQuery({
    queryKey: queryKeys.conversations.detail(resumeId ?? ''),
    queryFn: ({ signal }) => fetchJson<StudyConversation>(`/api/conversations/${resumeId}`, { signal }),
    enabled: status === 'authenticated' && !!resumeId,
    staleTime: STALE.conversation,
  })

  // 会话已不存在(被删/换了账号)→ 丢掉续课,回起始页重新开始
  useEffect(() => {
    if (!(conversationQuery.error instanceof NotFoundError)) return
    clearStudyLesson()
    setResumeId(null)
    window.history.replaceState(null, '', '/study')
  }, [conversationQuery.error])

  const conversation = conversationQuery.data

  // 让顶栏标题与侧栏高亮跟恢复的会话对上(与 /chat/c/[id] 行为一致)
  useEffect(() => {
    if (!conversation) return
    setCurrentConversationId(conversation.id)
    setConversationTitle(conversation.title)
    // 快照丢过/清过时也从会话回填归属,保证下次从侧栏进 /study 仍能续同一堂课
    patchStudyLesson({ conversationId: conversation.id })
  }, [conversation, setCurrentConversationId, setConversationTitle])

  // 可见过滤与 /chat/c/[id] 同口径(单聊:其他模型的回复不下发)
  const resumedMessages = useMemo<UIMessage[] | null>(() => {
    if (!conversation) return null
    return conversation.messages
      .filter((m) => m.role === 'user' || m.groupId == null || m.model === conversation.model)
      .map(studyMessageToUI)
  }, [conversation])

  // 扩展等外部入口可直接落到错题本抽屉:/study?panel=notes
  useEffect(() => {
    const panel = searchParams.get('panel')
    if (panel === 'notes' || panel === 'review' || panel === 'favorites') {
      setDrawerTab(panel)
      setDrawerOpen(true)
    }
  }, [searchParams])

  // 抽屉每次打开/切换都刷新计数,避免「刚存完卡 chip 还是旧数字」
  useEffect(() => {
    if (drawerOpen) refreshStudyCounts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawerOpen])

  const { data: allModels } = useSuspenseQuery(providersModelsQuery)
  // 首跑默认模型优先公共池门面档,与 /chat 同规则(见 chat/page.tsx 注释)
  const defaultModel =
    allModels.find((m) => m.publicPool)?.id || allModels[0]?.id || 'gpt-5.4-mini'

  // 状态条计数:与 /api/study/queue、服务端学情回灌同口径(到期含新卡;薄弱=lapses>=1 或掌握度<0.3)
  const { data: queue } = useQuery({
    queryKey: ['study', 'queue'],
    queryFn: () => fetchJson<Array<{ id: string }>>('/api/study/queue'),
    staleTime: 30_000,
  })
  const { data: notes } = useQuery({
    queryKey: ['study', 'notes-count'],
    queryFn: () => fetchJson<Array<{ id: string; lapses: number; mastery: number }>>('/api/study/notes'),
    staleTime: 30_000,
  })
  const dueCount = queue?.length ?? 0
  const weakCount = notes?.filter((n) => n.lapses >= 1 || n.mastery < 0.3).length ?? 0

  // 收藏计数:与错题本/复习队列完全独立,只用于抽屉状态条与工具入口文案
  const { data: favoritesCount } = useQuery({
    queryKey: ['favorites', 'count'],
    queryFn: () => fetchJson<{ count: number }>('/api/favorites?count=1'),
    staleTime: 30_000,
  })
  const favoriteCount = favoritesCount?.count ?? 0

  // 可翻原文的课本数(书架入口文案);只取 id 逻辑上等价于整个轻量列表,直接复用书架 API
  const router = useRouter()
  const { data: kbDocs } = useQuery({
    queryKey: queryKeys.kb.docs(),
    queryFn: ({ signal }) => fetchJson<Array<{ id: string }>>('/api/kb/docs', { signal }),
    staleTime: 60_000,
  })
  const kbCount = kbDocs?.length ?? 0

  if (status === 'loading') return null

  // 续课请求没回来前先挡一帧骨架:直接渲染学习室会闪一次「从一道题开始」再跳回讲解
  if (resumeId && status === 'authenticated' && !conversation && !conversationQuery.error) {
    return (
      <div className="flex h-full items-center justify-center text-content-muted">
        <div className="flex items-center gap-3">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-content-muted border-t-transparent" />
          <span>正在续上这道题…</span>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* 导师会话流(全宽主体) */}
      <div className="flex-1 min-h-0 relative overflow-hidden">
        <ChatPanel
          key={`study-${newChatNonce}-${conversation?.id ?? 'new'}`}
          studyMode
          conversationId={conversation?.id}
          initialMessages={resumedMessages ?? []}
          initialModel={conversation?.model ?? defaultModel}
          studyTools={[
            {
              id: 'notes',
              label: '错题本',
              description: notes && notes.length > 0
                ? `共 ${notes.length} 道${weakCount > 0 ? `，${weakCount} 道待巩固` : ''}`
                : '结课后会自动收进这里',
              icon: <NotebookPen size={18} />,
              onClick: () => { setDrawerTab('notes'); setDrawerOpen(true) },
            },
            {
              id: 'review',
              label: '错题回看',
              description: dueCount > 0 ? `待回看 ${dueCount} 道` : '暂无待回看的错题',
              icon: <CalendarClock size={18} />,
              onClick: () => { setDrawerTab('review'); setDrawerOpen(true) },
            },
            {
              id: 'favorites',
              label: '收藏',
              description: favoriteCount > 0 ? `已收藏 ${favoriteCount} 条` : '星标消息会收进这里',
              icon: <Star size={18} />,
              onClick: () => { setDrawerTab('favorites'); setDrawerOpen(true) },
            },
            {
              id: 'books',
              label: '课本',
              description: kbCount > 0 ? `${kbCount} 本教材 · 翻原文页面` : '导入教材后可翻原文',
              icon: <BookOpen size={18} />,
              onClick: () => router.push('/kb'),
            },
          ]}
          allModels={allModels}
        />

        {/* 错题本/复习抽屉:后台沉淀的备查视图 */}
        {drawerOpen && (
          <div className="absolute inset-0 z-40">
            <div className="absolute inset-0 bg-black/25" onClick={() => setDrawerOpen(false)} />
            <aside className="absolute right-0 top-0 bottom-0 w-full max-w-[400px] bg-surface border-l border-line shadow-xl flex flex-col">
              <div className="shrink-0 flex items-center gap-1 px-3 py-2 border-b border-line">
                {(
                  [
                    ['review', '错题回看'],
                    ['notes', '错题本'],
                    ['favorites', '收藏'],
                  ] as const
                ).map(([tab, label]) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setDrawerTab(tab)}
                    className={cn(
                      'px-3 py-1.5 rounded-lg text-xs transition-colors',
                      drawerTab === tab
                        ? 'bg-surface-subtle text-content-primary font-medium'
                        : 'text-content-muted hover:text-content-primary'
                    )}
                  >
                    {label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setDrawerOpen(false)}
                  className="ml-auto p-1.5 rounded-md text-content-muted hover:text-content-primary hover:bg-surface-subtle transition-colors"
                  aria-label="关闭抽屉"
                >
                  <X size={16} />
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto">
                <div className="flex flex-wrap gap-2 px-4 py-3">
                  {drawerTab === 'favorites' ? (
                    <span className={CHIP}>已收藏 <b>{favoriteCount}</b></span>
                  ) : (
                    <>
                      <span className={CHIP}>待回看 <b>{dueCount}</b></span>
                      <span className={CHIP}>薄弱考点 <b>{weakCount}</b></span>
                    </>
                  )}
                </div>
                {drawerTab === 'notes' ? <NoteList onChanged={refreshStudyCounts} /> : drawerTab === 'review' ? <ReviewCard onChanged={refreshStudyCounts} /> : <FavoriteList onChanged={refreshStudyCounts} />}
              </div>
            </aside>
          </div>
        )}
      </div>
    </div>
  )
}

export default function StudyPage() {
  return (
    <AuthErrorBoundary>
      <Suspense>
        <ClientOnly>
          <StudyContent />
        </ClientOnly>
      </Suspense>
    </AuthErrorBoundary>
  )
}
