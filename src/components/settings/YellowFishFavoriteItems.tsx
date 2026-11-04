'use client'

import { useEffect, useRef, useState } from 'react'
import { ExternalLink, Loader2, RefreshCw, Star, Trash2 } from 'lucide-react'
import { useYellowFishFavorites, type YellowFishFavoriteRow } from '@/hooks/useYellowFishFavorites'

/**
 * 商品收藏池：设置 → YellowFish 底部小节。
 *
 * 列出用实时价卡片星标收藏过的 goofish 在售商品(收藏时价格快照 + 原链接)。
 * 与消息收藏 FavoriteList 分家,这里只处理 FavoriteItem。
 *
 * 下架/现价检测(2026-11-04 第2波):每条可手动「查现价」(CLI item get,单件);
 * 打开池时渐进自动体检——只挑"最旧没查过/最久没查"的一件,localStorage 节流
 * 10 分钟,一次挂载至多一件。不做批量轮询(风控纪律)。unknown 不当误标,只显示原因。
 */

/** 渐进体检节流:两次自动检测至少间隔 10 分钟(跨挂载共享) */
const AUTO_CHECK_INTERVAL_MS = 10 * 60 * 1000
const AUTO_CHECK_AT_KEY = 'aichatt:yf-auto-check-at'

/** 取 list 里 checkedAt/createdAt 最旧的一条;空列表返回 null */
function oldestOf(list: YellowFishFavoriteRow[]): YellowFishFavoriteRow | null {
  if (list.length === 0) return null
  return list.reduce((oldest, r) =>
    new Date(r.checkedAt ?? r.createdAt).getTime() < new Date(oldest.checkedAt ?? oldest.createdAt).getTime() ? r : oldest,
  )
}

/**
 * 挑自动体检目标:未检测过的里挑最旧 → 没下架的里挑最久没查 →
 * 全下架了才在已下架里挑(卖家可能重新上架,但优先级最低)。
 */
function pickAutoCheckTarget(rows: YellowFishFavoriteRow[]): YellowFishFavoriteRow | null {
  const unchecked = rows.filter((r) => !r.checkedAt)
  if (unchecked.length > 0) return oldestOf(unchecked)
  const alive = rows.filter((r) => r.status !== 'off')
  return oldestOf(alive.length > 0 ? alive : rows)
}

export function YellowFishFavoriteItems() {
  const { rows, isLoading, toggle, checkOne, clearOff, checkingIds } = useYellowFishFavorites()
  // 一次挂载至多自动体检一件(防 cache 更新触发 effect 循环)
  const autoCheckDone = useRef(false)
  // 「清空下架收藏」两段式确认:第一下只亮红,3 秒内再点才真删
  const [confirmClear, setConfirmClear] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
    },
    [],
  )

  useEffect(() => {
    if (autoCheckDone.current || isLoading || rows.length === 0) return
    let last = 0
    try {
      last = Number(window.localStorage.getItem(AUTO_CHECK_AT_KEY) || 0)
    } catch {
      /* localStorage 不可用就当过期 */
    }
    if (Date.now() - last < AUTO_CHECK_INTERVAL_MS) return
    const target = pickAutoCheckTarget(rows)
    if (!target) return
    autoCheckDone.current = true
    try {
      window.localStorage.setItem(AUTO_CHECK_AT_KEY, String(Date.now()))
    } catch {
      /* 忽略 */
    }
    void checkOne(target.itemId)
  }, [rows, isLoading, checkOne])

  const autoChecking = rows.some((r) => checkingIds[r.itemId])

  // 已下架分组沉底:其余(未检/在售/检测失败)保持收藏时间倒序
  const offRows = rows.filter((r) => r.status === 'off')
  const activeRows = rows.filter((r) => r.status !== 'off')
  const onSaleCount = rows.reduce((n, r) => (r.status === 'onSale' ? n + 1 : n), 0)

  const handleClearOff = () => {
    if (!confirmClear) {
      setConfirmClear(true)
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
      confirmTimer.current = setTimeout(() => setConfirmClear(false), 3000)
      return
    }
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    setConfirmClear(false)
    void clearOff()
  }

  const rowNode = (r: YellowFishFavoriteRow) => {
    const priceLabel = r.price != null ? `¥${r.price}` : r.priceDisplay || '—'
    const checking = !!checkingIds[r.itemId]
    return (
      <li key={r.id} className={`flex items-start gap-2.5 ${r.status === 'off' ? 'opacity-60' : ''}`}>
        {r.pic ? (
          <img
            src={r.pic}
            alt=""
            loading="lazy"
            className="h-11 w-11 shrink-0 rounded-lg object-cover ring-1 ring-line/40"
          />
        ) : (
          <div className="h-11 w-11 shrink-0 rounded-lg bg-surface-muted" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <a
            href={r.url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 truncate text-[12px] text-content-primary hover:underline"
            title={r.title}
          >
            <span className="truncate">{r.title}</span>
            <ExternalLink className="h-3 w-3 shrink-0 text-content-muted" />
          </a>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-content-muted">
            <span className={`font-medium tabular-nums ${r.status === 'off' ? 'line-through' : 'text-content-secondary'}`}>
              收藏时 {priceLabel}
            </span>
            {r.status === 'onSale' && r.checkedPrice != null ? (
              <span className="font-medium tabular-nums text-content-secondary">
                现价 ¥{r.checkedPrice}
              </span>
            ) : null}
            {r.status === 'off' ? (
              <span className="rounded bg-red-500/10 px-1.5 py-0.5 font-medium text-red-500">
                {r.statusText || '已下架'}
              </span>
            ) : null}
            {r.status === 'unknown' ? (
              <span title={r.statusText || undefined}>检测未成功</span>
            ) : null}
            {r.location ? <span>{r.location}</span> : null}
            {r.keyword ? <span>搜「{r.keyword}」</span> : null}
            {r.checkedAt ? (
              <span className="tabular-nums">
                查于 {new Date(r.checkedAt).getMonth() + 1}/{new Date(r.checkedAt).getDate()}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            aria-label="查现价"
            title={checking ? '检测中…' : '查现价（在售/已下架 + 当前价）'}
            disabled={checking}
            onClick={() => void checkOne(r.itemId)}
            className="rounded p-1.5 text-content-muted transition-colors hover:bg-surface-muted hover:text-content-secondary disabled:opacity-40"
          >
            {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            aria-label="取消收藏"
            title="取消收藏"
            onClick={() =>
              void toggle(
                {
                  itemId: r.itemId,
                  title: r.title,
                  price: r.price,
                  priceDisplay: r.priceDisplay ?? '',
                  url: r.url,
                  pic: r.pic ?? undefined,
                  location: r.location ?? undefined,
                  seller: r.seller ?? undefined,
                },
                r.keyword ?? undefined,
              )
            }
            className="rounded p-1.5 text-content-muted transition-colors hover:bg-red-500/10 hover:text-red-500"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </li>
    )
  }

  return (
    <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3 space-y-2.5">
      <div className="flex items-center gap-1.5 text-xs text-content-secondary">
        <Star className="w-3.5 h-3.5" />
        商品收藏
        {rows.length > 0 ? (
          <span className="ml-1 tabular-nums text-[10px] text-content-muted">
            · {rows.length}
            {onSaleCount > 0 ? ` · 在售 ${onSaleCount}` : ''}
            {offRows.length > 0 ? ` · 下架 ${offRows.length}` : ''}
          </span>
        ) : null}
      </div>

      {isLoading ? (
        <p className="text-[11px] text-content-muted">加载中…</p>
      ) : rows.length === 0 ? (
        <p className="text-[11px] leading-5 text-content-muted">
          还没有收藏。在聊天里的「YellowFish 实时价」卡片展开在售商品，点每条右侧的星标即可存到这里。
        </p>
      ) : (
        <>
          {autoChecking ? (
            <p className="flex items-center gap-1.5 text-[10px] text-content-muted">
              <Loader2 className="h-3 w-3 animate-spin" />
              正在体检一件最早的收藏（查下架状态与现价，约几秒到十几秒）…
            </p>
          ) : null}
          <ul className="space-y-2.5">{activeRows.map((r) => rowNode(r))}</ul>
          {offRows.length > 0 ? (
            <div className="space-y-2.5 border-t border-line/50 pt-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-medium tracking-wide text-content-muted">
                  已下架 · {offRows.length}
                </span>
                <button
                  type="button"
                  onClick={handleClearOff}
                  className={`rounded px-2 py-1 text-[10px] font-medium transition-colors ${
                    confirmClear
                      ? 'bg-red-500/15 text-red-500 hover:bg-red-500/25'
                      : 'text-content-muted hover:bg-surface-muted hover:text-content-secondary'
                  }`}
                >
                  {confirmClear ? '确认清空？' : '清空下架收藏'}
                </button>
              </div>
              <ul className="space-y-2.5">{offRows.map((r) => rowNode(r))}</ul>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
