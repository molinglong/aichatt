'use client'

/**
 * 学习台(E+ 三宫格方案):打开 /study 的第一屏。
 * 复习先来找你(到期卡)、然后是「继续上次」与「学新题」;底部输入框直接开讲。
 * 左栏为学习会话自己的历史(与聊天列表彻底分家)。
 */
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'

export interface StudySessionListItem {
  id: string
  question: string
  status: 'explaining' | 'completed'
  stepCount: number
  updatedAt: string
}

interface Props {
  sessions: StudySessionListItem[]
  dueCount: number
  noteCount: number
  favoriteCount: number
  kbCount: number
  loading: boolean
  onResume: (id: string) => void
  /** text = 输入框里已敲的题目,带进 setup 预填 */
  onNew: (text?: string) => void
  onOpenDrawer: (tab: 'review' | 'notes' | 'favorites') => void
}

function shortTitle(q: string): string {
  return q.replace(/[#*`>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24) || '未命名题目'
}

function dateLabel(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}-${d.getDate()}`
}

export function StudyHome({ sessions, dueCount, noteCount, favoriteCount, kbCount, loading, onResume, onNew, onOpenDrawer }: Props) {
  const router = useRouter()
  const [draft, setDraft] = useState('')
  const continueTarget = sessions.find((s) => s.status === 'explaining')

  const submitDraft = () => {
    const t = draft.trim()
    if (!t) return
    onNew(t)
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto max-w-[760px] px-7 py-7">
        <h2 className="text-[21px] font-bold">学习模式</h2>
        <p className="mb-5 text-[13px] text-content-muted">该复习的先复习,没讲完的接着讲。</p>

        <div className="mb-3.5 grid grid-cols-1 gap-3 md:grid-cols-2">
          {continueTarget ? (
            <button
              type="button"
              onClick={() => onResume(continueTarget.id)}
              className="flex flex-col items-start gap-1.5 rounded-[14px] border border-line bg-surface p-4 text-left transition-colors hover:border-line-strong"
            >
              <span className="text-[19px]" aria-hidden>📖</span>
              <b className="text-[15px] text-content-primary">{shortTitle(continueTarget.question)}</b>
              <span className="text-xs text-content-muted">
                继续上次 · 讲到第 {continueTarget.stepCount} 步 · {dateLabel(continueTarget.updatedAt)}
              </span>
              <span className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-content-primary px-4 py-2 text-[13px] font-semibold text-surface">
                继续学习
              </span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onNew()}
              className="flex flex-col items-start gap-1.5 rounded-[14px] border border-line bg-surface p-4 text-left transition-colors hover:border-line-strong"
            >
              <span className="text-[19px]" aria-hidden>✏️</span>
              <b className="text-[15px] text-content-primary">学新题</b>
              <span className="text-xs text-content-muted">贴题或传图,选个起点开讲</span>
              <span className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-content-primary px-4 py-2 text-[13px] font-semibold text-surface">
                开始
              </span>
            </button>
          )}

          <button
            type="button"
            onClick={() => onOpenDrawer('review')}
            className="flex flex-col items-start gap-1.5 rounded-[14px] border border-[rgba(0,122,255,.35)] bg-[linear-gradient(135deg,rgba(0,122,255,.14),rgba(0,122,255,.05))] p-4 text-left transition-colors hover:border-accent"
          >
            <span className="text-[19px]" aria-hidden>🔁</span>
            <b className="text-[15px] text-content-primary">复习</b>
            <span className="text-xs text-content-muted">
              {dueCount > 0 ? `${dueCount} 张卡今天到期` : '暂无到期卡片,学新题会自动排期'}
            </span>
            <span className="mt-1.5 inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-accent-foreground">
              {dueCount > 0 ? '开始复习' : '看看队列'}
            </span>
          </button>
        </div>

        {continueTarget && (
          <button
            type="button"
            onClick={() => onNew()}
            className="mb-5 w-full rounded-[14px] border-[1.5px] border-dashed border-line-strong py-3 text-[13.5px] text-content-secondary transition-colors hover:text-content-primary"
          >
            ＋ 学新题
          </button>
        )}

        {/* 学习会话历史:主流程内(用户定稿:不再放侧栏) */}
        <div className="mt-5">
          <div className="mb-2 px-1 text-[11px] text-content-muted">学习会话</div>
          {loading && sessions.length === 0 && (
            <div className="rounded-xl border border-line bg-surface px-4 py-3 text-[13px] text-content-muted">加载中…</div>
          )}
          {!loading && sessions.length === 0 && (
            <div className="rounded-xl border border-line bg-surface px-4 py-3 text-[13px] text-content-muted">
              还没有学习会话,学完第一道题会自动收进这里
            </div>
          )}
          <div className="space-y-2">
            {sessions.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onResume(s.id)}
                className="flex w-full items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-left transition-colors hover:border-line-strong"
              >
                <span className="min-w-0 truncate text-[13.5px] text-content-primary">{shortTitle(s.question)}</span>
                <span
                  className={cn(
                    'flex-none text-xs',
                    s.status === 'explaining' ? 'text-accent' : 'text-content-muted'
                  )}
                >
                  {s.status === 'explaining' ? `讲到第 ${s.stepCount} 步` : '已完成'}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-4 px-1 text-xs text-content-muted">
          <button type="button" className="hover:text-content-primary" onClick={() => onOpenDrawer('notes')}>
            错题本 <b className="font-semibold text-content-primary">{noteCount}</b>
          </button>
          <button type="button" className="hover:text-content-primary" onClick={() => onOpenDrawer('review')}>
            待回看 <b className="font-semibold text-content-primary">{dueCount}</b>
          </button>
          <button type="button" className="hover:text-content-primary" onClick={() => onOpenDrawer('favorites')}>
            收藏 <b className="font-semibold text-content-primary">{favoriteCount}</b>
          </button>
          <button type="button" className="hover:text-content-primary" onClick={() => router.push('/kb')}>
            课本 <b className="font-semibold text-content-primary">{kbCount}</b>
          </button>
        </div>
      </div>
    </div>
  )
}
