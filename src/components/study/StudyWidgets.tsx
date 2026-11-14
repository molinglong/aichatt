'use client'

/**
 * 学习台右侧小组件列 —— StudyHome 的子组件(纯展示)。
 * 数据全部由父组件 props 下发,不自取数;无数据时优雅空态。
 */

/** 复习统计卡(阶段三方案B:「知识掌握」环升级):均掌握度环 + 连击天数,点击开统计弹层 */
export function MasteryWidget({
  masteryAvg,
  noteCount,
  streakDays,
  onOpenStats,
}: {
  masteryAvg: number | null
  noteCount: number
  /** 连续复习天数(stats 接口;加载中/无数据为 null) */
  streakDays: number | null
  onOpenStats: () => void
}) {
  const has = masteryAvg !== null
  const pct = has ? Math.round(masteryAvg * 100) : 0
  const C = 2 * Math.PI * 22
  return (
    <button
      type="button"
      onClick={onOpenStats}
      title={has ? `平均掌握度 ${pct}%,点开复习统计` : '学完第一题,掌握度就会出现在这里'}
      className="glass-blur flex flex-1 items-center gap-3 rounded-[14px] border border-line/60 bg-surface-glass px-4 py-3 text-left transition-colors hover:border-line-strong"
    >
      <svg viewBox="0 0 52 52" className="h-[52px] w-[52px] shrink-0" aria-hidden>
        <circle cx="26" cy="26" r="22" fill="none" stroke="rgb(var(--surface-subtle))" strokeWidth="5" />
        {has && (
          <circle
            cx="26"
            cy="26"
            r="22"
            fill="none"
            stroke="rgb(var(--accent))"
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={`${(C * pct) / 100} ${C}`}
            transform="rotate(-90 26 26)"
          />
        )}
        <text
          x="26"
          y="31"
          textAnchor="middle"
          fontSize="13"
          fontWeight="700"
          fill="rgb(var(--content-primary))"
        >
          {has ? `${pct}%` : '—'}
        </text>
      </svg>
      <div className="min-w-0">
        <div className="text-[13px] font-semibold leading-tight text-content-primary">复习统计</div>
        <div className="mt-0.5 truncate text-[11.5px] text-content-muted">
          {has
            ? streakDays != null && streakDays > 0
              ? `${pct}% 均掌握 · 连续 ${streakDays} 天`
              : `${pct}% 均掌握 · ${noteCount} 个考点`
            : '还没有数据'}
        </div>
      </div>
    </button>
  )
}

/** 累计学习场次:大数字展示 */
export function SessionCountWidget({ totalSessions }: { totalSessions: number }) {
  return (
    <div className="glass-blur flex flex-1 items-center rounded-[14px] border border-line/60 bg-surface-glass px-4 py-3">
      <div>
        <div className="text-[24px] font-bold leading-tight text-content-primary tabular-nums">
          {totalSessions}
          <span className="ml-1 text-[11.5px] font-normal text-content-muted">场</span>
        </div>
        <div className="mt-0.5 text-[11.5px] text-content-muted">累计学习场次</div>
      </div>
    </div>
  )
}
