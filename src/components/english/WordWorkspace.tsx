'use client'

/**
 * 英语背词工作台（方案 A「居中沉浸」+ 学新流程 A+Alan 案）：
 *   顶部两段进度（复习 / 学新）→ 复习段(快认卡四档 / 拼写卡) → 学新段(讲义卡) → 小测段(拼写)。
 *   队列由 GET /api/words/queue 现取（首次访问会按计划推进新词），评一张立刻回写，
 *   断网/刷新都不丢进度（进度在 UserWord 里，不在浏览器里）。
 *
 * 2026-11-15 学新流程改版（design/preview-word-learn-flow.html 用户挑 A+Alan 细节 + 先复习后学新）：
 *   - 新词不再自测：讲义卡（LearnCard，讲解直接展开）逐词「记住了」→ 全部学完统一拼写小测；
 *     首试结果接 FSRS；点发音 = 用提示，拼对也按「忘记」结算；首错回讲解重学，再拼只算练习。
 *   - 四档评级（忘记/模糊/认识/秒答）只属于复习词。
 *   - 队列分组顺序在 plan.ts：复习在前、新词在后。
 *
 * 2026-11-17 复习段改循环队列（对齐不背单词）：忘记/模糊（或拼写没过）的词不移出队列，
 *   而是移到队尾轮转重现——队列里剩几个不会的就按序轮着出，答对才出队，清空才算复习完；
 *   重现只算当场巩固，不再提交 FSRS（首答已记账，跨天间隔仍由 FSRS 排）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { ChevronLeft, Headphones } from 'lucide-react'
import { fetchJson } from '@/lib/query/fetcher'
import { chickPlay } from '@/lib/chick/reactions'
import { cn } from '@/lib/utils'
import { meaningText, type WordQueue, type WordQueueItem } from '@/lib/words/types'
import { shortTrans } from '@/lib/words/gap'
import { FlipCard } from './FlipCard'
import { SpellCard } from './SpellCard'
import { LearnCard } from './LearnCard'
import { PassageDialog } from './PassageDialog'
import { DialogueDialog } from './DialogueDialog'
import { ListenMode } from './ListenMode'

const RATINGS = [
  { value: 1 as const, label: '忘记', hint: '1' },
  { value: 2 as const, label: '模糊', hint: '2' },
  { value: 3 as const, label: '认识', hint: '3' },
  { value: 4 as const, label: '秒答', hint: '4' },
]

/** 三段式会话状态：复习段 → 学新段（讲义）→ 小测段（拼写）。refetch 换 data 引用即整体重置 */
interface Flow {
  phase: 'review' | 'learn' | 'quiz'
  /** 复习段：剩余循环队列（队首 = 当前卡）；repeat = 本轮已错过、正在循环重现（答对出队不再记账） */
  rq: Array<{ id: string; repeat: boolean }>
  /** 复习段轮转计数：同一词紧邻重现时靠它变 key 强制重挂载，清掉卡内输入/反馈状态 */
  rot: number
  l: number
  q: number
  /** 小测段：该词首错后正在回讲解重学（重学通过只算练习） */
  relearn: boolean
  /** 小测段：重学完成后进入练习态拼写（拼对收尾,不再提交排期） */
  practice: boolean
}

export function WordWorkspace() {
  const router = useRouter()
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['words', 'queue'],
    queryFn: () => fetchJson<WordQueue>('/api/words/queue'),
    // 队列带副作用（推进计划），每次进页面都重新取，不吃缓存
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    retry: 0,
  })

  const items = data?.items ?? []
  const reviewItems = useMemo(() => items.filter((i) => !i.isNew), [items])
  const newItems = useMemo(() => items.filter((i) => i.isNew), [items])

  const [flow, setFlow] = useState<Flow | null>(null)
  const [flipped, setFlipped] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [finished, setFinished] = useState(false)
  const [stats, setStats] = useState({ remembered: 0, again: 0 })
  const [err, setErr] = useState<string | null>(null)
  const [passageOpen, setPassageOpen] = useState(false)
  const [dialogueOpen, setDialogueOpen] = useState(false)
  const [listenOpen, setListenOpen] = useState(false)

  /** 默写提示用 headword→中文释义首段（短文默写提示第二级；掺词不在 items 里则无中文档） */
  const transMap = useMemo(() => {
    const m: Record<string, string> = {}
    for (const i of items) if (i.headword && !m[i.headword]) m[i.headword] = shortTrans(meaningText(i.trans, i.pos))
    return m
  }, [items])

  // 队列到位后初始化/重置三段游标
  useEffect(() => {
    if (!data) {
      setFlow(null)
      return
    }
    setFlow({
      phase: reviewItems.length ? 'review' : 'learn',
      rq: reviewItems.map((i) => ({ id: i.id, repeat: false })),
      rot: 0,
      l: 0,
      q: 0,
      relearn: false,
      practice: false,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  const cur: WordQueueItem | null = !flow || finished
    ? null
    : flow.phase === 'review'
      ? reviewItems.find((i) => i.id === flow.rq[0]?.id) ?? null
      : flow.phase === 'learn'
        ? newItems[flow.l] ?? null
        : newItems[flow.q] ?? null

  const post = useCallback(async (body: Record<string, unknown>) => {
    setSubmitting(true)
    setErr(null)
    try {
      const res = await fetch('/api/words/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(e.error || `HTTP ${res.status}`)
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : '提交失败')
      throw e
    } finally {
      setSubmitting(false)
    }
  }, [])

  /* ── 复习段：快认卡四档 / 拼写卡 ── */
  /** 复习段结算（循环队列）：cleared=答对出队；否则移到队尾、标记重现。队列清空则进学新段或收尾 */
  const settleReview = useCallback(
    (cleared: boolean) => {
      if (!flow || flow.phase !== 'review') return
      const [head, ...rest] = flow.rq
      if (!head) return
      const rq = cleared ? rest : [...rest, { id: head.id, repeat: true }]
      if (rq.length) {
        setFlow({ ...flow, rq, rot: flow.rot + 1 })
        return
      }
      if (newItems.length) setFlow({ phase: 'learn', rq: [], rot: flow.rot + 1, l: 0, q: 0, relearn: false, practice: false })
      else {
        setFinished(true)
        chickPlay('wordReview') // 小鸡:这轮复习完
      }
    },
    [flow, newItems.length],
  )

  const rate = useCallback(
    async (rating: 1 | 2 | 3 | 4) => {
      if (!cur || !flow || submitting || flow.phase !== 'review') return
      const head = flow.rq[0]
      if (!head) return
      try {
        // 重现只算当场巩固：首答已给 FSRS 记账，不再重复提交
        if (!head.repeat) {
          await post({ userWordId: cur.id, card: 'flip', rating })
          setStats((s) => ({
            remembered: s.remembered + (rating >= 3 ? 1 : 0),
            again: s.again + (rating < 3 ? 1 : 0),
          }))
        }
        setFlipped(false)
        settleReview(rating >= 3)
      } catch {
        /* err 已在 post 里 */
      }
    },
    [cur, flow, post, settleReview, submitting],
  )

  const rateSpell = useCallback(
    async (firstTry: boolean, elapsedMs: number, hintUsed: boolean) => {
      if (!cur || !flow || submitting || flow.phase !== 'review') return
      const head = flow.rq[0]
      if (!head) return
      const cleared = firstTry && !hintUsed
      try {
        if (!head.repeat) {
          await post({ userWordId: cur.id, card: 'spell', correct: firstTry, elapsedMs, hint: hintUsed })
          setStats((s) => ({
            remembered: s.remembered + (cleared ? 1 : 0),
            again: s.again + (cleared ? 0 : 1),
          }))
        }
        settleReview(cleared)
      } catch {
        /* err 已在 post 里 */
      }
    },
    [cur, flow, post, settleReview, submitting],
  )

  /* ── 学新段：讲义卡 ── */
  const learnMastered = useCallback(() => {
    if (!flow || flow.phase !== 'learn') return
    const l = flow.l + 1
    if (l >= newItems.length) {
      setFlow({ ...flow, phase: 'quiz', l, q: 0, relearn: false, practice: false })
      chickPlay('wordNew') // 小鸡:新词讲完,准备小测
    } else setFlow({ ...flow, l })
  }, [flow, newItems.length])

  /* ── 小测段：拼写（首试接 FSRS；提示=忘记；首错回讲解重学，再拼只算练习） ── */
  const nextQuiz = useCallback(
    (f: Flow) => {
      const q = f.q + 1
      if (q >= newItems.length) {
        setFinished(true)
        chickPlay('wordReview') // 小鸡:这轮复习完(纯学新轮也在这收尾报一次)
      } else setFlow({ ...f, q, relearn: false, practice: false })
    },
    [newItems.length],
  )

  const onQuizResult = useCallback(
    async (firstTry: boolean, elapsedMs: number, hintUsed: boolean) => {
      if (!cur || !flow || submitting || flow.phase !== 'quiz') return
      try {
        await post({ userWordId: cur.id, card: 'spell', correct: firstTry, elapsedMs, hint: hintUsed })
        setStats((s) => ({
          remembered: s.remembered + (firstTry && !hintUsed ? 1 : 0),
          again: s.again + (firstTry && !hintUsed ? 0 : 1),
        }))
        nextQuiz(flow)
      } catch {
        /* err 已在 post 里 */
      }
    },
    [cur, flow, nextQuiz, post, submitting],
  )

  const onQuizFirstFail = useCallback(async () => {
    if (!cur || !flow || submitting || flow.phase !== 'quiz') return
    try {
      await post({ userWordId: cur.id, card: 'spell', correct: false })
      setStats((s) => ({ ...s, again: s.again + 1 }))
      setFlow({ ...flow, relearn: true, practice: false })
    } catch {
      /* err 已在 post 里 */
    }
  }, [cur, flow, post, submitting])

  const onQuizPractice = useCallback(() => {
    if (!flow) return
    nextQuiz(flow)
  }, [flow, nextQuiz])

  /* 短语小测：短语不考拼写，翻面自检 → 想起来了 / 没想起 两档（3/1） */
  const ratePhrase = useCallback(
    async (rating: 1 | 3) => {
      if (!cur || !flow || submitting || flow.phase !== 'quiz') return
      try {
        await post({ userWordId: cur.id, card: 'flip', rating })
        setStats((s) => ({
          remembered: s.remembered + (rating >= 3 ? 1 : 0),
          again: s.again + (rating < 3 ? 1 : 0),
        }))
        nextQuiz(flow)
      } catch {
        /* err 已在 post 里 */
      }
    },
    [cur, flow, nextQuiz, post, submitting],
  )

  /** 键盘：复习段空格翻面、1-4 评级；学新段回车「记住了」；Esc 退出 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (listenOpen) return // 听音模式接管键盘（Esc=退出听音，空格/方向键=播放控制）
      if (e.key === 'Escape') {
        router.push('/study')
        return
      }
      if (!cur || finished || submitting || !flow) return
      if (flow.phase === 'review') {
        if (e.key === ' ' || e.code === 'Space') {
          if (cur.card === 'flip') {
            e.preventDefault()
            setFlipped((f) => !f)
          }
          return
        }
        if (cur.card === 'flip' && flipped) {
          const r = Number(e.key)
          if (r >= 1 && r <= 4) {
            e.preventDefault()
            void rate(r as 1 | 2 | 3 | 4)
          }
        }
        return
      }
      if (flow.phase === 'learn' && e.key === 'Enter') {
        e.preventDefault()
        learnMastered()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cur, finished, flipped, flow, learnMastered, listenOpen, rate, router, submitting])

  /* ── 两段进度 ── */
  const rTotal = reviewItems.length
  const nTotal = newItems.length
  // 复习段进度 = 已攻克出队数（错词会循环重现，扫过 ≠ 完成）
  const rDone = flow ? (flow.phase === 'review' ? rTotal - flow.rq.length : rTotal) : 0
  const nDone = flow ? (flow.phase === 'learn' ? flow.l : flow.phase === 'quiz' ? flow.q : 0) : 0
  const total = items.length
  const done = rDone + nDone

  /* ── 状态：加载 / 出错 / 空队列 ── */
  if (isPending || (!error && total > 0 && !flow)) {
    return (
      <div className="h-full min-h-0 overflow-y-auto">
        <div className="mx-auto flex h-full max-w-[640px] flex-col px-5 py-6">
          <div className="h-6 w-40 animate-pulse rounded bg-surface-subtle" />
          <div className="mt-10 h-[352px] w-full animate-pulse rounded-sheet bg-surface-muted" />
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="h-full min-h-0 overflow-y-auto">
        <div className="mx-auto max-w-[560px] px-6 py-16 text-center">
          <div className="text-[15px] font-semibold">队列没取到</div>
          <div className="mt-1 text-[13px] text-content-secondary">
            {error instanceof Error ? error.message : '网络或登录状态异常'}
          </div>
          <button
            type="button"
            onClick={() => void refetch()}
            className="mt-5 rounded-full bg-accent px-5 py-2 text-[13px] font-semibold text-accent-foreground"
          >
            重试
          </button>
        </div>
      </div>
    )
  }

  if (!total || finished) {
    const doneCount = stats.remembered + stats.again
    return (
      <div className="h-full min-h-0 overflow-y-auto">
        <div className="mx-auto max-w-[560px] px-6 py-14 text-center">
          <div className="text-[56px] font-bold leading-none tracking-[-0.03em] tabular-nums">{doneCount}</div>
          <div className="mt-2 text-[13px] text-content-secondary">
            {doneCount > 0 ? '今天过了这么多词' : '今天没有要背的词'}
          </div>
          {doneCount > 0 && (
            <div className="mt-7 flex justify-center gap-9">
              <div className="text-[12.5px] text-content-muted">
                <b className="block text-[20px] font-semibold tabular-nums text-content-primary">{stats.remembered}</b>
                记住了
              </div>
              <div className="text-[12.5px] text-content-muted">
                <b className="block text-[20px] font-semibold tabular-nums text-content-primary">{stats.again}</b>
                要重来
              </div>
            </div>
          )}
          {doneCount === 0 && (
            <div className="mx-auto mt-6 max-w-[420px] text-[12.5px] leading-relaxed text-content-muted">
              字典里还没有词单，或者今日配额已用完。先在终端导入词单：
              <code className="mt-2 block rounded-card bg-surface-muted px-3 py-2 text-left text-[11.5px] text-content-secondary">
                npm run words:import -- &quot;文件&quot; --book &quot;我的计划&quot;
              </code>
            </div>
          )}
          <div className="mt-9 flex flex-wrap justify-center gap-2.5">
            {total > 0 && (
              <button
                type="button"
                onClick={() => setListenOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-full border border-accent/50 bg-accent-soft px-5 py-2.5 text-[13px] font-semibold text-accent"
              >
                <Headphones size={14} />
                闭上眼听一遍
              </button>
            )}
            <button
              type="button"
              onClick={() => setPassageOpen(true)}
              className="rounded-full border border-accent/50 bg-accent-soft px-5 py-2.5 text-[13px] font-semibold text-accent"
            >
              读一篇今天的小短文
            </button>
            <button
              type="button"
              onClick={() => setDialogueOpen(true)}
              className="rounded-full border border-accent/50 bg-accent-soft px-5 py-2.5 text-[13px] font-semibold text-accent"
            >
              来一段今日对话
            </button>
            <button
              type="button"
              onClick={() => router.push('/study')}
              className="rounded-full border border-line bg-surface px-5 py-2.5 text-[13px] font-semibold text-content-primary"
            >
              返回学习台
            </button>
            <button
              type="button"
              onClick={() => {
                setFinished(false)
                setStats({ remembered: 0, again: 0 })
                setFlipped(false)
                setFlow({
                  phase: reviewItems.length ? 'review' : 'learn',
                  rq: reviewItems.map((i) => ({ id: i.id, repeat: false })),
                  rot: 0,
                  l: 0,
                  q: 0,
                  relearn: false,
                  practice: false,
                })
                void refetch()
              }}
              className="rounded-full bg-accent px-5 py-2.5 text-[13px] font-semibold text-accent-foreground"
            >
              再来一轮
            </button>
          </div>
        </div>
        <PassageDialog open={passageOpen} words={items.map((i) => i.headword)} transMap={transMap} onClose={() => setPassageOpen(false)} />
        <DialogueDialog open={dialogueOpen} words={items.map((i) => i.headword)} onClose={() => setDialogueOpen(false)} />
        {listenOpen && total > 0 && (
          <ListenMode items={items} listName={data?.summary.listName ?? null} onClose={() => setListenOpen(false)} />
        )}
      </div>
    )
  }

  // 走到这里 total>0 且未结束,顶部 !flow 分支已拦掉空窗帧
  if (!flow) return null

  const spellBadge = flow.phase === 'quiz' ? '新词' : cur && cur.reps < 3 ? '学习中' : '复习'

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto flex min-h-full max-w-[640px] flex-col px-4 pb-8 pt-16 md:px-6 md:pt-6">
        {/* 顶栏：双行分层 —— 上行 退出/词书名/操作组，下行单条分段进度 + 图例 */}
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3">
          <button
            type="button"
            onClick={() => router.push('/study')}
            aria-label="退出"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary"
          >
            <ChevronLeft size={16} />
          </button>
          <div className="min-w-0">
            <div className="truncate text-[14px] font-semibold leading-tight text-content-primary">
              {data?.summary.listName || '我的词'}
            </div>
            <div className="mt-0.5 truncate text-[12px] leading-snug text-content-muted">
              每日 {data?.summary.dailyNew} 新 · 先复习后学新
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => setPassageOpen(true)}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-accent/50 bg-accent-soft px-3 text-[12px] font-semibold text-accent transition-colors hover:border-accent"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
              </svg>
              AI 短文
            </button>
            <button
              type="button"
              onClick={() => setListenOpen(true)}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-accent/50 bg-accent-soft px-3 text-[12px] font-semibold text-accent transition-colors hover:border-accent"
            >
              <Headphones size={13} />
              听音
            </button>
            <button
              type="button"
              onClick={() => router.push('/papers/words')}
              aria-label="打印背诵单"
              title="打印背诵单（一天 15 个词）"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line bg-surface text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 9V2h12v7" />
                <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                <path d="M6 14h12v8H6z" />
              </svg>
            </button>
          </div>
          <div className="col-span-full">
            <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-surface-subtle">
              <div
                className="h-full rounded-full bg-content-secondary/60 transition-[width]"
                style={{ width: `${total ? Math.round((rDone / total) * 100) : 0}%`, transitionDuration: 'var(--motion-base)' }}
              />
              <div
                className="h-full rounded-full bg-accent transition-[width]"
                style={{ width: `${total ? Math.round((nDone / total) * 100) : 0}%`, transitionDuration: 'var(--motion-base)' }}
              />
            </div>
            <div className="mt-1.5 flex items-center gap-3.5 text-[11px] tabular-nums text-content-muted">
              {rTotal > 0 && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-[7px] w-[7px] shrink-0 rounded-[2px] bg-content-secondary/60" />
                  复习 {rDone} / {rTotal}
                </span>
              )}
              {nTotal > 0 && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-[7px] w-[7px] shrink-0 rounded-[2px] bg-accent" />
                  {flow.phase === 'quiz' ? '小测' : '学新'} {nDone} / {nTotal}
                </span>
              )}
              <span className="ml-auto font-semibold text-content-secondary">
                {Math.min(done, total)} / {total}
              </span>
            </div>
          </div>
        </div>

        {/* 卡面 + 操作区：整体居中成一组，卡与按钮不拆散 */}
        <div className="flex flex-1 flex-col items-center justify-center gap-6 py-6 md:gap-7 md:py-8">
          {flow.phase === 'review' && cur && (
            cur.card === 'flip' ? (
              <>
                <FlipCard key={`${cur.id}-${flow.rot}`} item={cur} flipped={flipped} onFlip={() => setFlipped((f) => !f)} />
                {/* 卡下操作：翻面靠点卡片/空格（卡面已有提示），翻面后才是四档；
                    翻面前用同高隐形占位顶住，避免卡片上下塌移 */}
                {flipped ? (
                  <div className="w-full max-w-[560px]">
                    <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                      {RATINGS.map((r) => (
                        <button
                          key={r.value}
                          type="button"
                          disabled={submitting}
                          onClick={() => void rate(r.value)}
                          className={cn(
                            'flex h-12 flex-col items-center justify-center rounded-control border border-line bg-surface text-[13px] font-semibold transition-colors hover:border-line-strong hover:bg-surface-muted disabled:opacity-50',
                            r.value === 1 && 'hover:border-danger hover:text-danger',
                            r.value === 4 && 'hover:border-accent hover:text-accent',
                          )}
                        >
                          {r.label}
                          <span className="text-[10.5px] font-normal text-content-muted">{r.hint}</span>
                        </button>
                      ))}
                    </div>
                    <div className="mt-3 text-center text-[11.5px] text-content-muted">
                      按 1-4 快速评级 · 忘记/模糊的词稍后重现，直到全部记住 · Esc 退出
                    </div>
                  </div>
                ) : (
                  <div className="w-full max-w-[560px]" aria-hidden="true">
                    <div className="h-12" />
                    <div className="mt-3 text-center text-[11.5px]">{'\u00A0'}</div>
                  </div>
                )}
              </>
            ) : (
              <SpellCard key={`${cur.id}-${flow.rot}`} item={cur} badgeLabel={spellBadge} onResult={(ok, ms, hint) => void rateSpell(ok, ms, hint)} />
            )
          )}

          {flow.phase === 'learn' && cur && (
            <LearnCard key={cur.id} item={cur} onMastered={learnMastered} onAgain={() => {}} />
          )}

          {flow.phase === 'quiz' && cur && (
            cur.isPhrase ? (
              /* 短语小测：短语不考拼写（空格/连写各家不一，默写只会制造假错），翻面自检两档 */
              <div className="w-full max-w-[560px]">
                <div className="relative flex min-h-[240px] flex-col items-center justify-center rounded-sheet border border-line bg-surface px-6 text-center dark:border-line-strong dark:bg-surface-subtle">
                  <span className="absolute left-4 top-3 rounded-full bg-accent-soft px-2.5 py-[3px] text-[11px] font-medium text-accent">新词 · 短语</span>
                  <div className="text-[28px] font-bold leading-snug tracking-[-0.01em]">{cur.headword}</div>
                  {cur.phoneticUs && <div className="mt-1 text-[13px] text-content-secondary">{cur.phoneticUs}</div>}
                  <div className="mt-3 text-[11.5px] text-content-muted">心里过一遍意思，再点答案</div>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => void ratePhrase(3)}
                    className="h-12 rounded-control border border-accent/50 bg-accent-soft text-[13px] font-semibold text-accent transition-colors hover:border-accent disabled:opacity-50"
                  >
                    想起来了
                  </button>
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => void ratePhrase(1)}
                    className="h-12 rounded-control border border-line bg-surface text-[13px] font-semibold text-content-secondary transition-colors hover:border-danger hover:text-danger disabled:opacity-50"
                  >
                    没想起
                  </button>
                </div>
                <div className="mt-3 text-center text-[11.5px] text-content-muted">短语只考认读，不考拼写 · 翻面看讲解在复习轮还有</div>
              </div>
            ) : flow.relearn ? (
              <div className="w-full">
                <LearnCard
                  key={`relearn-${cur.id}`}
                  item={cur}
                  onMastered={() => setFlow((f) => f && { ...f, relearn: false, practice: true })}
                  onAgain={() => {}}
                />
                <div className="mt-2 text-center text-[11.5px] text-content-muted">
                  首次没拼出来已按「忘记」记账——重学后下面这遍只算练习，不再计排期。
                </div>
              </div>
            ) : flow.practice ? (
              <SpellCard
                key={`practice-${cur.id}`}
                item={cur}
                badgeLabel="新词 · 重学"
                practice
                onResult={() => {}}
                onPractice={onQuizPractice}
              />
            ) : (
              <SpellCard
                key={cur.id}
                item={cur}
                badgeLabel="新词"
                onResult={(ok, ms, hint) => void onQuizResult(ok, ms, hint)}
                onFirstFail={() => void onQuizFirstFail()}
              />
            )
          )}

          {flow.phase === 'quiz' && cur && !cur.isPhrase && !flow.relearn && (
            <div className="text-center text-[11.5px] text-content-muted">看中文拼英文——第一次独立想起来的结果才算数</div>
          )}
        </div>

        {err && (
          <div className="mx-auto w-full max-w-[560px] rounded-control border border-danger/50 bg-[rgb(var(--danger)/0.08)] px-3 py-2 text-[12.5px] text-danger">
            {err}
          </div>
        )}
      </div>

      <PassageDialog open={passageOpen} words={items.map((i) => i.headword)} transMap={transMap} onClose={() => setPassageOpen(false)} />
      <DialogueDialog open={dialogueOpen} words={items.map((i) => i.headword)} onClose={() => setDialogueOpen(false)} />
      {listenOpen && (
        <ListenMode items={items} listName={data?.summary.listName ?? null} onClose={() => setListenOpen(false)} />
      )}
    </div>
  )
}
