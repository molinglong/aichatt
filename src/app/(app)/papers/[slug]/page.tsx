'use client'

/**
 * /papers/[slug] —— 原卷页面预览:整卷逐页渲染 PaperPage 契约片段(纸质卷面)。
 *
 * 设计取舍:
 * - 垂直连续滚动流,与 /kb 阅读器同一翻阅形态(手机上下滑最自然);卷页是轻 HTML,并行拉取全部;
 * - ?number=N 从真题 chips/工具卡「查看原卷页」跳入:定位到题所在页,页角挂「第N题」徽标;
 * - 纸面恒白(纸质卷面定案),页面底色随主题;$...$/$$...$$ 客户端 KaTeX 渲染(全局已载 katex.css);
 * - 顶栏页码随滚动更新,点击输入跳页(与 kb 阅读器一致);答案缺省为空 div,CSS 藏。
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, Eye, EyeOff, X } from 'lucide-react'
import katex from 'katex'
import { AuthErrorBoundary } from '@/components/AuthErrorBoundary'
import { ClientOnly } from '@/components/ClientOnly'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { fetchJson } from '@/lib/query/fetcher'
import { queryKeys } from '@/lib/query/keys'
import { toast } from '@/lib/toast'
import styles from './PaperViewer.module.css'

const TOPBAR_H = 52

interface PaperMeta {
  slug: string
  title: string
  totalPages: number
  pages: Array<{ pageNo: number; numbers: number[] }>
  questionPages: Record<string, number>
}

/** 遍历文本节点,把 $...$ / $$...$$ 渲染成 KaTeX(throwOnError=false,失败原样) */
function renderTexIn(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const targets: Text[] = []
  let node: Node | null
  while ((node = walker.nextNode())) {
    const t = node as Text
    if (t.nodeValue && t.nodeValue.includes('$')) targets.push(t)
  }
  for (const t of targets) {
    const value = t.nodeValue ?? ''
    const re = /\$\$([^$\n]+?)\$\$|\$([^$\n]+?)\$/g
    const frag = document.createDocumentFragment()
    let last = 0
    let m: RegExpExecArray | null
    let changed = false
    while ((m = re.exec(value))) {
      if (m.index > last) frag.appendChild(document.createTextNode(value.slice(last, m.index)))
      const display = !!m[1]
      const span = document.createElement('span')
      span.className = display ? 'pv-tex-block' : 'pv-tex'
      span.innerHTML = katex.renderToString((m[1] ?? m[2]) ?? '', { throwOnError: false, displayMode: display })
      frag.appendChild(span)
      last = m.index + m[0].length
      changed = true
    }
    if (changed) {
      if (last < value.length) frag.appendChild(document.createTextNode(value.slice(last)))
      t.parentNode?.replaceChild(frag, t)
    }
  }
}

function PageSection({
  slug,
  pageNo,
  locatedLabel,
  hideAnswers,
  onLoaded,
}: {
  slug: string
  pageNo: number
  /** ?number=N 命中本页时的定位徽标文案(如「第 33 题」) */
  locatedLabel?: string
  /** 预览默认藏官方答案,顶栏「答案」开关打开后可见(打印始终带答案) */
  hideAnswers?: boolean
  onLoaded: (pageNo: number) => void
}) {
  const { data } = useQuery({
    queryKey: queryKeys.papers.page(slug, pageNo),
    queryFn: ({ signal }) => fetchJson<{ html: string }>(`/api/papers/${slug}/page/${pageNo}`, { signal }),
  })
  const ref = useRef<HTMLDivElement>(null)

  // 关键:__html 对象必须引用稳定。React 19 的 host diff 对 dangerouslySetInnerHTML 只做
  // 对象引用比较(不像旧版先比 __html 字符串),每次渲染新字面量都会触发 setProp →
  // 无条件重写 innerHTML,把 effect 里渲染好的 KaTeX 打回 raw $。钉稳引用后 diff 直接跳过。
  const html = useMemo(() => (data?.html ? { __html: data.html } : null), [data?.html])

  useEffect(() => {
    if (!data?.html || !ref.current) return
    renderTexIn(ref.current)
    onLoaded(pageNo)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.html])

  if (!html) {
    return (
      <div data-page={pageNo} className="relative">
        <div className="h-44 animate-pulse rounded-xl bg-surface-subtle" />
      </div>
    )
  }
  return (
    <div data-page={pageNo} className="relative">
      {/* 徽标放在卷头上方独立一行,不压卷头标题(卷头在纸面居中,右上角必撞) */}
      {locatedLabel && (
        <span className={styles.locateBadge}>
          <span className={styles.locateDot} />
          {locatedLabel}
        </span>
      )}
      {/* 契约片段来自用户自己录入的 PaperPage(服务端已剥 <script>),与聊天渲染同信任级别 */}
      <div ref={ref} className={`${styles.sheet}${hideAnswers ? ` ${styles.noAnswers}` : ''}`} dangerouslySetInnerHTML={html} />
    </div>
  )
}

/**
 * 卷头下的「学校考试成绩」卡(方案D 消费端):历次成绩 + 最近一次考点丢分;空态虚线 CTA 直达录入。
 * 数据走 GET /api/exam-records?slug=(公共库卷也可记成绩);删除收口在学习台全部成绩弹层,这里不删。
 * 「记一次成绩」深链学习台 /study?recordExam=<slug>,记录卡就地展开并预选本卷。
 */
/**
 * 卷详情页「在线做题」入口卡(方案A 挑稿定稿):开始答题 / 继续考试(断点续考) / 最近报告直进。
 * 同卷单场:ongoing 存在时只能继续或放弃(放弃走 ConfirmDialog);交卷后自动进成绩台账。
 */
function ExamEntryCard({ slug }: { slug: string }) {
  const router = useRouter()
  const qc = useQueryClient()
  const [starting, setStarting] = useState(false)
  const [confirmAbandon, setConfirmAbandon] = useState(false)
  const [abandoning, setAbandoning] = useState(false)

  const { data, isPending } = useQuery({
    queryKey: queryKeys.papers.attemptEntry(slug),
    queryFn: ({ signal }) =>
      fetchJson<{
        ongoing: { id: string; startedAt: string; answered: number; durationMin: number } | null
        last: { id: string; submittedAt: string; score: number; fullScore: number } | null
      }>(`/api/papers/${slug}/attempts`, { signal }),
    staleTime: 15_000,
  })

  const startExam = useCallback(async () => {
    setStarting(true)
    try {
      const res = await fetchJson<{ attempt: { id: string } }>(`/api/papers/${slug}/attempts`, { method: 'POST' })
      router.push(`/papers/exam/${res.attempt.id}`)
    } catch {
      toast.error('开考失败，请重试')
      setStarting(false)
    }
  }, [slug, router])

  const abandonExam = useCallback(async () => {
    if (!data?.ongoing) return
    setAbandoning(true)
    try {
      await fetchJson(`/api/papers/attempts/${data.ongoing.id}`, { method: 'DELETE' })
      qc.invalidateQueries({ queryKey: queryKeys.papers.attemptEntry(slug) })
      setConfirmAbandon(false)
    } catch {
      toast.error('放弃失败，请重试')
    } finally {
      setAbandoning(false)
    }
  }, [data?.ongoing, qc, slug])

  if (isPending) return <div className="study-sk h-16 rounded-[14px]" />
  if (!data) return null

  if (data.ongoing) {
    const remainMin = Math.max(
      0,
      data.ongoing.durationMin - Math.floor((Date.now() - Date.parse(data.ongoing.startedAt)) / 60_000)
    )
    return (
      <div className="rounded-[14px] border border-accent/30 bg-accent/5 px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="min-w-0 flex-1">
            <span className="block text-[12.5px] font-semibold text-content-primary">
              进行中的考试 · 已答 {data.ongoing.answered} 题
            </span>
            <span className="mt-0.5 block text-[11px] text-content-muted">
              剩约 {remainMin} 分钟 · 到点自动停笔,进度自动保存
            </span>
          </span>
          <button
            type="button"
            onClick={() => setConfirmAbandon(true)}
            className="flex-none rounded-full border border-line px-3 py-1.5 text-[11.5px] text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary"
          >
            放弃
          </button>
          <button
            type="button"
            onClick={() => router.push(`/papers/exam/${data.ongoing!.id}`)}
            className="flex-none rounded-full bg-accent px-3.5 py-1.5 text-[11.5px] font-semibold text-accent-foreground transition-opacity hover:opacity-90"
          >
            继续考试
          </button>
        </div>
        <ConfirmDialog
          open={confirmAbandon}
          title="放弃这场考试？"
          description="已保存的作答会一并丢弃,不可恢复;之后可以重新开始答题。"
          confirmLabel={abandoning ? '正在放弃…' : '放弃考试'}
          danger
          busy={abandoning}
          onConfirm={() => void abandonExam()}
          onCancel={() => setConfirmAbandon(false)}
        />
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center gap-3 rounded-[14px] border-[1.5px] border-dashed border-line-strong px-4 py-3">
        <span className="min-w-0 flex-1">
          <span className="block text-[12.5px] font-medium text-content-secondary">在线做题 · 全屏开考</span>
          <span className="mt-0.5 block text-[11px] text-content-muted">
            卷面仿真答题,交卷自动判客观分并记入学校考试
          </span>
        </span>
        <button
          type="button"
          onClick={() => void startExam()}
          disabled={starting}
          className="flex-none rounded-full bg-accent px-3.5 py-1.5 text-[11.5px] font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {starting ? '开考中…' : '开始答题'}
        </button>
      </div>
      {data.last && (
        <div className="mt-1.5 flex items-center gap-2 px-1">
          <span className="min-w-0 flex-1 text-[11px] tabular-nums text-content-muted">
            上次估分 {data.last.score}/{data.last.fullScore || '—'} ·{' '}
            {new Date(data.last.submittedAt).toLocaleDateString('sv-SE')}
          </span>
          <button
            type="button"
            onClick={() => router.push(`/papers/exam/${data.last!.id}`)}
            className="flex-none text-[11px] font-medium text-accent hover:underline"
          >
            查看估分报告 ›
          </button>
        </div>
      )}
    </div>
  )
}

function ExamHistoryCard({ slug }: { slug: string }) {
  const router = useRouter()
  const { data, isPending } = useQuery({
    queryKey: queryKeys.examRecords.byPaper(slug),
    queryFn: ({ signal }) =>
      fetchJson<{
        records: Array<{
          id: string
          examName: string
          date: string
          score: number
          fullScore: number
          rank: string | null
          topicLoss?: Array<{ topic: string; count: number; loss: number }>
        }>
      }>(`/api/exam-records?slug=${encodeURIComponent(slug)}`, { signal }),
    staleTime: 30_000,
  })
  const records = data?.records ?? []
  const latestLoss = records[0]?.topicLoss ?? []

  if (isPending) return <div className="study-sk h-16 rounded-[14px]" />

  if (records.length === 0) {
    return (
      <div className="flex items-center gap-3 rounded-[14px] border-[1.5px] border-dashed border-line-strong px-4 py-3">
        <span className="min-w-0 flex-1">
          <span className="block text-[12.5px] font-medium text-content-secondary">还没有学校考试记录</span>
          <span className="mt-0.5 block text-[11px] text-content-muted">考完试回来记一笔,这卷就会出现在学习台趋势里</span>
        </span>
        <button
          type="button"
          onClick={() => router.push(`/study?recordExam=${encodeURIComponent(slug)}`)}
          className="flex-none rounded-full bg-accent px-3.5 py-1.5 text-[11.5px] font-semibold text-accent-foreground transition-opacity hover:opacity-90"
        >
          记一次成绩
        </button>
      </div>
    )
  }

  return (
    <div className="rounded-[14px] border border-line/60 bg-surface px-4 py-3">
      <div className="flex items-baseline">
        <span className="text-[11px] font-semibold text-content-secondary">学校考试成绩 · {records.length} 次</span>
        <button
          type="button"
          onClick={() => router.push(`/study?recordExam=${encodeURIComponent(slug)}`)}
          className="flex-none rounded-full bg-accent px-3.5 py-1.5 text-[11.5px] font-semibold text-accent-foreground transition-opacity hover:opacity-90"
        >
          记一次成绩
        </button>
      </div>
      <div className="mt-1">
        {records.map((r, i) => (
          <div key={r.id} className={`flex items-center gap-3 py-1.5 ${i > 0 ? 'border-t border-line/40' : ''}`}>
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-content-primary">{r.examName}</span>
            <span className="flex-none text-[11px] tabular-nums text-content-muted">
              {r.date}
              {r.rank ? ` · ${r.rank}` : ''}
            </span>
            <span className="flex-none text-[15px] font-bold tabular-nums text-content-primary">
              {r.score}
              <span className="text-[11px] font-normal text-content-muted">/{r.fullScore}</span>
            </span>
          </div>
        ))}
      </div>
      {latestLoss.length > 0 && (
        <div className="mt-1 border-t border-line/40 pt-2">
          <div className="text-[10.5px] text-content-muted">考点丢分 · 来自最近一次勾错</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {latestLoss.map((t) => (
              <span
                key={t.topic}
                className="rounded-full bg-danger/10 px-2 py-0.5 text-[10.5px] font-semibold tabular-nums text-danger"
              >
                {t.topic} <span className="font-normal opacity-80">×{t.count} · −{t.loss}分</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function ViewerContent() {
  const { slug } = useParams<{ slug: string }>()
  const searchParams = useSearchParams()
  const router = useRouter()
  const questionParam = searchParams.get('number')

  const { data: meta, isError } = useQuery({
    queryKey: queryKeys.papers.meta(slug),
    queryFn: ({ signal }) => fetchJson<PaperMeta>(`/api/papers/${slug}`, { signal }),
  })

  const totalPages = meta?.totalPages ?? 0
  const containerRef = useRef<HTMLDivElement>(null)
  const topsRef = useRef<number[]>([])
  const pendingRaf = useRef(0)
  const [current, setCurrent] = useState(1)
  const [jumpOpen, setJumpOpen] = useState(false)
  const [jumpInput, setJumpInput] = useState('')
  // 预览默认藏官方答案:先看答案再开考会把「在线做题」变成对答案
  const [showAnswers, setShowAnswers] = useState(false)
  const [loaded, setLoaded] = useState<number[]>([])

  const locatePage = useMemo(() => {
    if (!questionParam || !meta) return null
    const p = meta.questionPages[questionParam]
    return typeof p === 'number' ? p : null
  }, [meta, questionParam])

  const onLoaded = useCallback((pageNo: number) => {
    setLoaded((prev) => (prev.includes(pageNo) ? prev : [...prev, pageNo]))
  }, [])

  const measureTops = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    const els = container.querySelectorAll<HTMLElement>('[data-page]')
    const tops: number[] = []
    els.forEach((el) => tops.push(el.offsetTop))
    topsRef.current = tops
  }, [])

  // 全部页加载完(含 KaTeX 重排后)再测量+定位,避免页高变化把定位顶偏
  const allLoaded = !!meta && loaded.length >= totalPages
  // 用户主动滚动过就不再纠正落点(滚动锚定会把 scrollTop 改掉,不能拿 scrollTop 判断「用户动过」)
  const userScrolledRef = useRef(false)
  useEffect(() => {
    const mark = () => {
      userScrolledRef.current = true
    }
    const passive = { passive: true } as AddEventListenerOptions
    window.addEventListener('wheel', mark, passive)
    window.addEventListener('touchstart', mark, passive)
    window.addEventListener('keydown', mark)
    return () => {
      window.removeEventListener('wheel', mark)
      window.removeEventListener('touchstart', mark)
      window.removeEventListener('keydown', mark)
    }
  }, [])
  useEffect(() => {
    if (!allLoaded) return
    let cancelled = false
    const apply = () => {
      if (cancelled || locatePage == null) return
      const container = containerRef.current
      if (!container) return
      measureTops()
      const top = topsRef.current[locatePage - 1]
      if (top == null) return
      // 减 8 而不是加 8:section 顶部是「第 N 题」徽标(19px + 6px 间距)而不是卷面,
      // 只有 section 顶落在顶栏下沿再让 8px,徽标才不会被半透明顶栏吃掉上半截。
      container.scrollTop = top - TOPBAR_H - 8
      // 落点写死页码:加载期滚动恢复/回流会抛出乱序 scroll 事件(实测停在第 4 页而顶栏读 6/6),
      // 这里与 jumpTo 一样显式对齐,避免指示器与真实落点不一致。
      setCurrent(locatePage)
    }
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        apply()
        // KaTeX 的 woff2 字体异步到位后公式高度会变(实测把落点顶偏 ~150px),
        // 字体就绪后再量一次把落点对齐;用户已经自己滚开则让路。
        document.fonts?.ready
          .then(() => requestAnimationFrame(() => !userScrolledRef.current && apply()))
          .catch(() => {})
      })
    )
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allLoaded])

  // 滚动 → 当前页(顶栏指示)
  const onScroll = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    if (pendingRaf.current) return
    pendingRaf.current = requestAnimationFrame(() => {
      pendingRaf.current = 0
      // 每次滚动重测:图片/字体回流会让 offsetTop 变化,只靠首次缓存会读错页(顶栏出现 6/6)
      measureTops()
      const tops = topsRef.current
      if (!tops.length) return
      const y = container.scrollTop + TOPBAR_H + 8
      let page = 1
      for (let i = 0; i < tops.length; i++) {
        if (tops[i] <= y) page = i + 1
        else break
      }
      setCurrent(page)
    })
  }, [measureTops])

  const jumpTo = useCallback(
    (page: number) => {
      const container = containerRef.current
      const target = Math.min(Math.max(Math.trunc(page), 1), totalPages)
      if (!container) return
      const top = topsRef.current[target - 1]
      if (top != null) {
        container.scrollTo({ top: top - TOPBAR_H - 8, behavior: 'smooth' })
        setCurrent(target)
      }
      setJumpOpen(false)
    },
    [totalPages]
  )

  // 新标签页直开(无历史)时回学习台兜底
  const handleBack = useCallback(() => {
    if (window.history.length > 1) router.back()
    else router.push('/study')
  }, [router])

  if (isError || (meta && totalPages === 0)) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-sm text-content-muted">
        {isError ? '卷子不存在或无权访问' : '该卷还没有录入页面'}
      </div>
    )
  }

  return (
    <div className="relative h-full bg-surface-subtle/40">
      {/* 顶栏:返回 / 卷名 / 页码(点击跳页)。手机端自管安全区。
          z-10 与 kb 阅读器同档:手机端全局悬浮圆钮是 z-30,若这里也写 z-30,后来的 DOM
          会把 ☰/⚙ 压在半透明顶栏底下(既发灰又点不到)。 */}
      <div className="absolute inset-x-0 top-0 z-10 flex min-h-[52px] items-center gap-1 border-b border-line/60 bg-surface/95 px-1.5 backdrop-blur-md max-md:pt-[var(--sat)] md:gap-2 md:px-4">
        <button
          type="button"
          onClick={handleBack}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-content-secondary transition-colors hover:bg-surface-subtle hover:text-content-primary"
          aria-label="返回"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div
          className="line-clamp-2 min-w-0 flex-1 py-1 text-[13px] font-medium leading-tight text-content-primary md:text-sm md:leading-snug"
          title={meta?.title}
        >
          {meta?.title ?? '试卷预览'}
        </div>
        <button
          type="button"
          onClick={() => setShowAnswers((v) => !v)}
          className="shrink-0 rounded-lg px-2 py-1.5 text-xs text-content-secondary transition-colors hover:bg-surface-subtle hover:text-content-primary"
          aria-label={showAnswers ? '隐藏官方答案' : '显示官方答案'}
          aria-pressed={showAnswers}
          title={showAnswers ? '隐藏官方答案' : '显示官方答案（默认隐藏，开考前先不看）'}
        >
          {showAnswers ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
        <button
          type="button"
          onClick={() => {
            setJumpInput(String(current))
            setJumpOpen((v) => !v)
          }}
          className="shrink-0 rounded-lg px-2 py-1.5 text-xs tabular-nums text-content-secondary transition-colors hover:bg-surface-subtle hover:text-content-primary"
          aria-label="跳转到指定页"
          aria-expanded={jumpOpen}
        >
          {current} / {totalPages}
        </button>
      </div>

      {/* 跳页面板 */}
      {jumpOpen && (
        <div className="absolute right-2 top-[calc(52px+var(--sat)+6px)] z-40 flex items-center gap-2 rounded-xl border border-line/70 bg-surface p-2 shadow-lg md:right-4 md:top-[58px]">
          <input
            autoFocus
            type="number"
            min={1}
            max={totalPages}
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

      {/* 卷页滚动流 */}
      <div
        ref={containerRef}
        onScroll={onScroll}
        className={`h-full overflow-y-auto pt-[calc(52px+var(--sat))] ${styles.scroller}`}
        style={{ scrollBehavior: 'auto' }}
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-2 pt-3 pb-[max(64px,var(--sab))] md:px-4 md:pb-16">
          {/* 在线做题入口卡(进行中=继续考试;否则虚线 CTA 开考;下挂最近报告) */}
          <ExamEntryCard slug={slug} />
          {/* 学校考试成绩卡(空态=虚线 CTA;有记录=历次成绩+考点丢分) */}
          <ExamHistoryCard slug={slug} />
          {(meta?.pages ?? []).map((p) => (
            <PageSection
              key={p.pageNo}
              slug={slug}
              pageNo={p.pageNo}
              locatedLabel={locatePage === p.pageNo && questionParam ? `第 ${questionParam} 题` : undefined}
              hideAnswers={!showAnswers}
              onLoaded={onLoaded}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

export default function PaperViewerPage() {
  return (
    <AuthErrorBoundary>
      <ClientOnly>
        <Suspense fallback={<div className="h-full" />}>
          <ViewerContent />
        </Suspense>
      </ClientOnly>
    </AuthErrorBoundary>
  )
}
