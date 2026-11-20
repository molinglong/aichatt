'use client'

/**
 * 「今日任务」弹窗(2026-11-16 方案A「今日清单」挑稿落码,原型 design/preview-today-tasks-panel.html):
 * 冲刺计划今日项(真勾选,走 PlanDialog 同一条 PATCH 通道)+ 常驻三件
 * (今日复习/继续学习/背单词;完成态由动作产生:到期清零 / 会话清零 / 今日量完成,不做手动打卡)。
 * 不替换主页三格大数字卡,入口挂「今天」区块行右侧「今日任务 ›」。
 * 骨架与 StudyPanelDialog 同配方:桌面居中磨砂遮罩玻璃卡 + ESC,移动端全屏 + 返回键收口。
 */
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useIsMobileViewport } from '@/hooks/useIsMobileViewport'
import { useBackToClose } from '@/hooks/useBackToClose'
import { useWordsSummary } from '@/components/english/EnglishEntryCard'
import { KIND_META, type PlanItem } from './PlanDialog'
import { shortTitle } from './StudyHome'

/** 计划项行最小字段(父组件从 plan.items 按今日过滤下发) */
export type TodayPlanItem = Pick<PlanItem, 'id' | 'topic' | 'kind' | 'target' | 'done'>

/** 进行中会话行最小字段(与 StudySessionListItem 子集同口径) */
export type TodaySessionItem = { id: string; question: string; stepCount: number }

interface Props {
  open: boolean
  onClose: () => void
  /** 当前计划名;null = 无冲刺计划,计划组整组不渲染 */
  planTitle: string | null
  planToday: TodayPlanItem[]
  /** 计划项勾销(与 PlanDialog 同通道,父级负责 invalidate) */
  onToggleItem: (itemId: string, done: boolean) => void
  /** 「整个计划 ›」:父级关本弹窗开 PlanDialog */
  onOpenPlan: () => void
  dueCount: number
  /** 到期卡里可重做题库原题数(复习行副行) */
  dueRedoCount: number
  inProgress: TodaySessionItem[]
  onResume: (id: string) => void
  /** 打开复习抽屉(翻卡/重做);父级先关本弹窗再开抽屉 */
  onOpenReview: (mode: 'flip' | 'redo') => void
  onOpenStats: () => void
  masteryAvg: number | null
  streakDays: number | null
  totalSessions: number
  noteCount: number
}

function todayLabelCn(): string {
  const d = new Date()
  return `${d.getMonth() + 1}月${d.getDate()}日 周${'日一二三四五六'[d.getDay()]}`
}

/* 线性 SVG 图标(禁 emoji 当图标;与 StudyHome 同形) */
function IcRepeat() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  )
}

function IcBook() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </svg>
  )
}

function IcCard() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="M7 9.5h6" />
      <path d="M7 14.5h10" />
    </svg>
  )
}

/** 勾选圆:done 实心 accent;常驻行为完成态展示(不可点),计划行为真勾选按钮 */
function Ck({ done }: { done: boolean }) {
  return (
    <span
      className={cn(
        'flex h-[21px] w-[21px] flex-none items-center justify-center rounded-full border-[1.5px] transition-colors',
        done ? 'border-accent bg-accent text-accent-foreground' : 'border-line-strong bg-transparent text-transparent',
      )}
      aria-hidden
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 6 9 17l-5-5" />
      </svg>
    </span>
  )
}

/** 行内小图标章(与 StudyHome CellLabel 同规格) */
function RowIcon({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[11px] bg-accent-soft text-accent" aria-hidden>
      {children}
    </span>
  )
}

/** 行主按钮(与 CellBtn 同规格;完成态由父级降调) */
function RowBtn({ text, muted }: { text: string; muted?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex flex-none items-center gap-1.5 rounded-full px-3.5 py-[7px] text-[12.5px] font-semibold transition-colors',
        muted ? 'bg-surface-subtle text-content-muted' : 'bg-accent text-accent-foreground',
      )}
    >
      {text}
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 12h14" />
        <path d="m12 5 7 7-7 7" />
      </svg>
    </span>
  )
}

/** 分组标签行 */
function GroupHead({ label, sub, link, onLink }: { label: string; sub?: string; link?: string; onLink?: () => void }) {
  return (
    <div className="flex items-baseline gap-1.5 px-0.5 pb-1 pt-3 text-[11px] text-content-muted">
      <b className="text-[11.5px] font-semibold text-content-secondary">{label}</b>
      {sub && <span>{sub}</span>}
      <span className="flex-1" />
      {link && onLink && (
        <button type="button" onClick={onLink} className="text-[12px] font-medium text-accent transition-opacity hover:opacity-80">
          {link}
        </button>
      )}
    </div>
  )
}

export function TodayTasksDialog({
  open,
  onClose,
  planTitle,
  planToday,
  onToggleItem,
  onOpenPlan,
  dueCount,
  dueRedoCount,
  inProgress,
  onResume,
  onOpenReview,
  onOpenStats,
  masteryAvg,
  streakDays,
  totalSessions,
  noteCount,
}: Props) {
  const isMobile = useIsMobileViewport()
  const router = useRouter()
  useBackToClose(open, onClose)
  // 背词数据与三格卡同源同缓存(queryKey ['words','summary']),打开即取,不触发推进
  const { data: words } = useWordsSummary()

  // ESC 关闭(桌面;移动端由返回键哨兵收口)
  useEffect(() => {
    if (!open || isMobile) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, isMobile, onClose])

  if (!open) return null

  // ── 常驻三件的完成态与显隐 ──
  const hasVocab = !!words && words.hasDictionary
  const vocabDue = words?.due ?? 0
  const vocabNewLeft = Math.max(0, (words?.dailyNew ?? 15) - (words?.todayNewDone ?? 0))
  const reviewDone = dueCount === 0
  const vocabDone = hasVocab && vocabDue === 0 && vocabNewLeft === 0

  // ── 今日进度 X/Y(计划项 + 常驻存在的行;无进行中会话不算任务) ──
  const standingRows = [
    { key: 'review', exists: true, done: reviewDone },
    { key: 'study', exists: inProgress.length > 0, done: false },
    { key: 'vocab', exists: hasVocab, done: vocabDone },
  ] as const
  const total = planToday.length + standingRows.filter((r) => r.exists).length
  const doneN =
    planToday.filter((i) => i.done).length +
    (reviewDone ? 1 : 0) +
    (vocabDone ? 1 : 0)
  const pct = total > 0 ? Math.round((doneN / total) * 100) : 0

  // 掌握度 footer(与三格卡 footer 同数据)
  const masteryHas = masteryAvg !== null
  const masteryPct = masteryHas ? Math.round(masteryAvg * 100) : 0
  const ringC = 2 * Math.PI * 15.5

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="今日任务"
      className={cn(
        'fixed inset-0 z-[200]',
        isMobile ? 'flex flex-col bg-surface' : 'flex items-start justify-center pt-[12vh] px-4',
      )}
    >
      {/* 桌面磨砂遮罩,点击空白关闭(与 StudyPanelDialog 同配方) */}
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
          'relative z-10 flex flex-col overflow-hidden',
          isMobile
            ? 'h-full w-full bg-surface'
            : 'h-[70vh] w-full max-w-[560px] rounded-xl border border-line/60 bg-surface-glass glass-blur shadow-2xl enter-pop',
        )}
      >
        {/* 头部:标题+日期 | 进度 X/Y+细条 | 关闭;移动端吃 --m-chrome-top 安全区 */}
        <div
          className="flex flex-none items-center gap-2 border-b border-line px-4"
          style={
            isMobile
              ? { paddingTop: 'max(12px, calc(var(--m-chrome-top, 0px) + 12px))', paddingBottom: 12 }
              : { paddingTop: 14, paddingBottom: 12 }
          }
        >
          <span className="text-[15.5px] font-bold text-content-primary">今日任务</span>
          <span className="text-[12px] text-content-muted">{todayLabelCn()}</span>
          <span className="flex-1" />
          <span className="text-[13px] font-bold tabular-nums text-content-primary">
            {doneN}/{total}
          </span>
          <span className="h-1.5 w-[92px] flex-none overflow-hidden rounded-full bg-surface-subtle">
            <span className="block h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${pct}%` }} />
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-1 rounded-md p-1.5 text-content-muted transition-colors hover:bg-surface-subtle hover:text-content-primary"
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </div>

        {/* 清单主体 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
          {/* 冲刺计划今日项(真勾选;无计划整组不渲染) */}
          {planTitle && planToday.length > 0 && (
            <>
              <GroupHead
                label="冲刺计划"
                sub={`${planTitle} · 今日 ${planToday.filter((i) => i.done).length}/${planToday.length}`}
                link="整个计划 ›"
                onLink={onOpenPlan}
              />
              {planToday.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => onToggleItem(it.id, !it.done)}
                  className="flex w-full items-center gap-3 border-t border-line/50 py-2.5 text-left first:border-t-0"
                >
                  <Ck done={it.done} />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        'block truncate text-[13.5px] font-semibold',
                        it.done ? 'text-content-muted line-through' : 'text-content-primary',
                      )}
                    >
                      {it.topic}
                    </span>
                    <span className="mt-0.5 block truncate text-[11.5px] text-content-muted">
                      {KIND_META[it.kind].label(it.target)} · 冲刺计划
                    </span>
                  </span>
                </button>
              ))}
            </>
          )}

          {/* 常驻三件(完成态由动作产生,勾选圆只展示) */}
          <GroupHead label="常驻" sub="每天按状态定量的三件事" />

          {/* 今日复习(常驻;到期清零即完成) */}
          <div className="flex items-center gap-3 border-t border-line/50 py-2.5 first:border-t-0">
            <Ck done={reviewDone} />
            <RowIcon>
              <IcRepeat />
            </RowIcon>
            <span className="min-w-0 flex-1">
              <span className={cn('block truncate text-[13.5px] font-semibold', reviewDone ? 'text-content-muted line-through' : 'text-content-primary')}>
                今日复习 <span className="text-accent">{dueCount} 张</span>
              </span>
              <span className="mt-0.5 block truncate text-[11.5px] text-content-muted">
                {dueCount > 0
                  ? dueRedoCount > 0
                    ? `${dueRedoCount} 道可重做题库原题 · 核对式自评`
                    : '按记忆曲线自动排期 · 核对式自评'
                  : '学新题会自动排期'}
              </span>
            </span>
            <button
              type="button"
              onClick={() => onOpenReview('flip')}
              className="flex-none text-[12px] font-medium text-accent transition-opacity hover:opacity-80"
            >
              翻卡速览
            </button>
            <button type="button" onClick={() => onOpenReview('redo')} className="flex-none transition-opacity hover:opacity-90">
              <RowBtn text="重做练习" muted={reviewDone} />
            </button>
          </div>

          {/* 继续学习(有进行中的题才渲染) */}
          {inProgress.length > 0 && (
            <div className="flex items-center gap-3 border-t border-line/50 py-2.5">
              <Ck done={false} />
              <RowIcon>
                <IcBook />
              </RowIcon>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-semibold text-content-primary">
                  继续学习 <span className="text-accent">{inProgress.length} 题</span>
                </span>
                <span className="mt-0.5 block truncate text-[11.5px] text-content-muted">
                  {inProgress.length > 1 ? '最近:' : ''}
                  {shortTitle(inProgress[0].question)} · 讲到第 {inProgress[0].stepCount} 步
                </span>
              </span>
              <button type="button" onClick={() => onResume(inProgress[0].id)} className="flex-none transition-opacity hover:opacity-90">
                <RowBtn text="继续" />
              </button>
            </div>
          )}

          {/* 背单词(字典空着不渲染;今日量完成即完成) */}
          {hasVocab && (
            <div className="flex items-center gap-3 border-t border-line/50 py-2.5">
              <Ck done={vocabDone} />
              <RowIcon>
                <IcCard />
              </RowIcon>
              <span className="min-w-0 flex-1">
                <span className={cn('block truncate text-[13.5px] font-semibold', vocabDone ? 'text-content-muted line-through' : 'text-content-primary')}>
                  背单词 <span className="text-accent">{vocabDue > 0 ? vocabDue : vocabNewLeft} 词</span>
                </span>
                <span className="mt-0.5 block truncate text-[11.5px] text-content-muted">
                  {[words?.listName, `今日新词 ${vocabNewLeft}`, `已学 ${words?.learning ?? 0}`].filter(Boolean).join(' · ')}
                </span>
              </span>
              <button
                type="button"
                onClick={() => {
                  onClose()
                  // 整页跳 /study/english(与三格卡同去向)
                  router.push('/study/english')
                }}
                className="flex-none transition-opacity hover:opacity-90"
              >
                <RowBtn text="继续背" muted={vocabDone} />
              </button>
            </div>
          )}
        </div>

        {/* footer:掌握度环 + 统计(与三格卡 footer 同构) */}
        <div className="flex flex-none items-center gap-2.5 border-t border-line px-4 py-3">
          <svg viewBox="0 0 40 40" width="30" height="30" className="shrink-0" aria-hidden>
            <circle cx="20" cy="20" r="15.5" fill="none" stroke="rgb(var(--surface-subtle))" strokeWidth="4" />
            {masteryHas && (
              <circle
                cx="20" cy="20" r="15.5" fill="none" stroke="rgb(var(--accent))" strokeWidth="4"
                strokeLinecap="round" strokeDasharray={`${(ringC * masteryPct) / 100} ${ringC}`} transform="rotate(-90 20 20)"
              />
            )}
            <text x="20" y="24.5" textAnchor="middle" fontSize="10" fontWeight="700" fill="rgb(var(--content-primary))">
              {masteryHas ? `${masteryPct}%` : '—'}
            </text>
          </svg>
          <span className="truncate text-[11.5px] text-content-muted">
            {masteryHas
              ? streakDays != null && streakDays > 0
                ? `均掌握 ${masteryPct}% · 连续 ${streakDays} 天 · `
                : `均掌握 ${masteryPct}% · ${noteCount} 个考点 · `
              : '还没有数据 · '}
            累计 <b className="text-[13px] font-semibold text-content-primary">{totalSessions}</b> 场
          </span>
          <span className="flex-1" />
          <button
            type="button"
            onClick={onOpenStats}
            className="shrink-0 text-[12.5px] font-medium text-accent transition-opacity hover:opacity-80"
          >
            复习统计 ›
          </button>
        </div>
      </div>
    </div>
  )
}
