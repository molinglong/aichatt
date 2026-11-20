'use client'

/**
 * 突击测试（监考黑场）——随机概念突袭,方案 B 定稿于 design/preview-surprise-quiz.html。
 *
 * 第 1 波口径(design/surprise-quiz-plan.md):
 * - 入口:学习台「突击一测」手动触发(window event surpriseQuiz:open)+
 *   ?surpriseQuiz=demo 验收参数(演示题,不落回执);自动触发引擎第 2 波接入。
 * - 题源:GET /api/study/surprise 服务端组装(错题本/课本/事件三池配额,
 *   概念选择题 ×3);三池全空 toast 提示不弹卡。
 * - B 监考黑场:全屏 #0b0b0e 大题面,无视浅色主题(定案:黑场即监考氛围)。
 * - Tauri 下弹卡即启动 30 分钟兜底锁定(与今晚测验同联动口径):
 *   本次代开的锁测完即放,手动开的锁测完不代放;浏览器无锁直接进题。
 * - 答错当场给解析;课本/事件源错题服务端自动回流错题本
 *   (origin=surprise_quiz,进今日 FSRS 队列),错题本源走 FSRS good/again。
 * - 仅桌面(≥768px),手机端第 3 波。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import katex from 'katex'
import { Check, Loader2, ShieldCheck, X } from 'lucide-react'
import { FlTransition } from '@/components/FocusLock'
import { fetchJson } from '@/lib/query/fetcher'
import { toast } from '@/lib/toast'
import { chickPlay } from '@/lib/chick/reactions'
import { tauri, useIsTauri } from '@/lib/tauri'
import type { SurpriseItem } from '@/lib/study/surprise'

/** 开场黑场过场时长（与 FocusLock/今晚测验同拍） */
const INTRO_MS = 2900
/** 兜底锁定分钟数 */
const FALLBACK_MIN = 30

interface AnsweredItem extends SurpriseItem {
  userAnswer: string
  right: boolean
}

/** 演示题(?surpriseQuiz=demo,与 design/preview-surprise-quiz.html 同数据) */
const DEMO_ITEMS: SurpriseItem[] = [
  {
    source: 'wrong_note',
    topic: '十字相乘',
    stem: '下列关于十字相乘法的说法，正确的是（　）',
    options: [
      { letter: 'A', text: '任何二次三项式都能用十字相乘分解' },
      { letter: 'B', text: '十字相乘只适用于首项系数为 1 的式子' },
      { letter: 'C', text: '拆分后交叉相乘之和等于一次项系数' },
      { letter: 'D', text: '分解结果一定都是整数' },
    ],
    answer: 'C',
    analysis: '十字相乘要求找到两数：积 = 二次项系数 × 常数项，和 = 一次项系数；并非所有二次三项式都能整数拆分。',
    sourceRef: '错题本 · 11-14 存',
  },
  {
    source: 'textbook',
    topic: '单调性',
    stem: '用定义证明 f(x) 在 D 上单调递增，取值方式正确的是（　）',
    options: [
      { letter: 'A', text: '取两个特殊值代入验证' },
      { letter: 'B', text: '任意取 x₁ < x₂ ∈ D，比较 f(x₁) 与 f(x₂)' },
      { letter: 'C', text: '举一个例子说明函数值随 x 增大而增大' },
      { letter: 'D', text: '比较 f(x₂)/f(x₁) 是否大于 1' },
    ],
    answer: 'B',
    analysis: '单调性定义要求对任意 x₁ < x₂ 都成立；特殊值或单个例子不能证明单调性。',
    sourceRef: '§2.3 函数的单调性',
  },
  {
    source: 'scratch',
    topic: '集合',
    stem: '下列集合中，表示空集的是（　）',
    options: [
      { letter: 'A', text: '{x | x² + 1 = 0，x ∈ R}' },
      { letter: 'B', text: '{0}' },
      { letter: 'C', text: '{x | x² = x，x ∈ R}' },
      { letter: 'D', text: '{x | x > 2 且 x < 3}' },
    ],
    answer: 'A',
    analysis: 'x² + 1 = 0 在实数范围内无解，是空集；{0} 含元素 0，{x | x² = x} = {0, 1}，D 集合含 2.5 等，都非空。',
    sourceRef: '便签「数学期中考」',
  },
]

const SOURCE_LABELS: Record<SurpriseItem['source'], string> = {
  wrong_note: '错题本',
  textbook: '课本',
  scratch: '事件',
}

/** 题干/选项里的 $...$ 渲染成 KaTeX（项目惯例:各测验组件自持同一套实现） */
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

export function SurpriseQuiz() {
  const inTauri = useIsTauri()

  const [desktop, setDesktop] = useState(false)
  const [phase, setPhase] = useState<'closed' | 'loading' | 'intro' | 'quiz' | 'done'>('closed')
  const [items, setItems] = useState<SurpriseItem[]>([])
  const [answers, setAnswers] = useState<AnsweredItem[]>([])
  const [qi, setQi] = useState(0)
  const [judged, setJudged] = useState<null | { right: boolean }>(null)
  const [picked, setPicked] = useState('')
  const [isDemo, setIsDemo] = useState(false)
  const [reflowCount, setReflowCount] = useState<number | null>(null)
  const [durationSec, setDurationSec] = useState(0)
  const openRef = useRef(false)
  const demoPoppedRef = useRef(false)
  const lockStartedHereRef = useRef(false)
  const quizStartRef = useRef(0)
  const bodyRef = useRef<HTMLDivElement>(null)
  /** 小鸡反应:本次连对计数 / 连对 3 题里程碑已报(每测至多一次) */
  const streakRef = useRef(0)
  const streakFiredRef = useRef(false)

  // 桌面视口判定（手机端第 3 波）
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)')
    const apply = () => setDesktop(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])

  const close = useCallback(() => {
    openRef.current = false
    setPhase('closed')
    setItems([])
    setAnswers([])
    setQi(0)
    setJudged(null)
    setPicked('')
    setIsDemo(false)
    setReflowCount(null)
    lockStartedHereRef.current = false
  }, [])

  /** 触发主流程:取题(demo 用演示题) → Tauri 上兜底锁 + 黑场过场 → 进题 */
  const openQuiz = useCallback(
    async (source: 'manual' | 'demo') => {
      if (openRef.current) return
      if (source === 'demo' && demoPoppedRef.current) return
      openRef.current = true
      if (source === 'demo') demoPoppedRef.current = true

      if (source === 'demo') {
        setItems(DEMO_ITEMS)
        setIsDemo(true)
      } else {
        setPhase('loading')
        try {
          // AI 逐题生成,慢是正常态:黑场 loading 明示在出题
          const r = await fetchJson<{ empty: boolean; items?: SurpriseItem[] }>(
            '/api/study/surprise',
            { timeoutMs: 180_000 }
          )
          if (r.empty || !r.items?.length) {
            openRef.current = false
            setPhase('closed')
            toast.warning('题池暂时没料：错题本/课本/便签都没有可抽的内容', { title: '突击测试' })
            return
          }
          setItems(r.items)
          setIsDemo(false)
        } catch {
          openRef.current = false
          setPhase('closed')
          toast.error('出题失败，稍后再试', { title: '突击测试' })
          return
        }
      }

      setAnswers([])
      setQi(0)
      setJudged(null)
      setPicked('')
      setReflowCount(null)
      streakRef.current = 0
      streakFiredRef.current = false
      quizStartRef.current = Date.now()

      if (inTauri) {
        try {
          const st = await tauri.focusLockStatus()
          if (!st?.locked) {
            await tauri.focusLockStart(FALLBACK_MIN, true)
            lockStartedHereRef.current = true
            window.dispatchEvent(new CustomEvent('fl:sync'))
            setPhase('intro')
            window.setTimeout(() => setPhase('quiz'), INTRO_MS)
            return
          }
          // 已在锁定中(手动开的):复用,测完不代放
          lockStartedHereRef.current = false
        } catch {
          lockStartedHereRef.current = false
        }
      }
      setPhase('quiz')
    },
    [inTauri]
  )

  // 入口监听:学习台「突击一测」事件 + ?surpriseQuiz=demo 验收参数
  useEffect(() => {
    const onOpen = () => {
      if (!desktop) {
        toast.info('突击测试暂仅支持桌面端，手机端后续接入', { title: '突击测试' })
        return
      }
      void openQuiz('manual')
    }
    window.addEventListener('surpriseQuiz:open', onOpen)
    const demo =
      typeof window !== 'undefined' && window.location.search.includes('surpriseQuiz=demo')
    if (demo && desktop) {
      const t = window.setTimeout(() => void openQuiz('demo'), 1200)
      return () => {
        window.removeEventListener('surpriseQuiz:open', onOpen)
        window.clearTimeout(t)
      }
    }
    return () => window.removeEventListener('surpriseQuiz:open', onOpen)
  }, [desktop, openQuiz])

  /** 单选判分:当场出对错 + 答错给解析 */
  const judge = useCallback(
    (letter: string) => {
      const current = items[qi]
      if (!current || judged) return
      const right = letter === current.answer
      setPicked(letter)
      setJudged({ right })
      setAnswers((a) => [...a, { ...current, userAnswer: letter, right }])
      // 小鸡反应:答错缩壳打气;连对 3 题三连蹦(每测至多报一次)
      if (!right) {
        streakRef.current = 0
        chickPlay('wrong')
      } else {
        streakRef.current += 1
        if (streakRef.current >= 3 && !streakFiredRef.current) {
          streakFiredRef.current = true
          chickPlay('streak3')
        }
      }
    },
    [items, qi, judged]
  )

  /** 结算:落回执 + 锁联动 + 完成屏 */
  const finish = useCallback(async () => {
    const sec = Math.max(1, Math.round((Date.now() - quizStartRef.current) / 1000))
    setDurationSec(sec)
    setPhase('done')
    chickPlay('group') // 小鸡:这组完成(演示也弹,便于验收)
    if (isDemo) {
      lockStartedHereRef.current = false
      return
    }
    try {
      const r = await fetchJson<{ ok: boolean; reflowed?: string[] }>(
        '/api/study/surprise/complete',
        {
          method: 'POST',
          json: {
            items: answers.map(({ userAnswer, right, ...rest }) => ({ ...rest, userAnswer })),
            total: answers.length,
            correct: answers.filter((a) => a.right).length,
            durationSec: sec,
            trigger: 'manual',
          },
          timeoutMs: 20_000,
        }
      )
      const reflowed = r.reflowed?.length ?? 0
      setReflowCount(reflowed)
      // 回流了错题 → 稍后小鸡「我帮你记下了」(错开冷却,接在完成报喜后面)
      if (reflowed > 0) window.setTimeout(() => chickPlay('wrongSaved'), 4200)
    } catch {
      toast.error('回执保存失败：答错的题可能没进错题本', { title: '突击测试' })
    }
    // 测完即放:仅当锁定是本次触发代开的;手动开的锁定不代放
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
  }, [answers, isDemo, inTauri])

  const goNext = useCallback(() => {
    if (qi + 1 < items.length) {
      setQi(qi + 1)
      setJudged(null)
      setPicked('')
      return
    }
    void finish()
  }, [qi, items.length, finish])

  const current = items[qi]
  const currentStem = current?.stem

  // KaTeX 渲染:题目内容变化后走一遍
  useEffect(() => {
    if (bodyRef.current) renderTexIn(bodyRef.current)
  }, [currentStem, phase, judged])

  if (!desktop || phase === 'closed') return null

  const correctCount = answers.filter((a) => a.right).length
  const answeredCount = answers.length

  return (
    <>
      {phase === 'intro' &&
        createPortal(<FlTransition kind="intro" label="已进入监管模式" />, document.body)}

      {(phase === 'loading' || phase === 'quiz' || phase === 'done') &&
        createPortal(
          // B 监考黑场:全屏纯黑,无视主题(定案)
          <div
            className="fixed inset-0 z-[121] flex items-center justify-center bg-[#0b0b0e] px-4"
            role="dialog"
            aria-label="突击测试"
          >
            <div className="w-[min(620px,92%)] py-8 text-[#ececf2]">
              {/* ── 出题中 ── */}
              {phase === 'loading' && (
                <div className="flex flex-col items-center py-16">
                  <Loader2 className="h-7 w-7 animate-spin text-white/40" aria-hidden />
                  <div className="mt-4 text-sm text-white/60">正在从题池抽题…</div>
                  <div className="mt-1.5 text-xs text-white/35">错题本 · 课本 · 便签 三路配额</div>
                  <button
                    type="button"
                    onClick={close}
                    className="mt-8 text-xs text-white/40 transition-colors duration-150 hover:text-white/70"
                  >
                    先不测了
                  </button>
                </div>
              )}

              {/* ── 答题 ── */}
              {phase === 'quiz' && current && (
                <div ref={bodyRef}>
                  <div className="flex items-center gap-2.5">
                    <span className="flex h-[34px] w-[34px] items-center justify-center rounded-[10px] bg-white/10">
                      <ShieldCheck className="h-[18px] w-[18px] text-white/70" aria-hidden />
                    </span>
                    <span className="text-[15.5px] font-semibold">突击测试</span>
                    <span className="ml-auto text-xs tabular-nums text-white/45">
                      第 {qi + 1}/{items.length} 题
                      {inTauri ? ' · 监管中' : isDemo ? ' · 演示' : ''}
                    </span>
                  </div>

                  <div className="mt-5 flex items-center gap-2">
                    <span className="rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white/70">
                      {SOURCE_LABELS[current.source]} · {current.topic}
                    </span>
                    {current.sourceRef && (
                      <span className="truncate text-[11px] text-white/35">{current.sourceRef}</span>
                    )}
                  </div>

                  <div className="mt-3 text-[16.5px] leading-[1.9]">{current.stem}</div>

                  <div className="mt-6 grid grid-cols-1 gap-2.5">
                    {current.options.map((o) => {
                      const isAnswer = o.letter === current.answer
                      const isPicked = o.letter === picked
                      const showRight = judged && isAnswer
                      const showWrong = judged && isPicked && !judged.right
                      return (
                        <button
                          key={o.letter}
                          type="button"
                          disabled={!!judged}
                          onClick={() => judge(o.letter)}
                          className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-left text-[14px] leading-7 transition-colors duration-150 ${
                            showRight
                              ? 'border-emerald-500/60 bg-emerald-500/10 text-[#ececf2]'
                              : showWrong
                                ? 'border-red-500/60 bg-red-500/10 text-[#ececf2]'
                                : judged
                                  ? 'border-white/10 text-white/55'
                                  : 'border-white/15 hover:border-white/35 hover:bg-white/5'
                          }`}
                        >
                          <span
                            className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-[12px] font-semibold tabular-nums ${
                              showRight
                                ? 'bg-emerald-500 text-white'
                                : showWrong
                                  ? 'bg-red-500 text-white'
                                  : 'bg-white/10 text-white/70'
                            }`}
                          >
                            {o.letter}
                          </span>
                          <span>{o.text}</span>
                        </button>
                      )
                    })}
                  </div>

                  {judged && (
                    <div className="mt-5">
                      <div
                        className={`flex items-center gap-2 text-sm font-medium ${
                          judged.right ? 'text-emerald-400' : 'text-red-400'
                        }`}
                      >
                        {judged.right ? (
                          <>
                            <Check className="h-4 w-4" aria-hidden />
                            回答正确
                          </>
                        ) : (
                          <>
                            <X className="h-4 w-4" aria-hidden />
                            答错了 · 正确答案 {current.answer}
                          </>
                        )}
                      </div>
                      {!judged.right && current.analysis && (
                        <div className="mt-2.5 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-[13px] leading-7 text-white/75">
                          {current.analysis}
                        </div>
                      )}
                      <div className="mt-5 flex justify-end">
                        <button
                          type="button"
                          onClick={goNext}
                          className="h-10 rounded-xl bg-white px-6 text-[13.5px] font-medium text-[#0b0b0e] transition-opacity duration-150 hover:opacity-85"
                        >
                          {qi + 1 < items.length ? '下一题' : '完成'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ── 完成 ── */}
              {phase === 'done' && (
                <div className="text-center">
                  <ShieldCheck
                    className={`mx-auto h-[52px] w-[52px] ${correctCount === items.length ? 'text-emerald-400' : 'text-white/40'}`}
                    aria-hidden
                  />
                  <div className="mt-4 text-base font-semibold">
                    {isDemo ? '演示完成 · 未计入回执' : '测完了'}
                  </div>
                  <div className="mt-1.5 text-xs text-white/50">
                    用时 {Math.floor(durationSec / 60)} 分 {durationSec % 60} 秒
                    {!isDemo && ' · 已记入突击回执'}
                  </div>
                  <div className="mx-auto mt-6 flex max-w-[340px] justify-center gap-3">
                    <div className="min-w-[110px] flex-1 rounded-xl border border-white/10 bg-white/5 px-3 py-3">
                      <div className="text-[20px] font-semibold tabular-nums">
                        {correctCount}/{items.length}
                      </div>
                      <div className="mt-0.5 text-[11px] text-white/45">本次正确</div>
                    </div>
                    <div className="min-w-[110px] flex-1 rounded-xl border border-white/10 bg-white/5 px-3 py-3">
                      <div className="text-[20px] font-semibold tabular-nums">
                        {reflowCount != null && reflowCount > 0 ? reflowCount : isDemo ? '—' : '0'}
                      </div>
                      <div className="mt-0.5 text-[11px] text-white/45">
                        {reflowCount != null && reflowCount > 0 ? '已回流错题本' : '错题回流'}
                      </div>
                    </div>
                  </div>
                  {answeredCount < items.length && answeredCount > 0 && (
                    <div className="mt-3 text-[11px] text-white/35">
                      有 {items.length - answeredCount} 题未作答,按答错回流
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={close}
                    className="mt-6 h-10 w-[min(340px,100%)] rounded-xl border border-white/15 text-[13px] text-white/75 transition-colors duration-150 hover:bg-white/5"
                  >
                    完成 · 回到学习
                  </button>
                </div>
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
