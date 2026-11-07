'use client'

/**
 * /kb/[docId] —— 课本阅读器:垂直连续滚动流翻页。
 *
 * 设计取舍:
 * - 滚动流而非单页覆盖式:手机上下滑最自然,原生 loading=lazy 只拉可视附近页,
 *   223 页的 img 节点量可接受,不需要虚拟化;
 * - 页图 URL /kb-pages/{bookKey}/pNNN.webp(兜底路由读盘,URL 稳定可长缓存);
 * - ?page=N 定位(检索命中「看原文」跳转用),无参数时恢复 localStorage 进度;
 * - 顶栏页码随滚动更新,点开可输入跳页。
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams, useSearchParams } from 'next/navigation'
import { useSuspenseQuery } from '@tanstack/react-query'
import { ChevronLeft, X } from 'lucide-react'
import { AuthErrorBoundary } from '@/components/AuthErrorBoundary'
import { ClientOnly } from '@/components/ClientOnly'
import { fetchJson } from '@/lib/query/fetcher'
import { queryKeys } from '@/lib/query/keys'
import type { KbDoc } from '@/app/(app)/kb/page'

const PAGE_RATIO = '1191 / 1684' // 教材页 render scale 2.0 的固定宽高比,占位防跳动
const TOPBAR_H = 52
const PROGRESS_KEY = 'kb-reader-progress'

function loadProgress(docId: string): number | null {
  try {
    const raw = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}') as Record<string, number>
    const v = raw[docId]
    return typeof v === 'number' && v >= 1 ? v : null
  } catch {
    return null
  }
}

function saveProgress(docId: string, page: number) {
  try {
    const raw = JSON.parse(localStorage.getItem(PROGRESS_KEY) || '{}') as Record<string, number>
    raw[docId] = page
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(raw))
  } catch {
    // 存储不可用(隐私模式等)静默跳过,进度只是体验增强
  }
}

function pageUrl(bookKey: string, page: number): string {
  return `/kb-pages/${bookKey}/p${String(page).padStart(3, '0')}.webp`
}

function ReaderContent() {
  const { docId } = useParams<{ docId: string }>()
  const searchParams = useSearchParams()
  const jumpParam = searchParams.get('page')

  const { data: doc } = useSuspenseQuery({
    queryKey: queryKeys.kb.doc(docId),
    queryFn: ({ signal }) => fetchJson<KbDoc>(`/api/kb/docs/${docId}`, { signal }),
  })

  const pageCount = doc.pageCount ?? 0
  const containerRef = useRef<HTMLDivElement>(null)
  const topsRef = useRef<number[]>([]) // 每页相对滚动容器的 offsetTop 缓存
  const [current, setCurrent] = useState(() => {
    const j = Number(jumpParam)
    return Number.isInteger(j) && j >= 1 ? j : 1
  })
  const [jumpOpen, setJumpOpen] = useState(false)
  const [jumpInput, setJumpInput] = useState('')

  const pages = useMemo(() => Array.from({ length: pageCount }, (_, i) => i + 1), [pageCount])

  // 页顶缓存:mount 后 + 图片加载完(实际高度替换占位) + resize 时重算。
  // aspect-ratio 占位其实已给准高度,这里主要是兜底比例异常的散页。
  const measureTops = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const els = container.querySelectorAll<HTMLElement>('[data-page]')
    const tops: number[] = []
    els.forEach((el) => tops.push(el.offsetTop))
    topsRef.current = tops
  }, [])
  const pendingRaf = useRef(0)

  // 初始定位:?page=N 优先,否则恢复上次阅读进度;等布局稳定后跳
  useEffect(() => {
    const container = containerRef.current
    if (!container || pageCount === 0) return
    const target = (() => {
      const j = Number(jumpParam)
      if (Number.isInteger(j) && j >= 1 && j <= pageCount) return j
      const p = loadProgress(docId)
      return p != null && p >= 1 && p <= pageCount ? p : 1
    })()
    // 占位盒已在首帧给出高度,双 rAF 等首帧布局完成
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        measureTops()
        if (target > 1) {
          const top = topsRef.current[target - 1]
          if (top != null) container.scrollTop = top - TOPBAR_H + 8
        }
      })
    )
    return () => cancelAnimationFrame(raf)
    // 只在进入页面时定位一次;jumpParam/docId 变化视为重新进入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, jumpParam, pageCount, measureTops])

  // 滚动 → 当前页(顶栏指示 + 进度记忆)
  const onScroll = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    if (pendingRaf.current) return
    pendingRaf.current = requestAnimationFrame(() => {
      pendingRaf.current = 0
      const tops = topsRef.current
      if (!tops.length) return
      const y = container.scrollTop + TOPBAR_H + 8
      let page = 1
      for (let i = 0; i < tops.length; i++) {
        if (tops[i] <= y) page = i + 1
        else break
      }
      setCurrent((prev) => {
        if (prev !== page) saveProgress(docId, page)
        return page
      })
    })
  }, [docId])

  const jumpTo = useCallback(
    (page: number) => {
      const container = containerRef.current
      const target = Math.min(Math.max(Math.trunc(page), 1), pageCount)
      if (!container) return
      const top = topsRef.current[target - 1]
      if (top != null) {
        container.scrollTo({ top: top - TOPBAR_H + 8, behavior: 'smooth' })
        setCurrent(target)
        saveProgress(docId, target)
      }
      setJumpOpen(false)
    },
    [docId, pageCount]
  )

  if (pageCount === 0 || !doc.bookKey) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-sm text-content-muted">
        这本课本没有页图数据
      </div>
    )
  }

  return (
    <div className="relative h-full">
      {/* 顶栏:返回 / 书名 / 页码(点击跳页) */}
      <div className="absolute inset-x-0 top-0 z-10 flex h-[52px] items-center gap-2 border-b border-line/60 bg-surface/85 px-2 backdrop-blur-md md:px-4">
        <Link
          href="/kb"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-content-secondary transition-colors hover:bg-surface-subtle hover:text-content-primary"
          aria-label="返回书架"
        >
          <ChevronLeft className="h-5 w-5" />
        </Link>
        <div className="min-w-0 flex-1 truncate text-sm font-medium text-content-primary" title={doc.title}>
          {doc.title}
        </div>
        <button
          type="button"
          onClick={() => {
            setJumpInput(String(current))
            setJumpOpen((v) => !v)
          }}
          className="shrink-0 rounded-lg px-2.5 py-1.5 text-xs tabular-nums text-content-secondary transition-colors hover:bg-surface-subtle hover:text-content-primary"
          aria-label="跳转到指定页"
        >
          {current} / {pageCount}
        </button>
      </div>

      {/* 跳页面板 */}
      {jumpOpen && (
        <div className="absolute right-2 top-[56px] z-20 flex items-center gap-2 rounded-xl border border-line/70 bg-surface p-2 shadow-lg md:right-4">
          <input
            autoFocus
            type="number"
            min={1}
            max={pageCount}
            value={jumpInput}
            onChange={(e) => setJumpInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') jumpTo(Number(jumpInput))
              if (e.key === 'Escape') setJumpOpen(false)
            }}
            className="w-20 rounded-lg border border-line bg-surface-subtle px-2 py-1.5 text-sm tabular-nums text-content-primary outline-none focus:border-accent"
            aria-label="页码"
          />
          <button
            type="button"
            onClick={() => jumpTo(Number(jumpInput))}
            className="rounded-lg bg-accent px-3 py-1.5 text-sm text-white transition-opacity hover:opacity-90"
          >
            跳转
          </button>
          <button
            type="button"
            onClick={() => setJumpOpen(false)}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-content-muted transition-colors hover:bg-surface-subtle hover:text-content-primary"
            aria-label="关闭跳页"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* 页面滚动流 */}
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="h-full overflow-y-auto bg-surface-subtle/40 pt-[52px]"
        style={{ scrollBehavior: 'auto' }}
      >
        <div className="mx-auto max-w-3xl px-2 pb-16 md:px-4">
          {pages.map((p) => (
            <div key={p} data-page={p} className="relative">
              <div
                className="overflow-hidden rounded-lg bg-surface-subtle"
                style={{ aspectRatio: PAGE_RATIO }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={pageUrl(doc.bookKey!, p)}
                  alt={`第 ${p} 页`}
                  loading={p <= 2 ? 'eager' : 'lazy'}
                  decoding="async"
                  onLoad={p <= 3 ? measureTops : undefined}
                  className="h-full w-full object-contain"
                />
              </div>
              {/* 页间隙页码:轻提示,不抢视觉 */}
              <div className="py-1.5 text-center text-[10px] tabular-nums text-content-muted/70">
                {p}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function KbReaderPage() {
  return (
    <AuthErrorBoundary>
      <ClientOnly>
        <Suspense fallback={<div className="h-full" />}>
          <ReaderContent />
        </Suspense>
      </ClientOnly>
    </AuthErrorBoundary>
  )
}
