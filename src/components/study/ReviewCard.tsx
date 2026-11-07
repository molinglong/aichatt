'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, Trash2, Eye } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer'
import { SUBJECT_LABELS } from '@/lib/study/subject-labels'
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

export function ReviewCard({ onChanged, onRestudy }: { onChanged?: () => void; onRestudy?: (note: { id: string; title: string; content: string; imageUrl?: string | null }) => void }) {
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [index, setIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const [revealed, setRevealed] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setIndex(0)
    setRevealed(false)
    try {
      const res = await fetch('/api/study/queue')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setQueue(await res.json())
    } catch (err) {
      console.error('[ReviewCard] load failed:', err)
      toast.error('加载复习队列失败', { title: '复习' })
      setQueue([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const current = index < queue.length ? queue[index] : null

  // 题干/选项/我的答案 结构化解析(变式题与题库题都有此结构;自由文本回落普通渲染)
  // ⚠ 必须在提前 return 之前调用(钩子顺序稳定),空队列时返回 null
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

  const handleRate = useCallback(
    async (rating: 'again' | 'good') => {
      if (!current || submitting) return
      setSubmitting(true)
      try {
        const res = await fetch('/api/study/review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ noteId: current.id, rating }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        setRevealed(false)
        setIndex((i) => i + 1)
        onChanged?.()
      } catch (err) {
        console.error('[ReviewCard] rate failed:', err)
        toast.error('提交失败,请重试', { title: '复习' })
      } finally {
        setSubmitting(false)
      }
    },
    [current, submitting, onChanged],
  )

  const handleDelete = useCallback(async () => {
    if (!current || submitting) return
    if (!(await confirmDialog({ title: '删除错题', message: '确定删除这道错题吗？', danger: true, okText: '删除' }))) return
    setSubmitting(true)
    try {
      const res = await fetch(`/api/study/notes/${current.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setQueue((prev) => prev.filter((n) => n.id !== current.id))
      setRevealed(false)
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
        <div className="text-sm text-content-primary">这批看完了</div>
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

  return (
    <div className="min-h-full flex flex-col max-w-2xl w-full mx-auto">
      {/* 头部:进度 + 刷新 + 删除 */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-line/60">
        <span className="text-xs text-content-muted">
          {index + 1} / {queue.length}
        </span>
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

      {/* 卡片主体 */}
      <div className="flex-1 overflow-y-auto px-3.5 py-3.5">
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
              掌握 {Math.round(current.mastery * 100)}% · 第 {current.reps + 1} 次
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

          {parsed ? (
            <>
              <div className="text-sm font-medium text-content-primary leading-relaxed whitespace-pre-wrap">{parsed.stem}</div>
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
                      <span className="min-w-0 flex-1 text-[13px] leading-relaxed text-content-secondary">{o.text}</span>
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
            <>
              <div className="text-sm font-medium text-content-primary leading-relaxed">{current.title}</div>
              <div className="text-sm text-content-secondary whitespace-pre-wrap break-words leading-relaxed">
                {current.content}
              </div>
            </>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            {onRestudy && (
              <button
                type="button"
                onClick={() => onRestudy({ id: current.id, title: current.title, content: current.content, imageUrl: current.imageUrl })}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-accent text-accent-foreground text-xs font-medium transition-opacity hover:opacity-85"
              >
                🎓 重新学这道
              </button>
            )}
            {current.analysis ? (
              revealed ? null : (
                <button
                  onClick={() => setRevealed(true)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full border border-line text-xs text-content-secondary hover:text-content-primary hover:bg-surface-subtle transition-colors"
                >
                  <Eye className="w-3.5 h-3.5" />
                  显示解析
                </button>
              )
            ) : (
              <span className="text-xs text-content-muted">暂无解析(可在列表中回顾后自行总结)</span>
            )}
          </div>

          {current.analysis && revealed && (
            <div className="rounded-xl border border-line/60 bg-surface-subtle/40 p-3">
              <div className="text-[10px] text-content-muted mb-1.5">解析</div>
              <MarkdownRenderer content={current.analysis} messageId={`review-${current.id}`} rich />
            </div>
          )}
        </div>
      </div>

      {/* 底部 2 键自评:sticky 常驻抽屉底部,浏览题干时也能直接自评 */}
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
          onClick={() => void handleRate('good')}
          disabled={submitting}
          className={cn(
            'py-2.5 rounded-full text-sm font-semibold border transition-all active:scale-[0.98] touch-manipulation',
            'border-accent/40 text-accent hover:bg-accent/5 disabled:opacity-50 disabled:cursor-wait',
          )}
        >
          想起来了
        </button>
      </div>
    </div>
  )
}
