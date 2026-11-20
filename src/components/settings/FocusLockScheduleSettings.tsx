'use client'

import { useEffect, useState } from 'react'
import { Shield } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  FOCUS_SKIP_QUOTA_PER_MONTH,
  findActiveScheduleWindow,
  findNextScheduleWindow,
  getScheduleConfig,
  getSkipUsage,
  hhmmToMinutes,
  isScheduleSkippedToday,
  isWeekdayNow,
  refreshSchedule,
  setScheduleConfig,
  useFocusLockSchedule,
  type FocusLockScheduleConfig,
} from '@/lib/focus-lock-store'

/**
 * 设置 → 监管模式:定时锁定课表(定案 B 时间轴样式 + C 每段独立开关)。
 *
 * 课表只覆盖「人在家」的锁定时段,周一至周五生效;吃饭 15 分钟自由段不在
 * 课表内(时间轴上按 锁段起点 − 15 分钟 推算展示,仅示意不参与调度)。
 * 配置落 localStorage(focusLock:schedule),调度器在 FocusLock.tsx;
 * 设置开在独立 Tauri 子窗口,这里每次编辑即写盘,主窗口靠 storage 事件/
 * 30s 轮询跟进。开关只影响之后的自动锁 —— 锁定期切开关不会停当前锁。
 */

const DAY_MIN = 24 * 60

/** 分钟数 → 24h 时间轴上的百分比定位 */
function pct(min: number): string {
  return `${((min / DAY_MIN) * 100).toFixed(3)}%`
}

/** 分钟数 → HH:mm 刻度标签 */
function fmtMin(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
}

/** 开关滑块:与设置弹窗既有规格一致(桌面 36×20) */
function Switch({
  on,
  onClick,
  label,
  disabled,
}: {
  on: boolean
  onClick: () => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'relative h-5 w-9 shrink-0 rounded-full transition-colors duration-150 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40',
        on ? 'fl-switch-on' : 'bg-surface-subtle'
      )}
    >
      <span
        className={cn(
          'absolute top-[2px] left-[2px] h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-150',
          on && 'translate-x-4'
        )}
      />
    </button>
  )
}

export function FocusLockScheduleSettings() {
  // store 快照:外部(另一窗口/storage 事件)改动时同步进草稿
  const storeCfg = useFocusLockSchedule()
  // 本地草稿:时间输入的中间态(如先把 12:55 改成 14:00 的瞬间)不上盘,
  // 整行起止合法才持久化;非法行显示红字提示
  const [draft, setDraft] = useState<FocusLockScheduleConfig>(() => getScheduleConfig())
  // 30s 本地 tick:状态行/配额行跟着刷新(设置子窗口常驻,不需重启)
  const [now, setNow] = useState<Date | null>(null)

  useEffect(() => {
    refreshSchedule()
    setNow(new Date())
    const id = window.setInterval(() => setNow(new Date()), 30000)
    return () => window.clearInterval(id)
  }, [])

  // 外部改动同步(自己写盘引发的变化值相同,覆盖无感)
  useEffect(() => {
    setDraft(storeCfg)
  }, [storeCfg])

  const persist = (next: FocusLockScheduleConfig) => {
    setDraft(next)
    const allValid = next.windows.every((w) => {
      const s = hhmmToMinutes(w.start)
      const e = hhmmToMinutes(w.end)
      return s !== null && e !== null && s < e
    })
    if (allValid) setScheduleConfig(next)
  }

  const toggleEnabled = () => persist({ ...draft, enabled: !draft.enabled })

  const toggleWindow = (id: string) =>
    persist({
      ...draft,
      windows: draft.windows.map((w) => (w.id === id ? { ...w, on: !w.on } : w)),
    })

  const updateTime = (id: string, field: 'start' | 'end', value: string) => {
    const next = {
      ...draft,
      windows: draft.windows.map((w) => (w.id === id ? { ...w, [field]: value } : w)),
    }
    persist(next)
  }

  // 状态行文案(空值首渲染占位,避免 SSR 水合不一致)
  let statusText = '…'
  let statusDot = 'bg-content-muted/40'
  if (now) {
    if (!draft.enabled) {
      statusText = '定时锁已关闭 · 手动开锁不受影响'
    } else if (!isWeekdayNow(now)) {
      statusText = '周末不自动锁 · 周一至周五生效'
      statusDot = 'bg-content-muted/40'
    } else if (isScheduleSkippedToday()) {
      statusText = '今日已跳过 · 今天剩余锁段全免，明天照常'
      statusDot = 'bg-content-muted/40'
    } else {
      const act = findActiveScheduleWindow(draft, now)
      if (act) {
        statusText = `${act.win.label}锁定中 · ${act.win.end} 自动解锁`
        statusDot = 'bg-amber-500'
      } else {
        const nxt = findNextScheduleWindow(draft, now)
        if (nxt) {
          statusText = `下一锁 ${nxt.win.start} – ${nxt.win.end} · 今天还剩 ${nxt.remainingToday} 段`
          statusDot = 'bg-emerald-500'
        } else {
          statusText = '今天没有更多自动锁时段'
          statusDot = 'bg-content-muted/40'
        }
      }
    }
  }

  const skipUsage = getSkipUsage()

  // 时间轴段:每段锁块(on 实心琥珀 / off 空心虚线)+ 锁段前 15 分钟吃饭绿条(示意)
  const segs = draft.windows.flatMap((w) => {
    const s = hhmmToMinutes(w.start)
    const e = hhmmToMinutes(w.end)
    if (s === null || e === null || s >= e) return []
    const mealStart = s - 15
    return [{ id: w.id, on: w.on, s, e, meal: mealStart >= 0 && w.on ? mealStart : null }]
  })
  const marks = segs.flatMap((seg) => [
    { key: `${seg.id}-s`, min: seg.s, label: fmtMin(seg.s), end: false },
    { key: `${seg.id}-e`, min: seg.e, label: fmtMin(seg.e), end: true },
  ])

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3 space-y-2.5">
        {/* 头部:标题 + 总开关 */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-content-secondary">
            <Shield className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">定时锁定 · 在家时段</span>
          </div>
          <Switch on={draft.enabled} onClick={toggleEnabled} label="定时锁定总开关" />
        </div>
        <p className="text-[11px] leading-5 text-content-muted">
          周一至周五,到家吃完 15 分钟饭后自动上锁到段尾;在校与夜里不设锁。手动开锁不受影响。
        </p>

        {/* 状态行 */}
        <p className="flex items-center gap-1.5 text-[11px] leading-5 text-content-secondary">
          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', statusDot)} />
          {statusText}
        </p>

        {/* 24h 时间轴(B 案定案样式):琥珀实心=启用锁段,空心虚线=停用段,绿色=吃饭自由 */}
        <div className="pt-0.5">
          <div className="relative h-3 overflow-hidden rounded-full border border-line bg-surface-subtle/60">
            {[6, 12, 18].map((h) => (
              <span
                key={h}
                aria-hidden
                className="absolute inset-y-0 w-px bg-line"
                style={{ left: pct(h * 60) }}
              />
            ))}
            {segs.map((seg) => (
              <div key={seg.id} className="contents">
                {seg.meal !== null && (
                  <span
                    aria-hidden
                    className="absolute inset-y-0 bg-emerald-500/60"
                    style={{ left: pct(seg.meal), width: pct(15) }}
                  />
                )}
                <span
                  aria-hidden
                  className={cn(
                    'absolute inset-y-0',
                    seg.on ? 'bg-amber-500/80' : 'border border-dashed border-amber-500/50'
                  )}
                  style={{ left: pct(seg.s), width: pct(seg.e - seg.s) }}
                />
              </div>
            ))}
          </div>
          <div className="relative mt-1 h-7 text-[10px] leading-4 text-content-muted">
            {marks.map((m, i) => (
              <span
                key={m.key}
                // 奇偶交错两行:相邻刻度(17:55→18:30 仅差 3.5% 带宽)不再水平相撞
                className="absolute -translate-x-1/2 tabular-nums"
                style={{ left: pct(m.min), top: i % 2 === 0 ? 0 : 12 }}
              >
                {m.label}
              </span>
            ))}
          </div>
        </div>

        {/* 分段行:独立开关(C 案定案)+ 起止时间 */}
        <div className="space-y-1.5">
          {draft.windows.map((w) => {
            const s = hhmmToMinutes(w.start)
            const e = hhmmToMinutes(w.end)
            const rowInvalid = s === null || e === null || s >= e
            return (
              <div
                key={w.id}
                className="flex items-center justify-between gap-2 rounded-lg bg-surface-subtle/60 px-2.5 py-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Switch on={w.on} onClick={() => toggleWindow(w.id)} label={`${w.label}开关`} />
                  <span className="min-w-0 truncate text-[11px] text-content-primary">{w.label}</span>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <input
                    type="time"
                    value={w.start}
                    onChange={(ev) => updateTime(w.id, 'start', ev.target.value)}
                    aria-label={`${w.label}开始时间`}
                    className="h-7 rounded-lg border border-line bg-surface px-1.5 text-[11px] text-content-primary outline-none focus:border-accent/50 max-md:h-9 max-md:text-[16px]"
                  />
                  <span className="text-[11px] text-content-muted">–</span>
                  <input
                    type="time"
                    value={w.end}
                    onChange={(ev) => updateTime(w.id, 'end', ev.target.value)}
                    aria-label={`${w.label}结束时间`}
                    className={cn(
                      'h-7 rounded-lg border bg-surface px-1.5 text-[11px] text-content-primary outline-none max-md:h-9 max-md:text-[16px]',
                      rowInvalid ? 'border-red-500/70 focus:border-red-500' : 'border-line focus:border-accent/50'
                    )}
                  />
                </div>
              </div>
            )
          })}
          {draft.windows.some((w) => {
            const s = hhmmToMinutes(w.start)
            const e = hhmmToMinutes(w.end)
            return s === null || e === null || s >= e
          }) && (
            <p className="text-[10px] leading-4 text-red-500">
              有时段起止无效(需 当天 HH:mm,开始 &lt; 结束),该行改动暂未保存。
            </p>
          )}
        </div>

        {/* 规则 pills */}
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-600 dark:text-emerald-400">
            周一至周五生效
          </span>
          <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[10px] text-content-muted">
            在校 / 夜里不设锁
          </span>
          <span className="rounded-full bg-surface-muted px-2 py-0.5 text-[10px] text-content-muted">
            周末后续再议
          </span>
        </div>

        {/* 今日跳过配额 */}
        <div className="flex items-center justify-between gap-2 rounded-lg bg-surface-subtle/60 px-2.5 py-2">
          <div className="min-w-0">
            <span className="text-[11px] text-content-primary">今日跳过</span>
            <span className="ml-2 text-[10px] text-content-muted">
              锁内徽章面板操作 · 跳过当天剩余锁段 ·{' '}
              {skipUsage.unlimited
                ? '测试期不限次'
                : `每月 ${FOCUS_SKIP_QUOTA_PER_MONTH} 次`}
            </span>
          </div>
          <span className="shrink-0 text-[10px] tabular-nums text-content-muted">
            {skipUsage.unlimited
              ? `本月已用 ${skipUsage.used} 次(不限次)`
              : `本月已用 ${skipUsage.used} / ${FOCUS_SKIP_QUOTA_PER_MONTH} 次`}
          </span>
        </div>

        {/* 边界说明 */}
        <p className="text-[10px] leading-4 text-content-muted">
          App 没开错过起点 → 打开即补锁到本段结束。总开关与分段开关只影响之后的自动锁，
          锁定期内切开关不会停当前锁。手动开锁不受影响，仍无退出入口。
        </p>
      </div>
    </div>
  )
}
