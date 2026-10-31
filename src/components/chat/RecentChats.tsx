'use client'

import { useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query'
import { queryKeys, STALE } from '@/lib/query/keys'
import { fetchJson, HttpError } from '@/lib/query/fetcher'

/**
 * 移动端欢迎页「最近对话」快捷区(md:hidden):
 * 手机端热力图移除后,输入框下方的替代内容 —— 最多 3 条最近会话,点击直达。
 *
 * 设计要点:
 * - 数据与 Sidebar 完全同款 useInfiniteQuery(同 key 同 queryFn 同 staleTime),
 *   两处观察者共享同一份缓存,主页不产生额外请求
 * - 临时聊天模式(访客密码)无会话,整块不渲染(与 BottomDock 同逻辑)
 * - 列表为空也不渲染,保持欢迎页极简;加载中同样静默,无需骨架
 */

interface ConversationData {
  id: string
  title: string
  mode?: string
  /** 学习模式会话:快捷条目据此跳 /study?c=id */
  studyMode?: boolean
  maskId?: string | null
  updatedAt: string
}

interface ConversationsPage {
  items: ConversationData[]
  total: number
  hasMore: boolean
}

/** 与 Sidebar 一致的分页参数 —— query key 里的 limit 必须相同才能命中同一缓存 */
const PAGE_SIZE = 20
const MAX_ITEMS = 3

/** 相对时间: 刚刚/N 分钟前/N 小时前/昨天/N 天前/M月D日(跨年沿用月日,极简即可)
 *  导出共享:方案 C 手机端的全屏抽屉(MobileDrawer)历史行也用它 */
export function relativeTime(iso: string): string {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const min = Math.floor((Date.now() - t) / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d === 1) return '昨天'
  if (d < 7) return `${d} 天前`
  const date = new Date(t)
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

export function RecentChats() {
  const router = useRouter()
  const { data: session, status } = useSession()

  // 与 Sidebar.tsx 同款查询:同 key 共享缓存,会话增删改(指标 bump)后两处同步刷新
  const { data } = useInfiniteQuery<
    ConversationsPage,
    HttpError,
    InfiniteData<ConversationsPage, number>,
    readonly unknown[],
    number
  >({
    queryKey: queryKeys.conversations.list(PAGE_SIZE, 0),
    queryFn: async ({ pageParam }) => {
      const d = await fetchJson<ConversationsPage>(
        `/api/conversations?limit=${PAGE_SIZE}&offset=${pageParam}`
      )
      return {
        items: d.items ?? [],
        total: d.total ?? 0,
        hasMore: !!d.hasMore,
      }
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      if (!lastPage.hasMore) return undefined
      return allPages.reduce((acc, p) => acc + p.items.length, 0)
    },
    staleTime: STALE.conversationList,
    enabled: status === 'authenticated' && session?.ephemeral !== true,
  })

  // 临时模式(访客密码登录)无会话;空列表/加载中整块不渲染
  if (session?.ephemeral === true) return null
  const items = (data?.pages?.[0]?.items ?? []).slice(0, MAX_ITEMS)
  if (items.length === 0) return null

  return (
    <div className="md:hidden mt-3">
      <p className="px-2 mb-1.5 text-[11px] tracking-wide text-content-secondary/90 [text-shadow:0_1px_2px_rgb(var(--background)/0.8)]">
        最近对话
      </p>
      <div className="flex flex-col gap-1.5">
        {items.map((c) => (
          <button
            key={c.id}
            onClick={() => router.push(c.studyMode ? `/study?c=${c.id}` : `/chat/c/${c.id}`)}
            aria-label={`打开对话：${c.title || '未命名对话'}`}
            className="flex h-11 w-full items-center gap-2 rounded-lg px-2.5 text-left
              bg-surface-muted/75 border border-line/40 backdrop-blur-sm
              active:bg-surface-subtle active:scale-[0.99] transition-all touch-manipulation"
            style={{ WebkitTapHighlightColor: 'transparent' }}
          >
            <span className="min-w-0 flex-1 truncate text-[13px] text-content-primary">
              {c.title || '未命名对话'}
            </span>
            <span className="shrink-0 text-[10px] text-content-secondary" suppressHydrationWarning>
              {relativeTime(c.updatedAt)}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
