'use client'

import { useCallback, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query/keys'
import { fetchJson } from '@/lib/query/fetcher'
import { toast } from '@/lib/toast'
import type { YellowFishLiveListing } from '@/lib/ai/yellow-fish-live-tool'

/**
 * 商品收藏(闲鱼在售商品快照)客户端状态。
 *
 * 与消息收藏 favorite 是两套数据:这里挂 FavoriteItem 表,入口是实时价卡片每条商品
 * 的行内星标 + 设置页 YellowFish 节收藏池。整会话内共享同一份 react-query 缓存
 * (queryKeys.yellowFish.favorites),多处组件调用同一 hook 只发一次请求。
 */

/** 后端 FavoriteItem 行(仅取前端需要的字段) */
export interface YellowFishFavoriteRow {
  id: string
  itemId: string
  title: string
  price: number | null
  priceDisplay: string | null
  url: string
  pic: string | null
  location: string | null
  seller: string | null
  keyword: string | null
  note: string | null
  /** null=从未检测过;onSale=在售;off=已下架/删除;unknown=查了但没拿到可信结论 */
  status: string | null
  statusText: string | null
  /** 最近一次检测到的现价(元) */
  checkedPrice: number | null
  checkedAt: string | null
  createdAt: string
}

/** toggle 的入参:实时价卡片一条 listing 的可收藏字段子集 */
export type YellowFishFavListingInput = Pick<
  YellowFishLiveListing,
  'itemId' | 'title' | 'price' | 'priceDisplay' | 'url' | 'pic' | 'location' | 'seller'
>

export function useYellowFishFavorites() {
  const queryClient = useQueryClient()
  // 正在检测现价的行 itemId → true(手动按钮 spinner 与防连点)
  const [checkingIds, setCheckingIds] = useState<Record<string, boolean>>({})

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.yellowFish.favorites(),
    queryFn: () => fetchJson<YellowFishFavoriteRow[]>('/api/yellow-fish/favorites'),
    staleTime: 30 * 1000,
  })

  const rows = useMemo(() => data ?? [], [data])

  // itemId → 收藏记录 id;星标态与取消收藏都按它判定
  const idByItemId = useMemo(() => {
    const m = new Map<string, string>()
    for (const r of rows) m.set(r.itemId, r.id)
    return m
  }, [rows])

  const isFavorited = useCallback(
    (itemId: string) => !!itemId && idByItemId.has(itemId),
    [idByItemId],
  )

  /**
   * 切换某条在售商品的收藏态:未收藏→POST(乐观插一行),已收藏→DELETE。
   * 无合法 itemId(解析不出数字 id)的行调用方应不给按钮;这里再兜一道。
   */
  const toggle = useCallback(
    async (listing: YellowFishFavListingInput, keyword?: string) => {
      const itemId = (listing.itemId ?? '').trim()
      if (!/^\d{5,20}$/.test(itemId)) {
        toast.hint('这条商品没有可用 id，暂时收藏不了')
        return
      }
      const key = queryKeys.yellowFish.favorites()
      const existingId = idByItemId.get(itemId)

      // 乐观:先从缓存里挪/加一行,失败再回滚重取
      const prev = queryClient.getQueryData<YellowFishFavoriteRow[]>(key) ?? []
      if (existingId) {
        queryClient.setQueryData(
          key,
          prev.filter((r) => r.id !== existingId),
        )
        try {
          await fetchJson(`/api/yellow-fish/favorites/${existingId}`, { method: 'DELETE' })
          toast.hint('已取消收藏')
        } catch {
          queryClient.setQueryData(key, prev)
          toast.error('取消收藏失败，请重试')
        }
      } else {
        const tempId = `pending:${itemId}`
        const optimistic: YellowFishFavoriteRow = {
          id: tempId,
          itemId,
          title: listing.title || '闲鱼商品',
          price: listing.price ?? null,
          priceDisplay: listing.priceDisplay || null,
          url: listing.url,
          pic: listing.pic ?? null,
          location: listing.location ?? null,
          seller: listing.seller ?? null,
          keyword: keyword ?? null,
          note: null,
          status: null,
          statusText: null,
          checkedPrice: null,
          checkedAt: null,
          createdAt: new Date().toISOString(),
        }
        queryClient.setQueryData(key, [optimistic, ...prev])
        try {
          const res = await fetchJson<{ id: string }>('/api/yellow-fish/favorites', {
            method: 'POST',
            json: {
              itemId,
              title: listing.title,
              price: listing.price ?? null,
              priceDisplay: listing.priceDisplay,
              url: listing.url,
              pic: listing.pic,
              location: listing.location,
              seller: listing.seller,
              keyword,
            },
          })
          // 用真实 id 替换乐观占位,避免紧接着再点被当新收藏
          queryClient.setQueryData(key, (cur: YellowFishFavoriteRow[] | undefined) =>
            (cur ?? prev).map((r) => (r.id === tempId ? { ...r, id: res.id } : r)),
          )
          toast.success('已收藏')
        } catch {
          queryClient.setQueryData(key, prev)
          toast.error('收藏失败，请重试')
        }
      }
      // 收尾再后台对齐一次服务端真值(字段以服务端为准)
      void queryClient.invalidateQueries({ queryKey: key })
    },
    [idByItemId, queryClient],
  )

  /**
   * 检测一件商品的现状(POST /check → CLI item get):在售回填现价、下架标红、
   * 失败标 unknown 不误判。成功后用服务端行原位替换缓存,失败 toast 不改缓存。
   */
  const checkOne = useCallback(
    async (itemId: string): Promise<YellowFishFavoriteRow | null> => {
      if (!/^\d{5,20}$/.test(itemId) || checkingIds[itemId]) return null
      setCheckingIds((p) => ({ ...p, [itemId]: true }))
      try {
        const updated = await fetchJson<YellowFishFavoriteRow>('/api/yellow-fish/favorites/check', {
          method: 'POST',
          json: { itemId },
          timeoutMs: 70_000, // CLI 可能先做 ~12s 的 Playwright 免密刷新
        })
        const key = queryKeys.yellowFish.favorites()
        queryClient.setQueryData<YellowFishFavoriteRow[]>(key, (cur) =>
          (cur ?? []).map((r) => (r.itemId === itemId ? { ...r, ...updated } : r)),
        )
        return updated
      } catch (err) {
        toast.error(err instanceof Error && err.message ? `检测失败：${err.message}` : '检测失败，请重试')
        return null
      } finally {
        setCheckingIds((p) => {
          const next = { ...p }
          delete next[itemId]
          return next
        })
      }
    },
    [checkingIds, queryClient],
  )

  /**
   * 一键清掉全部「已下架」收藏:乐观摘除 off 行 → DELETE ?offOnly=1,失败回滚。
   * 只动本地快照,不触发 goofish 请求;返回实际清掉的条数(失败 0)。
   */
  const clearOff = useCallback(async (): Promise<number> => {
    const key = queryKeys.yellowFish.favorites()
    const prev = queryClient.getQueryData<YellowFishFavoriteRow[]>(key) ?? []
    const removing = prev.filter((r) => r.status === 'off')
    if (removing.length === 0) return 0
    queryClient.setQueryData(
      key,
      prev.filter((r) => r.status !== 'off'),
    )
    try {
      const res = await fetchJson<{ deleted: number }>('/api/yellow-fish/favorites?offOnly=1', {
        method: 'DELETE',
      })
      toast.hint(`已清掉 ${res.deleted} 件下架收藏`)
      void queryClient.invalidateQueries({ queryKey: key })
      return res.deleted
    } catch {
      queryClient.setQueryData(key, prev)
      toast.error('清理失败，请重试')
      return 0
    }
  }, [queryClient])

  return { rows, isLoading, isFavorited, idByItemId, toggle, checkOne, clearOff, checkingIds }
}
