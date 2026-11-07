'use client'

import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { Search, X, Loader2, MessageSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ALL_BUILTIN_MASKS } from '@/lib/ai/builtin-masks'
import { resolveMaskBadge, type MaskDTO } from '@/lib/ai/mask-types'
import { queryKeys, STALE } from '@/lib/query/keys'
import { fetchJson } from '@/lib/query/fetcher'
import { useIsMobileViewport } from '@/hooks/useIsMobileViewport'

interface ConversationData {
  id: string
  title: string
  mode?: string
  /** 学习模式会话:点进 /chat/c/id 后由会话页渲染学习室 */
  studyMode?: boolean
  maskId?: string | null
  updatedAt: string
  // 搜索模式下,由 /api/messages/snippets 注入的"消息级命中"预览
  matchedFragment?: string | null
  matchedFragmentRole?: string | null
}

interface MessageFragment {
  conversationId: string
  messageId: string
  role: string
  snippet: string
}

/**
 * 按 updatedAt 把对话分到时间分组:
 * - 今天(0:00 至今)
 * - 昨天(昨天 0:00 至今天 0:00)
 * - 本周(过去 7 天内,但不是今天/昨天)
 * - 本月(过去 30 天内,但不在上述范围)
 * - 更早(超过 30 天)
 */
type GroupKey = '今天' | '昨天' | '本周' | '本月' | '更早'

const GROUP_ORDER: GroupKey[] = ['今天', '昨天', '本周', '本月', '更早']

// 每页拉取条数(分段加载的"段")
const PAGE_SIZE = 20

/** 面具筛选胶囊折叠时默认显示的 emoji 数(使用次数最多的前 N 个) */
const COLLAPSED_VISIBLE = 2

/** 筛选用的面具条目(内置 + 自定义,附使用次数) */
interface MaskFilterItem {
  id: string
  avatar: string
  name: string
  count: number
}

function getGroupKey(updatedAt: string, now: Date = new Date()): GroupKey {
  const d = new Date(updatedAt)
  if (isNaN(d.getTime())) return '更早'

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const oneDay = 24 * 60 * 60 * 1000
  const diff = startOfToday.getTime() - d.getTime()

  if (diff >= 0 && diff < oneDay) return '今天'
  if (diff >= oneDay && diff < 2 * oneDay) return '昨天'
  if (diff < 7 * oneDay) return '本周'
  if (diff < 30 * oneDay) return '本月'
  return '更早'
}

function groupConversations(items: ConversationData[]) {
  const map = new Map<GroupKey, ConversationData[]>()
  for (const conv of items) {
    const key = getGroupKey(conv.updatedAt)
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(conv)
  }
  // 只保留实际有数据的分组,并按预定义顺序排列
  return GROUP_ORDER.filter((k) => map.has(k)).map((k) => ({
    key: k,
    items: map.get(k)!,
  }))
}

/** 筛选胶囊的值:null = 全部;'none' = 无面具;其余为面具 id(内置裸 id / user:<cuid>) */
type MaskFilter = string | null

/** 筛选胶囊;中性灰极简风格,选中态与侧边栏激活项一致 */
function MaskFilterChip({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean
  onClick: () => void
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn(
        // 手机端全屏页:胶囊放大到可点尺寸(13px / 32px 高);桌面浮层维持紧凑 11px
        'shrink-0 px-3 py-1 rounded-full text-[13px] leading-5 whitespace-nowrap transition-colors touch-manipulation md:px-2 md:py-0.5 md:text-[11px]',
        active
          ? 'bg-accent-soft text-content-primary'
          : 'bg-surface-subtle/60 text-content-muted hover:text-content-primary hover:bg-surface-subtle'
      )}
    >
      {children}
    </button>
  )
}

interface SearchDialogProps {
  open: boolean
  onClose: () => void
  /** 选中一条对话后跳转。Sidebar 用 router.push,其他场景可自定义(如嵌入子页) */
  onSelect?: (id: string) => void
}

export function SearchDialog({ open, onClose, onSelect }: SearchDialogProps) {
  const [query, setQuery] = useState('')
  const [filterMask, setFilterMask] = useState<MaskFilter>(null)
  const [results, setResults] = useState<ConversationData[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [total, setTotal] = useState<number | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  // 消息级命中片段(由 /api/messages/snippets 注入): conversationId -> fragment
  const [fragmentsByConv, setFragmentsByConv] = useState<Map<string, MessageFragment>>(
    new Map()
  )
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const router = useRouter()
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 手机端(≤md)全屏页形态;桌面端保持居中浮层。
  // 媒体查询口径与 useIsMobileViewport 一致,SSR 首帧 false → 桌面形态,水合后切换。
  const isMobile = useIsMobileViewport()

  // 自定义面具列表(筛选胶囊用;打开时才启用,与侧边栏共享缓存)
  const { data: userMasks } = useQuery({
    queryKey: queryKeys.masks.list(),
    queryFn: () => fetchJson<MaskDTO[]>('/api/masks'),
    enabled: open,
    staleTime: STALE.masks,
  })
  // 各面具的对话使用数(折叠排序用)
  const { data: maskUsage } = useQuery({
    queryKey: queryKeys.masks.usage(),
    queryFn: () =>
      fetchJson<{ usage: { maskId: string; count: number }[] }>('/api/masks/usage'),
    enabled: open,
    staleTime: STALE.masks,
  })
  // 折叠/展开态:默认折叠,只显示使用次数最多的前 N 个 emoji
  const [maskFilterExpanded, setMaskFilterExpanded] = useState(false)
  // 同步当前结果长度,供 runSearch 在追加模式下计算 offset
  const itemsRef = useRef<ConversationData[]>([])
  useEffect(() => {
    itemsRef.current = results
  }, [results])

  // 打开时自动聚焦输入框
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 30)
    } else {
      setQuery('')
      setFilterMask(null)
      setMaskFilterExpanded(false)
      setResults([])
      setFragmentsByConv(new Map())
      setActiveIndex(0)
      setHasMore(true)
      setTotal(null)
    }
  }, [open])

  // ESC 关闭弹窗
  useEffect(() => {
    if (!open) return
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  // 锁定背景滚动
  useEffect(() => {
    if (!open) return
    const original = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = original
    }
  }, [open])

  // 搜索接口
  const runSearch = useCallback(
    async (q: string, reset: boolean) => {
      const trimmed = q.trim()
      if (reset) {
        setLoading(true)
      } else {
        setLoadingMore(true)
      }
      try {
        const params = new URLSearchParams()
        params.set('limit', String(PAGE_SIZE))
        params.set('offset', reset ? '0' : String(itemsRef.current.length))
        if (trimmed) params.set('q', trimmed)
        if (filterMask) params.set('maskId', filterMask)
        const res = await fetch(`/api/conversations?${params.toString()}`)
        if (res.ok) {
          const data = await res.json()
          const items = data.items ?? []
          const total = typeof data.total === 'number' ? data.total : null
          const hasMore =
            typeof data.hasMore === 'boolean'
              ? data.hasMore
              : total == null
                ? items.length === PAGE_SIZE
                : itemsRef.current.length + items.length < total
          setResults((prev) => (reset ? items : [...prev, ...items]))
          setTotal(total)
          setHasMore(hasMore)
          if (reset) setActiveIndex(0)
        }
      } catch (err) {
        console.error('Search failed:', err)
        if (reset) setResults([])
      } finally {
        if (reset) setLoading(false)
        else setLoadingMore(false)
      }
    },
    [filterMask]
  )

  // 防抖触发首次/重置查询(query 或筛选变化)。
  // 依赖里必须带 open:关闭时结果被清空,重开若 query 未变,旧实现不会重新请求,
  // 表现为「第二次打开搜索永远是空列表」。
  useEffect(() => {
    if (!open) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      runSearch(query, true)
    }, 200)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [open, query, filterMask, runSearch])

  // 当搜索结果或关键词变化时,拉取消息级命中片段。
  // 翻页加载也会重新触发,保证新增会话也能拿到片段。
  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed || results.length === 0) {
      // 无关键词或无结果:清理片段,避免显示陈旧命中
      setFragmentsByConv((prev) => (prev.size === 0 ? prev : new Map()))
      return
    }
    const convIds = results.map((r) => r.id).join(',')
    const controller = new AbortController()
    let cancelled = false
    // 短延迟避免搜索主请求抖动期间重复触发
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/messages/snippets?convIds=${encodeURIComponent(convIds)}&q=${encodeURIComponent(trimmed)}`,
          { signal: controller.signal }
        )
        if (!res.ok) return
        const data = await res.json()
        if (cancelled) return
        const fragments: MessageFragment[] = Array.isArray(data.fragments)
          ? data.fragments
          : []
        const map = new Map<string, MessageFragment>()
        for (const f of fragments) {
          // 一个会话取一条最早的(后端已排序),后到的忽略
          if (!map.has(f.conversationId)) map.set(f.conversationId, f)
        }
        setFragmentsByConv(map)
      } catch {
        // 静默失败:片段是"锦上添花",不影响主搜索体验
      }
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(timer)
      controller.abort()
    }
  }, [results, query])

  // 触底加载更多(滚动容器内哨兵元素)
  useEffect(() => {
    if (!open) return
    const sentinel = sentinelRef.current
    const root = scrollRef.current
    if (!sentinel || !root) return
    const observer = new IntersectionObserver(
      (entries) => {
        const e = entries[0]
        if (e.isIntersecting && hasMore && !loading && !loadingMore) {
          runSearch(query, false)
        }
      },
      { root, rootMargin: '120px 0px' }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [open, hasMore, loading, loadingMore, query, runSearch])

  function highlightMatch(text: string, q: string) {
    if (!q.trim()) return text
    // 不区分大小写地高亮;只标第一个命中(标题/片段通常一次即可)
    const idx = text.toLowerCase().indexOf(q.trim().toLowerCase())
    if (idx === -1) return text
    return (
      <>
        {text.slice(0, idx)}
        <mark className="bg-accent/30 text-content-primary rounded px-0.5">
          {text.slice(idx, idx + q.trim().length)}
        </mark>
        {text.slice(idx + q.trim().length)}
      </>
    )
  }

  // 命中片段的角色徽章(用户/AI),搜索模式下显示
  function FragmentRoleBadge({ role }: { role: string }) {
    const isUser = role === 'user'
    return (
      <span
        className={cn(
          'inline-flex items-center px-1 py-px rounded text-[9px] font-medium tracking-wide uppercase',
          isUser
            ? 'bg-accent/15 text-accent'
            : 'bg-surface-subtle text-content-muted'
        )}
      >
        {isUser ? 'YOU' : 'AI'}
      </span>
    )
  }

  function handleSelect(conv: ConversationData) {
    onClose()
    // 学习模式会话不再特殊改道(2026-11-02 /study 下线):统一进 /chat/c/id,
    // 由会话页按 conversation.studyMode 渲染学习室
    if (onSelect) {
      onSelect(conv.id)
      return
    }
    router.push(`/chat/c/${conv.id}`)
  }

  // 把结果按时间分组(最新在上,已经在 API 层按 updatedAt desc 排好)
  const grouped = useMemo(() => groupConversations(results), [results])

  // 全部面具(内置 + 自定义)按使用次数降序;稳定排序,同次数保持内置顺序,0 次垫底
  const sortedMasks = useMemo<MaskFilterItem[]>(() => {
    const usageMap = new Map(
      (maskUsage?.usage ?? []).map((u) => [u.maskId, u.count])
    )
    return [
      ...ALL_BUILTIN_MASKS.map((m) => ({ id: m.id, avatar: m.avatar, name: m.name })),
      ...(userMasks ?? []).map((m) => ({ id: m.id, avatar: m.avatar, name: m.name })),
    ]
      .map((m) => ({ ...m, count: usageMap.get(m.id) ?? 0 }))
      .sort((a, b) => b.count - a.count)
  }, [maskUsage, userMasks])

  // 折叠态可见集合:使用次数前 N 的 emoji;当前选中的面具若不在其中则追加(保证选中态可见)
  const visibleMasks = useMemo<MaskFilterItem[]>(() => {
    if (maskFilterExpanded) return sortedMasks
    const top = sortedMasks.filter((m) => m.count > 0).slice(0, COLLAPSED_VISIBLE)
    const selected =
      filterMask && filterMask !== 'none'
        ? sortedMasks.find((m) => m.id === filterMask)
        : undefined
    if (selected && !top.includes(selected)) top.push(selected)
    return top
  }, [sortedMasks, maskFilterExpanded, filterMask])

  // 折叠时可展开的剩余数量(有使用的面具数 - 折叠态已显示数);为 0 时不渲染展开按钮
  const hiddenUsedCount = useMemo(() => {
    if (maskFilterExpanded) return 0
    const usedTotal = sortedMasks.filter((m) => m.count > 0).length
    const visibleUsed = visibleMasks.filter((m) => m.count > 0).length
    return usedTotal - visibleUsed
  }, [sortedMasks, visibleMasks, maskFilterExpanded])
  // 扁平化用于键盘导航(activeIndex 跨组工作)
  const flatResults = useMemo(
    () => grouped.flatMap((g) => g.items),
    [grouped]
  )

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // 手机端没有方向键语境:回车 = 收起键盘,不要误开高亮的第一条
    if (isMobile) {
      if (e.key === 'Enter') {
        e.preventDefault()
        e.currentTarget.blur()
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(i + 1, Math.max(0, flatResults.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const target = flatResults[activeIndex]
      if (target) handleSelect(target)
    }
  }

  if (!open) return null

  return (
    <div
      className={cn(
        'fixed inset-0 z-[200]',
        isMobile
          ? // 手机端:整页全屏(inset-0,软键盘弹起时随 WebView 视口一起缩),不再留 12vh 悬浮边距
            'flex flex-col bg-surface'
          : 'flex items-start justify-center pt-[12vh] px-4'
      )}
      onClick={isMobile ? undefined : onClose}
    >
      {/* Backdrop — 主题感知磨砂遮罩(仅桌面浮层;手机端整页不透明) */}
      {!isMobile && (
        <div className="absolute inset-0 bg-black/20 backdrop-blur-[12px] saturate-150 dark:bg-white/15 dark:saturate-150" />
      )}

      {/* Panel */}
      <div
        className={cn(
          'relative overflow-hidden',
          isMobile
            ? 'flex h-full min-h-0 w-full flex-col bg-surface'
            : 'w-full max-w-lg rounded-xl border border-line/60 bg-surface-glass glass-blur shadow-2xl'
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input — 手机端页头与全局 chrome 同一 --m-chrome-top 基线 */}
        <div
          className={cn(
            'flex items-center gap-2 border-b border-line/50',
            isMobile
              ? 'shrink-0 pl-5 pr-[var(--m-chrome-inset)] pt-[var(--m-chrome-top)] pb-2'
              : 'px-3.5 py-3'
          )}
        >
          <Search className={cn('shrink-0 text-content-muted', isMobile ? 'w-[18px] h-[18px]' : 'w-4 h-4')} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索聊天记录..."
            enterKeyHint="search"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className={cn(
              'flex-1 min-w-0 bg-transparent text-content-primary placeholder:text-content-muted outline-none',
              isMobile ? 'text-[16px] leading-6' : 'text-sm'
            )}
          />
          {loading && <Loader2 className="w-3.5 h-3.5 text-content-muted animate-spin" />}
          <button
            onClick={onClose}
            className={cn(
              'hover:bg-surface-subtle transition-colors touch-manipulation',
              isMobile
                ? 'flex h-10 w-10 shrink-0 items-center justify-center rounded-full active:bg-surface-subtle/70'
                : 'p-1 rounded-md'
            )}
            aria-label="关闭搜索"
          >
            <X className={cn('text-content-muted', isMobile ? 'w-[18px] h-[18px]' : 'w-3.5 h-3.5')} />
          </button>
        </div>

        {/* Mask filter chips —— 2026-10-31 收成悬浮圆角条：去掉贴边底边线，
            两侧内缩 + 极淡外投影，读作浮在搜索框与结果之间的独立一层 */}
        <div
          className={cn(
            'flex items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
            // 浮卡用卡面色（不用灰底）：chips 未选中的 surface-subtle 才看得出底，
            // 与面板的分层交给外投影，和设置列表卡同一套语言
            'mb-1 mt-1.5 rounded-[14px] bg-surface',
            'shadow-[0_1px_2px_rgb(0_0_0/0.04),0_6px_14px_-8px_rgb(0_0_0/0.16)] dark:shadow-[0_1px_2px_rgb(0_0_0/0.4),0_8px_18px_-10px_rgb(0_0_0/0.6)]',
            // 内缩量 + 条内 padding = 原起点，chips 位置不漂移
            isMobile ? 'shrink-0 gap-1.5 mx-3.5 px-2 py-2' : 'gap-1 mx-2 px-1.5 py-1.5'
          )}
          role="group"
          aria-label="按面具筛选"
        >
          <MaskFilterChip
            active={filterMask === null}
            onClick={() => setFilterMask(null)}
            title="显示全部对话"
          >
            全部
          </MaskFilterChip>
          {visibleMasks.map((m) => (
            <MaskFilterChip
              key={m.id}
              active={filterMask === m.id}
              onClick={() => setFilterMask(m.id)}
              title={m.count > 0 ? `${m.name}（${m.count} 次对话）` : m.name}
            >
              {m.avatar}
            </MaskFilterChip>
          ))}
          {hiddenUsedCount > 0 && (
            <MaskFilterChip
              active={false}
              onClick={() => setMaskFilterExpanded(true)}
              title={`展开其余 ${hiddenUsedCount} 个面具`}
            >
              +{hiddenUsedCount}
            </MaskFilterChip>
          )}
          {maskFilterExpanded && (
            <MaskFilterChip
              active={false}
              onClick={() => setMaskFilterExpanded(false)}
              title="只显示最常用的面具"
            >
              收起
            </MaskFilterChip>
          )}
          <MaskFilterChip
            active={filterMask === 'none'}
            onClick={() => setFilterMask('none')}
            title="只看未使用面具的对话"
          >
            无面具
          </MaskFilterChip>
        </div>

        {/* Results — 手机端吃满剩余高度,滚到底就是键盘/系统手势区 */}
        <div
          ref={scrollRef}
          className={cn(
            'overflow-y-auto py-1',
            isMobile
              ? 'flex-1 min-h-0 overscroll-contain pb-[max(var(--sab,0px),8px)]'
              : 'max-h-[50vh]'
          )}
        >
          {results.length === 0 && !loading ? (
            !query.trim() ? (
              // 无关键词、无结果 —— 没有任何历史记录
              <div className="px-4 py-8 text-center text-xs text-content-muted">
                还没有聊天记录
              </div>
            ) : (
              // 有关键词、无结果 —— 搜索无匹配
              <div className="px-4 py-8 text-center text-xs text-content-muted">
                没有匹配的对话
              </div>
            )
          ) : grouped.length === 0 && !loading ? (
            <div className="px-4 py-8 text-center text-xs text-content-muted">
              加载中...
            </div>
          ) : (
            <div className="py-1">
              {grouped.map((group, gi) => {
                const fragmentHits = query.trim()
                  ? group.items.filter((c) => fragmentsByConv.has(c.id)).length
                  : 0
                return (
                  <div key={group.key} className={cn(gi === 0 ? '' : 'mt-1')}>
                    {/* 分组标题 —— 搜索时显示"搜索结果",浏览时显示时间分组 */}
                    <div
                      className={cn(
                        'font-medium uppercase tracking-wider text-content-muted',
                        isMobile ? 'px-5 pt-3 pb-1.5 text-[11px]' : 'px-3.5 pt-2 pb-1 text-[10px]'
                      )}
                    >
                      {query.trim() ? '搜索结果' : group.key}
                      <span className="ml-1.5 text-content-muted/70 normal-case tracking-normal">
                        {group.items.length}
                        {query.trim() && fragmentHits > 0 ? ` (${fragmentHits} 条消息命中)` : ''}
                      </span>
                    </div>
                  {/* 该分组下的对话 */}
                  <ul className={cn('space-y-0.5', isMobile ? 'px-2' : 'px-1')}>
                    {group.items.map((conv) => {
                      const flatIdx = flatResults.indexOf(conv)
                      const fragment = fragmentsByConv.get(conv.id)
                      const badge = resolveMaskBadge(conv.maskId, userMasks)
                      return (
                        <li key={conv.id}>
                          <button
                            onClick={() => handleSelect(conv)}
                            onMouseEnter={() => setActiveIndex(flatIdx)}
                            className={cn(
                              'w-full flex rounded-lg text-left transition-colors touch-manipulation',
                              isMobile
                                ? 'items-center gap-3 px-3 py-2.5 min-h-[52px] text-content-secondary active:bg-surface-subtle/70'
                                : 'items-start gap-2 px-2.5 py-1.5',
                              !isMobile && flatIdx === activeIndex
                                ? 'bg-accent/15 text-content-primary'
                                : !isMobile && 'text-content-secondary hover:bg-surface-subtle/60'
                            )}
                          >
                            <MessageSquare
                              className={cn(
                                'shrink-0 opacity-60',
                                isMobile ? 'w-4 h-4 mt-0.5' : 'w-3.5 h-3.5 mt-1'
                              )}
                            />
                            <div className="flex-1 min-w-0">
                              {/* 标题行(支持高亮,尾随面具徽标) */}
                              <div className={cn('truncate', isMobile ? 'text-[15px]' : 'text-sm')}>
                                {highlightMatch(conv.title || '新对话', query)}
                                {badge && (
                                  <span className="ml-1 text-xs" title={`面具：${badge.name}`} aria-label={`面具：${badge.name}`}>
                                    {badge.avatar}
                                  </span>
                                )}
                              </div>
                              {/* 消息级命中片段:仅搜索模式下显示,无命中时退化隐藏 */}
                              {fragment && (
                                <div className="mt-0.5 flex items-center gap-1.5 min-w-0">
                                  <FragmentRoleBadge role={fragment.role} />
                                  <span
                                    className={cn(
                                      'text-content-muted/90 truncate flex-1',
                                      isMobile ? 'text-[12.5px]' : 'text-[11px]'
                                    )}
                                  >
                                    {highlightMatch(fragment.snippet, query)}
                                  </span>
                                </div>
                              )}
                            </div>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </div>
                )
              })}

              {/* 加载更多哨兵 —— 滚到这里自动请求下一页 */}
              <div ref={sentinelRef} className="h-1" />
              {loadingMore && (
                <div className="flex items-center justify-center gap-2 py-3 text-[11px] text-content-muted">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  加载更多...
                </div>
              )}
              {!hasMore && results.length > 0 && (
                <div className="py-3 text-center text-[11px] text-content-muted/70">
                  已经到底了
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer hint — 桌面键盘提示;手机端无键盘语境且会被软键盘盖住,不渲染 */}
        <div className="hidden md:flex items-center justify-between px-3.5 py-2 border-t border-line/50 text-[10px] text-content-muted">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-surface-subtle text-content-secondary">↑</kbd>
              <kbd className="px-1 py-0.5 rounded bg-surface-subtle text-content-secondary">↓</kbd>
              选择
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-surface-subtle text-content-secondary">↵</kbd>
              打开
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-surface-subtle text-content-secondary">Esc</kbd>
              关闭
            </span>
          </div>
          <span>
            {results.length}
            {total != null ? ` / ${total}` : ''} 条{query.trim() ? '结果' : '记录'}
          </span>
        </div>
      </div>
    </div>
  )
}
