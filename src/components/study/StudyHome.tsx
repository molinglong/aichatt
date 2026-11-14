'use client'

/**
 * 学习台(E+ 三宫格方案):打开 /study 的第一屏。
 * v4 任务队列式首页(用户定稿):进行中的题(可多道)条卡列表在上(带上次讲到摘要+相对时间),
 * 今日复习区(复习卡+小组件列)居中,学新题虚线沉底;小组件列是 StudyWidgets 儿子组件。
 * 2026-11-14 方案A:复习卡/小组件全页只渲染一份(删掉无进行中会话时的重复三分栏),
 * 「学新题」通栏虚线按钮常驻;首屏数据未齐时整页骨架屏,不再闪零值空态。
 * 原型:design/preview-study-home-loading.html
 */
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'
import { SUBJECT_LABELS } from '@/lib/study/subject-labels'
import { MasteryWidget, SessionCountWidget } from './StudyWidgets'

/** 冲刺计划摘要(阶段四方案A:学习台常驻条卡;详情在 PlanDialog) */
export interface StudyPlanSummary {
  title: string
  examDate: string
  /** 今天应做的项数与已完成数(父组件从 plan items 聚合) */
  todayTotal: number
  todayDone: number
  totalItems: number
  totalDone: number
}

export interface StudySessionListItem {
  id: string
  question: string
  status: 'explaining' | 'completed'
  stepCount: number
  updatedAt: string
  /** 上次讲解末尾的摘要(API 返回,content 前 60 字),进行中条卡用 */
  lastStepBrief?: string | null
}

/** 拟卷列表条目(GET /api/papers/composed);区块展示最近几张,统计行 chip 显总数 */
export interface ComposedPaperListItem {
  id: string
  title: string
  subject: string
  totalScore: number
  durationMin: number
  onlyChoice: boolean
  createdAt: string
  slotCount: number
}

interface Props {
  sessions: StudySessionListItem[]
  dueCount: number
  /** 到期卡里可重做题库原题的张数(入口卡副行「其中 M 道可重做」) */
  dueRedoCount: number
  noteCount: number
  favoriteCount: number
  kbCount: number
  /** StudyNote.mastery 均值(0-1);无笔记为 null */
  masteryAvg: number | null
  /** 连续复习天数(stats 接口;加载中为 null) */
  streakDays: number | null
  /** 累计学习场次(列表接口 total) */
  totalSessions: number
  /** 当前生效冲刺计划摘要;null = 无计划不渲染冲刺条 */
  activePlan: StudyPlanSummary | null
  /** 拟卷列表(createdAt 倒序全量,组件内取最近 3 张);空 = 区块与 chip 都不渲染 */
  papers: ComposedPaperListItem[]
  /** 会话列表单独刷新中(整页骨架屏由 booting 承担,这里只管会话区块的重取态) */
  loading: boolean
  /** 首屏数据未齐(list/queue/notes/favorites/kb/papers 任一仍在首取):整页骨架屏,不渲染零值 */
  booting: boolean
  onResume: (id: string) => void
  /** text = 输入框里已敲的题目,带进 setup 预填 */
  onNew: (text?: string) => void
  onOpenDrawer: (tab: 'review' | 'notes' | 'favorites', mode?: 'flip' | 'redo') => void
  onOpenStats: () => void
  onOpenPlan: () => void
}

function shortTitle(q: string): string {
  return q.replace(/[#*`>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24) || '未命名题目'
}

/** 相对时间:今天/昨天/N 天前,超过一周回退日期(学习台条卡与拟卷列表页共用) */
export function dateRel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  return `${d.getMonth() + 1}-${d.getDate()}`
}

/* 图标章:accent-soft 圆角方形 + 线性 SVG(禁 emoji 当图标) */
function IconBadge({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[12px] bg-accent-soft text-accent"
      aria-hidden
    >
      {children}
    </span>
  )
}

function BookIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </svg>
  )
}

function RepeatIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  )
}

function TargetIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  )
}

function DocIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M8 13h8" />
      <path d="M8 17h5" />
    </svg>
  )
}

function ArrowRightIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  )
}

/* 区块小标签:「继续学习 · N 道进行中」;unit 换量词(拟卷=张) */
function SecLabel({ children, count, unit = '道进行中' }: { children: React.ReactNode; count?: number; unit?: string }) {
  return (
    <div className="mb-2 px-0.5 text-[11px] text-content-muted">
      {children}
      {count != null && count > 0 && <span className="ml-1 font-medium text-content-secondary">· {count} {unit}</span>}
    </div>
  )
}

export function StudyHome({
  sessions,
  dueCount,
  dueRedoCount,
  noteCount,
  favoriteCount,
  kbCount,
  masteryAvg,
  streakDays,
  totalSessions,
  activePlan,
  papers,
  loading,
  booting,
  onResume,
  onNew,
  onOpenDrawer,
  onOpenStats,
  onOpenPlan,
}: Props) {
  const router = useRouter()
  // sessions 已按 updatedAt 倒序;进行中的题全部露出(v4:不再只取最近一道)
  const inProgress = sessions.filter((s) => s.status === 'explaining')

  // 首屏骨架屏(方案A):形状对齐数据到达后的布局,加载中不再闪「0 场 / 还没有数据」
  if (booting) {
    return (
      <div className="h-full min-h-0 overflow-y-auto">
        <div className="mx-auto max-w-[860px] px-7 py-7">
          <div className="study-sk h-[22px] w-32 rounded-md" />
          <div className="study-sk mt-2.5 h-3 w-56 rounded-md" />
          <div className="mb-5 mt-6">
            <div className="study-sk mb-2 h-[11px] w-16 rounded-sm" />
            <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_216px]">
              <div className="study-sk h-[150px] rounded-[14px]" />
              <div className="flex flex-col gap-3">
                <div className="study-sk h-[72px] rounded-[14px]" />
                <div className="study-sk h-[72px] rounded-[14px]" />
              </div>
            </div>
          </div>
          <div className="study-sk mb-5 h-12 rounded-[14px]" />
          <div className="study-sk mb-2 h-[46px] rounded-[14px]" />
          <div className="study-sk mb-2 h-[46px] w-[78%] rounded-[14px]" />
          <div className="mt-4 flex gap-2">
            <div className="study-sk h-[29px] w-16 rounded-full" />
            <div className="study-sk h-[29px] w-16 rounded-full" />
            <div className="study-sk h-[29px] w-16 rounded-full" />
            <div className="study-sk h-[29px] w-16 rounded-full" />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto max-w-[860px] px-7 py-7">
        <h2 className="text-[22px] font-bold tracking-[0.01em]">学习模式</h2>
        <p className="mb-5 mt-1 text-[13px] text-content-secondary">到期的复习优先，没讲完的接着讲。</p>

        {/* ── 进行中区:每道进行中的题一张横向条卡 ── */}
        {inProgress.length > 0 && (
          <div className="mb-5">
            <SecLabel count={inProgress.length}>继续学习</SecLabel>
            <div className="space-y-2.5">
              {inProgress.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onResume(s.id)}
                  className="group glass-blur flex w-full items-center gap-3.5 rounded-[14px] border border-line/60 bg-surface-glass px-4 py-3 text-left transition-all duration-150 hover:-translate-y-px hover:border-line-strong"
                >
                  <IconBadge>
                    <BookIcon />
                  </IconBadge>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-semibold text-content-primary">
                      {shortTitle(s.question)}
                    </span>
                    {s.lastStepBrief && (
                      <span className="mt-0.5 block truncate text-xs text-content-secondary">
                        上次讲到：<span className="font-medium text-content-muted">{s.lastStepBrief}</span>
                      </span>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-3">
                    <span className="text-[11.5px] text-content-muted">{dateRel(s.updatedAt)}</span>
                    <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-[11px] font-medium text-accent">
                      讲到第 {s.stepCount} 步
                    </span>
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-[7px] text-[12.5px] font-semibold text-accent-foreground transition-transform duration-150 group-hover:translate-x-0.5">
                      继续
                      <ArrowRightIcon size={12} />
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* ── 冲刺计划条(阶段四方案A:active 计划常驻;点开按日勾销弹层) ── */}
        {activePlan && (
          <div className="mb-5">
            <SecLabel>考前冲刺</SecLabel>
            <button
              type="button"
              onClick={onOpenPlan}
              className="group glass-blur flex w-full items-center gap-3.5 rounded-[14px] border border-accent/50 bg-surface-glass px-4 py-3 text-left transition-all duration-150 hover:-translate-y-px hover:border-accent"
            >
              <IconBadge>
                <TargetIcon />
              </IconBadge>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-semibold text-content-primary">{activePlan.title}</span>
                <span className="mt-0.5 block truncate text-xs text-content-muted">
                  距考试 {Math.max(0, Math.round((new Date(`${activePlan.examDate}T00:00:00`).getTime() - new Date(new Date().setHours(0, 0, 0, 0)).getTime()) / 86_400_000))} 天
                  {activePlan.todayTotal > 0
                    ? ` · 今日已完成 ${activePlan.todayDone}/${activePlan.todayTotal}`
                    : ' · 今天还没有任务'}
                </span>
              </span>
              <span className="h-1.5 w-16 flex-none overflow-hidden rounded-full bg-surface-subtle">
                <span
                  className="block h-full rounded-full bg-accent"
                  style={{ width: `${activePlan.totalItems > 0 ? (activePlan.totalDone / activePlan.totalItems) * 100 : 0}%` }}
                />
              </span>
              <span className="inline-flex flex-none items-center gap-1.5 rounded-full bg-accent px-3.5 py-[7px] text-[12.5px] font-semibold text-accent-foreground transition-transform duration-150 group-hover:translate-x-0.5">
                打开
                <ArrowRightIcon size={12} />
              </span>
            </button>
          </div>
        )}

        {/* ── 今日复习区:复习卡(单卡双出口,阶段一方案A)+ 小组件列 ── */}
        <div className="mb-5">
          <SecLabel>今日复习</SecLabel>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_216px]">
            <div
              className="group glass-blur flex flex-col items-start gap-1 rounded-[14px] border border-line/60 bg-surface-glass p-4 text-left transition-all duration-150 hover:-translate-y-px hover:border-line-strong"
            >
              <IconBadge>
                <RepeatIcon />
              </IconBadge>
              <b className="w-full truncate text-[15px] font-semibold leading-snug text-content-primary">
                {dueCount > 0 ? `今日复习 ${dueCount} 张` : '暂无到期卡片'}
              </b>
              <span className="text-xs text-content-muted">
                {dueCount > 0
                  ? dueRedoCount > 0
                    ? `到期 ${dueCount} · 其中 ${dueRedoCount} 道可重做题库原题`
                    : '按记忆曲线自动排期 · 核对式自评'
                  : '学新题会自动排期'}
              </span>
              <span className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onOpenDrawer('review', 'flip')}
                  className="inline-flex items-center gap-1.5 rounded-full border border-accent px-3.5 py-[6px] text-[12.5px] font-semibold text-accent transition-colors hover:bg-accent-soft"
                >
                  翻卡速览
                </button>
                <button
                  type="button"
                  onClick={() => onOpenDrawer('review', 'redo')}
                  className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-[7px] text-[12.5px] font-semibold text-accent-foreground transition-transform duration-150 hover:opacity-90"
                >
                  重做练习
                  <ArrowRightIcon size={12} />
                </button>
              </span>
            </div>

            {/* 小组件列(儿子组件,props 下发) */}
            <div className="flex flex-col gap-3">
              <MasteryWidget masteryAvg={masteryAvg} noteCount={noteCount} streakDays={streakDays} onOpenStats={onOpenStats} />
              <SessionCountWidget totalSessions={totalSessions} />
            </div>
          </div>
        </div>

        {/* ── 拟卷练习:最近 3 张卷条卡点击直达卷面,「全部拟卷」进列表页;无卷整块不渲染 ── */}
        {papers.length > 0 && (
          <div className="mb-5">
            <SecLabel count={papers.length} unit="张">拟卷练习</SecLabel>
            <div className="space-y-2.5">
              {/* 首行 CTA(方案A 虚线行动条,design/preview-study-compose-cta.html):与「＋ 学新题」同语言,跳列表页并自动展开组卷表单 */}
              <button
                type="button"
                onClick={() => router.push('/papers/composed?compose=1')}
                className="group flex w-full items-center gap-3.5 rounded-[14px] border-[1.5px] border-dashed border-line-strong px-4 py-3 text-left transition-all duration-150 hover:-translate-y-px hover:border-solid hover:border-accent hover:bg-accent-soft"
              >
                <span
                  className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[12px] border-[1.5px] border-dashed border-line-strong text-accent transition-colors duration-150 group-hover:border-accent group-hover:bg-accent group-hover:text-accent-foreground"
                  aria-hidden="true"
                >
                  <PlusIcon />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-semibold text-accent">去组一张卷</span>
                  <span className="mt-0.5 block truncate text-xs text-content-muted">真题重组 · 也可让 AI 补题</span>
                </span>
              </button>
              {papers.slice(0, 3).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => router.push(`/papers/composed/${p.id}`)}
                  className="group glass-blur flex w-full items-center gap-3.5 rounded-[14px] border border-line/60 bg-surface-glass px-4 py-3 text-left transition-all duration-150 hover:-translate-y-px hover:border-line-strong"
                >
                  <IconBadge>
                    <DocIcon />
                  </IconBadge>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-semibold text-content-primary">{p.title}</span>
                    <span className="mt-0.5 block truncate text-xs text-content-muted">
                      {SUBJECT_LABELS[p.subject as keyof typeof SUBJECT_LABELS] ?? p.subject} · 满分 {p.totalScore} · {p.slotCount} 题
                      {p.onlyChoice ? ' · 只取选择题' : ''}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3">
                    <span className="text-[11.5px] text-content-muted">{dateRel(p.createdAt)}</span>
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-[7px] text-[12.5px] font-semibold text-accent-foreground transition-transform duration-150 group-hover:translate-x-0.5">
                      打开
                      <ArrowRightIcon size={12} />
                    </span>
                  </span>
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => router.push('/papers/composed')}
              className="mt-2.5 inline-flex items-center gap-1 text-[12.5px] font-medium text-accent transition-opacity hover:opacity-80"
            >
              全部拟卷 ›
            </button>
          </div>
        )}

        {/* ── 学新题:通栏虚线按钮常驻(方案A:空态/有进行中同一形态,重复三分栏已删) ── */}
        <button type="button" onClick={() => onNew()} className="study-newq-btn glass-blur mb-5 w-full">
          ＋ 学新题
        </button>

        {/* ── 学习会话历史:全量列表(进行中的带蓝徽章,与上方区呼应) ── */}
        <div className="mt-5">
          <div className="mb-2 px-1 text-[11px] text-content-muted">学习会话</div>
          {loading && sessions.length === 0 && (
            <div className="glass-blur rounded-[14px] border border-line/60 bg-surface-glass px-4 py-3 text-[13px] text-content-muted">加载中…</div>
          )}
          {!loading && sessions.length === 0 && (
            <div className="glass-blur rounded-[14px] border border-line/60 bg-surface-glass px-4 py-3 text-[13px] text-content-muted">
              还没有学习会话，学完第一道题会自动收进这里
            </div>
          )}
          <div className="space-y-2">
            {sessions.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onResume(s.id)}
                className="glass-blur flex w-full items-center justify-between gap-3 rounded-[14px] border border-line/60 bg-surface-glass px-4 py-3 text-left transition-colors hover:border-line-strong"
              >
                <span className="min-w-0 truncate text-[13.5px] text-content-primary">{shortTitle(s.question)}</span>
                <span
                  className={cn(
                    'flex-none rounded-full px-2.5 py-0.5 text-[11px] font-medium',
                    s.status === 'explaining' ? 'bg-accent-soft text-accent' : 'bg-surface-subtle text-content-muted'
                  )}
                >
                  {s.status === 'explaining' ? `讲到第 ${s.stepCount} 步` : '已完成'}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <button type="button" className="flex items-baseline gap-1.5 rounded-full border border-line bg-surface-subtle/60 px-3.5 py-1.5 text-xs text-content-muted transition-colors hover:border-line-strong hover:text-content-primary" onClick={() => onOpenDrawer('notes')}>
            <b className="text-[13px] font-semibold tabular-nums text-content-primary">{noteCount}</b>错题本
          </button>
          <button type="button" className="flex items-baseline gap-1.5 rounded-full border border-line bg-surface-subtle/60 px-3.5 py-1.5 text-xs text-content-muted transition-colors hover:border-line-strong hover:text-content-primary" onClick={() => onOpenDrawer('review')}>
            <b className="text-[13px] font-semibold tabular-nums text-content-primary">{dueCount}</b>待回看
          </button>
          <button type="button" className="flex items-baseline gap-1.5 rounded-full border border-line bg-surface-subtle/60 px-3.5 py-1.5 text-xs text-content-muted transition-colors hover:border-line-strong hover:text-content-primary" onClick={() => onOpenDrawer('favorites')}>
            <b className="text-[13px] font-semibold tabular-nums text-content-primary">{favoriteCount}</b>收藏
          </button>
          <button type="button" className="flex items-baseline gap-1.5 rounded-full border border-line bg-surface-subtle/60 px-3.5 py-1.5 text-xs text-content-muted transition-colors hover:border-line-strong hover:text-content-primary" onClick={onOpenStats}>
            复习统计 ›
          </button>
          <button type="button" className="flex items-baseline gap-1.5 rounded-full border border-line bg-surface-subtle/60 px-3.5 py-1.5 text-xs text-content-muted transition-colors hover:border-line-strong hover:text-content-primary" onClick={() => router.push('/kb')}>
            <b className="text-[13px] font-semibold tabular-nums text-content-primary">{kbCount}</b>课本
          </button>
          {papers.length > 0 && (
            <button type="button" className="flex items-baseline gap-1.5 rounded-full border border-line bg-surface-subtle/60 px-3.5 py-1.5 text-xs text-content-muted transition-colors hover:border-line-strong hover:text-content-primary" onClick={() => router.push('/papers/composed')}>
              <b className="text-[13px] font-semibold tabular-nums text-content-primary">{papers.length}</b>拟卷
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
