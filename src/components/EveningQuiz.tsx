'use client'

/**
 * 今晚测验（监管之夜）——打印监察 → 定时触发 → 监管锁定 + 弹卡测验 → 测完即放。
 *
 * 方案 A（盾徽卡片）定稿于 design/preview-evening-quiz.html；2026-11-16 拍板口径：
 * - 工作日 22:00 定时触发（localStorage eveningQuiz:time = "HH:mm" 可调，默认 22:00）；
 *   App 没开则打开即补触发（等价「22:00~睡前首次打开即触发」）。
 * - 仅桌面：视口 ≥768px 且（桌面浏览器或 Tauri）；手机端暂不接入。
 * - Tauri 下弹卡即启动 30 分钟兜底锁定（focus_lock_start，已锁定则复用）；
 *   测完即放复用 focus_lock_stop —— 零 Rust 改动。
 * - 浏览器（无锁）可「今日跳过」；Tauri 锁内无跳过，测完或兜底到点放行。
 * - 测验 = 组卷原题重测（choice 自动判分、answer 展示答案自判），
 *   答错的选择真题当场经 variants API 追加 1 道同型变式（举一反三）。
 * - 验收入口：任意页 URL 加 ?eveningQuiz=demo 绕过时间闸（仍需当日有打印记录）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import katex from 'katex'
import { Check, Eye, Loader2, Shield, ShieldCheck, X } from 'lucide-react'
import { FlTransition } from '@/components/FocusLock'
import { fetchJson } from '@/lib/query/fetcher'
import { isModelAvailable, providerKeysStatusQuery, providersModelsQuery } from '@/lib/query/providers'
import { parseObjectiveAnswer } from '@/lib/papers/answer-parse'
import { toast } from '@/lib/toast'
import { tauri, useIsTauri } from '@/lib/tauri'

/** 开场黑场过场时长（与 FocusLock INTRO_MS 同拍） */
const INTRO_MS = 2900
/** 兜底锁定分钟数：测完即放，最坏情况到点放行 */
const FALLBACK_MIN = 30

interface QueuePaper {
  id: string
  title: string
  subject: string
  printCount: number
  lastPrintAt: string
  origCount: number
}

interface QItem {
  key: string
  kind: 'choice' | 'answer' | 'variant'
  /** 变式出题种子（仅真题槽）；内联槽为 null */
  paperQuestionId: string | null
  stem: string
  options: string[]
  multiple: boolean
  /** 标准答案字母串（choice，经 answer-parse 口径解析）或原文（answer 自判展示） */
  answer: string | null
  answerText: string | null
}

const SUBJECT_LABELS: Record<string, string> = {
  math: '数学', chinese: '语文', english: '英语', physics: '物理', chemistry: '化学',
  biology: '生物', history: '历史', geography: '地理', politics: '政治', other: '综合',
}

/** 本地日界零点毫秒（队列判定口径：客户端本地「今天」） */
function localMidnight(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
function localDateStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}
/** 工作日 + 到达设定时刻（默认 22:00，localStorage 可调） */
function timeGateOk(): boolean {
  const day = new Date().getDay()
  if (day === 0 || day === 6) return false
  let hh = 22
  let mm = 0
  try {
    const conf = localStorage.getItem('eveningQuiz:time')
    if (conf) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(conf)
      if (m) {
        hh = Math.min(23, Math.max(0, Number(m[1])))
        mm = Math.min(59, Math.max(0, Number(m[2])))
      }
    }
  } catch {
    // ignore
  }
  const now = new Date()
  return now.getHours() * 60 + now.getMinutes() >= hh * 60 + mm
}
function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function lsSet(key: string, val: string) {
  try {
    localStorage.setItem(key, val)
  } catch {
    // ignore
  }
}

/** 题干/选项里的 $...$ 渲染成 KaTeX（与组卷页 renderTexIn 同一套实现） */
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
      const tex = m[1] ?? m[2] ?? ''
      let html = ''
      try {
        html = katex.renderToString(tex, { throwOnError: false, displayMode: !!m[1] })
      } catch {
        continue
      }
      if (m.index > last) frag.appendChild(document.createTextNode(value.slice(last, m.index)))
      const span = document.createElement('span')
      span.innerHTML = html
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

/** 选项「A. xxx」→ 字母 A */
function optionLetter(opt: string): string {
  const m = /^([A-H])[.、．]/.exec(opt.trim())
  return m ? m[1] : ''
}

export function EveningQuiz() {
  const inTauri = useIsTauri()

  // ── 触发引擎状态 ──────────────────────────────────────────
  const [desktop, setDesktop] = useState(false)
  const [phase, setPhase] = useState<'closed' | 'intro' | 'card' | 'quiz' | 'done'>('closed')
  const [papers, setPapers] = useState<QueuePaper[]>([])
  const [picked, setPicked] = useState(0)
  const [triggeredInfo, setTriggeredInfo] = useState<'schedule' | 'catchup' | 'demo'>('catchup')
  const openRef = useRef(false)
  const lockStartedHereRef = useRef(false)
  const demoPoppedRef = useRef(false)

  // ── 测验状态 ─────────────────────────────────────────────
  const [paperMeta, setPaperMeta] = useState<{ id: string; title: string } | null>(null)
  const [items, setItems] = useState<QItem[]>([])
  const [qi, setQi] = useState(0)
  const [loadingPaper, setLoadingPaper] = useState(false)
  const [genVariant, setGenVariant] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [judged, setJudged] = useState<null | { right: boolean }>(null)
  const [revealed, setRevealed] = useState(false)
  const [stats, setStats] = useState({ origTotal: 0, origRight: 0, varTotal: 0, varRight: 0 })
  const [wrongIds, setWrongIds] = useState<string[]>([])
  const [durationSec, setDurationSec] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const quizStartRef = useRef(0)
  const bodyRef = useRef<HTMLDivElement>(null)

  // 变式生成用模型（与组卷页同一解析口径：可用模型里优先公共池）
  const { data: allModels } = useQuery({ ...providersModelsQuery })
  const { data: keyProviders } = useQuery<Set<string>>({ ...providerKeysStatusQuery })
  const modelId = useMemo(() => {
    if (!allModels) return null
    const avail = keyProviders ? allModels.filter((m) => isModelAvailable(m, keyProviders)) : allModels
    return avail.find((m) => m.publicPool)?.id || avail[0]?.id || null
  }, [allModels, keyProviders])

  // ── 桌面视口判定（手机端暂不接入） ────────────────────────
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const apply = () => setDesktop(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  /** 拉今晚队列；空/失败返回 null 表示无事可做 */
  const fetchQueue = useCallback(async (): Promise<QueuePaper[] | null> => {
    try {
      const r = await fetchJson<{ papers: QueuePaper[] }>(
        `/api/study/evening-quiz?since=${localMidnight()}`,
        { timeoutMs: 15_000 }
      )
      return r.papers ?? []
    } catch {
      return null // 未登录/网络失败：静默
    }
  }, [])

  /** 触发主流程：过闸 → 拉队列 → 有卷才弹卡（Tauri 先上兜底锁） */
  const maybeTrigger = useCallback(
    async (force: boolean, source: 'schedule' | 'catchup' | 'demo') => {
      if (openRef.current) return
      if (source === 'demo' && demoPoppedRef.current) return // demo 只弹一次,防轮询重弹
      if (!force) {
        if (lsGet('eveningQuiz:triggeredDate') === localDateStr()) return
        if (lsGet('eveningQuiz:dismissedDate') === localDateStr()) return
        if (!timeGateOk()) return
      }
      const queue = await fetchQueue()
      if (!queue || !queue.length) return
      if (openRef.current) return
      openRef.current = true
      if (source === 'demo') demoPoppedRef.current = true
      if (source !== 'demo') lsSet('eveningQuiz:triggeredDate', localDateStr())
      setTriggeredInfo(source)
      setPapers(queue)
      setPicked(0)
      setHasMore(false)
      if (inTauri) {
        try {
          const st = await tauri.focusLockStatus()
          if (!st?.locked) {
            await tauri.focusLockStart(FALLBACK_MIN, true)
            lockStartedHereRef.current = true
            window.dispatchEvent(new CustomEvent('fl:sync'))
            setPhase('intro')
            window.setTimeout(() => setPhase('card'), INTRO_MS)
            toast.info(`今天打印了 ${queue.length} 份卷子 · 测完自动放行`, { title: '今晚测验' })
            return
          }
          // 已在锁定中（手动开的）：复用，不重复上锁，测完也不代放
          lockStartedHereRef.current = false
        } catch {
          // 桌面命令失败 → 按浏览器语义弹卡（无锁）
          lockStartedHereRef.current = false
        }
      }
      setPhase('card')
    },
    [fetchQueue, inTauri]
  )

  // 触发引擎：打开即补触发 + 30s 轮询跨过设定时刻；?eveningQuiz=demo 绕过时间闸
  useEffect(() => {
    if (!desktop) return
    let stopped = false
    const demo =
      typeof window !== 'undefined' && window.location.search.includes('eveningQuiz=demo')
    const check = () => {
      if (!stopped) void maybeTrigger(demo, demo ? 'demo' : 'catchup')
    }
    const t = window.setTimeout(check, 1200)
    const iv = window.setInterval(check, 30_000)
    return () => {
      stopped = true
      window.clearTimeout(t)
      window.clearInterval(iv)
    }
  }, [desktop, maybeTrigger])

  // ── 测验流 ───────────────────────────────────────────────
  const close = useCallback(() => {
    openRef.current = false
    setPhase('closed')
    setPaperMeta(null)
    setItems([])
    setQi(0)
    setJudged(null)
    setSelected(new Set())
    setRevealed(false)
    setStats({ origTotal: 0, origRight: 0, varTotal: 0, varRight: 0 })
    setWrongIds([])
  }, [])

  const startQuiz = useCallback(async () => {
    const p = papers[picked]
    if (!p) return
    setLoadingPaper(true)
    try {
      const view = await fetchJson<{
        id: string
        title: string
        slots: Array<{
          paperQuestionId?: string | null
          kind: string
          stem: string | null
          options: string[]
          answer: string | null
          multiple: boolean
        }>
      }>(`/api/papers/composed/${p.id}`, { timeoutMs: 20_000 })
      const qItems: QItem[] = view.slots
        .filter((s) => s.answer != null && s.stem)
        .map((s, i) => {
          const kind: QItem['kind'] = s.kind === 'choice' ? 'choice' : 'answer'
          const letters = kind === 'choice' ? parseObjectiveAnswer({ kind: 'choice', multiple: s.multiple, answer: s.answer }) : []
          return {
            key: `o${i}`,
            kind,
            paperQuestionId: s.paperQuestionId ?? null,
            stem: s.stem ?? '',
            options: s.options ?? [],
            multiple: !!s.multiple,
            answer: kind === 'choice' ? letters[0] ?? null : null,
            answerText: s.answer,
          }
        })
      if (!qItems.length) {
        toast.warning('这张卷没有可判定题目（缺答案），已跳过', { title: '今晚测验' })
        setLoadingPaper(false)
        return
      }
      setPaperMeta({ id: p.id, title: p.title })
      setItems(qItems)
      setQi(0)
      setJudged(null)
      setSelected(new Set())
      setRevealed(false)
      setStats({ origTotal: qItems.length, origRight: 0, varTotal: 0, varRight: 0 })
      setWrongIds([])
      quizStartRef.current = Date.now()
      setPhase('quiz')
    } catch {
      toast.error('卷子加载失败，稍后重试', { title: '今晚测验' })
    }
    setLoadingPaper(false)
  }, [papers, picked])

  /** 结算 + 回执落库 + 测完即放 */
  const finishQuiz = useCallback(
    async (finalStats: typeof stats, wrong: string[]) => {
      const sec = Math.max(1, Math.round((Date.now() - quizStartRef.current) / 1000))
      setDurationSec(sec)
      setStats(finalStats)
      setWrongIds(wrong)
      setPhase('done')
      try {
        await fetchJson('/api/study/evening-quiz/complete', {
          method: 'POST',
          json: {
            composedId: paperMeta?.id,
            origTotal: finalStats.origTotal,
            origRight: finalStats.origRight,
            variantTotal: finalStats.varTotal,
            variantRight: finalStats.varRight,
            wrongQuestionIds: wrong,
            durationSec: sec,
            releasedBy: 'quiz',
          },
          timeoutMs: 15_000,
        })
      } catch {
        toast.error('回执保存失败，明天这张卷会重新进队列', { title: '今晚测验' })
      }
      // 测完即放：仅当锁定是本次触发代开的；手动开的锁定不代放
      if (inTauri && lockStartedHereRef.current) {
        try {
          await tauri.focusLockStop()
        } catch {
          // ignore
        }
        lockStartedHereRef.current = false
      } else if (inTauri) {
        toast.info('你手动开启的锁定继续保留，到点自动放行', { title: '监管模式' })
      }
      // 还有没测的卷吗？
      const rest = await fetchQueue()
      setHasMore(!!rest && rest.length > 0)
    },
    [fetchQueue, inTauri, paperMeta]
  )

  const current = items[qi]
  const origCount = items.filter((i) => i.kind !== 'variant').length

  /** 判定当前题（choice）→ 记分；答错的真题触发变式生成 */
  const judgeChoice = useCallback(
    async (letters: string[]) => {
      if (!current || judged) return
      const expect = (current.answer ?? '').split('').sort().join('')
      const got = letters.slice().sort().join('')
      const right = !!expect && got === expect
      setJudged({ right })
      const isOrig = current.kind !== 'variant'
      if (isOrig) {
        if (right) setStats((s) => ({ ...s, origRight: s.origRight + 1 }))
        else if (current.paperQuestionId) setWrongIds((w) => (w.includes(current.paperQuestionId!) ? w : [...w, current.paperQuestionId!]))
      } else if (right) {
        setStats((s) => ({ ...s, varRight: s.varRight + 1 }))
      }
      if (!right && isOrig && current.kind === 'choice' && current.paperQuestionId && modelId && !genVariant) {
        setGenVariant(true)
        try {
          const r = await fetchJson<{
            variants: Array<{ stem: string; options: string[]; answer: string; kind: string }>
          }>(`/api/papers/composed/${paperMeta?.id}/variants`, {
            method: 'POST',
            json: { paperQuestionId: current.paperQuestionId, modelId, count: 1 },
            timeoutMs: 120_000,
          })
          const v = r.variants?.[0]
          if (v) {
            const vKind: QItem['kind'] = v.kind === 'choice' ? 'choice' : 'answer'
            const vLetters =
              vKind === 'choice'
                ? parseObjectiveAnswer({ kind: 'choice', multiple: false, answer: v.answer })
                : []
            const item: QItem = {
              key: `v${Date.now()}`,
              kind: 'variant',
              paperQuestionId: null,
              stem: v.stem,
              options: v.options ?? [],
              multiple: false,
              answer: vKind === 'choice' ? vLetters[0] ?? null : null,
              answerText: v.answer,
            }
            setItems((arr) => {
              const next = [...arr]
              next.splice(qi + 1, 0, item)
              return next
            })
            setStats((s) => ({ ...s, varTotal: s.varTotal + 1 }))
          }
        } catch {
          toast.warning('变式生成失败，跳过（不影响本题判分）', { title: '举一反三' })
        }
        setGenVariant(false)
      }
    },
    [current, judged, modelId, genVariant, paperMeta, qi]
  )

  /** answer 题自判 */
  const judgeSelf = useCallback(
    (right: boolean) => {
      if (!current || judged) return
      setJudged({ right })
      if (current.kind === 'variant') {
        if (right) setStats((s) => ({ ...s, varRight: s.varRight + 1 }))
      } else {
        if (right) setStats((s) => ({ ...s, origRight: s.origRight + 1 }))
        else if (current.paperQuestionId)
          setWrongIds((w) => (w.includes(current.paperQuestionId!) ? w : [...w, current.paperQuestionId!]))
      }
    },
    [current, judged]
  )

  const goNext = useCallback(() => {
    if (qi + 1 < items.length) {
      setQi(qi + 1)
      setJudged(null)
      setSelected(new Set())
      setRevealed(false)
      return
    }
    // 全部答完 → 结算
    void finishQuiz(stats, wrongIds)
  }, [qi, items.length, stats, wrongIds, finishQuiz])

  // KaTeX 渲染：题目内容变化后走一遍
  useEffect(() => {
    if (bodyRef.current) renderTexIn(bodyRef.current)
  }, [current?.key, revealed, judged])

  // ── 渲染 ────────────────────────────────────────────────
  if (!desktop || phase === 'closed') return null

  const totalNow = items.length

  return (
    <>
      {phase === 'intro' &&
        createPortal(<FlTransition kind="intro" label="已进入监管模式" />, document.body)}

      {(phase === 'card' || phase === 'quiz' || phase === 'done') &&
        createPortal(
          <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/30 p-4" role="dialog" aria-label="今晚测验">
            <div className="w-[420px] max-w-full rounded-2xl border border-line bg-surface shadow-2xl">
              {/* ── 选卷 ── */}
              {phase === 'card' && (
                <div className="p-[22px] pb-[18px]">
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-[34px] w-[34px] items-center justify-center rounded-[10px] fl-butter-chip">
                      <ShieldCheck className="h-[18px] w-[18px]" aria-hidden />
                    </span>
                    <span className="text-[15.5px] font-semibold text-content-primary">今晚测验</span>
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-content-muted">
                    今天通过 App 打印了 <b className="font-medium text-content-secondary">{papers.length} 份卷子</b>
                    {inTauri ? ' · 监管模式已自动开启' : ' · 浏览器预览（无锁定）'}
                    <br />
                    <span className="text-[11px]">
                      {triggeredInfo === 'schedule'
                        ? '22:00 定时触发'
                        : triggeredInfo === 'demo'
                          ? '验收演示触发（?eveningQuiz=demo）'
                          : '打开即补触发'}{' '}
                      · 仅工作日 · 测完即放
                    </span>
                  </p>

                  <div className="mt-3.5 flex flex-col gap-2">
                    {papers.map((p, i) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setPicked(i)}
                        className={`block w-full rounded-xl border p-3 text-left transition-colors duration-150 ${
                          i === picked ? 'fl-butter-pick' : 'border-line fl-butter-hover'
                        }`}
                      >
                        <span className="flex items-center gap-2 text-[13.5px] font-medium text-content-primary">
                          <span className="truncate">{p.title}</span>
                          <span className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10.5px] font-medium text-emerald-600 dark:text-emerald-400">
                            {SUBJECT_LABELS[p.subject] ?? p.subject}
                          </span>
                        </span>
                        <span className="mt-1.5 flex flex-wrap gap-1.5">
                          <span className="rounded-full fl-butter-chip px-2 py-0.5 text-[11px]">原题 {p.origCount}</span>
                          <span className="rounded-full bg-surface-subtle px-2 py-0.5 text-[11px] text-content-muted">
                            今日打印 {p.printCount} 次 · {new Date(p.lastPrintAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={startQuiz}
                    disabled={loadingPaper}
                    className="mt-3.5 h-10 w-full rounded-xl fl-butter-btn text-[13.5px] font-medium transition-all duration-150 disabled:opacity-50"
                  >
                    {loadingPaper ? '加载中…' : `开始测验 · 原题 ${papers[picked]?.origCount ?? 0}`}
                  </button>
                  {!inTauri && (
                    <button
                      type="button"
                      onClick={() => {
                        lsSet('eveningQuiz:dismissedDate', localDateStr())
                        close()
                      }}
                      className="mt-2 h-9 w-full rounded-xl border border-line text-xs text-content-muted transition-colors duration-150 hover:bg-surface-subtle"
                    >
                      今日跳过（明晚照常触发）
                    </button>
                  )}
                  <p className="mt-3 rounded-lg bg-surface-subtle px-2.5 py-2 text-[11px] leading-relaxed text-content-muted/80">
                    {inTauri
                      ? '盾形锁已生效：测完自动放行；未测完最长锁定 30 分钟兜底放行。当日未测内容顺延明晚。'
                      : '浏览器预览无锁定：验收触发流与测验流；桌面 App 内会同时上 30 分钟兜底锁。'}
                  </p>
                </div>
              )}

              {/* ── 测验 ── */}
              {phase === 'quiz' && current && (
                <div className="p-[22px] pb-[18px]" ref={bodyRef}>
                  <div className="flex items-center gap-2">
                    {inTauri && (
                      <span className="flex items-center gap-1.5 rounded-full fl-butter-chip px-2.5 py-1 text-[11px] font-semibold">
                        <Shield className="h-3 w-3" aria-hidden />
                        监管中 · 兜底 {FALLBACK_MIN} 分钟
                      </span>
                    )}
                    <span className="ml-auto text-xs text-content-muted">
                      第 {qi + 1}/{totalNow} 题 · 原题 {origCount}
                    </span>
                  </div>

                  <div className="mt-3 flex items-center gap-1.5">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${
                        current.kind === 'variant'
                          ? 'fl-butter-chip'
                          : 'bg-surface-subtle text-content-muted'
                      }`}
                    >
                      {current.kind === 'variant' ? '变式 · 举一反三' : current.kind === 'choice' ? '原题 · 选择' : '原题 · 自判'}
                    </span>
                    <span className="truncate text-[11px] text-content-muted/70">{paperMeta?.title}</span>
                  </div>

                  <div className="mt-2.5 text-sm leading-7 text-content-primary">{current.stem}</div>

                  {current.kind === 'choice' && (
                    <div className={`mt-3 grid gap-2 ${current.options.length > 4 ? 'grid-cols-1' : 'grid-cols-2'}`}>
                      {current.options.map((o) => {
                        const letter = optionLetter(o)
                        const sel = selected.has(letter)
                        const showRight = judged && letter && (current.answer ?? '').includes(letter)
                        const showWrong = judged && sel && !judged.right
                        return (
                          <button
                            key={o}
                            type="button"
                            disabled={!!judged || genVariant}
                            onClick={() => {
                              if (current.multiple) {
                                setSelected((s) => {
                                  const n = new Set(s)
                                  if (n.has(letter)) n.delete(letter)
                                  else n.add(letter)
                                  return n
                                })
                              } else {
                                setSelected(new Set([letter]))
                                void judgeChoice([letter])
                              }
                            }}
                            className={`rounded-xl border p-2.5 text-left text-[13px] leading-6 transition-colors duration-150 ${
                              showRight
                                ? 'border-emerald-500 bg-emerald-500/10'
                                : showWrong
                                  ? 'border-red-500 bg-red-500/5'
                                  : sel
                                    ? 'fl-butter-pick'
                                    : 'border-line fl-butter-hover'
                            } disabled:cursor-default`}
                          >
                            {o}
                          </button>
                        )
                      })}
                    </div>
                  )}

                  {current.kind === 'choice' && current.multiple && !judged && (
                    <button
                      type="button"
                      disabled={!selected.size}
                      onClick={() => void judgeChoice(Array.from(selected))}
                      className="mt-2.5 h-9 w-full rounded-xl fl-butter-btn text-xs font-medium transition-opacity duration-150 disabled:opacity-40"
                    >
                      确认多选（{selected.size} 项）
                    </button>
                  )}

                  {current.kind === 'answer' && (
                    <div className="mt-3">
                      {!revealed ? (
                        <button
                          type="button"
                          onClick={() => setRevealed(true)}
                          className="flex h-9 w-full items-center justify-center gap-1.5 rounded-xl border border-line text-xs text-content-secondary transition-colors duration-150 hover:bg-surface-subtle"
                        >
                          <Eye className="h-3.5 w-3.5" aria-hidden />
                          作答完成后查看参考答案
                        </button>
                      ) : (
                        <>
                          <div className="rounded-xl bg-surface-subtle p-3 text-[13px] leading-6 text-content-secondary">
                            <span className="text-[11px] font-medium text-content-muted">参考答案</span>
                            <div className="mt-1 whitespace-pre-wrap">{current.answerText}</div>
                          </div>
                          {!judged && (
                            <div className="mt-2 flex gap-2">
                              <button
                                type="button"
                                onClick={() => judgeSelf(true)}
                                className="h-9 flex-1 rounded-xl bg-emerald-500 text-xs font-medium text-white transition-opacity duration-150 hover:opacity-90"
                              >
                                答对了
                              </button>
                              <button
                                type="button"
                                onClick={() => judgeSelf(false)}
                                className="h-9 flex-1 rounded-xl border border-red-500/40 text-xs font-medium text-red-500 transition-colors duration-150 hover:bg-red-500/10"
                              >
                                答错了
                              </button>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}

                  {judged && (
                    <div
                      className={`mt-3 flex items-center gap-2 rounded-lg px-3 py-2 text-xs ${
                        judged.right ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-red-500/5 text-red-500'
                      }`}
                    >
                      {judged.right ? (
                        <>
                          <Check className="h-3.5 w-3.5" aria-hidden />
                          回答正确
                        </>
                      ) : (
                        <>
                          <X className="h-3.5 w-3.5" aria-hidden />
                          答错了{current.kind === 'choice' && current.answer ? ` · 正确答案 ${current.answer}` : ''}
                        </>
                      )}
                    </div>
                  )}

                  {genVariant && (
                    <div className="mt-3 flex items-center gap-2 rounded-lg bg-surface-subtle px-3 py-2 text-xs text-content-muted">
                      <Loader2 className="h-3.5 w-3.5 animate-spin fl-gold-text" aria-hidden />
                      正在按原题题型出同型变式…
                    </div>
                  )}

                  <div className="mt-3 flex items-center gap-2">
                    <span className="text-[11px] leading-5 text-content-muted/70">
                      答错的选择真题当场追加 1 道同型变式（举一反三）
                    </span>
                    {judged && !genVariant && (
                      <button
                        type="button"
                        onClick={goNext}
                        className="ml-auto h-9 rounded-xl fl-butter-btn px-4 text-xs font-medium transition-colors duration-150"
                      >
                        {qi + 1 < items.length ? '下一题' : '完成测验'}
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* ── 完成回执 ── */}
              {phase === 'done' && (
                <div className="p-[22px] pb-[18px] text-center">
                  <ShieldCheck className="mx-auto mt-1.5 h-[52px] w-[52px] text-emerald-500" aria-hidden />
                  <div className="mt-3 text-base font-semibold text-content-primary">测完了 · 监管模式已解除</div>
                  <div className="mt-1 text-xs text-content-muted">
                    用时 {Math.floor(durationSec / 60)} 分 {durationSec % 60} 秒 · 已记入今晚测验回执
                  </div>
                  <div className="mt-4 flex justify-center gap-2">
                    <div className="min-w-[88px] rounded-xl bg-surface-subtle px-3 py-2.5">
                      <div className="text-[17px] font-semibold tabular-nums text-content-primary">
                        {stats.origRight}/{stats.origTotal}
                        <span className="text-[11px] font-normal text-content-muted"> 题</span>
                      </div>
                      <div className="mt-0.5 text-[10.5px] text-content-muted">原题正确</div>
                    </div>
                    <div className="min-w-[88px] rounded-xl bg-surface-subtle px-3 py-2.5">
                      <div className="text-[17px] font-semibold tabular-nums text-content-primary">
                        {stats.varTotal ? `${stats.varRight}/${stats.varTotal}` : '—'}
                        <span className="text-[11px] font-normal text-content-muted"> 题</span>
                      </div>
                      <div className="mt-0.5 text-[10.5px] text-content-muted">
                        {stats.varTotal ? '变式正确' : '变式未触发'}
                      </div>
                    </div>
                  </div>
                  {hasMore && (
                    <button
                      type="button"
                      onClick={async () => {
                        const rest = await fetchQueue()
                        if (rest && rest.length) {
                          setPapers(rest)
                          setPicked(0)
                          setPhase('card')
                        } else {
                          close()
                        }
                      }}
                      className="mt-4 h-10 w-full rounded-xl fl-butter-btn text-[13.5px] font-medium transition-colors duration-150"
                    >
                      继续测下一份
                    </button>
                  )}
                  {!hasMore && (
                    <button
                      type="button"
                      onClick={close}
                      className="mt-4 h-10 w-full rounded-xl border border-line text-[13px] text-content-secondary transition-colors duration-150 hover:bg-surface-subtle"
                    >
                      完成 · 收下回执
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
