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
import { decodeUpstreamError } from '@/lib/error-catalog'
import type { StudyAction, StudyPostOpts, StudyRef, StudySessionView, StudyStepView } from '@/hooks/useStudyStream'
import { cn, expandSingleNewlines } from '@/lib/utils'

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
  /** 归档的错题卡 id(null = 已移出错题本) */
  archivedNoteId: string | null
  /** 移出/恢复归档(操作完成后由页面刷新状态) */
  onArchiveChange: (remove: boolean) => void
  onAction: (action: StudyAction, opts?: StudyPostOpts) => void
  onManualComplete: () => void
  onBack: () => void
}

function plainHeadline(content: string): string {
  const line = content.replace(/[#*`>]/g, '').split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return line.slice(0, 40)
}

function RefsChips({ refs }: { refs: StudyRef[] }) {
  // 两级折叠:标题行收起整个引用区;展开后点单个 chip 再看原文
  // 分型:paper=真题出处,paper+textbook 混合时标题只写「引用」(chip 图标区分)
  const [listOpen, setListOpen] = useState(false)
  const [detail, setDetail] = useState<number | null>(null)
  const hasPaper = refs.some((r) => r.kind === 'paper')
  const hasTextbook = refs.some((r) => r.kind !== 'paper')
  const label = hasPaper ? (hasTextbook ? '引用' : '真题出处') : '课本引用'
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
        {label} · {refs.length} 条
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
                {r.kind === 'paper' ? '📄' : '📖'} {r.doc}
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
              {refs[detail].kind === 'paper' ? (
                // 真题 chip 的 content 是原卷题干(含 $...$ LaTeX):按纯文本渲染会把公式原样漏出来
                <MarkdownRenderer
                  content={refs[detail].content}
                  rich
                  className="line-clamp-4 text-xs leading-relaxed text-content-secondary"
                />
              ) : (
                <div className="line-clamp-4 whitespace-pre-wrap text-xs leading-relaxed text-content-secondary">
                  {refs[detail].content}
                </div>
              )}
              {refs[detail].paperSlug && refs[detail].questionNumber != null && (
                <a
                  href={`/papers/${refs[detail].paperSlug}?number=${refs[detail].questionNumber}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex items-center gap-1 text-[11px] text-accent transition-opacity hover:opacity-80"
                >
                  查看原卷页 ↗
                </a>
              )}
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
  // 手风琴:非最新步默认收起(新步到来时自动收起旧的);点标题行展开/收起
  const [collapsed, setCollapsed] = useState(!isLast)
  useEffect(() => {
    if (!isLast) setCollapsed(true)
  }, [isLast])
  return (
    <div className="card overflow-hidden rounded-[14px] border border-line bg-surface">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-2.5 border-b border-line bg-surface-muted px-4 py-2.5 text-left transition-colors hover:bg-surface-subtle/60"
      >
        <span className={`flex-none rounded-full px-2.5 py-0.5 text-[11px] font-bold ${step.streaming ? 'bg-accent-soft text-accent' : 'bg-accent text-white'}`}>
          {badge}
        </span>
        {headline && <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-content-primary">{headline}</span>}
        <ChevronDown
          className={cn('h-3.5 w-3.5 flex-none text-content-muted transition-transform duration-200', !collapsed && 'rotate-180')}
          aria-hidden
        />
      </button>
      {!collapsed && (
        <>
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
        </>
      )}
    </div>
  )
}

export function StudyWorkspace({ session, steps, busy, streamError, archivedNoteId, onArchiveChange, onAction, onManualComplete, onBack }: Props) {
  const [qCollapsed, setQCollapsed] = useState(false)
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  // 跟随模式:贴着底部时新内容自动滚入;用户上滑即脱离,滑回底部恢复
  const [following, setFollowing] = useState(true)
  const completed = session.status === 'completed'
  const lastStep = steps[steps.length - 1]

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    setFollowing(dist < 48)
  }

  // 新步出现/内容推进时贴底(仅跟随模式;instant 滚动,smooth 会和流式打架)
  useEffect(() => {
    if (!following) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [steps.length, lastStep?.content.length, following])

  const jumpToBottom = () => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    setFollowing(true)
  }

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
      {/* 题目条:chrome 灰带的一部分;下方白纸顶边下移,纸的圆角在此露出(globals 作用域规则)。
          分界靠灰条与纸面的底色差,border-b 灰线多余(2026-11-08 用户圈删) */}
      <div
        data-study-questionbar
        className="flex items-center gap-2.5 bg-surface-muted px-5 py-3 text-[13px] text-content-secondary"
      >
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
      <div ref={scrollRef} onScroll={handleScroll} className="relative flex-1 min-h-0 overflow-y-auto">
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

          {streamError && (() => {
            // A10:上游错误是 ERR|code|status|detail|raw 信封,直接上屏会把裸管道串
            // 印给用户;走 error-catalog 解码出中文标题+说明,原文折叠成小字。
            const info = decodeUpstreamError(streamError)
            return (
              <div className="space-y-1 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-[13px] text-destructive">
                <p className="font-semibold">{info.title}</p>
                <p className="opacity-90">{info.detail}</p>
                {info.raw && (
                  <p className="break-all text-[11px] leading-[1.5] opacity-55">{info.raw}</p>
                )}
              </div>
            )
          })()}

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
                    <MarkdownRenderer content={expandSingleNewlines(session.summary)} rich />
                  </div>
                </div>
              )}
              {archivedNoteId ? (
                <div className="mb-4 inline-flex items-center gap-2.5 rounded-full bg-[rgba(52,199,89,.13)] px-4 py-1.5 text-[12.5px] text-[#1d7a3a]">
                  <span>✓ 已自动存入错题本 · 复习排期已生成</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onArchiveChange(true)}
                    title="从错题本移出这张卡(可恢复)"
                    className="rounded-full border border-[rgba(29,122,58,.3)] px-2.5 py-0.5 text-[11px] transition-colors hover:bg-white/60 disabled:opacity-50"
                  >
                    移出
                  </button>
                </div>
              ) : (
                <div className="mb-4 inline-flex items-center gap-2.5 rounded-full bg-surface-muted px-4 py-1.5 text-[12.5px] text-content-muted">
                  <span>已移出错题本</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onArchiveChange(false)}
                    className="rounded-full border border-line px-2.5 py-0.5 text-[11px] transition-colors hover:border-line-strong hover:text-content-primary disabled:opacity-50"
                  >
                    恢复
                  </button>
                </div>
              )}
              <div className="mt-1 flex justify-center gap-2.5">
                <button type="button" onClick={onBack} className="rounded-full bg-content-primary px-6 py-2.5 text-sm font-semibold text-surface">
                  再学一道
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onAction('quiz')}
                  className="rounded-full border border-line bg-surface px-6 py-2.5 text-sm font-semibold text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary disabled:opacity-50"
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

          {busy && !following && (
            <button
              type="button"
              onClick={jumpToBottom}
              className="sticky bottom-3 ml-auto flex items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 py-1.5 text-xs text-content-secondary shadow-md transition-colors hover:text-content-primary"
            >
              ↓ 生成中,回到底部
            </button>
          )}
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
