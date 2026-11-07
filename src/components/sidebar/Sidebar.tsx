'use client'

import { useEffect, useLayoutEffect, useState, useCallback, useRef } from 'react'
import { useRenderProbe } from '@/lib/client-diagnostics'
import type { CSSProperties } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Settings, Search, Star, PanelLeftClose, PanelLeftOpen, VenetianMask, LogOut, User, Glasses, ListChecks, Trash2, X, FileJson } from 'lucide-react'
import { signOut, useSession } from 'next-auth/react'
import { useInfiniteQuery, useQueryClient, useQuery, type InfiniteData } from '@tanstack/react-query'
import { NEW_CHAT_MASK_SIGNAL_KEY, useChatStore } from '@/store/chat-store'
import { BUILTIN_MASKS } from '@/lib/ai/builtin-masks'
import { resolveMaskBadge, type MaskDTO } from '@/lib/ai/mask-types'
import { useInstalledMasks } from '@/hooks/useInstalledMasks'
import { useSingleFlight } from '@/hooks/useSingleFlight'
import { useStartNewChat } from '@/hooks/useStartNewChat'
import { useBackgroundStreamWatcher } from '@/hooks/useBackgroundStreamWatcher'
import { useForegroundResume } from '@/hooks/useForegroundResume'
// 暂时下线新消息提醒(如需恢复,连同下方调用一起取消注释)
// import { useUnreadToastNotifier } from '@/hooks/useUnreadToastNotifier'
import { useIsTauri } from '@/lib/tauri'
import { TrafficLights } from '@/components/TrafficLights'
import { cn } from '@/lib/utils'
import { ConversationItem } from './ConversationItem'
import { SearchDialog } from './SearchDialog'
import { FavoritesDialog } from '@/components/favorites/FavoritesDialog'
import { SidebarNav } from './SidebarNav'
import { queryKeys, STALE } from '@/lib/query/keys'
import { fetchJson, HttpError } from '@/lib/query/fetcher'
import { toast } from '@/lib/toast'
import { downloadConversationBundle } from '@/lib/portable-client'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'

interface ConversationData {
  id: string
  title: string
  mode?: string
  /** 学习模式会话:点进 /chat/c/id 后由会话页渲染学习室(2026-11-02 起不再改道 /study) */
  studyMode?: boolean
  /** 主对话:账号级学习管家,置顶 + 蓝色识别态 */
  isMain?: boolean
  maskId?: string | null
  updatedAt: string
}

interface ConversationsPage {
  items: ConversationData[]
  total: number
  hasMore: boolean
}

const PAGE_SIZE = 20

/** 滚动到底自动续载哨兵:进入视口(含提前 240px 预载距离)即触发加载下一页,
 * 替代旧的手动「加载更多」按钮,滚动连续无感;加载完成后哨兵仍在视口内会
 * 自动续载下一页直到填满视口。 */
function LoadMoreSentinel({ onVisible, loading }: { onVisible: () => void; loading: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) onVisible()
      },
      { rootMargin: '240px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [onVisible])
  return (
    <div ref={ref} className="py-2 text-center text-[11px] text-content-muted/60">
      {loading ? '加载中…' : ''}
    </div>
  )
}

async function fetchConversationsPage(ctx: {
  pageParam: number
}): Promise<ConversationsPage> {
  const data = await fetchJson<ConversationsPage>(
    `/api/conversations?limit=${PAGE_SIZE}&offset=${ctx.pageParam}`
  )
  return {
    items: data.items ?? [],
    total: data.total ?? 0,
    hasMore: !!data.hasMore,
  }
}

export function Sidebar() {
  useRenderProbe('Sidebar')
  const inTauri = useIsTauri()

  const sidebarOpen = useChatStore((s) => s.sidebarOpen)
  const toggleSidebar = useChatStore((s) => s.toggleSidebar)
  const setSidebarOpen = useChatStore((s) => s.setSidebarOpen)
  const setSettingsOpen = useChatStore((s) => s.setSettingsOpen)
  const setSettingsSection = useChatStore((s) => s.setSettingsSection)
  const conversationVersion = useChatStore((s) => s.conversationVersion)
  const hydrated = useChatStore((s) => s.hydrated)
  const setHydrated = useChatStore((s) => s.setHydrated)
  const currentConversationId = useChatStore((s) => s.currentConversationId)
  const setConversationTitle = useChatStore((s) => s.setConversationTitle)
  const conversationMaskId = useChatStore((s) => s.conversationMaskId)
  const setConversationMaskId = useChatStore((s) => s.setConversationMaskId)
  const removeConversationRead = useChatStore((s) => s.removeConversationRead)
  const queryClient = useQueryClient()

  // 后台生成跟踪:生成中切走的会话完成后点亮蓝点(轮询注册表,完成即刷新列表)
  useBackgroundStreamWatcher()

  useLayoutEffect(() => {
    if (!hydrated) {
      setHydrated(true)
      try {
        localStorage.getItem('chat:sidebarOpen')
      } catch {
        // ignore
      }
    }
  }, [hydrated, setHydrated])

  const sidebarEffectiveOpen = hydrated ? sidebarOpen : true
  const { data: session } = useSession()
  // 临时聊天模式(访客密码登录):侧边栏只显示隔离区临时对话,
  // 隐藏账户设置入口;服务端 API 层已同步隔离,此处仅 UX 提示
  const isEphemeral = session?.ephemeral === true

  // 自定义面具列表（面具菜单「我的面具」分组用）
  const { data: userMasks } = useQuery({
    queryKey: queryKeys.masks.list(),
    queryFn: () => fetchJson<MaskDTO[]>('/api/masks'),
    staleTime: STALE.masks,
  })
  // 面具面板已下载的内置面具，与自定义面具一起进「我的面具」
  const { installedMasks } = useInstalledMasks()
  // 已下载面具若已升入精选（策展调整），不再重复出现在「我的面具」
  const curatedMaskIds = new Set(BUILTIN_MASKS.map((m) => m.id))
  const myMasks = [...(userMasks ?? []), ...installedMasks.filter((m) => !curatedMaskIds.has(m.id))]

  // ── Infinite Query: conversation list ─────────────────────────
  // bumpConversationVersion() is called when a new conversation is
  // created / deleted / renamed; we listen for version changes and
  // invalidate to refetch in the background.
  const {
    data,
    isLoading,
    isPending,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
  } = useInfiniteQuery<
    ConversationsPage,
    HttpError,
    InfiniteData<ConversationsPage, number>,
    readonly unknown[],
    number
  >({
    queryKey: queryKeys.conversations.list(PAGE_SIZE, 0),
    queryFn: async ({ pageParam }) =>
      fetchConversationsPage({ pageParam }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage.hasMore) return undefined
      // Sum across already-loaded pages
      return allPages.reduce((acc, p) => acc + p.items.length, 0)
    },
    staleTime: STALE.conversationList,
  })

  // bumpConversationVersion() triggers invalidate so a refetch happens
  useEffect(() => {
    if (conversationVersion === 0) return
    queryClient.invalidateQueries({ queryKey: queryKeys.conversations.list(PAGE_SIZE, 0) })
  }, [conversationVersion, queryClient])

  // 跨端回流:从后台切回来时刷一次列表,电脑上新开/聊过的会话排序与蓝点才跟得上
  // (全局 refetchOnWindowFocus 是关的,这里只对会话列表这一项开口子)
  useForegroundResume(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.conversations.list(PAGE_SIZE, 0) })
  })

  const conversations: ConversationData[] = (data?.pages ?? []).flatMap((p) => p.items)
  const total = data?.pages?.[0]?.total ?? 0
  // 搜索弹层走全局开关：顶栏搜索框（Google 样式）与侧栏搜索钮共用
  const searchOpen = useChatStore((s) => s.searchDialogOpen)
  const setSearchOpen = useChatStore((s) => s.setSearchDialogOpen)
  // 面具选择菜单(仅在展开态渲染,折叠态点击先展开侧边栏)
  const [maskMenuOpen, setMaskMenuOpen] = useState(false)
  // 用户菜单(底部头像/用户行点击弹出:账号设置入口 + 退出登录)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  // 收藏浮层:主界面看收藏的入口(星标消息的归档列表,与学习室抽屉同一份 FavoriteList)
  const [favoritesOpen, setFavoritesOpen] = useState(false)
  // ── 批量删除:管理模式开关、勾选集合、确认弹窗目标 ──
  const [manageMode, setManageMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  /** 待确认的单条删除会话 id:非空即打开确认弹窗(替代原生 window.confirm) */
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  /** 批量导出对话包进行中:导出是取数+下载,不碰库,但仍要防连点 */
  const [batchExporting, setBatchExporting] = useState(false)
  const router = useRouter()

  const loading = isLoading || isPending
  const loadingMore = isFetchingNextPage
  const hasMore = !!hasNextPage

  const handleLoadMore = useCallback(() => {
    if (!hasNextPage || isFetchingNextPage) return
    fetchNextPage()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  // Toast on unread change
  // 暂时下线新消息提醒(恢复时取消注释,并恢复顶部 import)
  // useUnreadToastNotifier(conversations)

  // Cmd/Ctrl + K opens the search dialog
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  /**
   * Fixed: hard reload removed.
   *
   * Previously, when pathname === '/chat' but window.location had been
   * rewritten to /chat/c/[id], we forced `window.location.href = '/chat'`
   * which triggered a full page reload — Sidebar/TopBar rebuilt, fonts
   * re-downloaded, store rehydrated. Perceived as "a hitch".
   *
   * Now: startNewChat (see useStartNewChat for why a bare router.push
   * is not enough — replaceState-made URLs make Next.js reuse the same
   * page subtree, or no-op entirely when already on /chat).
   * ChatPanel re-mounts with a fresh key when the new page renders,
   * so useChat enters "new conversation" mode deterministically.
   */
  const startNewChat = useStartNewChat()
  const handleNewConversation = useSingleFlight(() => {
    // 移动端(<md)侧边栏是 fixed 浮层,点完「新对话」要收回才能看到聊天区;
    // 桌面端侧边栏静态占位,保持用户当前的开合状态,不折叠。
    if (typeof window !== 'undefined' && !window.matchMedia('(min-width: 768px)').matches) {
      setSidebarOpen(false)
    }
    startNewChat()
  }, [setSidebarOpen, startNewChat])

  // 选面具开新对话:写入 store + 一次性信号,复用单飞导航。
  // 新对话默认不带面具,只有这里显式选择才通过信号带入;
  // ChatPanel 挂载后消费信号恢复,首条消息发送时服务端将 maskId 写入会话。
  const handleSelectMask = useCallback(
    (maskId: string | null) => {
      if (maskId) {
        localStorage.setItem(NEW_CHAT_MASK_SIGNAL_KEY, maskId)
      } else {
        localStorage.removeItem(NEW_CHAT_MASK_SIGNAL_KEY)
      }
      setConversationMaskId(maskId)
      setMaskMenuOpen(false)
      handleNewConversation()
    },
    [setConversationMaskId, handleNewConversation]
  )

  // 折叠态点面具图标:先展开侧边栏再弹菜单(菜单在展开态渲染,避免被 aside overflow 裁剪)
  const handleMaskButtonInCollapsed = useCallback(() => {
    setSidebarOpen(true)
    setMaskMenuOpen(true)
  }, [setSidebarOpen])

  // 折叠态点头像:先展开侧边栏再弹菜单(菜单在展开态渲染,避免被 aside overflow 裁剪)
  const handleAvatarInCollapsed = useCallback(() => {
    setSidebarOpen(true)
    setUserMenuOpen(true)
  }, [setSidebarOpen])

  // 用户菜单 → 打开设置弹窗并定位到「用户中心」
  const handleOpenAccountSettings = useCallback(() => {
    setUserMenuOpen(false)
    setSettingsSection('account')
    setSettingsOpen(true)
  }, [setSettingsSection, setSettingsOpen])

  // 用户菜单 → 退出登录
  const handleSignOut = useCallback(async () => {
    setUserMenuOpen(false)
    await signOut({ callbackUrl: '/login' })
  }, [])

  // 用户菜单:点击外部或 Esc 关闭。不用 fixed 遮罩——aside 的 backdrop-blur/transform
  // 会使 fixed 相对 aside 而非视口定位,遮罩罩不住主内容区
  useEffect(() => {
    if (!userMenuOpen) return
    function onPointerDown(e: PointerEvent) {
      const el = e.target as HTMLElement | null
      if (el?.closest('[data-user-menu-root]')) return
      setUserMenuOpen(false)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setUserMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [userMenuOpen])

  /** 从无限查询缓存里剔除指定会话(逐页 total 按真实命中数扣减),避免整表 refetch */
  const dropConversationsFromCache = useCallback((ids: Set<string>) => {
    queryClient.setQueryData<InfiniteData<ConversationsPage, number> | undefined>(
      queryKeys.conversations.list(PAGE_SIZE, 0),
      (prev) => {
        if (!prev) return prev
        const present = new Set<string>()
        for (const page of prev.pages) {
          for (const c of page.items) if (ids.has(c.id)) present.add(c.id)
        }
        return {
          ...prev,
          pages: prev.pages.map((p) => ({
            ...p,
            items: p.items.filter((c) => !ids.has(c.id)),
            total: Math.max(0, p.total - present.size),
          })),
        }
      }
    )
  }, [queryClient])

  // 单条删除只负责打开确认弹窗,真正的删除在 confirmSingleDelete 里执行
  const handleDeleteConversation = useCallback((id: string) => {
    setPendingDeleteId(id)
  }, [])

  const confirmSingleDelete = useCallback(async () => {
    const id = pendingDeleteId
    if (!id) return
    setDeleting(true)
    try {
      await fetchJson(`/api/conversations/${id}`, { method: 'DELETE' })
      dropConversationsFromCache(new Set([id]))
      removeConversationRead(id)
      if (currentConversationId === id) {
        router.push('/chat')
      }
      setPendingDeleteId(null)
    } catch (err) {
      console.error('Failed to delete conversation:', err)
      toast.error(err instanceof Error ? err.message : '删除失败，请重试', { title: '删除对话' })
    } finally {
      setDeleting(false)
    }
  }, [
    pendingDeleteId,
    dropConversationsFromCache,
    removeConversationRead,
    currentConversationId,
    router,
  ])

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const exitManageMode = useCallback(() => {
    setManageMode(false)
    setSelectedIds(new Set())
    setBatchConfirmOpen(false)
  }, [])

  const confirmBatchDelete = useCallback(async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    setDeleting(true)
    try {
      const res = await fetchJson<{ deleted?: number; skipped?: number }>(
        '/api/conversations/batch-delete',
        { method: 'POST', json: { ids } }
      )
      dropConversationsFromCache(new Set(ids))
      selectedIds.forEach((id) => removeConversationRead(id))
      if (currentConversationId && selectedIds.has(currentConversationId)) {
        startNewChat()
      }
      const skipped = res?.skipped ?? 0
      if (skipped > 0) {
        toast.error(`已删除 ${res?.deleted ?? 0} 个，${skipped} 个已不存在或无权删除`, {
          title: '批量删除',
        })
      } else {
        toast.success(`已删除 ${res?.deleted ?? ids.length} 个对话`, { title: '批量删除' })
      }
      exitManageMode()
    } catch (err) {
      // 失败保留勾选集合,用户可直接重试同一批
      console.error('Failed to batch delete conversations:', err)
      toast.error(err instanceof Error ? err.message : '批量删除失败，请重试', { title: '批量删除' })
    } finally {
      setDeleting(false)
    }
  }, [
    selectedIds,
    dropConversationsFromCache,
    removeConversationRead,
    currentConversationId,
    startNewChat,
    exitManageMode,
  ])

  /**
   * 批量导出对话包:把勾选的会话打成一个可回灌的 .aichat.json。
   * 与批量删除共用勾选集合,导完**不**退出管理模式 ——
   * 用户常常是"先导一遍再决定删哪些",导完就退模式等于把勾选白丢了。
   */
  const confirmBatchExport = useCallback(async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    setBatchExporting(true)
    try {
      const res = await downloadConversationBundle({
        ids,
        fileName: `aichat-对话包-${ids.length}条-${new Date().toISOString().slice(0, 10)}`,
      })
      if (res.skipped > 0) {
        toast.error(
          `已导出 ${res.exported} 条，${res.skipped} 条在当前模式下不可见`,
          { title: '批量导出' }
        )
      } else {
        toast.success(`已导出 ${res.exported} 条对话`, { title: '批量导出' })
      }
    } catch (err) {
      console.error('Failed to batch export conversations:', err)
      toast.error(err instanceof Error ? err.message : '导出失败，请重试', { title: '批量导出' })
    } finally {
      setBatchExporting(false)
    }
  }, [selectedIds])

  // 批量管理模式 Esc 退出;确认弹窗开着时让弹窗自己吃掉这次按键,避免一次退两层
  useEffect(() => {
    if (!manageMode || batchConfirmOpen) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') exitManageMode()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [manageMode, batchConfirmOpen, exitManageMode])

  const handleRenameConversation = useCallback(
    async (id: string, newTitle: string) => {
      try {
        await fetchJson(`/api/conversations/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          json: { title: newTitle },
        })
        // Optimistic: update cache immediately
        queryClient.setQueryData<InfiniteData<ConversationsPage, number> | undefined>(
          queryKeys.conversations.list(PAGE_SIZE, 0),
          (prev) => {
            if (!prev) return prev
            return {
              ...prev,
              pages: prev.pages.map((p) => ({
                ...p,
                items: p.items.map((c) =>
                  c.id === id ? { ...c, title: newTitle } : c
                ),
              })),
            }
          }
        )
        // 同步会话详情缓存，否则正在浏览的会话页顶栏标题不同步
        queryClient.setQueryData<
          | { id: string; title: string; [key: string]: unknown }
          | undefined
        >(queryKeys.conversations.detail(id), (prev) =>
          prev ? { ...prev, title: newTitle } : prev
        )
        // 新对话页(history.replaceState 后未导航到 /chat/c/[id])没有详情查询,
        // 顶栏标题由 store 驱动，直接同步
        if (currentConversationId === id) {
          setConversationTitle(newTitle)
        }
      } catch (err) {
        console.error('Failed to rename conversation:', err)
      }
    },
    [queryClient, currentConversationId, setConversationTitle]
  )

  return (
    <>
      {/* 方案 C:移动端(<md)旧抽屉遮罩已随全屏 V2 抽屉(MobileDrawer)下线 ——
          aside 本体在 <md 由 max-md:hidden 整体隐藏,桌面端(≥md)侧栏行为不变 */}

      {/* Sidebar */}
      {/* data-collapsed: 样式维度用(Google 侧栏展开 256px / 折叠 48px),
          只有展开态才允许 CSS 抬宽度,否则会压掉 md:w-12 的折叠轨道 */}
      <aside
        data-collapsed={!sidebarEffectiveOpen ? '' : undefined}
        className={cn(
          // app-shell-sidebar: shell 层壁纸激活时由 globals.css :has 规则改半透明(毛玻璃透壁纸)
          // max-md:hidden: 方案 C 手机端侧栏改走全屏 V2 抽屉(MobileDrawer),旧 w-56 浮层整体下线
          'app-shell-sidebar fixed top-1.5 bottom-1.5 left-1.5 z-50 w-56 flex flex-col max-md:hidden',
          // pb-[var(--sab)]: PWA 全屏模式下列表底部让出 Home Indicator 安全区(浏览器内为 0)
          'pb-[var(--sab)]',
          // 侧栏材质 = 「次级面」: 底色走 --surface-muted(比内容区的 --surface 暗一档,
          // 深色主题下反而亮一档),不再是纯白。
          // 原先的 bg-surface-glass 是「72% 的白」,而它背后就是 .app-shell 的纯色
          // bg-surface —— 同色叠同色、blur 在纯色上等于空转,侧栏因此是一块没有
          // 材质的死白(格子主题下比暖纸底的页面还白)。glass-blur 保留:
          // 它让 aside 成为 fixed 后代的包含块(下方面具菜单的点击遮罩依赖这点)。
          // sidebar-panel: 右端「入影」暗层(见 globals.css .sidebar-panel::after)。
          // 铺在整个面板上而不是只铺会话列表容器 —— 否则列表顶边会多一条断层
          'bg-surface-muted glass-blur text-content-primary sidebar-panel',
          'rounded-xl border border-line/50 overflow-hidden',
          'transition-transform duration-slow ease-standard',
          'm-1.5',
          sidebarEffectiveOpen ? 'translate-x-0' : '-translate-x-full',
          // Tablets and above: always static (taking layout space)
          'md:static md:z-auto md:inset-auto md:translate-x-0 md:m-1.5 md:transition-[width,transform,margin]',
          // Collapsed on desktop: shrink to a narrow icon bar
          !sidebarEffectiveOpen && 'md:w-12'
        )}
      >
        {/* 侧栏材质层(B): 纯 CSS 装饰,只在「配色 = 格子」下渲染(见 .sidebar-material)。
            三态共用同一套窗棂格影,只换光色与混合模式 —— 白天/暮色 multiply 压暗,
            晚上 screen 提亮;与聊天区是同一扇窗。基线 / 月白·桂花金下这一层不渲染 */}
        <div className="sidebar-material" aria-hidden="true" />

        <div
          className={cn(
            'sidebar-head flex items-center pt-3 pb-1.5',
            sidebarEffectiveOpen ? 'justify-between gap-2 px-3' : 'justify-center px-0'
          )}
          // 拖拽区两种状态都挂:折叠后顶栏带下线,侧栏头是窗口左上仅剩的拖拽点
          // ([data-tauri] [data-tauri-drag-region] button 的自动隔离见 globals.css)
          {...(inTauri
            ? {
                'data-tauri-drag-region': '',
                style: { WebkitAppRegion: 'drag' } as React.CSSProperties,
                onDoubleClick: () => {
                  import('@/lib/tauri').then(({ tauri }) => tauri.toggleMaximize())
                },
              }
            : {})}
        >
          {inTauri && sidebarEffectiveOpen && <TrafficLights />}
          {sidebarEffectiveOpen ? (
            <div className="flex items-center gap-2 min-w-0 flex-1">
              {/* 品牌标记: 深色模式换反白版图,不用 CSS filter 反相(会连红点一起翻色) */}
              <img src="/brand/mark.png" alt="" aria-hidden className="w-4 shrink-0 dark:hidden" />
              <img src="/brand/mark-invert.png" alt="" aria-hidden className="hidden w-4 shrink-0 dark:block" />
              <h1 className="text-base font-semibold tracking-tight truncate">aichatt</h1>
            </div>
          ) : (
            <button
              onClick={toggleSidebar}
              className="p-1 rounded-md hover:bg-surface-subtle transition active:scale-95 touch-manipulation"
              aria-label="展开侧边栏"
              title="展开侧边栏"
              style={{ WebkitTapHighlightColor: 'transparent', WebkitAppRegion: 'no-drag' } as CSSProperties}
            >
              <PanelLeftOpen className="w-3.5 h-3.5 text-content-secondary" />
            </button>
          )}
          {sidebarEffectiveOpen && (
            <button
              onClick={toggleSidebar}
              className="p-1 rounded-md hover:bg-surface-subtle transition active:scale-95 touch-manipulation"
              aria-label="收起侧边栏"
              title="收起侧边栏"
              style={{ WebkitTapHighlightColor: 'transparent', WebkitAppRegion: 'no-drag' } as CSSProperties}
            >
              <PanelLeftClose className="w-3.5 h-3.5 text-content-secondary" />
            </button>
          )}
        </div>

        {/* 临时聊天模式标识条(中性灰极简风):明确当前处于隔离区 */}
        {sidebarEffectiveOpen && isEphemeral && (
          <div className="mx-3 mt-1 mb-0.5 px-2.5 py-1.5 rounded-lg bg-surface-subtle/70 border border-line/40">
            <p className="text-[11px] font-medium text-content-secondary flex items-center gap-1.5">
              <Glasses className="w-3 h-3 shrink-0" aria-hidden />
              临时聊天
            </p>
            <p className="mt-0.5 text-[10px] leading-4 text-content-muted">
              对话已隔离保存，可在正常模式 设置→用户中心 中找回
            </p>
          </div>
        )}
        {!sidebarEffectiveOpen && isEphemeral && (
          <div className="flex justify-center pt-1" title="临时聊天模式">
            <Glasses className="w-3.5 h-3.5 text-content-muted" aria-label="临时聊天模式" />
          </div>
        )}

        {/* 页面导航(T-C 顶栏下沉):展开态首行「聊天」(客户端升级为「聊天 | 工作」切换条)
            + 「更多功能」折叠组 —— 见 SidebarNav */}
        {sidebarEffectiveOpen && <SidebarNav variant="list" />}

        {/* 页面导航(C-1 常驻轨道):折叠后导航仍一击可及,与下方会话动作以分隔线断开 */}
        {!sidebarEffectiveOpen && (
          <>
            <SidebarNav variant="rail" />
            <div className="mx-auto w-6 border-t border-line/40" />
          </>
        )}

        {!sidebarEffectiveOpen && (
          <div className="flex flex-col items-center gap-1 pt-2">
            <button
              onClick={handleNewConversation}
              className="p-2 rounded-lg text-content-secondary hover:text-content-primary hover:bg-surface-subtle/60 transition active:scale-95 touch-manipulation"
              aria-label="新对话"
              title="新对话"
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              <Plus className="w-4 h-4" />
            </button>
            <button
              onClick={handleMaskButtonInCollapsed}
              className="p-2 rounded-lg text-content-secondary hover:text-content-primary hover:bg-surface-subtle/60 transition active:scale-95 touch-manipulation"
              aria-label="用面具开新对话"
              title="用面具开新对话"
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              <VenetianMask className="w-4 h-4" />
            </button>
            <button
              onClick={() => setSearchOpen(true)}
              className="p-2 rounded-lg text-content-secondary hover:text-content-primary hover:bg-surface-subtle/60 transition active:scale-95 touch-manipulation"
              aria-label="搜索聊天记录"
              title="搜索 (⌘K / Ctrl+K)"
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              <Search className="w-4 h-4" />
            </button>
          </div>
        )}

        {sidebarEffectiveOpen && (
          <div className="px-2 pt-1.5 pb-3 relative">
            <div className="flex items-center gap-1.5">
              {/* 新对话: 底色不再用 bg-surface(255 纯白) —— 侧栏底已是近白的
                  --surface-muted,再叠一层纯白会在面板里多出一块死白(与刚撤掉的
                  左缘白层是同一个病),故改为近乎不加填充 + 描边。
                  h-8 与原 py-1.5 算出来的 32px 等高,加边框不会撑高这一行 */}
              <button
                onClick={handleNewConversation}
                className="sidebar-new-chat flex-1 flex h-8 items-center justify-start gap-1.5 px-3 rounded-lg text-sm font-medium
                  border border-line/40 bg-surface-muted/60 text-content-primary
                  hover:bg-surface-subtle transition active:scale-[0.98] touch-manipulation"
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                <Plus className="w-3.5 h-3.5" />
                新对话
              </button>
            </div>

            {/* 面具菜单:纯色浮层(遵循弹窗纯色背景规范),向下弹出 */}
            {maskMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMaskMenuOpen(false)} />
                <div
                  className="absolute left-2 top-full -mt-1.5 z-50 w-[13rem] max-h-72 overflow-y-auto
                    rounded-xl border border-line bg-surface shadow-lg py-1.5"
                  role="menu"
                >
                  <div className="px-3 py-1 text-[10px] font-medium text-content-muted/70 uppercase tracking-wide">
                    选择面具开新对话
                  </div>
                  {BUILTIN_MASKS.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => handleSelectMask(m.id)}
                      role="menuitem"
                      className={`w-full flex items-start gap-2.5 px-3 py-1.5 text-left transition-colors
                        ${m.id === conversationMaskId ? 'bg-surface-muted' : 'hover:bg-surface-subtle'}`}
                    >
                      <span className="text-base leading-5 shrink-0" aria-hidden>{m.avatar}</span>
                      <span className="min-w-0">
                        <span className="block text-xs font-medium text-content-primary">{m.name}</span>
                        <span className="block text-[11px] text-content-muted truncate">{m.description}</span>
                      </span>
                    </button>
                  ))}
                  {myMasks.length > 0 && (
                    <>
                      <div className="px-3 pt-2 pb-1 text-[10px] font-medium text-content-muted/70 uppercase tracking-wide">
                        我的面具
                      </div>
                      {myMasks.map((m) => (
                        <button
                          key={m.id}
                          onClick={() => handleSelectMask(m.id)}
                          role="menuitem"
                          className={`w-full flex items-start gap-2.5 px-3 py-1.5 text-left transition-colors
                            ${m.id === conversationMaskId ? 'bg-surface-muted' : 'hover:bg-surface-subtle'}`}
                        >
                          <span className="text-base leading-5 shrink-0" aria-hidden>{m.avatar}</span>
                          <span className="min-w-0">
                            <span className="block text-xs font-medium text-content-primary">{m.name}</span>
                            <span className="block text-[11px] text-content-muted truncate">{m.description}</span>
                          </span>
                        </button>
                      ))}
                    </>
                  )}
                  <div className="my-1 border-t border-line" />
                  {/* 临时模式隐藏面具管理入口(写操作已被服务端拦截) */}
                  {!isEphemeral && (
                    <button
                      onClick={() => { setSettingsSection('masks'); setSettingsOpen(true); setMaskMenuOpen(false) }}
                      role="menuitem"
                      className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-xs text-content-muted
                        hover:bg-surface-subtle transition-colors"
                    >
                      <Settings className="w-4 h-4 shrink-0" aria-hidden />
                      <span>管理面具（新增/编辑/删除）</span>
                    </button>
                  )}
                  <button
                    onClick={() => handleSelectMask(null)}
                    role="menuitem"
                    className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-xs text-content-muted
                      hover:bg-surface-subtle transition-colors"
                  >
                    <span className="text-base leading-5" aria-hidden>✕</span>
                    <span>不带面具开新对话</span>
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {sidebarEffectiveOpen && (
          <div className="px-3.5 pt-2 pb-1 flex items-center justify-between">
            <h2 className="text-[11px] font-medium text-content-muted/80">
              {manageMode
                ? `已选 ${selectedIds.size} 条`
                : isEphemeral ? '临时对话' : '历史记录'}
            </h2>
            <div className="flex items-center gap-1.5">
              {total > 0 && !manageMode && (
                <span className="text-[11px] text-content-muted/60 tabular-nums">
                  {conversations.length}
                  {hasMore ? ` / ${total}` : ''}
                </span>
              )}
              {/* 批量管理:进入多选模式后逐条删除换成勾选集合 + 底部一次性删除 */}
              {total > 0 && !manageMode && (
                <button
                  onClick={() => setManageMode(true)}
                  className="p-0.5 rounded-md text-content-muted/70 hover:text-content-primary hover:bg-surface-subtle transition active:scale-95 touch-manipulation"
                  aria-label="批量管理对话"
                  title="批量管理"
                  style={{ WebkitTapHighlightColor: 'transparent' }}
                >
                  <ListChecks className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                onClick={() => setSearchOpen(true)}
                className="p-0.5 -mr-1 rounded-md text-content-muted/70 hover:text-content-primary hover:bg-surface-subtle transition active:scale-95"
                aria-label="搜索聊天记录"
                title="搜索 (⌘K / Ctrl+K)"
              >
                <Search className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}

        {sidebarEffectiveOpen && (
          <div className="flex-1 overflow-y-auto px-1.5 pt-0.5">
            <nav className="space-y-0.5">
              {loading && !data ? (
                <div className="px-3 py-6 text-center text-content-muted text-xs">
                  加载中…
                </div>
              ) : conversations.length === 0 ? (
                <div className="px-3 py-6 text-center text-content-muted text-xs">
                  暂无对话记录
                </div>
              ) : (
                <>
                  {conversations.map((conv, index) => {
                    const badge = resolveMaskBadge(conv.maskId, userMasks)
                    return (
                      <ConversationItem
                        key={conv.id}
                        id={conv.id}
                        title={conv.title}
                        isMain={conv.isMain === true}
                        mode={conv.mode}
                        maskAvatar={badge?.avatar}
                        maskName={badge?.name}
                        index={index}
                        lastMessageAt={new Date(conv.updatedAt).getTime()}
                        selectable={manageMode}
                        selected={selectedIds.has(conv.id)}
                        onToggleSelect={toggleSelect}
                        onDelete={handleDeleteConversation}
                        onRename={handleRenameConversation}
                      />
                    )
                  })}
                  {hasMore && (
                    <LoadMoreSentinel onVisible={handleLoadMore} loading={loadingMore} />
                  )}
                </>
              )}
            </nav>
          </div>
        )}

        {/* 批量管理操作条 */}
        {sidebarEffectiveOpen && manageMode && (
          <div className="px-2 pt-2 pb-2 mt-0.5 border-t border-line/40 flex items-center gap-1.5">
            <button
              onClick={confirmBatchExport}
              disabled={selectedIds.size === 0 || batchExporting}
              className="flex-1 flex h-7 items-center justify-center gap-1 rounded-lg text-[11px] font-medium
                bg-surface-subtle text-content-secondary hover:bg-surface-muted
                transition-colors active:scale-[0.98] touch-manipulation
                disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100"
              aria-label={`导出 ${selectedIds.size} 个对话`}
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              {batchExporting ? (
                <FileJson className="w-3 h-3 animate-pulse" aria-hidden />
              ) : (
                <FileJson className="w-3 h-3" aria-hidden />
              )}
              导出{selectedIds.size > 0 ? ` ${selectedIds.size}` : ''}
            </button>
            <button
              onClick={() => setBatchConfirmOpen(true)}
              disabled={selectedIds.size === 0 || deleting}
              className="flex-1 flex h-7 items-center justify-center gap-1 rounded-lg text-[11px] font-medium
                bg-red-500 text-white hover:bg-red-600 dark:bg-red-500/90 dark:hover:bg-red-500
                transition-colors active:scale-[0.98] touch-manipulation
                disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100"
              aria-label={`删除 ${selectedIds.size} 个对话`}
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              <Trash2 className="w-3 h-3" aria-hidden />
              删除{selectedIds.size > 0 ? ` ${selectedIds.size}` : ''}
            </button>
            <button
              onClick={exitManageMode}
              className="h-7 px-2 rounded-lg text-[11px] text-content-muted hover:text-content-primary
                hover:bg-surface-subtle transition-colors touch-manipulation"
              aria-label="退出批量管理"
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              取消
            </button>
          </div>
        )}

        {/* User info region — hidden when collapsed */}
        {sidebarEffectiveOpen && session?.user && (
          <div
            className="relative px-2 pt-2 pb-2 mt-1 border-t border-line/40"
            data-user-menu-root
          >
            <div className="flex items-center gap-0.5">
            <button
              onClick={() => setUserMenuOpen((v) => !v)}
              className="min-w-0 flex-1 flex items-center gap-2 px-1.5 py-1 rounded-lg text-left
                hover:bg-surface-subtle/60 transition-colors touch-manipulation"
              aria-label="账号菜单"
              aria-expanded={userMenuOpen}
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              {session.user.image ? (
                <img
                  src={session.user.image}
                  alt={session.user.name || '头像'}
                  className="w-7 h-7 rounded-full shrink-0 object-cover"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="w-7 h-7 rounded-full bg-accent/20 flex items-center justify-center text-[11px] font-medium text-accent shrink-0">
                  {(session.user.name || session.user.email || '?').charAt(0).toUpperCase()}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-content-primary truncate">
                  {session.user.name || session.user.email || '已登录'}
                </p>
                {session.user.email && session.user.name && (
                  <p className="text-[10px] text-content-muted truncate">
                    {session.user.email}
                  </p>
                )}
              </div>
            </button>
            {/* 快捷入口:收藏浮层 + 设置,免两跳直达(临时模式隐藏设置,收藏跨模式可看) */}
            <div className="flex shrink-0 items-center">
              <button
                onClick={() => { setUserMenuOpen(false); setFavoritesOpen(true) }}
                className="p-1.5 rounded-md text-content-secondary hover:text-content-primary hover:bg-surface-subtle transition active:scale-95 touch-manipulation"
                aria-label="收藏"
                title="收藏"
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                <Star className="w-3.5 h-3.5" aria-hidden />
              </button>
              {!isEphemeral && (
                <button
                  onClick={() => { setUserMenuOpen(false); setSettingsOpen(true) }}
                  className="p-1.5 rounded-md text-content-secondary hover:text-content-primary hover:bg-surface-subtle transition active:scale-95 touch-manipulation"
                  aria-label="设置"
                  title="设置"
                  style={{ WebkitTapHighlightColor: 'transparent' }}
                >
                  <Settings className="w-3.5 h-3.5" aria-hidden />
                </button>
              )}
            </div>
            </div>

            {/* 用户菜单:纯色浮层(遵循弹窗纯色背景规范),向上弹出 */}
            {userMenuOpen && (
              <div
                className="absolute left-2 bottom-full mb-1.5 z-50 w-[13rem]
                  rounded-xl border border-line bg-surface shadow-lg py-1.5"
                role="menu"
              >
                <div className="px-3 py-2 flex items-center gap-2.5">
                  {session.user.image ? (
                    <img
                      src={session.user.image}
                      alt={session.user.name || '头像'}
                      className="w-9 h-9 rounded-full shrink-0 object-cover"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className="w-9 h-9 rounded-full bg-accent/20 flex items-center justify-center text-sm font-medium text-accent shrink-0">
                      {(session.user.name || session.user.email || '?').charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-content-primary truncate">
                      {session.user.name || '已登录'}
                    </p>
                    {session.user.email && (
                      <p className="text-[11px] text-content-muted truncate">
                        {session.user.email}
                      </p>
                    )}
                  </div>
                </div>
                <div className="my-1 border-t border-line" />
                {/* 临时模式隐藏账号设置入口(账户管理写操作已被服务端拦截) */}
                {!isEphemeral && (
                  <button
                    onClick={handleOpenAccountSettings}
                    role="menuitem"
                    className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-xs text-content-secondary
                      hover:bg-surface-subtle transition-colors"
                  >
                    <User className="w-4 h-4 shrink-0" aria-hidden />
                    <span>账号设置</span>
                  </button>
                )}
                <button
                  onClick={handleSignOut}
                  role="menuitem"
                  className="w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-xs text-red-500/70
                    hover:text-red-500 hover:bg-surface-subtle transition-colors"
                >
                  <LogOut className="w-4 h-4 shrink-0" aria-hidden />
                  <span>退出登录</span>
                </button>
              </div>
            )}
          </div>
        )}

        {/* 底部:折叠态头像(点击展开侧边栏并弹出账号菜单) */}
        {!sidebarEffectiveOpen && session?.user && (
          <div className="mt-auto pt-1 pb-2 px-0 border-t border-line/40 flex flex-col items-center">
            <button
              onClick={handleAvatarInCollapsed}
              className="rounded-full transition active:scale-95 touch-manipulation"
              aria-label="展开侧边栏并打开账号菜单"
              title="账号"
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              {session.user.image ? (
                <img
                  src={session.user.image}
                  alt={session.user.name || '头像'}
                  className="w-7 h-7 rounded-full shrink-0 object-cover mb-1.5"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="w-7 h-7 rounded-full bg-accent/20 flex items-center justify-center text-[11px] font-medium text-accent shrink-0 mb-1.5">
                  {(session.user.name || session.user.email || '?').charAt(0).toUpperCase()}
                </div>
              )}
            </button>
          </div>
        )}
      </aside>

      <SearchDialog
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSelect={(id) => {
          setSearchOpen(false)
          setSidebarOpen(false)
          router.push(`/chat/c/${id}`)
        }}
      />
      {/* 收藏浮层:侧栏星标入口打开,「回到原对话」浮层内部先自关再导航 */}
      <FavoritesDialog open={favoritesOpen} onClose={() => setFavoritesOpen(false)} />
      {/* 删除确认:单条与批量共用一个弹窗组件,替代原生 window.confirm */}
      <ConfirmDialog
        open={pendingDeleteId !== null}
        title="删除这个对话？"
        description="对话内的消息与上传的附件将一并清除，删除后不可恢复。"
        confirmLabel="删除"
        danger
        busy={deleting}
        onConfirm={confirmSingleDelete}
        onCancel={() => setPendingDeleteId(null)}
      />
      <ConfirmDialog
        open={batchConfirmOpen}
        title={`删除 ${selectedIds.size} 个对话？`}
        description="对话内的消息与上传的附件将一并清除，删除后不可恢复。"
        confirmLabel="删除"
        danger
        busy={deleting}
        onConfirm={confirmBatchDelete}
        onCancel={() => setBatchConfirmOpen(false)}
      />
    </>
  )
}
