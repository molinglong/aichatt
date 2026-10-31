'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'

interface DayStat {
  date: string
  count: number
}

interface ActivityStatsResponse {
  days: DayStat[]
  totalDays: number
  currentStreak?: number
}

export interface ActivityGridProps {
  /** 过去 N 周的数据(52 周 = GitHub profile 的整年视图) */
  weeks?: number
}

/** 活跃度分级(0-4): 空档 / 15% / 35% / 60% / 90%(走 CSS 变量,明暗主题自动适配) */
function getLevel(count: number): number {
  if (count === 0) return 0
  if (count <= 3) return 1
  if (count <= 9) return 2
  if (count <= 19) return 3
  return 4
}

const LEVEL_CLASSES = [
  'bg-[rgb(var(--surface-subtle)_/_80%)]',
  'bg-[rgb(var(--content-muted)_/_15%)] border border-transparent',
  'bg-[rgb(var(--content-muted)_/_35%)] border border-transparent',
  'bg-[rgb(var(--content-muted)_/_60%)] border border-transparent',
  'bg-[rgb(var(--content-muted)_/_90%)] border border-transparent',
]

function formatStreak(streak: number | undefined): string {
  if (!streak || streak <= 1) return ''
  return ` · 连续${streak}天`
}

/** GitHub profile 规格: 格 10px + 间距 2px → 52 列整年总宽 ≈ 622px,恰好填满 max-w-2xl */
const CELL = 10
const GAP = 2
const LABEL_H = 14

export function ActivityHeatmap({ weeks = 52 }: ActivityGridProps) {
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<ActivityStatsResponse | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [availW, setAvailW] = useState(0)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/stats/activity?weeks=${weeks}`)
      .then((res) => res.json())
      .then((json: ActivityStatsResponse) => {
        if (!cancelled) {
          setData(json)
          setLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [weeks])

  // 测量容器宽度供格子满宽伸缩;数据到位后滚动容器才挂载,故依赖 loading/data
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = () => setAvailW(el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [loading, data])

  if (loading) {
    return (
      <div className="flex justify-center" role="status" aria-live="off">
        {/* 与玻璃卡成品等高(网格 96 + 底行 14 + 间距 8 + 内边距 24),避免加载完成时跳动 */}
        <div className="heatmap-card h-[142px] w-full rounded-2xl border border-line/60 bg-surface-glass glass-blur animate-pulse" />
      </div>
    )
  }
  if (!data || data.days.length === 0) return null

  const todayStr = new Date().toISOString().slice(0, 10)
  const streakStr = formatStreak(data.currentStreak)
  const isYear = weeks >= 52

  // ── 只保留 2025-11-01 之后的数据: 此前的周列基本全是空白,裁掉后左侧不拖沓 ──
  // (52 周滚动窗口自然越过 2026-11 后,该下限自动失效,无需再改)
  const SINCE = '2025-11-01'
  const visibleDays = data.days.filter((d) => d.date >= SINCE)

  // ── 周对齐: 第一天按星期几在行方向补空位(0=周日),使每列都是完整的一周 ──
  type Cell = { date: string; count: number } | null
  const firstDow = new Date(`${visibleDays[0].date}T00:00:00`).getDay()
  const cells: Cell[] = [
    ...Array.from({ length: firstDow }, () => null),
    ...visibleDays,
  ]
  const numCols = Math.ceil(cells.length / 7)

  // ── 流式满宽:格子尺寸随容器宽度伸缩,铺满欢迎页栏宽(未测得时回落 GitHub 规格 10px)──
  // 总宽 = 星期标签列(宽=格子) + 4px 列距 + numCols 列格 + (numCols-1)×GAP → 反解单格尺寸
  const cellSize = availW > 0 ? Math.max(6, (availW - 4 - (numCols - 1) * GAP) / (numCols + 1)) : CELL

  // ── 月份标签: 每列第一个有效日期的月份变化时标注;相邻标签至少隔 3 列,防止挤压重叠 ──
  const monthLabels: Array<string | null> = []
  let lastMonth = -1
  let lastLabelCol = -99
  for (let c = 0; c < numCols; c++) {
    let label: string | null = null
    for (let r = 0; r < 7; r++) {
      const cell = cells[c * 7 + r]
      if (cell) {
        const m = new Date(`${cell.date}T00:00:00`).getMonth() + 1
        if (m !== lastMonth && c - lastLabelCol >= 3) {
          label = `${m}月`
          lastLabelCol = c
        }
        lastMonth = m
        break
      }
    }
    monthLabels.push(label)
  }

  return (
    <div className="w-full">
      {/* 玻璃承托卡(方案A,定稿自 preview-heatmap-wallpaper): 与输入框同一套玻璃语言,不再裸压壁纸 */}
      <div className="heatmap-card flex w-full flex-col gap-2 px-4 py-3 rounded-2xl border border-line/60 bg-surface-glass glass-blur shadow-[0_8px_28px_rgb(0_0_0_/_9%)]">
        {/* 满宽铺满欢迎页栏;极窄屏格子已随宽收缩,仍溢出时横向滚动(滚动条隐藏) */}
        <div ref={scrollRef} className="overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
          <div className="flex items-start gap-1">
            {/* 左侧星期标签列(行1=周日...行7=周六,标一/三/五) */}
            <div className="flex flex-col shrink-0" style={{ width: cellSize }}>
              <div style={{ height: LABEL_H }} />
              <div
                className="grid"
                style={{ gridTemplateRows: `repeat(7, ${cellSize}px)`, gap: GAP }}
              >
                {[2, 4, 6].map((row, i) => (
                  <span
                    key={row}
                    style={{ gridRow: row }}
                    className="text-[9px] leading-none text-content-muted"
                  >
                    {['一', '三', '五'][i]}
                  </span>
                ))}
              </div>
            </div>

            {/* 右侧: 月份标签行 + 主体网格(列优先,左旧右新) */}
            <div className="flex flex-col">
              <div
                className="grid"
                style={{
                  gridTemplateColumns: `repeat(${numCols}, ${cellSize}px)`,
                  gap: GAP,
                  height: LABEL_H,
                }}
              >
                {monthLabels.map((m, i) => (
                  <span
                    key={i}
                    className="text-[9px] leading-none text-content-muted whitespace-nowrap"
                  >
                    {m ?? ''}
                  </span>
                ))}
              </div>

              {/* 主体: grid-auto-flow column + 开头空位补齐 → 精确的周对齐 */}
              <div
                className="grid"
                style={{
                  gridTemplateRows: `repeat(7, ${cellSize}px)`,
                  gridAutoFlow: 'column',
                  gridAutoColumns: `${cellSize}px`,
                  gap: GAP,
                }}
                role="img"
                aria-label={isYear ? '过去一年活跃度热力图' : `近 ${weeks} 周活跃度热力图`}
              >
                {cells.map((cell, i) => {
                  if (!cell) {
                    // 月初/月末不存在的日期占位(不可见,仅保持网格对齐)
                    return <div key={`e${i}`} aria-hidden />
                  }
                  const level = getLevel(cell.count)
                  const isToday = cell.date === todayStr
                  return (
                    <div
                      key={cell.date}
                      title={cell.count > 0 ? `${cell.date} · ${cell.count} 次提问` : `${cell.date} · 无提问`}
                      style={{ width: cellSize, height: cellSize }}
                      className={`rounded-[2px] cursor-help transition-transform hover:scale-125 ${LEVEL_CLASSES[level]}${
                        isToday ? ' ring-1 ring-inset ring-[rgb(var(--content-secondary))]' : ''
                      }`}
                    />
                  )
                })}
              </div>
            </div>
          </div>
        </div>

        {/* 底行: 左标题(总活跃天数/连续) + 右图例(少→多);移出滚动区,横向滚动时保持固定 */}
        <div className="flex items-center justify-between" style={{ height: LABEL_H }}>
          <span className="text-[10px] text-content-secondary whitespace-nowrap">
            {isYear ? '过去一年' : `近 ${weeks} 周`} · {data.totalDays} 天活跃{streakStr}
          </span>
          <span className="flex items-center gap-1 text-[9px] text-content-muted whitespace-nowrap">
            少
            {LEVEL_CLASSES.map((cls, i) => (
              <span key={i} className={`inline-block w-2 h-2 rounded-[2px] ${cls}`} />
            ))}
            多
          </span>
        </div>
      </div>
    </div>
  )
}
