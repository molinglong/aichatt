'use client'

/**
 * 复习统计弹层(阶段三方案B:独立浮层,小组件「复习统计」卡/统计行 chip 进入)。
 * 内容三块:汇总 chips(连击/今日/待到期/近7日)+ 近 12 周热力图 + 考点掌握度排行(低在前)。
 * 「专项 ›」= 按考点过滤复习队列;底部「排个冲刺计划」进计划弹层(阶段四)。
 * 骨架与 StudyPanelDialog 同配方:桌面居中磨砂遮罩玻璃卡 + ESC/点外关,移动端全屏 + 返回键收口。
 */
import { useEffect } from 'react'
import { X, Flame } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useIsMobileViewport } from '@/hooks/useIsMobileViewport'
import { useBackToClose } from '@/hooks/useBackToClose'

export interface StudyStats {
  streakDays: number
  todayCount: number
  weekCount: number
  dueCount: number
  heatmap: Array<{ date: string; count: number }>
  topics: Array<{ topic: string; total: number; due: number; redo: number; masteryAvg: number }>
}

const CHIP = 'px-2.5 py-1 rounded-full text-xs bg-surface-subtle/60 border border-line/60 text-content-secondary'

/** 热力图色阶:accent 同色相 α 阶梯(token 口径,无新色相) */
function heatClass(count: number): string {
  if (count <= 0) return 'bg-surface-subtle'
  if (count <= 2) return 'bg-[rgb(var(--accent)/0.18)]'
  if (count <= 4) return 'bg-[rgb(var(--accent)/0.38)]'
  if (count <= 7) return 'bg-[rgb(var(--accent)/0.62)]'
  return 'bg-[rgb(var(--accent)/0.9)]'
}

export function ReviewStatsDialog({
  open,
  onClose,
  stats,
  loading,
  onSpecialize,
  onOpenPlan,
}: {
  open: boolean
  onClose: () => void
  /** 父组件 useQuery 下发(与小组件共用一份数据);null = 加载中/失败 */
  stats: StudyStats | null
  loading: boolean
  /** 按考点发起专项复习(开回看弹层并带 topic 过滤) */
  onSpecialize: (topic: string) => void
  onOpenPlan: () => void
}) {
  const isMobile = useIsMobileViewport()
  // 弹层内无导航,只借返回键哨兵收口
  useBackToClose(open, onClose)

  useEffect(() => {
    if (!open || isMobile) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, isMobile, onClose])

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
          <span className="px-2 text-xs font-semibold text-content-primary">复习统计</span>
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
          {loading && !stats ? (
            <div className="grid gap-3">
              <div className="study-sk h-8 rounded-full" />
              <div className="study-sk h-32 rounded-[14px]" />
              <div className="study-sk h-24 rounded-[14px]" />
            </div>
          ) : !stats ? (
            <div className="py-10 text-center text-[13px] text-content-muted">统计加载失败,稍后再试</div>
          ) : (
            <>
              {/* 汇总 chips */}
              <div className="flex flex-wrap gap-2">
                <span className={cn(CHIP, 'inline-flex items-center gap-1')}>
                  <Flame size={12} className="text-accent" aria-hidden />
                  连续 <b className="tabular-nums">{stats.streakDays}</b> 天
                </span>
                <span className={CHIP}>
                  今日已复习 <b className="tabular-nums">{stats.todayCount}</b>
                </span>
                <span className={CHIP}>
                  待到期 <b className="tabular-nums">{stats.dueCount}</b>
                </span>
                <span className={CHIP}>
                  近 7 日 <b className="tabular-nums">{stats.weekCount}</b> 张
                </span>
              </div>

              {/* 近 12 周热力图:行=星期一~日,列=周(GitHub 口径) */}
              <div className="mt-5 text-[11px] text-content-muted">复习频率 · 近 12 周</div>
              <div className="mt-2 flex gap-[3px] overflow-x-auto pb-1">
                {/* 84 天按周列排:第一列补齐周一开头 */}
                {chunkHeatmapIntoWeeks(stats.heatmap).map((week, wi) => (
                  <div key={wi} className="flex flex-col gap-[3px]">
                    {week.map((d, di) => (
                      <span
                        key={di}
                        title={d ? `${d.date} · 复习 ${d.count} 张` : undefined}
                        className={cn('h-[13px] w-[13px] rounded-[3px]', d ? heatClass(d.count) : 'opacity-0')}
                      />
                    ))}
                  </div>
                ))}
              </div>
              <div className="mt-1.5 flex items-center justify-end gap-1 text-[10px] text-content-muted">
                少
                <span className={cn('h-2.5 w-2.5 rounded-[3px]', heatClass(1))} />
                <span className={cn('h-2.5 w-2.5 rounded-[3px]', heatClass(3))} />
                <span className={cn('h-2.5 w-2.5 rounded-[3px]', heatClass(5))} />
                <span className={cn('h-2.5 w-2.5 rounded-[3px]', heatClass(9))} />
                多
              </div>

              {/* 考点掌握度排行 */}
              <div className="mt-5 flex items-baseline gap-2 text-[11px] text-content-muted">
                考点掌握度<span className="text-[10px]">(低的在前)</span>
                {stats.topics.length > 6 && <span className="ml-auto">共 {stats.topics.length} 个考点</span>}
              </div>
              <div className="mt-2 space-y-1.5">
                {stats.topics.length === 0 && (
                  <div className="rounded-[14px] border border-line/60 bg-surface-glass px-4 py-3 text-[12px] text-content-muted">
                    还没有带考点标签的错题卡
                  </div>
                )}
                {stats.topics.slice(0, 8).map((t) => {
                  const pct = Math.round(t.masteryAvg * 100)
                  return (
                    <div
                      key={t.topic}
                      className="flex items-center gap-2.5 rounded-[12px] border border-line/60 bg-surface-glass px-3 py-2"
                    >
                      <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-content-primary">{t.topic}</span>
                      <span className="h-1.5 w-[72px] flex-none overflow-hidden rounded-full bg-surface-subtle">
                        <span
                          className={cn('block h-full rounded-full', pct < 40 ? 'bg-destructive' : 'bg-accent')}
                          style={{ width: `${pct}%` }}
                        />
                      </span>
                      <span className="w-9 flex-none text-right text-[11px] tabular-nums text-content-secondary">{pct}%</span>
                      {t.due > 0 ? (
                        <span className="flex-none rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive">
                          到期 {t.due}
                        </span>
                      ) : (
                        <span className="flex-none rounded-full bg-surface-subtle px-2 py-0.5 text-[10px] text-content-muted">无到期</span>
                      )}
                      <button
                        type="button"
                        onClick={() => onSpecialize(t.topic)}
                        className="flex-none text-[11px] font-medium text-accent transition-opacity hover:opacity-80"
                      >
                        专项 ›
                      </button>
                    </div>
                  )
                })}
              </div>

              {/* 冲刺计划入口(阶段四) */}
              <button
                type="button"
                onClick={onOpenPlan}
                className="mt-6 w-full rounded-[14px] border-[1.5px] border-dashed border-line-strong px-4 py-3 text-[13px] font-semibold text-accent transition-all duration-150 hover:-translate-y-px hover:border-solid hover:border-accent hover:bg-accent-soft"
              >
                排个考前冲刺计划 ›
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

/** 84 天(旧→新)按周分列:首列按周一开头补 null 占位,让列对齐星期 */
function chunkHeatmapIntoWeeks(heatmap: Array<{ date: string; count: number }>): Array<Array<{ date: string; count: number } | null>> {
  if (heatmap.length === 0) return []
  const firstDow = (new Date(heatmap[0].date + 'T00:00:00').getDay() + 6) % 7 // 0=周一
  const cells: Array<{ date: string; count: number } | null> = [
    ...Array.from({ length: firstDow }, () => null),
    ...heatmap,
  ]
  const weeks: Array<Array<{ date: string; count: number } | null>> = []
  for (let i = 0; i < cells.length; i += 7) {
    let week = cells.slice(i, i + 7)
    while (week.length < 7) week = [...week, null]
    weeks.push(week)
  }
  return weeks
}
