'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import { X, Check, ChevronRight, ChevronDown, Search, Plus, MessageSquare, BookOpen, Sparkles, Scale, PenLine, Pencil, Trash2, BellDot, Settings as SettingsIcon } from 'lucide-react'
import { useSession } from 'next-auth/react'
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import { useChatStore } from '@/store/chat-store'
import { usePageNav } from '@/hooks/usePageNav'
import { queryKeys, STALE } from '@/lib/query/keys'
import { fetchJson, HttpError } from '@/lib/query/fetcher'
import { resolveMaskBadge, type MaskDTO } from '@/lib/ai/mask-types'
import { SearchDialog } from '@/components/sidebar/SearchDialog'
import { relativeTime } from '@/components/chat/RecentChats'
import { useIsMobileViewport } from '@/hooks/useIsMobileViewport'
import { useBackToClose } from '@/hooks/useBackToClose'
import { useUiStyle } from '@/hooks/useUiStyle'
import { useContextMenuStore, type ContextMenuItem } from '@/store/contextMenuStore'
import { confirmDialog } from '@/components/ui/ConfirmDialog'
import { isUnread } from '@/lib/last-read'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'

/**
 * 方案 C 手机端全屏抽屉(≤md,V2 大字导航版)—— 移动端唯一导航入口。
 *
 * 设计稿定稿形态:全屏毛玻璃(surface/.86 + blur 28)+ 级联入场;
 * 顶部 AICHATT 品牌字 + ✕ 圆钮;01-05 编号 + 24px 大字导航(选中琥珀);
 * 分隔线下「最近 · N / 总数」历史行(标题 + 相对时间);底部用户行(点头像行进账号设置)。
 *
 * 状态复用 chat-store 的 sidebarOpen(与桌面侧栏同一开关,localStorage 记忆):
 * 浮钮 ☰ toggleSidebar 打开的就是它。桌面端不渲染——aside 本体在 ≥md 仍是原侧栏。
 * 关闭动画:开启 = 双 RAF 后加 .open(transform 过渡);关闭 = 先落 .open 再卸载。
 */

interface ConversationData {
  id: string
  title: string
  mode?: string
  /** 学习模式会话:历史行据此跳 /study?c=id */
  studyMode?: boolean
  maskId?: string | null
  updatedAt: string
}

interface ConversationsPage {
  items: ConversationData[]
  total: number
  hasMore: boolean
}

const PAGE_SIZE = 20

/** Google 2020 抽屉的导航图标（usePageNav 只给 key/label） */
const NAV_ICONS: Record<string, typeof MessageSquare> = {
  chat: MessageSquare,
  study: BookOpen,
  images: Sparkles,
  explore: Scale,
  write: PenLine,
}

/** 触底续载哨兵(与桌面侧栏 Sidebar 的 LoadMoreSentinel 同一形态):
 * 进入视口前 240px 就取下一页,加载完哨兵仍在视口内会继续触发,直到铺满。 */
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

interface HistoryRowProps {
  conv: ConversationData
  /** 面具 emoji;无面具为空 */
  badge: string | null
  active: boolean
  unread: boolean
  variant: 'default' | 'google'
  editing: boolean
  editValue: string
  onEditValueChange: (v: string) => void
  onCommitEdit: () => void
  onCancelEdit: () => void
  /** 轻点:导航到会话 */
  onOpenConversation: () => void
  /** 长按确认后装配菜单(回调在抬手时执行,el 为行元素) */
  onOpenMenu: (el: HTMLElement, conv: ConversationData) => void
  style?: React.CSSProperties
}

/** 长按判定时长:安卓系统长按约 500ms,取同一档 */
const LONG_PRESS_MS = 500
/** 手指位移超过该值视为滚动,取消长按 */
const LONG_PRESS_MOVE_PX = 10

/**
 * 抽屉历史行:长按菜单的行级锚点、内联改名、未读蓝点。
 * 两套 uiStyle 分支共用一份 —— 只差 className,交互与编辑态不写两遍。
 * select-none 是触屏刚需:不关掉文本选择,安卓长按会先起选区/放大镜再派 contextmenu。
 */
function HistoryRow({
  conv,
  badge,
  active,
  unread,
  variant,
  editing,
  editValue,
  onEditValueChange,
  onCommitEdit,
  onCancelEdit,
  onOpenConversation,
  onOpenMenu,
  style,
}: HistoryRowProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  // ── 触屏长按:自己计时,不赌系统 contextmenu ──
  // 行内文本 select-none 之后,个别 WebView 的长按不再派 contextmenu(原生选择
  // 手势被关掉就没有菜单锚点);这里由 touchstart 计时 500ms 判定,抬手后装配。
  // 手指仍压屏时绝不弹菜单 —— 抬手合成的 click/mousedown 会把菜单秒关。
  const pressRef = useRef<{
    timer: number
    fallback: number
    startX: number
    startY: number
    el: HTMLElement
    fired: boolean
  } | null>(null)
  // 长按确认的时间戳:挡住抬手补发的 click 导航
  const longPressAtRef = useRef(0)

  const disarmPress = () => {
    const p = pressRef.current
    if (!p) return
    window.clearTimeout(p.timer)
    window.clearTimeout(p.fallback)
    pressRef.current = null
  }
  useEffect(() => () => disarmPress(), [])

  const isCoarsePointer = () =>
    typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches

  const fireMenu = () => {
    const p = pressRef.current
    if (!p) return
    const el = p.el
    disarmPress()
    onOpenMenu(el, conv)
  }

  const touchHandlers = {
    onTouchStart: (e: React.TouchEvent) => {
      if (!isCoarsePointer() || e.touches.length !== 1) return
      const el = e.currentTarget as HTMLElement
      const t = e.touches[0]
      disarmPress()
      const press = {
        timer: 0,
        fallback: 0,
        startX: t.clientX,
        startY: t.clientY,
        el,
        fired: false,
      }
      press.timer = window.setTimeout(() => {
        // 到达长按时长:记下"已确认",等抬手再装配;万一手势被系统吞掉没有
        // touchend,900ms 后兜底弹(不能让长按静默无反应)
        press.fired = true
        longPressAtRef.current = Date.now()
        press.fallback = window.setTimeout(fireMenu, 900)
      }, LONG_PRESS_MS)
      pressRef.current = press
    },
    onTouchMove: (e: React.TouchEvent) => {
      const p = pressRef.current
      if (!p) return
      const t = e.touches[0]
      if (!t) return
      // 确认后继续拖动 = 用户其实想滚列表,不弹菜单
      if (Math.hypot(t.clientX - p.startX, t.clientY - p.startY) > LONG_PRESS_MOVE_PX) disarmPress()
    },
    onTouchEnd: (e: React.TouchEvent) => {
      const p = pressRef.current
      if (!p || !p.fired) {
        disarmPress()
        return
      }
      // 阻止长按按钮抬手后补发的 click,避免菜单刚开就跳转会话
      if (e.cancelable) e.preventDefault()
      fireMenu()
    },
    onTouchCancel: () => disarmPress(),
  }

  // 内联改名:与被替代的行同高,避免整列表跳动
  if (editing) {
    return (
      <div className={variant === 'google' ? 'px-4 py-1.5' : 'py-1.5'}>
        <div className="flex items-center gap-1 rounded-xl bg-surface px-2 py-1 ring-1 ring-line/70">
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e) => onEditValueChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                onCommitEdit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                onCancelEdit()
              }
            }}
            onBlur={onCommitEdit}
            className="min-w-0 flex-1 bg-transparent px-1 text-[14px] text-content-primary outline-none"
            placeholder="对话标题"
            maxLength={200}
            enterKeyHint="done"
          />
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); onCommitEdit() }}
            className="flex h-8 w-8 flex-none items-center justify-center rounded-lg text-green-500 active:bg-surface-subtle"
            aria-label="确认改名"
          >
            <Check className="h-4 w-4" />
          </button>
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); onCancelEdit() }}
            className="flex h-8 w-8 flex-none items-center justify-center rounded-lg text-red-500 active:bg-surface-subtle"
            aria-label="取消改名"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    )
  }

  const dot = unread ? (
    <span
      aria-label="未读"
      title="有未读消息"
      className="shrink-0 w-2 h-2 rounded-full bg-blue-500 dark:bg-blue-400
        shadow-[0_0_8px_rgba(59,130,246,0.75)] animate-pulse"
      style={{ animationDuration: '2.4s' }}
    />
  ) : null

  const interaction = {
    onClick: () => {
      // 长按抬手补发的 click:当次轻点作废
      if (Date.now() - longPressAtRef.current < 600) return
      onOpenConversation()
    },
    onContextMenu: (e: React.MouseEvent) => {
      // 触屏只吞系统菜单,真正的装配走计时器抬手路径
      e.preventDefault()
      if (isCoarsePointer()) return
      onOpenMenu(e.currentTarget as HTMLElement, conv)
    },
    ...touchHandlers,
  }

  if (variant === 'google') {
    return (
      <button
        type="button"
        {...interaction}
        data-conversation-row={conv.id}
        className={cn(
          'flex h-[52px] w-full select-none items-center gap-3 px-6 text-left transition-colors touch-manipulation',
          active ? 'bg-accent-soft' : 'active:bg-black/5 dark:active:bg-white/10'
        )}
        style={style}
      >
        {dot}
        {badge && <span className="flex-none text-[15px] leading-5" aria-hidden>{badge}</span>}
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate text-[13.5px]', active ? 'font-medium text-accent' : 'text-content-primary')}>
            {conv.title || '未命名对话'}
          </span>
          <span className="mt-0.5 block text-[11px] text-content-secondary" suppressHydrationWarning>
            {relativeTime(conv.updatedAt)}
          </span>
        </span>
      </button>
    )
  }

  return (
    <button
      type="button"
      {...interaction}
      data-conversation-row={conv.id}
      className="mdr-st flex w-full select-none items-center gap-2.5 py-2 text-left active:opacity-70 transition-opacity touch-manipulation"
      style={style}
    >
      {dot}
      {badge && <span className="flex-none text-base leading-5" aria-hidden>{badge}</span>}
      <span className="min-w-0 flex-1 truncate text-[13.5px] text-content-secondary">
        {conv.title || '未命名对话'}
      </span>
      <span className="flex-none text-[10.5px] text-content-muted" suppressHydrationWarning>
        {relativeTime(conv.updatedAt)}
      </span>
    </button>
  )
}

export function MobileDrawer() {
  const sidebarOpen = useChatStore((s) => s.sidebarOpen)
  const setSidebarOpen = useChatStore((s) => s.setSidebarOpen)
  const setSettingsOpen = useChatStore((s) => s.setSettingsOpen)
  const setSettingsSection = useChatStore((s) => s.setSettingsSection)
  const conversationVersion = useChatStore((s) => s.conversationVersion)
  // 未读蓝点/长按菜单共用同一份本地已读表
  const lastReadAt = useChatStore((s) => s.lastReadAt)
  const removeConversationRead = useChatStore((s) => s.removeConversationRead)
  const pathname = usePathname()
  const { data: session } = useSession()
  const isMobile = useIsMobileViewport()
  const queryClient = useQueryClient()
  // 正打开的会话:点自己这一条只收抽屉(同 URL replace 不动历史,白跑一次导航);
  // 长按菜单判断"是不是当前会话"也用它
  const currentConvId = pathname?.startsWith('/chat/c/') ? pathname.slice('/chat/c/'.length) : null

  // 入场/退场动画状态机:rendered=true 期间 DOM 存在;open 由双 RAF 置 true 触发过渡
  const [rendered, setRendered] = useState(false)
  const [open, setOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  // armed:首个 effect 跑完前不渲染 —— 避免移动端首帧用「桌面默认展开」的 sidebarOpen 弹开抽屉
  const [armed, setArmed] = useState(false)

  // 移动视口下进入即收起一次(桌面侧栏默认展开,移动端抽屉默认关闭;
  // sidebarOpen 是两端共用的持久化开关,移动端每次进入都从「关」起步)
  useEffect(() => {
    if (isMobile && sidebarOpen) setSidebarOpen(false)
    setArmed(true)
    // 仅在视口特性变化时重置;用户之后的开合不受影响
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile])

  useEffect(() => {
    if (!armed) return
    if (sidebarOpen) {
      setRendered(true)
      let raf2 = 0
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setOpen(true))
      })
      return () => {
        cancelAnimationFrame(raf1)
        if (raf2) cancelAnimationFrame(raf2)
      }
    }
    // 关闭:先退场(transitionend 由兜底计时收尾),再卸载
    setOpen(false)
    if (!rendered) return
    const timer = window.setTimeout(() => setRendered(false), 420)
    return () => window.clearTimeout(timer)
  }, [sidebarOpen, rendered, armed])

  // Esc 关闭(设计稿交互);抽屉开着时拦截,避免同时触发底层弹层
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSidebarOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, setSidebarOpen])

  // 系统/浏览器「返回」先收抽屉:抽屉不占路由,而壳内返回键固定走 WebView goBack
  const { navigate: navClose } = useBackToClose(isMobile && open, () => setSidebarOpen(false))

  // 搜索页同样是「不占路由的全屏层」,返回键先收它;否则真机按返回会直接脱离聊天页。
  useBackToClose(searchOpen, () => setSearchOpen(false))

  // 抽屉内导航一律走 navClose(replace + 抑制 armPop 收尾的 history.back):
  // 旧 push 版本里收尾的 back() 抢在在途导航落历史之前弹掉哨兵,把导航一并取消——
  // 真机「点历史对话没反应」事故。导航项注入后 handleGo/handleChat 内部也走同一路径。
  const { items: navItems, isEphemeral } = usePageNav({ navigate: navClose })
  const uiStyle = useUiStyle()

  // 会话历史:与 Sidebar 同 queryKey 共享缓存(bump 版本联动刷新),无额外请求
  const {
    data,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
  } = useInfiniteQuery<ConversationsPage, HttpError, InfiniteData<ConversationsPage, number>, readonly unknown[], number>({
    queryKey: queryKeys.conversations.list(PAGE_SIZE, 0),
    queryFn: async ({ pageParam }) => {
      const d = await fetchJson<ConversationsPage>(`/api/conversations?limit=${PAGE_SIZE}&offset=${pageParam}`)
      return { items: d.items ?? [], total: d.total ?? 0, hasMore: !!d.hasMore }
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.hasMore ? allPages.reduce((acc, p) => acc + p.items.length, 0) : undefined,
    staleTime: STALE.conversationList,
    enabled: rendered && isEphemeral !== true,
  })

  // 面具徽章(历史行头像)
  const { data: userMasks } = useQuery({
    queryKey: queryKeys.masks.list(),
    queryFn: () => fetchJson<MaskDTO[]>('/api/masks'),
    staleTime: STALE.masks,
    enabled: rendered && isEphemeral !== true,
  })

  // 触底续载:抽屉历史列表原来只挂了第一页 20 条就断了 —— queryKey 与 Sidebar 共用
  // 同一份缓存,但 Sidebar 的哨兵在桌面侧栏里,移动视口看不见,必须自己带一个。
  const handleLoadMore = useCallback(() => {
    if (!hasNextPage || isFetchingNextPage) return
    fetchNextPage()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])

  // ── 长按历史行:重命名 / 标记为未读 / 删除 ──
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  // 改名前的原标题:提交时判断"没改"用,避免和 conversations 数组产生依赖
  const editingOriginalRef = useRef<{ id: string; title: string } | null>(null)

  const cancelRename = useCallback(() => {
    editingOriginalRef.current = null
    setEditingId(null)
  }, [])

  const beginRename = useCallback((conv: ConversationData) => {
    editingOriginalRef.current = { id: conv.id, title: conv.title || '' }
    setEditValue(conv.title || '')
    setEditingId(conv.id)
  }, [])

  const commitRename = useCallback(async () => {
    const original = editingOriginalRef.current
    editingOriginalRef.current = null
    setEditingId(null)
    if (!original) return
    const trimmed = editValue.trim()
    if (!trimmed || trimmed === original.title) return
    // 乐观更新列表缓存(与桌面侧栏共用同一 queryKey,那边同步可见)
    queryClient.setQueryData<InfiniteData<ConversationsPage, number> | undefined>(
      queryKeys.conversations.list(PAGE_SIZE, 0),
      (prev) =>
        prev
          ? {
              ...prev,
              pages: prev.pages.map((p) => ({
                ...p,
                items: p.items.map((c) => (c.id === original.id ? { ...c, title: trimmed } : c)),
              })),
            }
          : prev
    )
    try {
      await fetchJson(`/api/conversations/${original.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        json: { title: trimmed },
      })
      // 顶栏标题与详情缓存同步(正在看的会话改名要即时反映)
      queryClient.setQueryData<{ title?: string } | undefined>(
        queryKeys.conversations.detail(original.id),
        (prev) => (prev ? { ...prev, title: trimmed } : prev)
      )
      if (useChatStore.getState().currentConversationId === original.id) {
        useChatStore.getState().setConversationTitle(trimmed)
      }
    } catch (err) {
      console.error('[MobileDrawer] rename failed:', err)
      queryClient.invalidateQueries({ queryKey: queryKeys.conversations.list(PAGE_SIZE, 0) })
      toast.error(err instanceof Error ? err.message : '重命名失败，请重试', { title: '重命名' })
    }
  }, [editValue, queryClient])

  const handleDeleteConv = useCallback(async (conv: ConversationData) => {
    const ok = await confirmDialog({
      title: '删除这个对话？',
      message: `「${conv.title || '未命名对话'}」及其全部消息将被删除，无法恢复。`,
      okText: '删除',
      danger: true,
    })
    if (!ok) return
    try {
      await fetchJson(`/api/conversations/${conv.id}`, { method: 'DELETE' })
      // 直接从列表缓存摘掉,不等后台刷新(抽屉里那行要立刻消失)
      queryClient.setQueryData<InfiniteData<ConversationsPage, number> | undefined>(
        queryKeys.conversations.list(PAGE_SIZE, 0),
        (prev) =>
          prev
            ? {
                ...prev,
                pages: prev.pages.map((p) => ({
                  ...p,
                  items: p.items.filter((c) => c.id !== conv.id),
                  total: Math.max(0, p.total - 1),
                })),
              }
            : prev
      )
      removeConversationRead(conv.id)
      // 删的是正在看的这条:先把抽屉收了再离开,避免返回时又回到已删会话
      if (
        conv.id === useChatStore.getState().currentConversationId ||
        conv.id === currentConvId
      ) {
        setSidebarOpen(false)
        navClose('/chat')
      }
    } catch (err) {
      console.error('[MobileDrawer] delete failed:', err)
      toast.error(err instanceof Error ? err.message : '删除失败，请重试', { title: '删除对话' })
    }
  }, [queryClient, removeConversationRead, navClose, setSidebarOpen, currentConvId])

  const openRowMenu = useCallback((el: HTMLElement, conv: ConversationData) => {
    const rect = el.getBoundingClientRect()
    const alreadyUnread = isUnread(conv.id, Date.parse(conv.updatedAt), useChatStore.getState().lastReadAt)
    const items: ContextMenuItem[] = [
      {
        id: 'rename',
        label: '重命名',
        icon: <Pencil className="h-[18px] w-[18px]" />,
        onSelect: () => beginRename(conv),
      },
    ]
    // 已经未读 / 正在看的会话都不给:前者动作无效果,后者读了就清、标了也看不见
    const isCurrent =
      conv.id === useChatStore.getState().currentConversationId || conv.id === currentConvId
    if (!alreadyUnread && !isCurrent) {
      items.push({
        id: 'mark-unread',
        label: '标记为未读',
        icon: <BellDot className="h-[18px] w-[18px]" />,
        onSelect: () => useChatStore.getState().markConversationUnread(conv.id),
      })
    }
    items.push({
      id: 'delete',
      label: '删除',
      danger: true,
      icon: <Trash2 className="h-[18px] w-[18px]" />,
      onSelect: () => { void handleDeleteConv(conv) },
    })
    // 锚在行上:优先贴行下方(参考图形态),下方放不下翻到行上方;
    // 高度按 44px/行 + 12px 容器粗估,宿主的真实尺寸测量还会再纠一次。
    // 最后再把锚点夹回视口:行被程序化触发/滚动到半截时 rect 可能在视口外。
    const estHeight = items.length * 44 + 12
    const below = rect.bottom + 6
    const rawY = below + estHeight + 8 <= window.innerHeight ? below : rect.top - 6 - estHeight
    const anchorX = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - 204 - 8))
    const anchorY = Math.min(Math.max(8, rawY), Math.max(8, window.innerHeight - estHeight - 8))
    useContextMenuStore.getState().openContextMenu(
      { x: anchorX, y: anchorY },
      items,
      undefined,
      { size: 'comfortable' }
    )
  }, [beginRename, handleDeleteConv, currentConvId])

  // 只拦「首个 effect 跑完前」那一帧:抽屉本体随 rendered 卸载,
  // 但搜索页是全屏独立层 —— 关抽屉后必须继续存活(原来一起 return null,
  // 点搜索 → 抽屉退场 420ms 后把搜索页也带走,等于搜索自己关掉)。
  if (!armed) return null

  const conversations = (data?.pages ?? []).flatMap((p) => p.items)
  const total = data?.pages?.[0]?.total ?? 0
  const user = session?.user

  const close = () => setSidebarOpen(false)

  // 级联入场延迟(与原型一致 0.02 起步逐项递增)
  const d = (i: number) => ({ ['--d' as string]: `${i}s` }) as React.CSSProperties

  return (
    <>
      {/* 全屏抽屉本层:玻璃面板(inset-0),transform 过渡;条目级联用 .mdr-st + --d */}
      {/* Google 2020: 300px 侧滑抽屉 + 遮罩（其他样式仍是全屏玻璃抽屉） */}
      {rendered && uiStyle === 'google' && (
        <div
          aria-hidden
          onClick={close}
          className={cn(
            'md:hidden fixed inset-0 z-40 bg-black/50 transition-opacity duration-base',
            open ? 'opacity-100' : 'pointer-events-none opacity-0'
          )}
        />
      )}
      {rendered && (
      <aside
        aria-label="导航抽屉"
        className={cn(
          'mdrawer md:hidden fixed z-50 flex flex-col overflow-hidden',
          uiStyle === 'google'
            ? 'inset-y-0 left-0 w-[300px] max-w-[82vw] bg-surface text-content-primary shadow-[2px_0_12px_rgba(60,64,67,.24)]'
            : 'inset-0 bg-surface-muted/85 text-content-primary',
          'transition-transform duration-slow ease-standard',
          open ? 'translate-x-0 mdrawer-open' : '-translate-x-full'
        )}
        style={uiStyle === 'google' ? {
          paddingTop: 'var(--sat)',
          paddingBottom: 'calc(var(--m-safe-bottom, var(--sab, 0px)) + 8px)',
        } : {
          WebkitBackdropFilter: 'blur(28px)',
          backdropFilter: 'blur(28px)',
          paddingBottom: 'calc(var(--m-safe-bottom, var(--sab, 0px)) + 8px)',
        }}
      >
        {uiStyle === 'google' ? (
          <>
            <div className="flex h-14 shrink-0 items-center gap-2 pl-5 pr-2">
              <span className="text-[22px] font-normal tracking-[-0.02em] text-content-primary">aichatt</span>
              <span className="flex-1" />
              <button
                onClick={close}
                className="flex h-10 w-10 items-center justify-center rounded-full text-content-secondary active:bg-black/5 dark:active:bg-white/10"
                aria-label="关闭"
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {user && !isEphemeral && (
              <button
                onClick={() => { close(); setSettingsSection('account'); setSettingsOpen(true) }}
                className="mx-3 flex items-center gap-3 rounded-xl px-2 py-2 text-left active:bg-black/5 dark:active:bg-white/10"
              >
                {user.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={user.image} alt="" className="h-10 w-10 flex-none rounded-full object-cover" referrerPolicy="no-referrer" />
                ) : (
                  <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-accent-soft text-[15px] font-medium text-accent">
                    {(user.name || user.email || '?').charAt(0).toUpperCase()}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-content-primary">{user.name || '已登录'}</span>
                  {user.email && <span className="block truncate text-[11.5px] text-content-secondary">{user.email}</span>}
                </span>
                <ChevronDown className="h-4 w-4 flex-none text-content-muted" />
              </button>
            )}

            <button
              onClick={() => { close(); navItems[0]?.onClick() }}
              className="mx-4 mb-2 mt-1 flex h-12 items-center gap-3 rounded-2xl bg-surface px-5 text-sm font-medium text-content-primary shadow-[0_1px_2px_rgba(60,64,67,.3),0_1px_3px_1px_rgba(60,64,67,.15)] active:scale-[0.99]"
            >
              <Plus className="h-5 w-5 text-accent" />
              新对话
            </button>

            <nav className="flex flex-col">
              {navItems.map((item) => {
                const Icon = NAV_ICONS[item.key] || MessageSquare
                return (
                  <button
                    key={item.key}
                    onClick={() => { close(); item.onClick() }}
                    aria-current={item.active ? 'page' : undefined}
                    className={cn(
                      'flex h-12 items-center gap-5 pl-6 pr-3 text-left text-sm transition-colors active:bg-black/5 dark:active:bg-white/10',
                      item.active ? 'bg-accent-soft font-medium text-accent' : 'text-content-primary'
                    )}
                  >
                    <Icon className="h-5 w-5" />
                    {item.label}
                  </button>
                )
              })}
            </nav>

            {!isEphemeral && (
              <>
                <div className="mx-4 my-2 h-px bg-line" />
                <div className="flex items-center px-6 pb-1 text-[11px] font-medium text-content-secondary">
                  历史记录
                  <span className="ml-auto font-normal tabular-nums text-content-muted">
                    {conversations.length}{total > conversations.length ? ` / ${total}` : ''}
                  </span>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {conversations.length === 0 ? (
                    <p className="py-6 text-center text-xs text-content-muted">暂无对话记录</p>
                  ) : (
                    <>
                      {conversations.map((conv) => {
                        const badge = resolveMaskBadge(conv.maskId, userMasks)
                        const active = conv.id === currentConvId
                        return (
                          <HistoryRow
                            key={conv.id}
                            conv={conv}
                            badge={badge?.avatar ?? null}
                            active={active}
                            unread={!active && isUnread(conv.id, Date.parse(conv.updatedAt), lastReadAt)}
                            variant="google"
                            editing={editingId === conv.id}
                            editValue={editValue}
                            onEditValueChange={setEditValue}
                            onCommitEdit={commitRename}
                            onCancelEdit={cancelRename}
                            onOpenConversation={() => {
                              if (conv.id === currentConvId) { close(); return }
                              navClose(conv.studyMode ? `/study?c=${conv.id}` : `/chat/c/${conv.id}`)
                            }}
                            onOpenMenu={openRowMenu}
                          />
                        )
                      })}
                      <LoadMoreSentinel onVisible={handleLoadMore} loading={isFetchingNextPage} />
                    </>
                  )}
                </div>
              </>
            )}

            <div className="border-t border-line px-0 pb-1 pt-1">
              <button
                onClick={() => { close(); setSettingsOpen(true) }}
                className="flex h-10 w-full items-center gap-5 pl-6 text-sm text-content-primary active:bg-black/5 dark:active:bg-white/10"
              >
                <SettingsIcon className="h-5 w-5 text-content-secondary" />
                设置
              </button>
            </div>
          </>
        ) : (
          <>
        {/* 顶部:品牌字 + 搜索 + 关闭(行顶/右内缩与浮钮簇同一条 --m-chrome 基线,
            抽屉是 fixed inset-0,所以直接吃同一变量就能与 ⚙ 原位重合) */}
        <div className="mdr-st shrink-0 flex items-center justify-between pl-6 pr-[var(--m-chrome-inset)] pt-[var(--m-chrome-top)]" style={d(0.02)}>
          <span className="text-xs font-bold tracking-[0.18em] text-content-muted">AICHATT</span>
          <div className="flex items-center gap-[var(--m-chrome-gap)]">
            {!isEphemeral && (
              <button
                onClick={() => { close(); setSearchOpen(true) }}
                className="flex items-center justify-center w-10 h-10 rounded-full bg-surface/70 text-content-secondary shadow-[0_1px_2px_rgb(0_0_0/0.06),0_4px_10px_-4px_rgb(0_0_0/0.14)] dark:shadow-[0_1px_2px_rgb(0_0_0/0.4),0_6px_12px_-6px_rgb(0_0_0/0.7)] active:scale-90 transition-transform touch-manipulation"
                aria-label="搜索聊天记录"
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                <Search className="w-[18px] h-[18px]" />
              </button>
            )}
            <button
              onClick={close}
              className="flex items-center justify-center w-10 h-10 rounded-full bg-surface/70 text-content-secondary shadow-[0_1px_2px_rgb(0_0_0/0.06),0_4px_10px_-4px_rgb(0_0_0/0.14)] dark:shadow-[0_1px_2px_rgb(0_0_0/0.4),0_6px_12px_-6px_rgb(0_0_0/0.7)] active:scale-90 transition-transform touch-manipulation"
              aria-label="关闭"
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              <X className="w-[18px] h-[18px]" />
            </button>
          </div>
        </div>

        {/* 01-05 大字导航(头部行下沉 42px,这里把上边距收回来,首条目测位置基本不动) */}
        <nav className="mt-1 flex flex-col px-6">
          {navItems.map((item, i) => (
            <button
              key={item.key}
              onClick={() => { close(); item.onClick() }}
              aria-current={item.active ? 'page' : undefined}
              className={cn(
                'mdr-st flex items-baseline gap-4 py-2 text-left text-2xl leading-[1.2] font-medium transition-colors active:translate-x-0.5 touch-manipulation',
                item.active ? 'text-accent font-semibold' : 'text-content-primary/50'
              )}
              style={d(0.06 + i * 0.04)}
            >
              <span className={cn('w-[26px] flex-none text-[11px] font-semibold tracking-[0.05em] tabular-nums', item.active ? 'text-accent/80' : 'text-content-muted/80')}>
                {String(i + 1).padStart(2, '0')}
              </span>
              {item.label}
            </button>
          ))}
        </nav>

        {/* 分隔线 + 最近历史 */}
        {!isEphemeral && (
          <>
            <div className="mdr-st mx-6 mt-4 border-t border-line/90" style={d(0.26)} />
            <p className="mdr-st px-6 pb-2 pt-3 text-[10.5px] tracking-[0.14em] text-content-muted" style={d(0.28)}>
              最近 · {conversations.length}{total > conversations.length ? ` / ${total}` : ''}
            </p>
            <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {conversations.length === 0 ? (
                <p className="mdr-st py-6 text-center text-xs text-content-muted" style={d(0.3)}>暂无对话记录</p>
              ) : (
                <>
                  {conversations.map((conv, i) => {
                    const badge = resolveMaskBadge(conv.maskId, userMasks)
                    const active = conv.id === currentConvId
                    return (
                      <HistoryRow
                        key={conv.id}
                        conv={conv}
                        /* 面具 emoji 只在真的挂了面具时出现;原先无面具兜底 💬,
                           整列表被同一枚消息 emoji 刷屏,已按用户定案撤掉 */
                        badge={badge?.avatar ?? null}
                        active={active}
                        unread={!active && isUnread(conv.id, Date.parse(conv.updatedAt), lastReadAt)}
                        variant="default"
                        editing={editingId === conv.id}
                        editValue={editValue}
                        onEditValueChange={setEditValue}
                        onCommitEdit={commitRename}
                        onCancelEdit={cancelRename}
                        onOpenConversation={() => {
                          if (conv.id === currentConvId) { close(); return }
                          navClose(conv.studyMode ? `/study?c=${conv.id}` : `/chat/c/${conv.id}`)
                        }}
                        onOpenMenu={openRowMenu}
                        /* 首屏条目走级联入场;续载进来的(第 2 页起)不再延迟,
                           否则触底后要空等 0.5s 才露面 */
                        style={d(i < PAGE_SIZE ? Math.min(0.3 + i * 0.02, 0.5) : 0)}
                      />
                    )
                  })}
                  <LoadMoreSentinel onVisible={handleLoadMore} loading={isFetchingNextPage} />
                </>
              )}
            </div>

            {/* 底部用户行 → 账号设置 */}
            {user && (
              <button
                onClick={() => { close(); setSettingsSection('account'); setSettingsOpen(true) }}
                className="mdr-st mx-4 mb-1 flex items-center gap-2.5 rounded-2xl px-3 py-2.5 text-left active:bg-surface-subtle/60 transition-colors touch-manipulation"
                style={d(0.42)}
              >
                {user.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={user.image} alt="" className="h-9 w-9 flex-none rounded-full object-cover" referrerPolicy="no-referrer" />
                ) : (
                  <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-accent text-sm font-semibold text-white">
                    {(user.name || user.email || '?').charAt(0).toUpperCase()}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-semibold text-content-primary">{user.name || '已登录'}</span>
                  {user.email && <span className="block truncate text-[10.5px] text-content-muted">{user.email}</span>}
                </span>
                <ChevronRight className="h-4 w-4 flex-none text-content-muted" />
              </button>
            )}
          </>
        )}
          </>
        )}
      </aside>
      )}

      <SearchDialog
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSelect={(id) => {
          setSearchOpen(false)
          navClose(`/chat/c/${id}`)
        }}
      />
    </>
  )
}
