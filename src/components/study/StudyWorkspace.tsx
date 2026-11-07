'use client'

/**
 * 学习会话工作区(讲义卡流):
 * - 一步一张卡:步号 + 课本引用 chip(点开原文)+ 讲解内容(MarkdownRenderer rich)
 * - 最后一步卡带操作条(懂了,继续 / 没懂,换个说法 / 直接要答案)——自评随 action 一起落库
 * - 生成中的步走打字机 + 引用渐进出现;检索降级时卡内如实标注
 * - 结课后出总结卡 + 归档状态;追问输入框在卡流底部
 */
import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer'
import { INPUT_SEND_EVENT } from '@/lib/input-bridge'
import type { StudyAction, StudyPostOpts, StudyRef, StudySessionView, StudyStepView } from '@/hooks/useStudyStream'
import { cn } from '@/lib/utils'

const ACTION_LABEL: Record<string, string> = {
  start: '开讲',
  continue: '继续讲解',
  easier: '换个说法',
  solution: '完整解法',
  followup: '追问',
}

interface Props {
  session: StudySessionView
  steps: StudyStepView[]
  busy: boolean
  streamError: string | null
  onAction: (action: StudyAction, opts?: StudyPostOpts) => void
  onManualComplete: () => void
  onBack: () => void
}

function plainHeadline(content: string): string {
  const line = content.replace(/[#*`>]/g, '').split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return line.slice(0, 40)
}

function RefsChips({ refs }: { refs: StudyRef[] }) {
  // 两级折叠:标题行收起整个引用区;展开后点单个 chip 再看课本原文
  const [listOpen, setListOpen] = useState(false)
  const [detail, setDetail] = useState<number | null>(null)
  return (
    <div className="px-4 pb-3">
      <button
        type="button"
        onClick={() => setListOpen((v) => !v)}
        aria-expanded={listOpen}
        className="flex items-center gap-1 text-[11px] text-content-muted transition-colors hover:text-accent"
      >
        <ChevronDown
          className={cn('h-3 w-3 transition-transform duration-200', listOpen && 'rotate-180')}
          aria-hidden
        />
        课本引用 · {refs.length} 条
      </button>
      {listOpen && (
        <>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {refs.map((r, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setDetail(detail === i ? null : i)}
                className={cn(
                  'rounded-lg px-2.5 py-1 text-[11px] transition-colors',
                  detail === i
                    ? 'bg-accent text-accent-foreground'
                    : 'bg-accent-soft text-accent hover:bg-accent/20'
                )}
              >
                📖 {r.doc}
                {r.chapter ? ` · ${r.chapter}` : ''}
                {r.section ? ` · ${r.section}` : ''}
              </button>
            ))}
          </div>
          {detail != null && refs[detail] && (
            <div className="mt-2 rounded-xl border border-line bg-surface-subtle/50 p-3">
              <div className="mb-1 text-xs font-medium text-content-primary">
                {refs[detail].doc}
                {refs[detail].chapter ? ` · ${refs[detail].chapter}` : ''}
                {refs[detail].section ? ` · ${refs[detail].section}` : ''}
                {refs[detail].heading ? ` · ${refs[detail].heading}` : ''}
              </div>
              <div className="line-clamp-4 whitespace-pre-wrap text-xs leading-relaxed text-content-secondary">
                {refs[detail].content}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function StepCard({ step, isLast, canAct, busy, onAction }: {
  step: StudyStepView
  isLast: boolean
  canAct: boolean
  busy: boolean
  onAction: Props['onAction']
}) {
  const badge = step.streaming ? '生成中' : step.action === 'followup' ? '追问' : `第 ${step.idx + 1} 步`
  const headline = plainHeadline(step.content)
  return (
    <div className="card overflow-hidden rounded-[14px] border border-line bg-surface">
      <div className="flex items-center gap-2.5 border-b border-line bg-surface-muted px-4 py-2.5">
        <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${step.streaming ? 'bg-accent-soft text-accent' : 'bg-accent text-white'}`}>
          {badge}
        </span>
        {headline && <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-content-primary">{headline}</span>}
      </div>
      <div className="px-4 py-3.5 text-[14px] leading-[1.75] text-content-secondary">
        {step.reasoning && !step.streaming && (
          <details className="mb-2.5">
            <summary className="cursor-pointer text-xs text-content-muted">思考过程</summary>
            <div className="mt-1 whitespace-pre-wrap text-xs text-content-muted">{step.reasoning}</div>
          </details>
        )}
        <MarkdownRenderer content={step.content || (step.streaming ? '' : '(空)')} rich={!step.streaming} />
        {step.streaming && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-accent align-middle" aria-hidden />}
      </div>
      {step.refs && step.refs.length > 0 && <RefsChips refs={step.refs} />}
      {step.selfRating && (
        <div className="px-4 pb-2.5 text-[11px] text-content-muted">
          已记录:
          {step.selfRating === 'good' ? <b className="font-semibold text-[#1d7a3a]">这一步懂了</b> : <b className="font-semibold text-[#9a6207]">这一步没懂</b>}
          {' · 会影响本卡的复习排期'}
        </div>
      )}
      {isLast && canAct && !step.streaming && (
        <div className="flex flex-wrap gap-2 border-t border-line bg-surface-muted px-3.5 py-2.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => onAction('continue', { rate: { idx: step.idx, rating: 'good' } })}
            className="rounded-full border border-line bg-surface px-3.5 py-1.5 text-[12.5px] text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary disabled:opacity-50"
          >
            ✓ 懂了,继续
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onAction('easier', { rate: { idx: step.idx, rating: 'again' } })}
            className="rounded-full border border-line bg-surface px-3.5 py-1.5 text-[12.5px] text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary disabled:opacity-50"
          >
            没懂,换个说法
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onAction('solution')}
            className="rounded-full border border-line bg-surface px-3.5 py-1.5 text-[12.5px] text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary disabled:opacity-50"
          >
            直接要答案
          </button>
        </div>
      )}
    </div>
  )
}

export function StudyWorkspace({ session, steps, busy, streamError, onAction, onManualComplete, onBack }: Props) {
  const [qCollapsed, setQCollapsed] = useState(false)
  const [draft, setDraft] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const completed = session.status === 'completed'
  const lastStep = steps[steps.length - 1]

  // 新步出现/内容推进时贴底
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [steps.length, lastStep?.content.length])

  // 考试块交卷桥:变式题/练习的「交卷并让我批改」把作答当追问发给模型判分
  const onActionRef = useRef(onAction)
  onActionRef.current = onAction
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ text?: string }>).detail
      if (detail?.text) onActionRef.current('followup', { text: detail.text })
    }
    window.addEventListener(INPUT_SEND_EVENT, handler)
    return () => window.removeEventListener(INPUT_SEND_EVENT, handler)
  }, [])

  const sendFollowup = () => {
    const t = draft.trim()
    if (!t || busy) return
    setDraft('')
    onAction('followup', { text: t })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 题目条 */}
      <div className="flex items-center gap-2.5 border-b border-line bg-surface-muted px-5 py-3 text-[13px] text-content-secondary">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md px-1.5 py-0.5 text-content-muted transition-colors hover:text-content-primary"
          aria-label="返回学习台"
        >
          ←
        </button>
        <span>当前题目:</span>
        {!qCollapsed && <span className="min-w-0 flex-1 truncate font-semibold text-content-primary">{session.question}</span>}
        <button
          type="button"
          onClick={() => setQCollapsed((v) => !v)}
          className="ml-auto flex-none text-xs text-content-muted transition-colors hover:text-content-primary"
        >
          {qCollapsed ? '展开题目 ▾' : '收起题目 ▴'}
        </button>
      </div>

      {/* 卡流 */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto flex max-w-[760px] flex-col gap-3.5 px-5 py-5">
          {steps.map((step, i) => (
            <StepCard
              key={step.id}
              step={step}
              isLast={i === steps.length - 1}
              canAct={!completed && !busy && session.status === 'explaining'}
              busy={busy}
              onAction={onAction}
            />
          ))}

          {streamError && (
            <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-[13px] text-destructive">
              {streamError}
            </div>
          )}

          {completed && (
            <div className="rounded-[14px] border border-line bg-surface p-5 text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[rgba(52,199,89,.13)] text-[24px] text-[#34c759]">
                ✓
              </div>
              <div className="text-[17px] font-bold">这道题讲完了</div>
              <div className="mb-3 text-[13px] text-content-muted">共 {steps.length} 步</div>
              {session.summary && (
                <div className="mx-auto mb-3 max-w-[560px] rounded-[14px] border border-line p-4 text-left">
                  <div className="mb-2 text-[13px] text-content-secondary">本次学到</div>
                  <div className="text-[13.5px] leading-relaxed text-content-secondary">
                    <MarkdownRenderer content={session.summary} rich />
                  </div>
                </div>
              )}
              <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-[rgba(52,199,89,.13)] px-4 py-1.5 text-[12.5px] text-[#1d7a3a]">
                ✓ 已自动存入错题本 · 复习排期已生成
              </div>
              <div>
                <button type="button" onClick={onBack} className="primary rounded-full px-6 py-2.5 text-sm font-semibold text-surface">
                  再学一道
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onAction('quiz')}
                  className="ml-2.5 rounded-full border border-line bg-surface px-6 py-2.5 text-sm font-semibold text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary disabled:opacity-50"
                >
                  🎯 来一道变式题
                </button>
              </div>
            </div>
          )}

          {/* 手动结课兜底:模型没调 finish_study 时用 */}
          {!completed && !busy && steps.length > 0 && (
            <div className="text-center">
              <button
                type="button"
                onClick={onManualComplete}
                className="text-xs text-content-muted underline-offset-2 transition-colors hover:text-content-primary hover:underline"
              >
                本题讲完了
              </button>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* 追问输入框 */}
      {!completed && (
        <div className="flex-none px-5 pb-4 pt-2">
          <div className="mx-auto flex max-w-[760px] items-end gap-2 rounded-2xl border border-line bg-surface px-3.5 py-2.5">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  sendFollowup()
                }
              }}
              rows={1}
              placeholder="哪里没懂?直接问…"
              className="max-h-32 min-h-[24px] flex-1 resize-none border-0 bg-transparent text-[14px] text-content-primary outline-none placeholder:text-content-muted"
            />
            <button
              type="button"
              onClick={sendFollowup}
              disabled={busy || !draft.trim()}
              className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-content-primary text-surface transition-opacity disabled:opacity-40"
              aria-label="发送追问"
            >
              ➤
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
