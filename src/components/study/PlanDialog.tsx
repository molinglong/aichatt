'use client'

/**
 * 考前冲刺计划弹层(阶段四方案A:AI 排期 + 按日勾销)。
 * 无计划态:三字段小表单(考试名/日期/科目)→ POST /api/study/plan → AI 编排(失败降级确定性摊排);
 * 有计划态:按日分组任务列表 + 勾销(PATCH item)+ 总进度 + 距考试倒计时;「结束计划」退役当前计划。
 * 骨架与 StudyPanelDialog 同配方;数据由父组件 useQuery 下发,勾销后父级 invalidate。
 */
import { useEffect, useMemo, useState } from 'react'
import { X, Target, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { useIsMobileViewport } from '@/hooks/useIsMobileViewport'
import { useBackToClose } from '@/hooks/useBackToClose'
import { SUBJECT_LABELS } from '@/lib/study/subject-labels'

export interface PlanItem {
  id: string
  date: string
  topic: string
  kind: 'cards' | 'redo' | 'variant'
  target: number
  done: boolean
}

export interface StudyPlan {
  id: string
  title: string
  examName: string | null
  examDate: string
  subject: string | null
  items: PlanItem[]
}

/** 计划项动作文案(今日任务弹窗共用) */
export const KIND_META: Record<PlanItem['kind'], { label: (n: number) => string; cls: string }> = {
  cards: { label: (n) => `翻卡 ${n} 张`, cls: 'bg-surface-subtle text-content-muted' },
  redo: { label: (n) => `重做 ${n} 题`, cls: 'bg-accent-soft text-accent' },
  variant: { label: (n) => `变式 ${n} 题`, cls: 'bg-accent-soft text-accent' },
}

const SUBJECT_CHIPS = ['math', 'english', 'chinese', 'physics'] as const

export function PlanDialog({
  open,
  onClose,
  plan,
  loading,
  onToggleItem,
  onCreate,
  onEndPlan,
  creating,
}: {
  open: boolean
  onClose: () => void
  plan: StudyPlan | null
  loading: boolean
  onToggleItem: (itemId: string, done: boolean) => void
  onCreate: (body: { examName: string; examDate: string; subject?: string }) => Promise<boolean>
  onEndPlan: () => void
  creating: boolean
}) {
  const isMobile = useIsMobileViewport()
  // 弹层内无导航,只借返回键哨兵收口
  useBackToClose(open, onClose)
  const [examName, setExamName] = useState('')
  const [examDate, setExamDate] = useState('')
  const [subject, setSubject] = useState<string | null>(null)

  useEffect(() => {
    if (!open || isMobile) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, isMobile, onClose])

  // 默认日期:今天 +14 天
  useEffect(() => {
    if (!open) return
    const d = new Date()
    d.setDate(d.getDate() + 14)
    setExamDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
  }, [open])

  const today = useMemo(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d
  }, [])

  // 按日分组(今天在前;已过去的日子如有未完成项顺延显示为日期)
  const dayGroups = useMemo(() => {
    if (!plan) return []
    const map = new Map<string, PlanItem[]>()
    for (const it of plan.items) {
      const arr = map.get(it.date) ?? []
      arr.push(it)
      map.set(it.date, arr)
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, items]) => {
        const d = new Date(`${date}T00:00:00`)
        const diff = Math.round((d.getTime() - today.getTime()) / 86_400_000)
        return {
          date,
          label: diff === 0 ? `今天 · ${date.slice(5)}` : diff === 1 ? `明天 · ${date.slice(5)}` : date.slice(5),
          isToday: diff === 0,
          items,
        }
      })
  }, [plan, today])

  const total = plan?.items.length ?? 0
  const doneCount = plan?.items.filter((i) => i.done).length ?? 0
  const daysLeft = plan ? Math.max(0, Math.round((new Date(`${plan.examDate}T00:00:00`).getTime() - today.getTime()) / 86_400_000)) : 0

  const submit = async () => {
    if (!examDate) {
      toast.error('先选考试日期', { title: '冲刺计划' })
      return
    }
    const ok = await onCreate({ examName: examName.trim() || '考前冲刺', examDate, ...(subject ? { subject } : {}) })
    if (ok) setExamName('')
  }

  if (!open) return null

  return (
    <div
      className={cn(
        'fixed inset-0 z-[200]',
        isMobile ? 'flex flex-col bg-surface' : 'flex items-start justify-center pt-[12vh] px-4'
      )}
    >
      {!isMobile && (
        <button
          type="button"
          aria-label="关闭"
          onClick={onClose}
          className="absolute inset-0 bg-black/20 backdrop-blur-[12px] saturate-150 dark:bg-white/15 dark:saturate-150"
        />
      )}

      <div
        className={cn(
          'relative flex flex-col overflow-hidden',
          isMobile
            ? 'h-full w-full bg-surface'
            : 'h-[70vh] w-full max-w-[680px] rounded-xl border border-line/60 bg-surface-glass glass-blur shadow-2xl enter-pop'
        )}
      >
        <div
          className="flex flex-none items-center gap-1 border-b border-line px-3"
          style={
            isMobile
              ? { paddingTop: 'max(12px, calc(var(--m-chrome-top, 0px) + 12px))', paddingBottom: 12 }
              : { paddingTop: 8, paddingBottom: 8 }
          }
        >
          <span className="px-2 text-xs font-semibold text-content-primary">{plan ? plan.title : '冲刺计划'}</span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-md p-1.5 text-content-muted transition-colors hover:bg-surface-subtle hover:text-content-primary"
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {loading && !plan ? (
            <div className="grid gap-3">
              <div className="study-sk h-8 rounded-full" />
              <div className="study-sk h-24 rounded-[14px]" />
            </div>
          ) : !plan ? (
            /* ── 无计划态:小表单 ── */
            <div className="mx-auto max-w-[420px]">
              <label className="mb-1.5 mt-1 block text-[12px] font-semibold">考试名称</label>
              <input
                value={examName}
                onChange={(e) => setExamName(e.target.value)}
                maxLength={20}
                placeholder="期末考试 / 月考…"
                className="h-10 w-full rounded-[12px] border border-line bg-surface px-3.5 text-[13px] text-content-primary outline-none transition-colors placeholder:text-content-muted focus:border-accent"
              />
              <div className="mt-3 grid grid-cols-2 gap-2.5">
                <div>
                  <label className="mb-1.5 block text-[12px] font-semibold">考试日期</label>
                  <input
                    type="date"
                    value={examDate}
                    min={`${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`}
                    onChange={(e) => setExamDate(e.target.value)}
                    className="h-10 w-full rounded-[12px] border border-line bg-surface px-3 text-[13px] text-content-primary outline-none transition-colors focus:border-accent"
                  />
                </div>
                <div>
                  <label className="mb-1.5 block text-[12px] font-semibold">科目(可选)</label>
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {SUBJECT_CHIPS.map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setSubject((v) => (v === s ? null : s))}
                        className={cn(
                          'rounded-full border px-2.5 py-1 text-[11.5px] transition-colors',
                          subject === s
                            ? 'border-accent bg-accent-soft font-medium text-accent'
                            : 'border-line bg-surface text-content-secondary hover:border-line-strong'
                        )}
                      >
                        {SUBJECT_LABELS[s]}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={creating}
                className="mt-5 flex w-full items-center justify-center gap-1.5 rounded-full bg-accent py-2.5 text-[13.5px] font-semibold text-accent-foreground transition-opacity hover:opacity-85 disabled:opacity-50 disabled:cursor-wait"
              >
                <Target size={15} aria-hidden />
                {creating ? 'AI 正在按考点摊排…' : '生成冲刺排期'}
              </button>
              <p className="mt-2.5 text-center text-[11px] leading-relaxed text-content-muted">
                按错题本各考点的掌握度把翻卡 / 重做 / 变式摊到考前每一天;AI 不可用时退回按掌握度轮转的确定性排法。
              </p>
            </div>
          ) : (
            /* ── 有计划态:按日勾销 ── */
            <>
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="rounded-full bg-accent-soft px-2.5 py-1 text-[11.5px] font-medium text-accent">
                  距考试 {daysLeft} 天
                </span>
                <span className="text-[12px] text-content-secondary">
                  已完成 <b className="tabular-nums text-content-primary">{doneCount}</b> / {total}
                </span>
                <span className="h-1.5 min-w-[80px] flex-1 overflow-hidden rounded-full bg-surface-subtle">
                  <span
                    className="block h-full rounded-full bg-accent transition-all"
                    style={{ width: `${total > 0 ? (doneCount / total) * 100 : 0}%` }}
                  />
                </span>
                <button
                  type="button"
                  onClick={onEndPlan}
                  title="结束当前计划(历史保留,学习台冲刺条撤下)"
                  className="flex-none rounded-md p-1.5 text-content-muted transition-colors hover:bg-surface-subtle hover:text-destructive"
                >
                  <Trash2 size={14} />
                </button>
              </div>

              <div className="mt-4">
                {dayGroups.map((g) => (
                  <div key={g.date} className="mb-3">
                    <div className="mb-1.5 flex items-baseline gap-2 text-[11px] text-content-muted">
                      <b className={cn('text-[12px]', g.isToday ? 'text-accent' : 'text-content-primary')}>{g.label}</b>
                      <span>{g.items.filter((i) => i.done).length}/{g.items.length} 完成</span>
                    </div>
                    <div className="space-y-1.5">
                      {g.items.map((it) => (
                        <button
                          key={it.id}
                          type="button"
                          onClick={() => onToggleItem(it.id, !it.done)}
                          className={cn(
                            'flex w-full items-center gap-2.5 rounded-[12px] border px-3 py-2 text-left transition-colors',
                            it.done
                              ? 'border-line/40 bg-surface-subtle/50'
                              : 'border-line/60 bg-surface-glass hover:border-line-strong'
                          )}
                        >
                          <span
                            className={cn(
                              'flex h-4 w-4 flex-none items-center justify-center rounded-[5px] border-[1.5px] transition-colors',
                              it.done ? 'border-accent bg-accent' : 'border-line-strong bg-surface'
                            )}
                            aria-hidden
                          >
                            {it.done && (
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M20 6 9 17l-5-5" />
                              </svg>
                            )}
                          </span>
                          <span className={cn('min-w-0 flex-1 truncate text-[12.5px] font-semibold', it.done ? 'text-content-muted line-through' : 'text-content-primary')}>
                            {it.topic}
                          </span>
                          <span className={cn('flex-none rounded-full px-2 py-0.5 text-[10px] font-medium', KIND_META[it.kind].cls)}>
                            {KIND_META[it.kind].label(it.target)}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-content-muted">
                翻卡/重做/变式按任务里的考点去复习;做完勾掉,学习台冲刺条会跟着走。
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
