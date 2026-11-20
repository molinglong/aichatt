'use client'

/**
 * PDF 录题 · 审核台(挑稿三案收编:方案A 双栏工作台为主力骨架,
 * C 案「批量入库干净题」收进顶栏,B 案「单题焦点审」做成编辑抽屉 PdfImportEditDrawer)。
 * 左:pdfjs 渲染当前页 + 候选题区高亮定位(文本层题干匹配);右:候选卡列表 + 状态筛选。
 * 切题中按服务端分块计划逐块驱动(进度条 + 单块重试),齐了才能入库/建卷。
 * 建卷口径:未被跳过的候选 → Paper+PaperQuestion(真题池);已入库且有答案 → Question(练题池)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import katex from 'katex'
import {
  ChevronLeft, ChevronRight, Check, X, Pencil, RefreshCw,
  FileText, AlertTriangle, ArrowRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { fetchJson } from '@/lib/query/fetcher'
import { queryKeys } from '@/lib/query/keys'
import { toast } from '@/lib/toast'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { PdfImportEditDrawer } from '@/components/papers/PdfImportEditDrawer'
import {
  candidateCounts,
  type ImportCandidate,
  type ImportJobDto,
} from '@/lib/papers/pdf-import'
import { loadPage, locateStem, cropFromImg, type PageAsset } from '@/lib/papers/pdf-client'

type FilterKey = 'all' | 'wait' | 'dup' | 'noans' | 'done' | 'skip'

/** $...$ / $$...$$ 数学文本(与卷面预览页同分隔符口径;渲染失败原样) */
function TexText({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => {
    const re = /\$\$([^$\n]+?)\$\$|\$([^$\n]+?)\$/g
    let out = ''
    let last = 0
    let m: RegExpExecArray | null
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    while ((m = re.exec(text))) {
      out += esc(text.slice(last, m.index))
      try {
        out += katex.renderToString((m[1] ?? m[2]) ?? '', { throwOnError: false, displayMode: !!m[1] })
      } catch {
        out += esc(m[0])
      }
      last = m.index + m[0].length
    }
    out += esc(text.slice(last))
    return out
  }, [text])
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />
}

const FILTERS: Array<{ key: FilterKey; label: (c: ReturnType<typeof candidateCounts>) => string }> = [
  { key: 'all', label: (c) => `全部 ${c.total}` },
  { key: 'wait', label: (c) => `待审 ${c.wait}` },
  { key: 'dup', label: (c) => `疑似重复 ${c.dup}` },
  { key: 'noans', label: (c) => `缺答案 ${c.noAnswer}` },
  { key: 'done', label: (c) => `已入库 ${c.done}` },
  { key: 'skip', label: (c) => `已跳过 ${c.skip}` },
]

/** 状态 chip(与挑稿页方案同词汇) */
function StateChip({ c }: { c: ImportCandidate }) {
  if (c.state === 'done') return <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10.5px] font-semibold text-accent">已入库</span>
  if (c.state === 'skip') return <span className="rounded-full bg-surface-subtle px-2 py-0.5 text-[10.5px] text-content-muted">已跳过</span>
  if (c.dup) return <span className="rounded-full bg-[rgb(var(--danger)/0.1)] px-2 py-0.5 text-[10.5px] font-semibold text-[rgb(var(--danger))]">疑似重复</span>
  if (!c.answer) return <span className="rounded-full border border-dashed border-[rgb(var(--danger)/0.6)] px-2 py-0.5 text-[10.5px] text-[rgb(var(--danger))]">缺答案</span>
  return <span className="rounded-full bg-surface-subtle px-2 py-0.5 text-[10.5px] text-content-secondary">待审</span>
}

export function PdfImportWorkbench({ id }: { id: string }) {
  const router = useRouter()
  const queryClient = useQueryClient()

  const jobQuery = useQuery({
    queryKey: queryKeys.papers.pdfImport(id),
    queryFn: () => fetchJson<{ job: ImportJobDto }>(`/api/papers/pdf-import/${id}`).then((r) => r.job),
  })
  const job = jobQuery.data ?? null

  // 候选以本地态为会话真源;分块切题 / AI 解 / 重切的服务端结果整包采纳,人工操作本地改完即回写
  const [cands, setCands] = useState<ImportCandidate[] | null>(null)
  useEffect(() => {
    if (job && !cands) setCands(job.candidates)
  }, [job, cands])

  const [filter, setFilter] = useState<FilterKey>('all')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [solvingKey, setSolvingKey] = useState<string | null>(null)
  const [finishOpen, setFinishOpen] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [finishedSlug, setFinishedSlug] = useState<string | null>(null)

  // ── 切题编排 ──
  const [splitIdx, setSplitIdx] = useState(0)
  const [splitErr, setSplitErr] = useState<string | null>(null)
  const [retryTick, setRetryTick] = useState(0)
  const splitRunningRef = useRef(false)
  const splitIdxRef = useRef(0)

  // ── PDF 页图(服务端产出,客户端零 pdfjs) ──
  const [pageNo, setPageNo] = useState(1)
  const [pageAsset, setPageAsset] = useState<PageAsset | null>(null)
  const [pageErr, setPageErr] = useState(false)
  useEffect(() => {
    if (!job) return
    let alive = true
    setPageErr(false)
    loadPage(id, pageNo)
      .then((a) => {
        if (alive) setPageAsset(a)
      })
      .catch(() => {
        if (alive) setPageErr(true)
      })
    return () => {
      alive = false
    }
  }, [job, id, pageNo])

  const adopt = useCallback(
    (dto: ImportJobDto) => {
      setCands(dto.candidates)
      queryClient.setQueryData(queryKeys.papers.pdfImport(id), dto)
    },
    [id, queryClient]
  )

  /** 人工操作整包回写(轻校验放服务端;失败 toast,不回滚本地) */
  const persist = useCallback(
    async (next: ImportCandidate[], extra?: { title?: string }) => {
      try {
        const r = await fetchJson<{ job: ImportJobDto }>(`/api/papers/pdf-import/${id}`, {
          method: 'PATCH',
          json: { op: 'save', candidates: next, ...extra },
          timeoutMs: 30_000,
        })
        queryClient.setQueryData(queryKeys.papers.pdfImport(id), r.job)
      } catch {
        toast.error('保存失败,稍后会话内重试;先别关页')
      }
    },
    [id, queryClient]
  )

  useEffect(() => {
    if (!job || !cands || job.status !== 'splitting' || !job.chunks?.length) return
    if (splitRunningRef.current) return
    splitRunningRef.current = true
    ;(async () => {
      try {
        // 已有候选覆盖过的页跳过(断点续切/刷新重入)
        const covered = new Set((cands ?? []).map((c) => c.page))
        for (let i = splitIdxRef.current; i < job.chunks!.length; i++) {
          const ch = job.chunks![i]
          const fullyCovered = Array.from({ length: ch.to - ch.from + 1 }, (_, k) => ch.from + k).every((p) => covered.has(p))
          setSplitIdx(i)
          if (!fullyCovered) {
            const r = await fetchJson<{ job: ImportJobDto }>(`/api/papers/pdf-import/${id}/split`, {
              method: 'POST',
              json: { from: ch.from, to: ch.to },
              timeoutMs: 240_000,
            })
            setCands(r.job.candidates)
            queryClient.setQueryData(queryKeys.papers.pdfImport(id), r.job)
            r.job.candidates.forEach((c) => covered.add(c.page))
          }
          splitIdxRef.current = i + 1
          setSplitIdx(i + 1)
        }
        const r = await fetchJson<{ job: ImportJobDto }>(`/api/papers/pdf-import/${id}`, {
          method: 'PATCH',
          json: { op: 'ready' },
        })
        queryClient.setQueryData(queryKeys.papers.pdfImport(id), r.job)
      } catch (err) {
        setSplitErr(err instanceof Error ? err.message : String(err))
      } finally {
        splitRunningRef.current = false
      }
    })()
  }, [job, cands, id, queryClient, retryTick])

  // ── 派生:高亮框(矩形为 PDF pt,叠加层用百分比定位,天然随缩放) / 筛选列表 / 统计 ──
  const highlights = useMemo(() => {
    if (!cands || !pageAsset) return []
    return cands
      .filter((c) => c.page === pageNo && c.stem)
      .map((c) => {
        const rect = locateStem(pageAsset.items, c.stem)
        return { c, rect }
      })
      .filter((x) => x.rect)
  }, [cands, pageAsset, pageNo])

  const counts = useMemo(() => candidateCounts(cands ?? []), [cands])

  const visible = useMemo(() => {
    const list = cands ?? []
    if (filter === 'all') return list
    if (filter === 'dup') return list.filter((c) => c.dup)
    if (filter === 'noans') return list.filter((c) => !c.answer)
    return list.filter((c) => c.state === filter)
  }, [cands, filter])

  const editing = useMemo(() => (cands ?? []).find((c) => c.key === editingKey) ?? null, [cands, editingKey])

  // ── 动作 ──
  const setCandidateState = (key: string, state: ImportCandidate['state']) => {
    if (!cands) return
    const next = cands.map((c) => (c.key === key ? { ...c, state } : c))
    setCands(next)
    void persist(next)
  }

  const batchImportClean = () => {
    if (!cands) return
    let n = 0
    const next = cands.map((c) => {
      if (c.state === 'wait' && c.answer && !c.dup) {
        n++
        return { ...c, state: 'done' as const }
      }
      return c
    })
    if (!n) {
      toast.error('没有可批量入库的干净题(待审 ∧ 有答案 ∧ 未命中重复)')
      return
    }
    setCands(next)
    void persist(next)
    toast.success(`已入库 ${n} 题干净题`)
  }

  const saveEdit = (partial: Partial<ImportCandidate>) => {
    if (!cands || !editingKey) return
    const next = cands.map((c) => (c.key === editingKey ? { ...c, ...partial } : c))
    setCands(next)
    setEditingKey(null)
    void persist(next)
    toast.success('已保存')
  }

  const aiSolve = async (key: string) => {
    if (!cands) return
    await persist(cands) // 先落盘本地编辑,再让服务端在最新候选上解题
    setSolvingKey(key)
    try {
      const r = await fetchJson<{ job: ImportJobDto }>(`/api/papers/pdf-import/${id}`, {
        method: 'PATCH',
        json: { op: 'aiSolve', key },
        timeoutMs: 120_000,
      })
      setCands(r.job.candidates)
      queryClient.setQueryData(queryKeys.papers.pdfImport(id), r.job)
      toast.success('AI 解完成,答案标「AI 参考」来源')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`AI 解失败:${msg.slice(0, 80)}`)
    } finally {
      setSolvingKey(null)
    }
  }

  const resplitPage = async (page: number) => {
    if (!cands) return
    await persist(cands)
    try {
      const r = await fetchJson<{ job: ImportJobDto; added: number }>(`/api/papers/pdf-import/${id}`, {
        method: 'PATCH',
        json: { op: 'resplit', page },
        timeoutMs: 180_000,
      })
      setCands(r.job.candidates)
      queryClient.setQueryData(queryKeys.papers.pdfImport(id), r.job)
      toast.success(r.added ? `第 ${page} 页重切完成,新增 ${r.added} 题` : `第 ${page} 页重切完成,没有新题`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`重切失败:${msg.slice(0, 80)}`)
    }
  }

  const finish = async () => {
    setFinishing(true)
    try {
      const r = await fetchJson<{ slug: string; paperId: string; questionCount: number; paperQuestionCount: number }>(
        `/api/papers/pdf-import/${id}/finish`,
        { json: {}, timeoutMs: 60_000 }
      )
      setFinishedSlug(r.slug)
      setFinishOpen(false)
      toast.success(`建卷完成:练题池入库 ${r.questionCount} 题 · 真题池整卷 ${r.paperQuestionCount} 题`)
      void queryClient.invalidateQueries({ queryKey: queryKeys.papers.list() })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`建卷失败:${msg.slice(0, 100)}`)
    } finally {
      setFinishing(false)
    }
  }

  // ── 编辑抽屉:原图区域裁剪(按 key 缓存;页图来自服务端资产,离屏 canvas 裁剪) ──
  const regionCacheRef = useRef(new Map<string, string | null>())
  const [regionImage, setRegionImage] = useState<string | null>(null)
  useEffect(() => {
    if (!editing) {
      setRegionImage(null)
      return
    }
    const cached = regionCacheRef.current.get(editing.key)
    if (cached !== undefined) {
      setRegionImage(cached)
      return
    }
    let alive = true
    ;(async () => {
      try {
        const asset = await loadPage(id, editing.page)
        const rect = locateStem(asset.items, editing.stem)
        if (!rect) throw new Error('no-locate')
        const img = new Image()
        img.src = asset.dataUrl
        await img.decode()
        const url = cropFromImg(img, rect, asset.width)
        regionCacheRef.current.set(editing.key, url)
        if (alive) setRegionImage(url)
      } catch {
        regionCacheRef.current.set(editing.key, null)
        if (alive) setRegionImage(null)
      }
    })()
    return () => {
      alive = false
    }
  }, [editing, id])

  const status = job?.status ?? 'loading'
  const canReview = status === 'ready' && !!cands

  return (
    <div className="relative h-full">
      {/* 顶栏 */}
      <div className="absolute inset-x-0 top-0 z-10 flex min-h-[52px] items-center gap-1.5 border-b border-line/60 bg-surface/95 px-1.5 backdrop-blur-md max-md:pt-[var(--sat)] md:px-4">
        <button
          type="button"
          onClick={() => router.push('/papers/composed')}
          aria-label="返回"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-content-secondary transition-colors hover:bg-surface-subtle hover:text-content-primary"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1 py-1">
          <div className="truncate text-[13px] font-medium text-content-primary md:text-sm">
            {job?.title || 'PDF 录题'}
            <span className="ml-1.5 hidden text-[11px] font-normal text-content-muted md:inline">
              {job ? `${job.fileName} · ${job.pageCount} 页 · ${job.mode === 'text' ? '文本版' : '扫描版'}` : ''}
            </span>
          </div>
        </div>
        {canReview && (
          <>
            <span className="hidden shrink-0 items-center gap-1 text-[11.5px] text-content-secondary tabular-nums md:flex">
              已入库 <b className="font-semibold text-content-primary">{counts.done}</b> · 待审{' '}
              <b className="font-semibold text-content-primary">{counts.wait}</b> ·
              <span className="text-[rgb(var(--danger))]">重复 {counts.dup}</span> ·
              <span className="text-[rgb(var(--danger))]">缺答案 {counts.noAnswer}</span>
            </span>
            <button
              type="button"
              onClick={batchImportClean}
              className="hidden h-7 shrink-0 items-center rounded-full border border-line px-3 text-[11.5px] font-medium text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary md:flex"
            >
              批量入库干净题
            </button>
            <button
              type="button"
              onClick={() => setFinishOpen(true)}
              className="flex h-7 shrink-0 items-center rounded-full bg-accent px-3 text-[11.5px] font-semibold text-accent-foreground transition-opacity hover:opacity-90"
            >
              完成并建卷
            </button>
          </>
        )}
      </div>

      {/* 主体:双栏工作台 */}
      <div className="h-full overflow-y-auto pt-[calc(52px+var(--sat))]">
        <div className="mx-auto w-full max-w-[1480px] px-2 pb-[max(48px,var(--sab))] pt-3 md:px-4">
          {!job ? (
            <div className="py-24 text-center text-[12.5px] text-content-muted">{jobQuery.isError ? '作业不存在或已删除' : '加载中…'}</div>
          ) : status === 'finished' || finishedSlug ? (
            /* ── 完成横幅 ── */
            <div className="mx-auto mt-16 max-w-[560px] rounded-[14px] border border-line bg-surface p-6 text-center">
              <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-accent-soft text-accent">
                <Check className="h-5 w-5" />
              </div>
              <div className="text-[15px] font-bold text-content-primary">建卷完成</div>
              <div className="mt-1.5 text-[12.5px] leading-relaxed text-content-secondary">
                {finishedSlug ? (
                  <>
                    卷卡已进卷库,练题池入库 {counts.poolReady || counts.done} 题;可继续编辑候选或去学习台组卷用它们。
                  </>
                ) : (
                  '这张卷子已经建过了。'
                )}
              </div>
              <div className="mt-4 flex items-center justify-center gap-2">
                {finishedSlug && (
                  <button
                    type="button"
                    onClick={() => router.push(`/papers/${finishedSlug}`)}
                    className="flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-[12.5px] font-semibold text-accent-foreground transition-opacity hover:opacity-90"
                  >
                    查看卷卡 <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => router.push('/study')}
                  className="rounded-full border border-line px-4 py-2 text-[12.5px] text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary"
                >
                  回学习台
                </button>
              </div>
            </div>
          ) : status === 'splitting' ? (
            /* ── 切题进行中 ── */
            <div className="mx-auto mt-16 max-w-[520px] rounded-[14px] border border-line bg-surface p-6">
              <div className="flex items-center gap-2.5">
                <i className="h-2 w-2 animate-pulse rounded-full bg-accent" />
                <span className="text-[13.5px] font-semibold text-content-primary">AI 正在切题…</span>
                {job.chunks?.length ? (
                  <span className="ml-auto text-[11.5px] text-content-muted tabular-nums">
                    {Math.min(splitIdx, job.chunks.length)} / {job.chunks.length} 块
                  </span>
                ) : null}
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-subtle">
                <i
                  className="block h-full rounded-full bg-accent transition-all duration-300"
                  style={{ width: job.chunks?.length ? `${(splitIdx / job.chunks.length) * 100}%` : '8%' }}
                />
              </div>
              {splitErr ? (
                <div className="mt-3 rounded-lg bg-[rgb(var(--danger)/0.08)] px-3 py-2 text-[12px] leading-relaxed text-[rgb(var(--danger))]">
                  <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
                  切题中断:{splitErr}
                  <button
                    type="button"
                    onClick={() => {
                      setSplitErr(null)
                      setRetryTick((n) => n + 1)
                    }}
                    className="ml-2 font-semibold underline underline-offset-2"
                  >
                    从这里继续
                  </button>
                </div>
              ) : (
                <div className="mt-3 text-[11.5px] leading-relaxed text-content-muted">
                  按页分块喂给模型,整卷通常几十秒;期间可以滚看左边页图,切完自动进审核。
                </div>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1.02fr_0.98fr]">
              {/* ── 左:PDF 页图(服务端渲染,叠加高亮按百分比定位) ── */}
              <div className="min-w-0 rounded-[14px] border border-line bg-surface-muted p-3">
                <div className="mb-2.5 flex items-center justify-center gap-2.5">
                  <button
                    type="button"
                    aria-label="上一页"
                    disabled={pageNo <= 1}
                    onClick={() => setPageNo((p) => Math.max(1, p - 1))}
                    className="flex h-[26px] w-[26px] items-center justify-center rounded-full border border-line bg-surface text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary disabled:opacity-40"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </button>
                  <span className="text-[11.5px] text-content-secondary tabular-nums">
                    第 <b className="font-semibold text-content-primary">{pageNo}</b> / {job.pageCount} 页
                  </span>
                  <button
                    type="button"
                    aria-label="下一页"
                    disabled={pageNo >= job.pageCount}
                    onClick={() => setPageNo((p) => Math.min(job.pageCount, p + 1))}
                    className="flex h-[26px] w-[26px] items-center justify-center rounded-full border border-line bg-surface text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary disabled:opacity-40"
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                  {canReview && (
                    <button
                      type="button"
                      onClick={() => void resplitPage(pageNo)}
                      title="AI 重切本页:替换本页未入库的候选"
                      className="flex h-[26px] items-center gap-1 rounded-full border border-line bg-surface px-2.5 text-[10.5px] text-content-secondary transition-colors hover:border-accent hover:text-accent"
                    >
                      <RefreshCw className="h-3 w-3" />
                      重切本页
                    </button>
                  )}
                </div>

                <div className="relative mx-auto max-w-[640px]">
                  {pageErr ? (
                    <div className="flex h-[320px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line-strong text-[12px] text-content-muted">
                      <AlertTriangle className="h-5 w-5" />
                      本页页图加载失败,翻页再试或刷新页面
                    </div>
                  ) : !pageAsset ? (
                    <div className="flex h-[320px] items-center justify-center rounded-lg border border-line bg-surface text-[12px] text-content-muted">
                      页图渲染中…
                    </div>
                  ) : (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={pageAsset.dataUrl}
                        alt={`第 ${pageNo} 页`}
                        className="block w-full rounded-lg border border-line bg-white"
                      />
                      {/* 题区高亮层:矩形存 PDF pt,按页宽换算百分比,缩放自适应 */}
                      <div className="pointer-events-none absolute inset-0">
                        {highlights.map(({ c, rect }) => {
                          const sel = selectedKey === c.key
                          const style: React.CSSProperties = {
                            left: `${((rect!.x - 6) / pageAsset.width) * 100}%`,
                            top: `${((rect!.y - 4) / pageAsset.height) * 100}%`,
                            width: `${((rect!.w + 12) / pageAsset.width) * 100}%`,
                            height: `${((rect!.h + 8) / pageAsset.height) * 100}%`,
                          }
                          const tone =
                            c.state === 'done'
                              ? 'border-[rgb(var(--accent)/0.8)] bg-[rgb(var(--accent)/0.13)]'
                              : c.dup
                                ? 'border-dashed border-[rgb(var(--danger))] bg-[rgb(var(--danger)/0.09)]'
                                : c.state === 'skip'
                                  ? 'border-dashed border-line-strong'
                                  : sel
                                    ? 'border-dashed border-accent bg-[rgb(var(--accent)/0.08)]'
                                    : 'border-dashed border-[rgb(var(--accent)/0.4)]'
                          return (
                            <div key={c.key} className={cn('absolute rounded-[9px] border-[1.5px]', tone, sel && 'border-accent')} style={style}>
                              <span
                                className={cn(
                                  'absolute -top-[10px] left-1 whitespace-nowrap rounded-full border bg-surface px-1.5 text-[9.5px] leading-[16px] tabular-nums',
                                  c.state === 'done' || sel
                                    ? 'border-accent text-accent'
                                    : c.dup
                                      ? 'border-[rgb(var(--danger))] text-[rgb(var(--danger))]'
                                      : 'border-line-strong text-content-muted'
                                )}
                              >
                                第 {c.number || '?'} 题
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* ── 右:候选列表 ── */}
              <div className="flex min-w-0 flex-col gap-2 rounded-[14px] border border-line bg-surface p-3">
                <div className="flex flex-wrap gap-1.5 border-b border-line pb-2.5">
                  {FILTERS.map((f) => (
                    <button
                      key={f.key}
                      type="button"
                      onClick={() => setFilter(f.key)}
                      className={cn(
                        'rounded-full border px-2.5 py-1 text-[11px] tabular-nums transition-colors',
                        filter === f.key
                          ? 'border-accent bg-accent-soft font-semibold text-accent'
                          : 'border-line bg-surface text-content-secondary hover:border-line-strong hover:text-content-primary'
                      )}
                    >
                      {f.label(counts)}
                    </button>
                  ))}
                </div>

                <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto lg:max-h-[calc(100vh-190px)]">
                  {visible.length === 0 && (
                    <div className="py-10 text-center text-[12px] text-content-muted">这一类没有题了</div>
                  )}
                  {visible.map((c) => {
                    const sel = selectedKey === c.key
                    return (
                      <div
                        key={c.key}
                        onClick={() => {
                          setSelectedKey(c.key)
                          if (c.page !== pageNo) setPageNo(c.page)
                        }}
                        className={cn(
                          'cursor-pointer rounded-[10px] border bg-surface px-3 py-2.5 transition-all',
                          sel ? 'border-accent shadow-[0_0_0_2px_rgb(var(--accent)/0.11)]' : 'border-line hover:border-line-strong',
                          c.dup && !sel && 'border-dashed border-[rgb(var(--danger)/0.7)]',
                          c.state === 'skip' && 'opacity-60'
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <span className="rounded-[7px] bg-accent-soft px-1.5 py-0.5 text-[11.5px] font-bold tabular-nums text-accent">
                            {c.number || '?'}
                          </span>
                          <span className="rounded-full border border-line px-1.5 py-px text-[10px] text-content-muted">
                            {c.kind === 'choice' ? '选择' : '解答'}
                          </span>
                          {c.score > 0 && <span className="text-[10.5px] text-content-muted tabular-nums">{c.score} 分</span>}
                          <span className="ml-auto">
                            <StateChip c={c} />
                          </span>
                        </div>
                        <div className="mt-1.5 line-clamp-2 text-[12.5px] leading-relaxed text-content-primary">
                          <TexText text={c.stem} />
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2">
                          {c.topic && (
                            <span className="rounded-full bg-surface-subtle px-2 py-0.5 text-[10.5px] text-content-secondary">{c.topic}</span>
                          )}
                          {c.answer ? (
                            <span className="flex items-center gap-1 text-[11px] text-content-secondary">
                              <Check className="h-3 w-3 text-accent" />
                              {c.answerSource === 'ai' ? 'AI 参考' : '卷面答案'}
                            </span>
                          ) : null}
                          {c.dup && <span className="text-[11px] text-[rgb(var(--danger))]">{c.dup}</span>}
                          <span className="ml-auto flex items-center gap-1.5">
                            {c.state !== 'done' && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setCandidateState(c.key, 'done')
                                }}
                                className="rounded-full bg-accent px-2.5 py-1 text-[10.5px] font-semibold text-accent-foreground transition-opacity hover:opacity-90"
                              >
                                入库
                              </button>
                            )}
                            {c.state !== 'skip' ? (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setCandidateState(c.key, 'skip')
                                }}
                                className="rounded-full border border-line px-2.5 py-1 text-[10.5px] text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary"
                              >
                                跳过
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setCandidateState(c.key, 'wait')
                                }}
                                className="rounded-full border border-line px-2.5 py-1 text-[10.5px] text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary"
                              >
                                恢复
                              </button>
                            )}
                            <button
                              type="button"
                              aria-label="编辑"
                              onClick={(e) => {
                                e.stopPropagation()
                                setEditingKey(c.key)
                              }}
                              className="rounded p-1 text-content-muted transition-colors hover:bg-surface-subtle hover:text-content-primary"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                          </span>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 编辑抽屉(B 案) */}
      <PdfImportEditDrawer
        open={!!editing}
        candidate={editing}
        regionImage={regionImage}
        solving={solvingKey === editingKey}
        onClose={() => setEditingKey(null)}
        onSave={saveEdit}
        onAiSolve={() => editingKey && void aiSolve(editingKey)}
      />

      {/* 完成并建卷确认 */}
      <ConfirmDialog
        open={finishOpen}
        title="完成并建卷?"
        description={
          cands
            ? `练题池入库 ${counts.poolReady} 题(已入库 ∧ 有答案);真题池整卷建 ${counts.total - counts.skip} 题(跳过的 ${counts.skip} 题不入)。缺答案与待审的题只进卷面层,不进练题池,后续可补。`
            : ''
        }
        confirmLabel={finishing ? '建卷中…' : '建卷'}
        busy={finishing}
        onConfirm={() => void finish()}
        onCancel={() => setFinishOpen(false)}
      />
    </div>
  )
}
