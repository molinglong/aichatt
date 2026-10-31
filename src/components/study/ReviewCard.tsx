'use client'

import { useCallback, useEffect, useState } from 'react'
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

export function ReviewCard({ onChanged }: { onChanged?: () => void }) {
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
    <div className="h-full flex flex-col max-w-2xl w-full mx-auto">
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
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        <div className="flex items-center gap-1.5">
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
        <div className="text-sm font-medium text-content-primary leading-relaxed">{current.title}</div>
        <div className="text-sm text-content-secondary whitespace-pre-wrap break-words leading-relaxed">
          {current.content}
        </div>

        {current.analysis ? (
          revealed ? (
            <div className="rounded-xl border border-line/60 bg-surface-subtle/40 p-3">
              <div className="text-[10px] text-content-muted mb-1.5">解析</div>
              <MarkdownRenderer content={current.analysis} messageId={`review-${current.id}`} rich />
            </div>
          ) : (
            <button
              onClick={() => setRevealed(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-line text-xs text-content-secondary hover:text-content-primary hover:bg-surface-subtle transition-colors"
            >
              <Eye className="w-3.5 h-3.5" />
              显示解析
            </button>
          )
        ) : (
          <div className="text-xs text-content-muted">暂无解析(可在列表中回顾后自行总结)</div>
        )}
      </div>

      {/* 底部 2 键自评 */}
      <div className="shrink-0 grid grid-cols-2 gap-2 p-3 border-t border-line/60">
        <button
          onClick={() => void handleRate('again')}
          disabled={submitting}
          className={cn(
            'py-2.5 rounded-xl text-sm font-medium border transition-all active:scale-[0.98] touch-manipulation',
            'border-red-300/40 text-red-500 hover:bg-red-500/5 disabled:opacity-50 disabled:cursor-wait',
          )}
        >
          卡住了
        </button>
        <button
          onClick={() => void handleRate('good')}
          disabled={submitting}
          className={cn(
            'py-2.5 rounded-xl text-sm font-medium border transition-all active:scale-[0.98] touch-manipulation',
            'border-accent/40 text-accent hover:bg-accent/5 disabled:opacity-50 disabled:cursor-wait',
          )}
        >
          想起来了
        </button>
      </div>
    </div>
  )
}
