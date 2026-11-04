'use client'

import { useState } from 'react'
import { Star } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useYellowFishFavorites } from '@/hooks/useYellowFishFavorites'
import type { YellowFishLiveListing } from '@/lib/ai/yellow-fish-live-tool'

/**
 * 实时价卡片的「在售商品」列表 + 行内收藏星标。
 *
 * 与消息收藏不同:这里点星是把某件 goofish 商品(按 itemId)存进 FavoriteItem 表,
 * 归档下来供稍后回看,不会自动爬价。无合法 itemId 的行不给按钮(避免灰按钮撒谎)。
 */
export function YellowFishLiveListings({
  listings,
  keyword,
}: {
  listings: YellowFishLiveListing[]
  keyword?: string
}) {
  const { isFavorited, toggle } = useYellowFishFavorites()
  // 正在飞的行 itemId,防连点重复提交
  const [pending, setPending] = useState<Record<string, boolean>>({})

  return (
    <ul className="space-y-2">
      {listings.map((it) => {
        const canFav = /^\d{5,20}$/.test(it.itemId ?? '')
        const fav = canFav && isFavorited(it.itemId)
        const busy = pending[it.itemId] === true
        return (
          <li key={it.no} className="flex items-baseline gap-2 text-xs">
            <span className="w-10 shrink-0 text-right font-medium tabular-nums text-content-primary">
              {it.price != null ? `¥${it.price}` : (it.priceDisplay || '—')}
            </span>
            {it.url ? (
              <a
                href={it.url}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 flex-1 truncate text-content-secondary hover:underline"
                title={it.title}
              >
                {it.title}
              </a>
            ) : (
              <span className="min-w-0 flex-1 truncate text-content-secondary" title={it.title}>{it.title}</span>
            )}
            <span className="shrink-0 text-[11px] tabular-nums text-content-muted">
              {it.isSearch ? (it.location || '') : '推荐'}
            </span>
            {canFav ? (
              <button
                type="button"
                aria-pressed={fav}
                aria-label={fav ? '取消收藏该商品' : '收藏该商品'}
                title={fav ? '取消收藏' : '收藏商品'}
                disabled={busy}
                onClick={async (e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setPending((p) => ({ ...p, [it.itemId]: true }))
                  try {
                    await toggle(it, keyword)
                  } finally {
                    setPending((p) => {
                      const next = { ...p }
                      delete next[it.itemId]
                      return next
                    })
                  }
                }}
                className={cn(
                  'shrink-0 -mr-1 rounded p-1 transition-opacity hover:opacity-80 disabled:opacity-40',
                  fav ? 'text-amber-400' : 'text-content-muted hover:text-amber-400',
                )}
              >
                <Star className={cn('h-3.5 w-3.5', fav && 'fill-current')} />
              </button>
            ) : (
              // 没有合法 id 的行不留灰按钮:避免"能点但点了没用"的安慰剂
              <span className="w-[22px] shrink-0" aria-hidden />
            )}
          </li>
        )
      })}
    </ul>
  )
}
