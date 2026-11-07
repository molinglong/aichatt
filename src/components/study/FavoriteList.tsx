'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { Bot, ExternalLink, RefreshCw, Search, Star, Trash2, User } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer'
import { confirmDialog } from '@/components/ui/ConfirmDialog'
import type { Attachment } from '@/lib/attachment-types'

interface FavoriteRow {
  id: string
  sourceMessageId: string | null
  conversationId: string | null
  conversationTitle: string | null
  role: string
  title: string
  content: string
  attachments: unknown[]
  imageUrl: string | null
  createdAt: string
}

function toAttachments(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (a): a is Attachment =>
      !!a && typeof (a as Attachment).url === 'string' && typeof (a as Attachment).name === 'string'
  )
}

function formatDate(raw: string): string {
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 收藏列表(消息快照)。
 *
 * 与错题本(NoteList)分开:没有掌握度/复习状态,只做"回看 + 回到原对话 + 取消收藏"。
 * 收藏在服务端是软关联,原消息/会话删除后本列表仍可完整展示。
 */
export function FavoriteList({
  onChanged,
  /** 跳回原对话前回调（收藏浮层用它先关掉自己再导航） */
  onBeforeNavigate,
  /** 导航出口注入：移动端浮层内必须走 useBackToClose 的 navigate（否则导航会被哨兵取消），不传则默认 router.push */
  navigateToConversation,
}: {
  onChanged?: () => void
  onBeforeNavigate?: () => void
  navigateToConversation?: (conversationId: string) => void
}) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [rows, setRows] = useState<FavoriteRow[]>([])
  const [loading, setLoading] = useState(true)
  const [role, setRole] = useState('') // '' = 全部
  const [q, setQ] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (role) params.set('role', role)
      if (q.trim()) params.set('q', q.trim())
      const res = await fetch(`/api/favorites?${params.toString()}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setRows(Array.isArray(data) ? data : [])
    } catch (err) {
      console.error('[FavoriteList] load failed:', err)
      toast.error('加载收藏列表失败', { title: '收藏' })
    } finally {
      setLoading(false)
    }
    // 只依赖 role(切换即刷);关键字由表单提交触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role])

  useEffect(() => {
    void load()
  }, [load])

  const handleDelete = useCallback(async (id: string) => {
    if (
      !(await confirmDialog({
        title: '取消收藏',
        message: '确定从收藏中移除这条消息吗？',
        detail: '只影响收藏列表，不会删除原对话消息。',
        danger: true,
        okText: '移除',
      }))
    ) {
      return
    }
    try {
      const res = await fetch(`/api/favorites/${id}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)
      setRows((prev) => prev.filter((r) => r.id !== id))
      void queryClient.invalidateQueries({ queryKey: ['favorites', 'count'] })
      onChanged?.()
      toast.hint('已取消收藏')
    } catch (err) {
      console.error('[FavoriteList] delete failed:', err)
      toast.error('取消收藏失败', { title: '收藏' })
    }
  }, [queryClient, onChanged])

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
              placeholder="搜索收藏内容"
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
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="w-full px-2 py-1.5 rounded-lg bg-surface-subtle/60 border border-line/60 text-xs text-content-secondary outline-none cursor-pointer"
        >
          <option value="">全部来源</option>
          <option value="user">我的提问</option>
          <option value="assistant">AI 回答</option>
        </select>
      </div>

      {/* 列表 */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {loading && rows.length === 0 && (
          <div className="py-10 text-center text-xs text-content-muted">加载中...</div>
        )}
        {!loading && rows.length === 0 && (
          <div className="py-10 text-center text-xs text-content-muted">
            还没有收藏
            <br />
            <span className="opacity-70">在聊天消息的操作栏点星标即可收藏</span>
          </div>
        )}
        {rows.map((row) => {
          const expanded = expandedId === row.id
          const attachments = toAttachments(row.attachments)
          const images = attachments.filter((a) => a.type.startsWith('image/'))
          const files = attachments.filter((a) => !a.type.startsWith('image/'))
          return (
            <div key={row.id} className="rounded-lg border border-line/60 hover:border-line transition-colors">
              <button
                onClick={() => setExpandedId(expanded ? null : row.id)}
                className="w-full text-left px-2.5 py-2 space-y-1"
              >
                <div className="flex items-center gap-1.5">
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface-subtle text-[10px] text-content-secondary shrink-0">
                    {row.role === 'user' ? <User className="w-2.5 h-2.5" /> : <Bot className="w-2.5 h-2.5" />}
                    {row.role === 'user' ? '提问' : '回答'}
                  </span>
                  {row.conversationTitle && (
                    <span className="text-[10px] text-content-muted truncate">
                      {row.conversationTitle}
                    </span>
                  )}
                  <span className="ml-auto text-[10px] text-content-muted shrink-0">
                    {formatDate(row.createdAt)}
                  </span>
                </div>
                <div className="text-xs text-content-primary leading-snug line-clamp-2">{row.title}</div>
                {images.length > 0 && (
                  <div className="flex items-center gap-1 text-[10px] text-content-muted">
                    <span className="px-1.5 py-0.5 rounded border border-line/60">图片 {images.length}</span>
                  </div>
                )}
              </button>

              {expanded && (
                <div className="px-2.5 pb-2.5 space-y-2 border-t border-line/40 pt-2">
                  {images.length > 0 && (
                    <div className="space-y-1.5">
                      {images.map((img) => (
                        <a
                          key={img.url}
                          href={img.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block rounded-lg overflow-hidden border border-line/60 bg-surface-subtle/30"
                          title="点击查看原图"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={img.url}
                            alt={img.name || '收藏图片'}
                            loading="lazy"
                            className="block w-full max-h-64 object-contain"
                          />
                        </a>
                      ))}
                    </div>
                  )}
                  {files.length > 0 && (
                    <div className="space-y-1">
                      {files.map((file) => (
                        <a
                          key={file.url}
                          href={file.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1.5 text-[11px] text-accent hover:underline break-all"
                        >
                          <ExternalLink className="w-3 h-3 shrink-0" />
                          {file.name || '附件'}
                        </a>
                      ))}
                    </div>
                  )}
                  {row.role === 'assistant' ? (
                    <div className="rounded-lg bg-surface-subtle/50 p-2.5">
                      <MarkdownRenderer content={row.content} messageId={`favorite-${row.id}`} rich />
                    </div>
                  ) : (
                    <div className="text-xs text-content-secondary whitespace-pre-wrap break-words leading-relaxed">
                      {row.content}
                    </div>
                  )}
                  <div className="flex items-center justify-end gap-1">
                    {row.conversationId && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          const convId = row.conversationId
                          if (!convId) return
                          onBeforeNavigate?.()
                          if (navigateToConversation) navigateToConversation(convId)
                          else router.push(`/chat/c/${convId}`)
                        }}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-content-muted hover:text-content-primary hover:bg-surface-subtle transition-colors"
                        title="回到原对话"
                      >
                        <ExternalLink className="w-3 h-3" />
                        回到原对话
                      </button>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        void handleDelete(row.id)
                      }}
                      className="p-1 rounded-md text-content-muted hover:text-red-400 hover:bg-surface-subtle transition-colors"
                      title="取消收藏"
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
