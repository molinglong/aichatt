'use client'

/**
 * 复习卡(错题回看 tab 内核):
 * - flip 模式(默认):看题→翻解析→核对式两键自评,FSRS 排期(原口径不变)
 * - redo 模式(阶段二方案A「卡内答题态」):题库原题遮住旧答案真做一遍,提交客观判分,
 *   对→自动记 Good / 错→自动记 Again,不再依赖诚实自评;判分后可「再来一道同考点」
 *   拉题库变式题(变式判分只在前端,不计 FSRS,答错可一键存错题本)。
 *   无法客观判分的卡(无选项/解析缺答案字母)自动回落 flip 流程。
 * 原型:design/preview-review-suite.html 阶段二方案A。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import katex from 'katex'
import { RefreshCw, Trash2, Eye } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { SUBJECT_LABELS } from '@/lib/study/subject-labels'
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer'
import { confirmDialog } from '@/components/ui/ConfirmDialog'

interface QueueItem {
  id: string
  subject: string | null
  topic: string | null
  title: string
  content: string
  imageUrl: string | null
  analysis: string | null
  mastery: number
  reps: number
  lapses: number
  dueAt: string | null
  sourceQuestionId: string | null
}

/** 迷你数学文本:\(...\) 与 \[...\] 段用 katex 渲染(恒 inline),其余按原文输出。
 *  回看卡专用——绕开 MarkdownRenderer 的聊天级字号,选项/题干不再"正文比标题大"。 */
function MathText({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => {
    const parts = text.split(/(\\\[|\\\(|\\\)|\\\])/g)
    let inMath = false
    return parts
      .map((part) => {
        if (part === '\\(' || part === '\\[') { inMath = true; return '' }
        if (part === '\\)' || part === '\\]') { inMath = false }
        if (inMath && part.trim()) {
          try {
            return katex.renderToString(part, { throwOnError: false, displayMode: false })
          } catch {
            return part
          }
        }
        return part.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      })
      .join('')
  }, [text])
  return <span className={cn('whitespace-pre-wrap', className)} dangerouslySetInnerHTML={{ __html: html }} />
}

/** 解析文本结构化:题库格式的「答案:x」「出处:x」单独拆出,其余为解析正文 */
function parseAnalysis(analysis: string | null): { answer: string | null; source: string | null; body: string } {
  if (!analysis) return { answer: null, source: null, body: '' }
  let answer: string | null = null
  let source: string | null = null
  const body: string[] = []
  analysis
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .forEach((l) => {
      const am = l.match(/^答案[:：]\s*(.+)$/)
      if (am) {
        answer = am[1]
        return
      }
      const sm = l.match(/^出处[:：]\s*(.+)$/)
      if (sm) {
        source = sm[1]
        return
      }
      body.push(l)
    })
  return { answer, source, body: body.join('\n') }
}

/** 题干/选项 结构化解析(变式题与题库题都有此结构;自由文本回落普通渲染) */
function parseStemOptions(text: string): { stem: string; options: Array<{ letter: string; text: string }> } | null {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const optRe = /^([A-H])[.、．]\s*(.*)$/
  const options: Array<{ letter: string; text: string }> = []
  const stemLines: string[] = []
  lines.forEach((l) => {
    const om = l.match(optRe)
    if (om) {
      options.push({ letter: om[1], text: om[2] })
      return
    }
    stemLines.push(l)
  })
  if (options.length < 2) return null
  return { stem: stemLines.join('\n'), options }
}

/** 答案首字母(A-H):「答案:A」/「答案:A. xxx」都能取到;取不到 = 无法客观判分 */
function parseAnswerLetter(answer: string | null): string | null {
  if (!answer) return null
  const m = answer.trim().match(/^([A-H])(?![A-Za-z])/)
  return m ? m[1] : null
}

/** 重做判分结果(原位展示,不动队列位次) */
interface JudgeState {
  picked: string
  correct: boolean
  masteryBefore: number
  masteryAfter: number
}

/** 同考点变式题(纯前端判分,不入 FSRS) */
interface VariantQ {
  id: string
  stem: string
  options: Array<{ letter: string; text: string }>
  answerLetter: string
  analysis: string
  topic: string | null
  sourceRef: string | null
}

export function ReviewCard({ onChanged, onRestudy, onDrill, mode = 'flip', topicFilter, onClearTopic }: {
  onChanged?: () => void
  onRestudy?: (note: { id: string; title: string; content: string; imageUrl?: string | null }) => void
  onDrill?: (note: { id: string; title: string; content: string; imageUrl?: string | null }) => void
  /** flip=翻卡自评(默认) redo=重做题库原题,客观判分 */
  mode?: 'flip' | 'redo'
  /** 考点专项过滤(统计弹层「专项 ›」带入);顶部给清除入口 */
  topicFilter?: string | null
  onClearTopic?: () => void
}) {
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [index, setIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const [revealed, setRevealed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  // 「想起来了」的核对模式:先展开解析对照,再诚实评级(防"眼熟"冒充"会")
  const [verifying, setVerifying] = useState(false)
  // —— redo 模式状态(切卡即重置) ——
  const [selected, setSelected] = useState<string | null>(null)
  const [judged, setJudged] = useState<JudgeState | null>(null)
  const [variant, setVariant] = useState<VariantQ | null>(null)
  const [variantSelected, setVariantSelected] = useState<string | null>(null)
  const [variantJudged, setVariantJudged] = useState<boolean | null>(null)
  const [variantSaved, setVariantSaved] = useState(false)

  const resetCardStates = useCallback(() => {
    setRevealed(false)
    setVerifying(false)
    setSelected(null)
    setJudged(null)
    setVariant(null)
    setVariantSelected(null)
    setVariantJudged(null)
    setVariantSaved(false)
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setIndex(0)
    resetCardStates()
    try {
      const qs = topicFilter ? `?topic=${encodeURIComponent(topicFilter)}` : ''
      const res = await fetch(`/api/study/queue${qs}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setQueue(await res.json())
    } catch (err) {
      console.error('[ReviewCard] load failed:', err)
      toast.error('加载复习队列失败', { title: '复习' })
      setQueue([])
    } finally {
      setLoading(false)
    }
  }, [topicFilter, resetCardStates])

  useEffect(() => {
    void load()
  }, [load])

  const current = index < queue.length ? queue[index] : null
  const analysisParsed = parseAnalysis(current?.analysis ?? null)

  // 题干/选项/我的答案 结构化解析(钩子顺序稳定:提前 return 之前调用,空队列返回 null)
  const parsed = useMemo(() => {
    if (!current) return null
    const lines = current.content.split('\n').map((l) => l.trim()).filter(Boolean)
    const optRe = /^([A-H])[.、．]\s*(.*)$/
    const ansRe = /^我的答案[:：]\s*([A-H]?)/
    const options: Array<{ letter: string; text: string }> = []
    const marked = new Set<number>()
    let myAnswer: string | null = null
    lines.forEach((l, i) => {
      const om = l.match(optRe)
      if (om) {
        options.push({ letter: om[1], text: om[2] })
        marked.add(i)
        return
      }
      const am = l.match(ansRe)
      if (am) {
        myAnswer = am[1] || null
        marked.add(i)
      }
    })
    if (options.length < 2) return null
    const stem = lines.filter((_, i) => !marked.has(i)).join('\n')
    return { stem, options, myAnswer }
  }, [current?.content])

  // redo 可行性:重做模式 + 选项结构 + 解析里有答案字母(三者缺一 → 回落翻卡)
  const answerLetter = parseAnswerLetter(analysisParsed.answer)
  const canRedo = mode === 'redo' && !!parsed && !!answerLetter && !!current?.analysis

  /** 推进到下一张并重置全部卡内状态 */
  const advance = useCallback(() => {
    setIndex((i) => i + 1)
    resetCardStates()
  }, [resetCardStates])

  /** 评级提交(手动自评);成功即推进(flip 口径不变) */
  const handleRate = useCallback(
    async (rating: 'again' | 'good') => {
      if (!current || submitting) return
      setSubmitting(true)
      setVerifying(false)
      try {
        const res = await fetch('/api/study/review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ noteId: current.id, rating }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        advance()
        onChanged?.()
      } catch (err) {
        console.error('[ReviewCard] rate failed:', err)
        toast.error('提交失败,请重试', { title: '复习' })
      } finally {
        setSubmitting(false)
      }
    },
    [current, submitting, onChanged, advance],
  )

  /** 「想起来了」→ 先展开解析核对,再诚实评级;无解析的卡没有核对依据,直接计 good */
  const handleRemember = useCallback(() => {
    if (!current || submitting) return
    if (current.analysis) {
      setVerifying(true)
      setRevealed(true)
    } else {
      void handleRate('good')
    }
  }, [current, submitting, handleRate])

  /** redo 提交判分:对→good / 错→again,原位展示结果不推进 */
  const handleSubmitRedo = useCallback(async () => {
    if (!current || submitting || !selected) return
    setSubmitting(true)
    try {
      const correct = selected === answerLetter
      const res = await fetch('/api/study/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ noteId: current.id, rating: correct ? 'good' : 'again', source: 'redo' }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const d = (await res.json()) as { masteryBefore?: number; masteryAfter?: number }
      setJudged({
        picked: selected,
        correct,
        masteryBefore: d.masteryBefore ?? current.mastery,
        masteryAfter: d.masteryAfter ?? current.mastery,
      })
      setRevealed(true)
      onChanged?.()
    } catch (err) {
      console.error('[ReviewCard] redo submit failed:', err)
      toast.error('提交失败,请重试', { title: '复习' })
    } finally {
      setSubmitting(false)
    }
  }, [current, submitting, selected, answerLetter, onChanged])

  /** 「其实蒙的,算卡住」:答对后的诚实出口,补一次 Again 评级后推进 */
  const handleHonestAgain = useCallback(async () => {
    if (!current || submitting) return
    setSubmitting(true)
    try {
      const res = await fetch('/api/study/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ noteId: current.id, rating: 'again', source: 'redo' }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      advance()
      onChanged?.()
    } catch (err) {
      console.error('[ReviewCard] honest again failed:', err)
      toast.error('提交失败,请重试', { title: '复习' })
    } finally {
      setSubmitting(false)
    }
  }, [current, submitting, advance, onChanged])

  /** 「再来一道同考点」:题库按考点捞一道没做过的选择题(变式判分只在前端,不计 FSRS) */
  const loadVariant = useCallback(async () => {
    if (!current || submitting) return
    setSubmitting(true)
    try {
      const res = await fetch(`/api/study/variant?noteId=${current.id}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const d = (await res.json()) as {
        found: boolean
        reason?: string
        question?: { id: string; stem: string; answerLetter: string | null; analysis: string; topic: string | null; sourceRef: string | null }
      }
      if (!d.found || !d.question || !d.question.answerLetter) {
        toast.error('题库暂时没有这个考点的可练题,先过别的卡', { title: '变式' })
        return
      }
      const po = parseStemOptions(d.question.stem)
      if (!po) {
        toast.error('这道变式题缺选项结构,没法判分', { title: '变式' })
        return
      }
      setVariant({
        id: d.question.id,
        stem: po.stem,
        options: po.options,
        answerLetter: d.question.answerLetter,
        analysis: d.question.analysis,
        topic: d.question.topic,
        sourceRef: d.question.sourceRef,
      })
      setVariantSelected(null)
      setVariantJudged(null)
      setVariantSaved(false)
    } catch (err) {
      console.error('[ReviewCard] variant load failed:', err)
      toast.error('变式题加载失败', { title: '变式' })
    } finally {
      setSubmitting(false)
    }
  }, [current, submitting])

  /** 变式判分(纯前端):对错只影响展示与「存错题本」入口 */
  const submitVariant = useCallback(() => {
    if (!variant || !variantSelected) return
    setVariantJudged(variantSelected === variant.answerLetter)
  }, [variant, variantSelected])

  /** 变式答错一键入库(复用 /api/study/notes 的存入口径,后台 AI 打标兜底) */
  const saveVariantToNotes = useCallback(async () => {
    if (!variant || variantSaved || submitting) return
    setSubmitting(true)
    try {
      const questionText = [variant.stem, ...variant.options.map((o) => `${o.letter}. ${o.text}`)].join('\n')
      const res = await fetch('/api/study/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questionText,
          analysisText: `答案:${variant.answerLetter}\n${variant.analysis}`.slice(0, 2000),
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setVariantSaved(true)
      toast.success('已存入错题本,会自动进入复习队列', { title: '错题本' })
      onChanged?.()
    } catch (err) {
      console.error('[ReviewCard] save variant failed:', err)
      toast.error('存入失败,请重试', { title: '错题本' })
    } finally {
      setSubmitting(false)
    }
  }, [variant, variantSaved, submitting, onChanged])

  const handleDelete = useCallback(async () => {
    if (!current || submitting) return
    if (!(await confirmDialog({ title: '删除错题', message: '确定删除这道错题吗？', danger: true, okText: '删除' }))) return
    setSubmitting(true)
    try {
      const res = await fetch(`/api/study/notes/${current.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setQueue((prev) => prev.filter((n) => n.id !== current.id))
      setRevealed(false)
      setJudged(null)
      setSelected(null)
      setVariant(null)
      onChanged?.()
      // index 不动:删除后当前位次自动指向下一张
    } catch (err) {
      console.error('[ReviewCard] delete failed:', err)
      toast.error('删除失败', { title: '复习' })
    } finally {
      setSubmitting(false)
    }
  }, [current, submitting, onChanged])

  if (loading) {
    return <div className="h-full flex items-center justify-center text-xs text-content-muted">加载中...</div>
  }

  if (!current) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-center p-6">
        <div className="text-3xl">✓</div>
        <div className="text-sm text-content-primary">{mode === 'redo' ? '重做的都做完了' : '这批看完了'}</div>
        <button
          onClick={() => void load()}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-line text-xs text-content-secondary hover:text-content-primary hover:bg-surface-subtle transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          检查待回看
        </button>
      </div>
    )
  }

  const subjectLabel = current.subject ? SUBJECT_LABELS[current.subject as keyof typeof SUBJECT_LABELS] ?? '其他' : '未标注'

  /* ── 变式题渲染(盖在错题卡之上,判完回到队列) ── */
  if (variant) {
    return (
      /* h-full 封顶:同主卡,min-h-full 随内容长高会裁掉尾部且不可滚 */
      <div className="h-full flex flex-col max-w-2xl w-full mx-auto">
        <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-line/60">
          <span className="text-xs text-content-muted">{index + 1} / {queue.length}</span>
          <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-accent">变式 · 题库同考点</span>
          {variant.sourceRef && <span className="truncate text-[10px] text-content-muted">{variant.sourceRef}</span>}
          <div className="ml-auto" />
          <button
            onClick={() => setVariant(null)}
            className="p-1 rounded-md text-content-muted hover:text-content-primary hover:bg-surface-subtle transition-colors"
            title="放弃这道变式,回到当前错题"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-3.5 py-3.5">
          <div className="rounded-2xl border border-line bg-surface p-4 shadow-sm space-y-3">
            <div className="flex items-center gap-1.5 flex-wrap">
              {variant.topic && <span className="px-1.5 py-0.5 rounded bg-accent/10 text-[10px] text-accent">{variant.topic}</span>}
              <span className="ml-auto text-[10px] text-content-muted">不计入记忆排期</span>
            </div>
            <div className="text-[14px] font-medium text-content-primary leading-relaxed">
              <MathText text={variant.stem} />
            </div>
            <div className={cn('grid gap-2', variant.options.every((o) => o.text.length <= 14) ? 'grid-cols-2' : 'grid-cols-1')}>
              {variant.options.map((o) => {
                const mine = variantSelected === o.letter
                const isRight = variantJudged !== null && o.letter === variant.answerLetter
                const isWrongPick = variantJudged !== null && mine && o.letter !== variant.answerLetter
                return (
                  <button
                    key={o.letter}
                    type="button"
                    disabled={variantJudged !== null}
                    onClick={() => setVariantSelected(o.letter)}
                    className={cn(
                      'flex items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors disabled:cursor-default',
                      isRight ? 'border-accent bg-accent-soft' : isWrongPick ? 'border-destructive bg-destructive/10' :
                        mine ? 'border-accent/60 bg-accent-soft' : 'border-line/70 bg-surface hover:border-line-strong'
                    )}
                  >
                    <span
                      className={cn(
                        'flex-none flex items-center justify-center w-6 h-6 rounded-full text-[11px] font-bold',
                        mine || isRight ? 'bg-accent text-accent-foreground' : isWrongPick ? 'bg-destructive text-white' : 'bg-surface-subtle text-content-secondary'
                      )}
                    >
                      {o.letter}
                    </span>
                    <span className="min-w-0 flex-1 text-[13px] leading-relaxed text-content-secondary">
                      <MathText text={o.text} />
                    </span>
                  </button>
                )
              })}
            </div>

            {variantJudged !== null && (
              <>
                <div
                  className={cn(
                    'flex flex-wrap items-center gap-2 rounded-xl px-3 py-2.5 text-[13px] font-semibold',
                    variantJudged ? 'bg-accent-soft text-accent' : 'bg-destructive/10 text-destructive'
                  )}
                >
                  {variantJudged ? '答对了' : '答错了'}
                  <span className="ml-auto text-[10.5px] font-normal opacity-80">
                    正确答案 {variant.answerLetter}
                  </span>
                </div>
                <div className="rounded-xl border border-line/60 bg-surface-subtle/40 p-3 space-y-2">
                  <div className="text-[10px] text-content-muted">解析</div>
                  <div className="text-[13px] leading-[1.7] text-content-secondary">
                    <MathText text={variant.analysis} />
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={advance}
                    className="inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-1.5 text-xs font-medium text-accent-foreground transition-opacity hover:opacity-85"
                  >
                    下一张 ›
                  </button>
                  {!variantJudged && variantSelected !== variant.answerLetter && !variantSaved && (
                    <button
                      onClick={() => void saveVariantToNotes()}
                      disabled={submitting}
                      className="inline-flex items-center gap-1.5 rounded-full border border-line px-3.5 py-1.5 text-xs text-content-secondary transition-colors hover:text-content-primary hover:border-line-strong disabled:opacity-50 disabled:cursor-wait"
                    >
                      这道也不会,存入错题本
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        {variantJudged === null && (
          <div className="shrink-0 sticky bottom-0 z-10 grid grid-cols-2 gap-2 p-3 border-t border-line/60 bg-surface">
            <button
              onClick={() => setVariant(null)}
              disabled={submitting}
              className="py-2.5 rounded-full text-sm font-semibold border border-line text-content-secondary transition-all active:scale-[0.98] touch-manipulation hover:bg-surface-subtle disabled:opacity-50 disabled:cursor-wait"
            >
              放弃这次
            </button>
            <button
              onClick={submitVariant}
              disabled={!variantSelected || submitting}
              className="py-2.5 rounded-full text-sm font-semibold bg-accent text-accent-foreground transition-all active:scale-[0.98] touch-manipulation disabled:opacity-50 disabled:cursor-wait"
            >
              提交答案
            </button>
          </div>
        )}
      </div>
    )
  }

  /* ── 正常错题卡(flip 或 redo) ── */
  const showRedo = canRedo && !!parsed && !!answerLetter

  return (
    /* h-full 封顶给卡体让出滚动条件(min-h-full 会随内容长高,长解析被 overflow-hidden 裁掉且不可滚) */
    <div className="h-full flex flex-col max-w-2xl w-full mx-auto">
      {/* 头部:进度 + 模式/考点筛选 + 刷新 + 删除 */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-line/60">
        <span className="text-xs text-content-muted">
          {index + 1} / {queue.length}
        </span>
        {mode === 'redo' && (
          <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-accent">重做练习</span>
        )}
        {topicFilter && (
          <button
            type="button"
            onClick={onClearTopic}
            title="清除考点筛选,回到完整队列"
            className="flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-accent transition-opacity hover:opacity-80"
          >
            {topicFilter} ✕
          </button>
        )}
        <div className="flex-1 h-1 rounded-full bg-surface-subtle overflow-hidden">
          <div
            className="h-full rounded-full bg-accent/70 transition-all"
            style={{ width: `${(index / queue.length) * 100}%` }}
          />
        </div>
        <button
          onClick={() => void load()}
          className="p-1 rounded-md text-content-muted hover:text-content-primary hover:bg-surface-subtle transition-colors"
          title="重新加载队列"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => void handleDelete()}
          className="p-1 rounded-md text-content-muted hover:text-red-400 hover:bg-surface-subtle transition-colors"
          title="删除这道错题"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* 卡片主体(唯一滚动层;min-h-0 必须有,flex 子项默认 min-height:auto 会顶爆滚动) */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3.5 py-3.5">
        <div className="rounded-2xl border border-line bg-surface p-4 shadow-sm space-y-3">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="px-1.5 py-0.5 rounded bg-surface-subtle text-[10px] text-content-secondary">{subjectLabel}</span>
            {current.topic && (
              <span className="px-1.5 py-0.5 rounded bg-accent/10 text-[10px] text-accent">{current.topic}</span>
            )}
            {current.sourceQuestionId && (
              <span className="px-1.5 py-0.5 rounded border border-line/60 text-[10px] text-content-muted" title="来自题库练习">题库</span>
            )}
            <span className="ml-auto text-[10px] text-content-muted">
              {judged
                ? `掌握 ${Math.round(judged.masteryBefore * 100)}% → ${Math.round(judged.masteryAfter * 100)}%`
                : `掌握 ${Math.round(current.mastery * 100)}% · 第 ${current.reps + 1} 次`}
            </span>
          </div>
          {current.imageUrl && (
            <a
              href={current.imageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block rounded-xl overflow-hidden border border-line/60 bg-surface-subtle/30"
              title="点击查看原图"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={current.imageUrl}
                alt="题目截图"
                loading="lazy"
                className="block w-full max-h-72 object-contain"
              />
            </a>
          )}

          {showRedo && parsed ? (
            /* ── redo 答题态:遮住「我的答案」标记,选项可点,提交客观判分 ── */
            <>
              <div className="text-[14px] font-medium text-content-primary leading-relaxed">
                <MathText text={parsed.stem} />
              </div>
              <div className={cn('grid gap-2', parsed.options.every((o) => o.text.length <= 14) ? 'grid-cols-2' : 'grid-cols-1')}>
                {parsed.options.map((o) => {
                  const mine = selected === o.letter
                  const isRight = judged !== null && o.letter === answerLetter
                  const isWrongPick = judged !== null && mine && o.letter !== answerLetter
                  return (
                    <button
                      key={o.letter}
                      type="button"
                      disabled={judged !== null}
                      onClick={() => setSelected(o.letter)}
                      className={cn(
                        'flex items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors disabled:cursor-default',
                        isRight ? 'border-accent bg-accent-soft' : isWrongPick ? 'border-destructive bg-destructive/10' :
                          mine ? 'border-accent/60 bg-accent-soft' : 'border-line/70 bg-surface hover:border-line-strong'
                      )}
                    >
                      <span
                        className={cn(
                          'flex-none flex items-center justify-center w-6 h-6 rounded-full text-[11px] font-bold',
                          mine || isRight ? 'bg-accent text-accent-foreground' : isWrongPick ? 'bg-destructive text-white' : 'bg-surface-subtle text-content-secondary'
                        )}
                      >
                        {o.letter}
                      </span>
                      <span className="min-w-0 flex-1 text-[13px] leading-relaxed text-content-secondary">
                        <MathText text={o.text} />
                      </span>
                    </button>
                  )
                })}
              </div>

              {judged ? (
                <>
                  <div
                    className={cn(
                      'flex flex-wrap items-center gap-2 rounded-xl px-3 py-2.5 text-[13px] font-semibold',
                      judged.correct ? 'bg-accent-soft text-accent' : 'bg-destructive/10 text-destructive'
                    )}
                  >
                    {judged.correct ? '答对了' : '答错了'}
                    <span className="text-[10.5px] font-normal opacity-80">
                      你的答案 {judged.picked} · 正确答案 {answerLetter} · 自动记{judged.correct ? '「想起来了」' : '「卡住了」'}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => void loadVariant()}
                      disabled={submitting}
                      title="题库同考点再练一道,防背答案"
                      className="inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-1.5 text-xs font-medium text-accent-foreground transition-opacity hover:opacity-85 disabled:opacity-50 disabled:cursor-wait"
                    >
                      再来一道同考点
                    </button>
                    <button
                      onClick={advance}
                      disabled={submitting}
                      className="inline-flex items-center gap-1.5 rounded-full border border-line px-3.5 py-1.5 text-xs text-content-secondary transition-colors hover:text-content-primary hover:border-line-strong disabled:opacity-50"
                    >
                      下一张 ›
                    </button>
                    {judged.correct && (
                      <button
                        onClick={() => void handleHonestAgain()}
                        disabled={submitting}
                        title="刚才是蒙的:补记一次「卡住了」,明天优先再来"
                        className="text-[11px] text-content-muted underline decoration-dotted underline-offset-2 transition-colors hover:text-content-primary disabled:opacity-50"
                      >
                        其实蒙的,算卡住
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="text-[11px] text-content-muted">选定后提交判分:对 → 自动记「想起来了」,错 → 自动记「卡住了」,不再依赖自评</div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => void handleSubmitRedo()}
                      disabled={!selected || submitting}
                      className="inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-1.5 text-xs font-medium text-accent-foreground transition-opacity hover:opacity-85 disabled:opacity-50 disabled:cursor-wait"
                    >
                      提交答案
                    </button>
                    {revealed ? (
                      <button
                        onClick={advance}
                        className="inline-flex items-center gap-1.5 rounded-full border border-line px-3.5 py-1.5 text-xs text-content-secondary transition-colors hover:text-content-primary hover:border-line-strong"
                      >
                        跳过这卡,下一张 ›
                      </button>
                    ) : (
                      <button
                        onClick={() => setRevealed(true)}
                        className="inline-flex items-center gap-1.5 rounded-full border border-line px-3.5 py-1.5 text-xs text-content-secondary transition-colors hover:text-content-primary hover:border-line-strong"
                      >
                        看解析跳过
                      </button>
                    )}
                  </div>
                </>
              )}
            </>
          ) : parsed ? (
            /* ── flip:展示题干+选项+「我的答案」标记(原口径) ── */
            <>
              <div className="text-[14px] font-medium text-content-primary leading-relaxed">
                <MathText text={parsed.stem} />
              </div>
              <div className={cn('grid gap-2', parsed.options.every((o) => o.text.length <= 14) ? 'grid-cols-2' : 'grid-cols-1')}>
                {parsed.options.map((o) => {
                  const mine = parsed.myAnswer === o.letter
                  return (
                    <div
                      key={o.letter}
                      className={cn(
                        'flex items-start gap-2.5 rounded-xl border px-3 py-2 transition-colors',
                        mine ? 'border-accent/60 bg-accent-soft' : 'border-line/70 bg-surface'
                      )}
                    >
                      <span
                        className={cn(
                          'flex-none flex items-center justify-center w-6 h-6 rounded-full text-[11px] font-bold',
                          mine ? 'bg-accent text-accent-foreground' : 'bg-surface-subtle text-content-secondary'
                        )}
                      >
                        {o.letter}
                      </span>
                      <span className="min-w-0 flex-1 text-[13px] leading-relaxed text-content-secondary">
                        <MathText text={o.text} />
                      </span>
                      {mine && (
                        <span className="flex-none self-center text-[10px] font-medium text-accent">我的答案</span>
                      )}
                    </div>
                  )
                })}
              </div>
              {!parsed.myAnswer && (
                <div className="text-xs text-content-muted">未记录作答</div>
              )}
            </>
          ) : (
            /* ── 自由文本卡(无选项结构) ── */
            <>
              <div className="text-sm font-medium text-content-primary leading-relaxed">{current.title}</div>
              <div className="text-sm text-content-secondary whitespace-pre-wrap break-words leading-relaxed">
                {current.content}
              </div>
            </>
          )}

          {/* redo 模式下无法客观判分的卡给一行说明 */}
          {mode === 'redo' && !showRedo && (
            <div className="text-[11px] text-content-muted">这卡没法客观判分(缺选项或答案字母),按翻卡过</div>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            {onRestudy && !showRedo && (
              <button
                type="button"
                onClick={() => onRestudy({ id: current.id, title: current.title, content: current.content, imageUrl: current.imageUrl })}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-accent text-accent-foreground text-xs font-medium transition-opacity hover:opacity-85"
              >
                重新学这道
              </button>
            )}
            {onDrill && !showRedo && (
              <button
                type="button"
                onClick={() => onDrill({ id: current.id, title: current.title, content: current.content, imageUrl: current.imageUrl })}
                title="围绕这个考点连续出变式题练手"
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border border-line text-xs font-medium text-content-secondary transition-colors hover:text-content-primary hover:border-line-strong"
              >
                举一反三
              </button>
            )}
            {current.analysis && !showRedo ? (
              revealed ? null : (
                <button
                  onClick={() => setRevealed(true)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border border-line text-xs text-content-secondary hover:text-content-primary hover:bg-surface-subtle transition-colors"
                >
                  <Eye className="w-3.5 h-3.5" />
                  显示解析
                </button>
              )
            ) : !showRedo ? (
              <span className="text-xs text-content-muted">暂无解析(可在列表中回顾后自行总结)</span>
            ) : null}
          </div>

          {current.analysis && revealed && (
            <div className="rounded-xl border border-line/60 bg-surface-subtle/40 p-3 space-y-2">
              <div className="text-[10px] text-content-muted">解析</div>
              {analysisParsed.answer && (
                <div className="text-[13px] font-semibold text-content-primary">
                  答案:<span className="text-accent">{analysisParsed.answer}</span>
                </div>
              )}
              {analysisParsed.body && (
                <div className="text-[13px] leading-[1.7] text-content-secondary">
                  {/* 解析正文是学新讲义同源的 markdown+$$ 文本,MathText 只认 \( \) LaTeX,
                      加粗/标题等 markdown 标记会裸穿(A14),走聊天侧富渲染 */}
                  <MarkdownRenderer content={analysisParsed.body} rich />
                </div>
              )}
              {analysisParsed.source && (
                <div className="text-[11px] text-content-muted">出处:{analysisParsed.source}</div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 底部自评:flip 全程;redo 仅在不可判分卡上出现(可判分卡的操作行内联在卡内)。
          「想起来了」走核对式——先展开解析对照,再诚实评级 */}
      {(mode === 'flip' || !showRedo) &&
        (verifying ? (
          // 实底垫 bg-surface,防长解析从半透明条下穿出;蓝染走 accent token(裸 rgba 会深色串色)
          <div className="shrink-0 sticky bottom-0 z-10 border-t border-line/60 bg-surface bg-[linear-gradient(to_top,rgb(var(--accent)/0.10),rgb(var(--accent)/0.03))] p-3 space-y-2.5">
            <div className="text-center text-[13px] text-content-primary">
              对照解析——刚才是<b className="font-semibold">真想起来了</b>,还是只是<b className="font-semibold">眼熟</b>?
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => void handleRate('again')}
                disabled={submitting}
                className={cn(
                  'py-2.5 rounded-full text-sm font-semibold border transition-all active:scale-[0.98] touch-manipulation',
                  'border-red-300/40 text-red-500 hover:bg-red-500/5 disabled:opacity-50 disabled:cursor-wait',
                )}
              >
                其实卡住了
              </button>
              <button
                onClick={() => void handleRate('good')}
                disabled={submitting}
                className={cn(
                  'py-2.5 rounded-full text-sm font-semibold border transition-all active:scale-[0.98] touch-manipulation',
                  'border-accent/40 text-accent hover:bg-accent/5 disabled:opacity-50 disabled:cursor-wait',
                )}
              >
                真会,秒出来的
              </button>
            </div>
          </div>
        ) : (
          <div className="shrink-0 sticky bottom-0 z-10 grid grid-cols-2 gap-2 p-3 border-t border-line/60 bg-surface">
            <button
              onClick={() => void handleRate('again')}
              disabled={submitting}
              className={cn(
                'py-2.5 rounded-full text-sm font-semibold border transition-all active:scale-[0.98] touch-manipulation',
                'border-red-300/40 text-red-500 hover:bg-red-500/5 disabled:opacity-50 disabled:cursor-wait',
              )}
            >
              卡住了
            </button>
            <button
              onClick={handleRemember}
              disabled={submitting}
              className={cn(
                'py-2.5 rounded-full text-sm font-semibold border transition-all active:scale-[0.98] touch-manipulation',
                'border-accent/40 text-accent hover:bg-accent/5 disabled:opacity-50 disabled:cursor-wait',
              )}
            >
              想起来了
            </button>
          </div>
        ))}
    </div>
  )
}
