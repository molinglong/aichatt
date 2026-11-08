'use client'

/**
 * 学习台(E+ 三宫格方案):打开 /study 的第一屏。
 * v4 任务队列式首页(用户定稿):进行中的题(可多道)条卡列表在上(带上次讲到摘要+相对时间),
 * 今日复习区(复习卡+小组件列)居中,学新题虚线沉底;小组件列是 StudyWidgets 儿子组件。
 */
import { useRouter } from 'next/navigation'
import { cn } from '@/lib/utils'
import { MasteryWidget, SessionCountWidget } from './StudyWidgets'

export interface StudySessionListItem {
  id: string
  question: string
  status: 'explaining' | 'completed'
  stepCount: number
  updatedAt: string
  /** 上次讲解末尾的摘要(API 返回,content 前 60 字),进行中条卡用 */
  lastStepBrief?: string | null
}

interface Props {
  sessions: StudySessionListItem[]
  dueCount: number
  noteCount: number
  favoriteCount: number
  kbCount: number
  /** StudyNote.mastery 均值(0-1);无笔记为 null */
  masteryAvg: number | null
  /** 累计学习场次(列表接口 total) */
  totalSessions: number
  loading: boolean
  onResume: (id: string) => void
  /** text = 输入框里已敲的题目,带进 setup 预填 */
  onNew: (text?: string) => void
  onOpenDrawer: (tab: 'review' | 'notes' | 'favorites') => void
}

function shortTitle(q: string): string {
  return q.replace(/[#*`>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24) || '未命名题目'
}

/** 相对时间:今天/昨天/N 天前,超过一周回退日期 */
function dateRel(iso: string): string {
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

function PencilIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
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

/* 区块小标签:「继续学习 · N 道进行中」 */
function SecLabel({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <div className="mb-2 px-0.5 text-[11px] text-content-muted">
      {children}
      {count != null && count > 0 && <span className="ml-1 font-medium text-content-secondary">· {count} 道进行中</span>}
    </div>
  )
}

export function StudyHome({
  sessions,
  dueCount,
  noteCount,
  favoriteCount,
  kbCount,
  masteryAvg,
  totalSessions,
  loading,
  onResume,
  onNew,
  onOpenDrawer,
}: Props) {
  const router = useRouter()
  // sessions 已按 updatedAt 倒序;进行中的题全部露出(v4:不再只取最近一道)
  const inProgress = sessions.filter((s) => s.status === 'explaining')
  const continueTarget = inProgress[0]

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

        {/* ── 今日复习区:复习卡 + 小组件列 ── */}
        <div className="mb-5">
          <SecLabel>今日复习</SecLabel>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_216px]">
            <button
              type="button"
              onClick={() => onOpenDrawer('review')}
              className="group glass-blur flex flex-col items-start gap-1 rounded-[14px] border border-line/60 bg-surface-glass p-4 text-left transition-all duration-150 hover:-translate-y-px hover:border-line-strong"
            >
              <IconBadge>
                <RepeatIcon />
              </IconBadge>
              <b className="w-full truncate text-[15px] font-semibold leading-snug text-content-primary">
                {dueCount > 0 ? `今日复习 ${dueCount} 张` : '暂无到期卡片'}
              </b>
              <span className="text-xs text-content-muted">
                {dueCount > 0 ? '按记忆曲线自动排期' : '学新题会自动排期'}
              </span>
              <span className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-[7px] text-[13px] font-semibold text-accent-foreground transition-transform duration-150 group-hover:translate-x-0.5">
                {dueCount > 0 ? '开始复习' : '看看队列'}
                <ArrowRightIcon />
              </span>
            </button>

            {/* 小组件列(儿子组件,props 下发) */}
            <div className="flex flex-col gap-3">
              <MasteryWidget masteryAvg={masteryAvg} noteCount={noteCount} onOpenNotes={() => onOpenDrawer('notes')} />
              <SessionCountWidget totalSessions={totalSessions} />
            </div>
          </div>
        </div>

        {/* ── 学新题:有进行中时通栏虚线;没有时用入口卡承担 ── */}
        {continueTarget && (
          <button type="button" onClick={() => onNew()} className="study-newq-btn glass-blur mb-5 w-full">
            ＋ 学新题
          </button>
        )}
        {!continueTarget && (
          <div className="mb-3.5 grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_216px]">
            <button
              type="button"
              onClick={() => onNew()}
              className="group glass-blur flex flex-col items-start gap-1 rounded-[14px] border border-line/60 bg-surface-glass p-4 text-left transition-all duration-150 hover:-translate-y-px hover:border-line-strong"
            >
              <IconBadge>
                <PencilIcon />
              </IconBadge>
              <b className="w-full truncate text-[15px] font-semibold leading-snug text-content-primary">学新题</b>
              <span className="text-xs text-content-muted">贴题或传图，选个起点开讲</span>
              <span className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-[7px] text-[13px] font-semibold text-accent-foreground transition-transform duration-150 group-hover:translate-x-0.5">
                开始
                <ArrowRightIcon />
              </span>
            </button>
            <button
              type="button"
              onClick={() => onOpenDrawer('review')}
              className="group glass-blur flex flex-col items-start gap-1 rounded-[14px] border border-line/60 bg-surface-glass p-4 text-left transition-all duration-150 hover:-translate-y-px hover:border-line-strong"
            >
              <IconBadge>
                <RepeatIcon />
              </IconBadge>
              <b className="w-full truncate text-[15px] font-semibold leading-snug text-content-primary">
                {dueCount > 0 ? `今日复习 ${dueCount} 张` : '暂无到期卡片'}
              </b>
              <span className="text-xs text-content-muted">
                {dueCount > 0 ? '按记忆曲线自动排期' : '学新题会自动排期'}
              </span>
              <span className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-[7px] text-[13px] font-semibold text-accent-foreground transition-transform duration-150 group-hover:translate-x-0.5">
                {dueCount > 0 ? '开始复习' : '看看队列'}
                <ArrowRightIcon />
              </span>
            </button>
            <div className="flex flex-col gap-3">
              <MasteryWidget masteryAvg={masteryAvg} noteCount={noteCount} onOpenNotes={() => onOpenDrawer('notes')} />
              <SessionCountWidget totalSessions={totalSessions} />
            </div>
          </div>
        )}

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
          <button type="button" className="flex items-baseline gap-1.5 rounded-full border border-line bg-surface-subtle/60 px-3.5 py-1.5 text-xs text-content-muted transition-colors hover:border-line-strong hover:text-content-primary" onClick={() => router.push('/kb')}>
            <b className="text-[13px] font-semibold tabular-nums text-content-primary">{kbCount}</b>课本
          </button>
        </div>
      </div>
    </div>
  )
}
