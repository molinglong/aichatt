'use client'

import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, Search, Trash2 } from 'lucide-react'
import { cn, expandSingleNewlines } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer'
import { SUBJECT_LABELS } from '@/lib/study/subject-labels'
import { confirmDialog } from '@/components/ui/ConfirmDialog'

interface NoteRow {
  id: string
  subject: string | null
  topic: string | null
  title: string
  content: string
  imageUrl: string | null
  analysis: string | null
  mastery: number
  dueAt: string | null
  reps: number
  lapses: number
  createdAt: string
  sourceQuestionId: string | null
}

export function NoteList({ onChanged }: { onChanged?: () => void }) {
  const [notes, setNotes] = useState<NoteRow[]>([])
  const [loading, setLoading] = useState(true)
  const [subject, setSubject] = useState('') // '' = 全部
  const [q, setQ] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [retaggingId, setRetaggingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (subject) params.set('subject', subject)
      if (q.trim()) params.set('q', q.trim())
      const res = await fetch(`/api/study/notes?${params.toString()}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setNotes(await res.json())
    } catch (err) {
      console.error('[NoteList] load failed:', err)
      toast.error('加载错题列表失败', { title: '错题本' })
    } finally {
      setLoading(false)
    }
    // 只依赖 subject(学科切换即刷);关键字搜索由表单提交触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subject])

  useEffect(() => {
    void load()
  }, [load])

  const handleDelete = useCallback(async (id: string) => {
    if (!(await confirmDialog({ title: '删除错题', message: '确定删除这道错题吗？', detail: '复习记录会一并删除。', danger: true, okText: '删除' }))) return
    try {
      const res = await fetch(`/api/study/notes/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setNotes((prev) => prev.filter((n) => n.id !== id))
      toast.hint('已删除')
      onChanged?.()
    } catch (err) {
      console.error('[NoteList] delete failed:', err)
      toast.error('删除失败', { title: '错题本' })
    }
  }, [onChanged])

  const handleRetag = useCallback(async (id: string) => {
    if (retaggingId) return
    setRetaggingId(id)
    try {
      const res = await fetch(`/api/study/notes/${id}/retag`, { method: 'POST' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      toast.success('已重新标注')
      await load()
      onChanged?.()
    } catch (err) {
      console.error('[NoteList] retag failed:', err)
      toast.error('标注失败，请稍后再试', { title: '错题本' })
    } finally {
      setRetaggingId(null)
    }
  }, [retaggingId, load, onChanged])

  const isOverdue = (dueAt: string | null) => !!dueAt && new Date(dueAt).getTime() <= Date.now()

  return (
    <div className="flex flex-col h-full">
      {/* 筛选栏 */}
      <div className="shrink-0 p-3 border-b border-line space-y-2">
        <div className="flex items-center gap-2">
          <form
            className="flex-1 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-surface-subtle/60 border border-line/60"
            onSubmit={(e) => {
              e.preventDefault()
              void load()
            }}
          >
            <Search className="w-3.5 h-3.5 text-content-muted shrink-0" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索题干/考点"
              className="flex-1 min-w-0 bg-transparent text-xs text-content-primary outline-none placeholder:text-content-muted"
            />
          </form>
          <button
            onClick={() => void load()}
            className="p-1.5 rounded-lg text-content-muted hover:text-content-primary hover:bg-surface-subtle transition-colors"
            title="刷新"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
          </button>
        </div>
        <select
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          className="w-full px-2 py-1.5 rounded-lg bg-surface-subtle/60 border border-line/60 text-xs text-content-secondary outline-none cursor-pointer"
        >
          <option value="">全部学科</option>
          {Object.entries(SUBJECT_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </div>

      {/* 列表 */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {loading && notes.length === 0 && (
          <div className="py-10 text-center text-xs text-content-muted">加载中...</div>
        )}
        {!loading && notes.length === 0 && (
          <div className="py-10 text-center text-xs text-content-muted">
            还没有错题
            <br />
            <span className="opacity-70">
              结课后会自动收进这里；也可以右键消息手动存入
            </span>
          </div>
        )}
        {notes.map((n) => {
          const expanded = expandedId === n.id
          const subjectLabel = n.subject ? SUBJECT_LABELS[n.subject as keyof typeof SUBJECT_LABELS] ?? '其他' : '未标注'
          return (
            <div key={n.id} className="rounded-lg border border-line/60 hover:border-line transition-colors">
              <button
                onClick={() => setExpandedId(expanded ? null : n.id)}
                className="w-full text-left px-2.5 py-2 space-y-1"
              >
                <div className="flex items-center gap-1.5">
                  <span className="px-1.5 py-0.5 rounded bg-surface-subtle text-[10px] text-content-secondary shrink-0">
                    {subjectLabel}
                  </span>
                  {n.topic && (
                    <span className="px-1.5 py-0.5 rounded bg-accent/10 text-[10px] text-accent truncate">
                      {n.topic}
                    </span>
                  )}
                  {n.sourceQuestionId && (
                    <span className="px-1.5 py-0.5 rounded border border-line/60 text-[10px] text-content-muted shrink-0" title="来自题库练习">题库</span>
                  )}
                  {n.imageUrl && (
                    <span className="px-1.5 py-0.5 rounded border border-line/60 text-[10px] text-content-muted shrink-0" title="题目带截图">截图</span>
                  )}
                  {isOverdue(n.dueAt) && (
                    <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0 ml-auto" title="待复习" />
                  )}
                </div>
                <div className="text-xs text-content-primary leading-snug line-clamp-2">{n.title}</div>
                <div className="flex items-center gap-2 text-[10px] text-content-muted">
                  <span>复习 {n.reps} 次</span>
                  {n.lapses > 0 && <span className="text-red-400/80">遗忘 {n.lapses}</span>}
                  {/* 掌握度条 */}
                  <span className="flex-1 h-1 rounded-full bg-surface-subtle overflow-hidden">
                    <span
                      className="block h-full rounded-full bg-accent/70"
                      style={{ width: `${Math.round(n.mastery * 100)}%` }}
                    />
                  </span>
                </div>
              </button>
              {expanded && (
                <div className="px-2.5 pb-2.5 space-y-2 border-t border-line/40 pt-2">
                  {n.imageUrl && (
                    <a
                      href={n.imageUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block rounded-lg overflow-hidden border border-line/60 bg-surface-subtle/30"
                      title="点击查看原图"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={n.imageUrl}
                        alt="题目截图"
                        loading="lazy"
                        className="block w-full max-h-64 object-contain"
                      />
                    </a>
                  )}
                  <div className="text-xs text-content-secondary whitespace-pre-wrap break-words leading-relaxed">
                    {n.content}
                  </div>
                  {n.analysis && (
                    <div className="rounded-lg bg-surface-subtle/50 p-2.5">
                      <div className="text-[10px] text-content-muted mb-1">AI 解析</div>
                      <div className="[&_.rich-md]:text-[13px] [&_.rich-md]:leading-[1.7] [&_.rich-md_p]:mb-2">
                        <MarkdownRenderer content={expandSingleNewlines(n.analysis)} messageId={`study-${n.id}`} rich />
                      </div>
                    </div>
                  )}
                  <div className="flex items-center justify-end gap-1">
                    {!n.subject && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleRetag(n.id)
                        }}
                        disabled={retaggingId === n.id}
                        className="flex items-center gap-1 px-1.5 py-1 rounded-md text-[10px] text-content-muted hover:text-content-primary hover:bg-surface-subtle transition-colors disabled:opacity-50"
                        title="重新打标"
                      >
                        <RefreshCw className={cn('w-3 h-3', retaggingId === n.id && 'animate-spin')} />
                        重试标注
                      </button>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        void handleDelete(n.id)
                      }}
                      className="p-1 rounded-md text-content-muted hover:text-red-400 hover:bg-surface-subtle transition-colors"
                      title="删除"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
