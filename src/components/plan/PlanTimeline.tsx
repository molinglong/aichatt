"use client"

/**
 * 今日时间轴(原 plan/src/components/Timeline.tsx + PlanBlock.tsx 并入版)。
 *
 * 小时刻度 + 半小时虚线 + 当前时间线(只在空档里画)+ 时间块。
 * 时间真正交叉的块必须并排(lane),否则会一个压住另一个;块高度封顶到
 * 同列下一块的开始位置,短任务不能靠最小高度往下顶。
 */
import { useCallback, useEffect, useMemo, useRef } from "react"
import { Check } from "lucide-react"
import { cn } from "@/lib/utils"
import { DAY_START, fmtTime, nowMinutes } from "@/lib/plan/time"
import type { PlanItem } from "@/lib/plan/types"

export interface BlockLayout {
  lane: number
  lanes: number
  /** 同列下一块之间隔多少分钟;最后一块为 Infinity */
  gapMin: number
}

/**
 * 给时间块分配列:不交叉的块留在同一列,交叉的开新列。
 * 同时算出到下一块的间隔,供块限制高度——块不能长到吃掉后面的空档。
 */
function layoutBlocks(items: PlanItem[]): Map<string, BlockLayout> {
  const sorted = [...items].sort(
    (a, b) => (a.startMin ?? 0) - (b.startMin ?? 0) || (a.endMin ?? 0) - (b.endMin ?? 0)
  )
  const out = new Map<string, BlockLayout>()
  let cluster: { item: PlanItem; lane: number; end: number }[] = []
  let clusterEnd = 0

  const flush = () => {
    if (!cluster.length) return
    const lanes = Math.max(...cluster.map((c) => c.lane)) + 1
    for (const entry of cluster) {
      const sameLane = cluster
        .filter((c) => c.lane === entry.lane)
        .sort((a, b) => (a.item.startMin ?? 0) - (b.item.startMin ?? 0))
      const next = sameLane[sameLane.indexOf(entry) + 1]
      out.set(entry.item.id, {
        lane: entry.lane,
        lanes,
        gapMin: next ? (next.item.startMin ?? 0) - (entry.item.startMin ?? 0) : Infinity,
      })
    }
    cluster = []
  }

  for (const item of sorted) {
    const start = item.startMin ?? 0
    const end = item.endMin ?? start + item.estimateMin
    if (cluster.length && start >= clusterEnd) flush()
    let lane = 0
    while (cluster.some((c) => c.lane === lane && c.end > start)) lane++
    cluster.push({ item, lane, end })
    clusterEnd = cluster.length === 1 ? end : Math.max(clusterEnd, end)
  }
  flush()
  return out
}

/** 块底留 1px,避免与下一块贴死;不扣多,否则短任务会显得比实际时长短 */
const BOTTOM_PX = 1
/** 万一数据里同列两块挨得太近,给它们留 4px 缝隙 */
const LANE_GAP_RESERVE_PX = 4
/** 块再矮也给一点可点面积 */
const MIN_HEIGHT_PX = 6
/**
 * 自身高度和到下一块的间隔都小于这个分钟数时换紧凑单行排法。
 * 50 分钟在 56px/小时下约 47px,放不下「标题 + 时间/理由」两行,会顶破块。
 */
const DENSE_MIN = 50
const LANE_GAP_PX = 4

/**
 * 优先级不单独画标记:直接反映在勾选圈的描边深浅上(与待安排列表的圆点同口径)。
 * 之前块左侧贴边画一条 2px 竖线,在圆角卡片里像边裂了道缝,已去掉。
 */
function checkTone(item: PlanItem): string {
  if (item.priority === 2) return "border-content-primary"
  if (item.priority === 1) return "border-content-secondary"
  return "border-line-strong"
}

function PlanBlock({
  item,
  selected,
  layout,
  onSelect,
  onToggleDone,
}: {
  item: PlanItem
  selected: boolean
  layout: BlockLayout
  onSelect: () => void
  onToggleDone: () => void
}) {
  const start = item.startMin ?? 0
  const end = item.endMin ?? start + item.estimateMin
  const dur = Math.max(1, end - start)
  // 高度封顶到下一块开始的位置:短任务不能靠最小高度往下顶,那会压住后一件事
  const gapMin = Number.isFinite(layout.gapMin) && layout.gapMin > 0 ? layout.gapMin : null
  const natural = `calc(var(--hour) * ${dur / 60} - ${BOTTOM_PX}px)`
  // 同列的块本来就不会相交,gap 限制只是防御脏数据,正常不会生效
  const height = `max(${MIN_HEIGHT_PX}px, ${
    gapMin
      ? `min(${natural}, calc(var(--hour) * ${gapMin / 60} - ${LANE_GAP_RESERVE_PX}px))`
      : natural
  })`
  const dense = (gapMin ? Math.min(dur, gapMin) : dur) <= DENSE_MIN
  const isMemo = item.kind === "memo"
  const isEvent = item.kind === "event"
  const done = !!item.done
  const { lane, lanes } = layout

  return (
    <div
      data-block-id={item.id}
      className="plan-blk absolute left-14 right-3 z-10"
      style={{
        top: `calc(var(--hour) * ${(start - DAY_START) / 60})`,
        height,
      }}
    >
      <button
        type="button"
        onClick={onSelect}
        style={
          lanes > 1
            ? {
                width: `calc((100% - ${(lanes - 1) * LANE_GAP_PX}px) / ${lanes})`,
                marginLeft: `calc(${lane} * ((100% - ${(lanes - 1) * LANE_GAP_PX}px) / ${lanes} + ${LANE_GAP_PX}px))`,
              }
            : undefined
        }
        className={cn(
          // w-full 兜底单列时铺满;并排时上面用 inline style 覆盖成半宽
          "group relative flex h-full w-full items-start overflow-hidden border text-left",
          "transition-[border-color,background-color,opacity] duration-micro",
          "outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-content-primary/35",
          // 备忘块用便利贴材质;固定安排用虚线+灰底
          isMemo
            ? "border-[rgb(var(--note-edge))] bg-[rgb(var(--note-paper))] text-[rgb(var(--note-ink))]"
            : "border-line bg-surface text-content-primary",
          isEvent && "border-dashed bg-surface-muted",
          // 选中只靠一层边框加深 + 极淡底,不再叠外圈:两层描边在浅灰底上像输入框聚焦,太抢眼
          selected
            ? cn(
                isMemo ? "border-[rgb(var(--note-sub))]/70" : "border-content-secondary/55",
                !isMemo && "bg-accent-soft/50"
              )
            : !isEvent &&
              (isMemo
                ? "hover:border-[rgb(var(--note-sub))]/60"
                : "hover:border-line-strong"),
          done && "opacity-55",
          // 矮块用小圆角,免得 12px 圆角在二十几像素高时把块描成一枚胶囊
          dur <= 30 ? "rounded-control" : "rounded-card"
        )}
      >
        <span
          className={cn(
            "flex h-full w-full gap-2",
            // 矮块用左内边距对齐上方正常块(勾选圈中心对齐),不要整块缩边
            dense ? "items-center pl-3.5 pr-2.5" : "items-start py-1.5 pl-3 pr-2"
          )}
        >
          <span
            role="checkbox"
            aria-checked={done}
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation()
              onToggleDone()
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                e.stopPropagation()
                onToggleDone()
              }
            }}
            className={cn(
              "flex shrink-0 items-center justify-center rounded-full border transition-colors duration-micro",
              dense ? "h-3 w-3" : "mt-[2px] h-[15px] w-[15px]",
              done
                ? "border-content-primary bg-content-primary text-accent-foreground"
                : cn(checkTone(item), "bg-transparent hover:border-content-primary/70")
            )}
          >
            {done && <Check size={dense ? 7 : 9} strokeWidth={3.5} />}
          </span>

          <span className="min-w-0 flex-1">
            <span className={cn("flex gap-1.5", dense ? "items-center" : "items-baseline")}>
              <span
                className={cn(
                  "truncate font-medium",
                  dense ? "text-[11px] leading-[13px]" : "text-[13px] leading-tight",
                  done && "line-through decoration-content-muted"
                )}
              >
                {item.title}
              </span>
              {isMemo && (
                <span className="shrink-0 text-[9px] uppercase tracking-wide text-[rgb(var(--note-sub))]">
                  备忘
                </span>
              )}
            </span>

            {!dense && (
              <span className="mt-1 flex min-w-0 items-center gap-1.5">
                <span className="shrink-0 text-[10px] tabular-nums text-content-muted">
                  {fmtTime(start)}–{fmtTime(end)}
                </span>
                {item.reason && (
                  <>
                    <span className="h-2 w-px shrink-0 bg-line" />
                    <span className="truncate text-[10px] text-content-muted">{item.reason}</span>
                  </>
                )}
              </span>
            )}
          </span>
        </span>
      </button>
    </div>
  )
}

interface PlanTimelineProps {
  items: PlanItem[]
  loading?: boolean
  selectedId: string | null
  onSelect: (id: string) => void
  onToggleDone: (id: string) => void
}

export function PlanTimeline({
  items,
  loading = false,
  selectedId,
  onSelect,
  onToggleDone,
}: PlanTimelineProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const planned = items.filter((i) => i.status === "planned" && i.startMin != null)
  // planned 是每次渲染新建的数组,依赖 items 才能真的省掉重复计算
  const layouts = useMemo(() => layoutBlocks(planned), [items])
  const now = nowMinutes()
  const showNow = now >= DAY_START && now <= 24 * 60
  // 此刻是否已经落在某个已排块的时间里
  const nowInBlock = planned.some((item) => {
    const start = item.startMin ?? 0
    const end = item.endMin ?? start + item.estimateMin
    return now >= start && now < end
  })
  const hours = (24 * 60 - DAY_START) / 60
  const ticks = Array.from({ length: hours + 1 }, (_, i) => DAY_START + i * 60)

  // 首次进入滚到当前时间附近,省得手动找。
  // 直接依赖 effect/ref 时机的 scrollTop 在部分环境会被吞,所以渲染一个
  // 不可见的「此刻」锚点,挂载时 scrollIntoView —— 浏览器原生同步滚动,无条件生效。
  const nowAnchorRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    // 挂载即调用:浏览器同步计算祖先滚动容器并滚到锚点附近
    el.scrollIntoView({ block: 'center' })
  }, [])

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      <div className="pb-6 pl-4 pr-3 pt-2">
        <div
          className="relative"
          style={{ ['--hour' as string]: '56px', height: `calc(var(--hour) * ${hours})` }}
        >
          {/* 小时刻度线 */}
          {ticks.map((min, i) => (
            <div
              key={min}
              className="absolute inset-x-0 flex items-start"
              style={{ top: `calc(var(--hour) * ${i})` }}
            >
              <span className="w-10 shrink-0 -translate-y-1/2 pr-2 text-right text-[10px] tabular-nums text-content-muted">
                {min === 24 * 60 ? "24:00" : fmtTime(min)}
              </span>
              <div className="h-px flex-1 bg-line/55" />
            </div>
          ))}

          {/* 半小时虚线,弱到几乎看不见,只用来对齐 */}
          {ticks.slice(0, -1).map((min, i) => (
            <div
              key={`half-${min}`}
              className="pointer-events-none absolute inset-x-0 flex items-start"
              style={{ top: `calc(var(--hour) * ${i + 0.5})` }}
            >
              <span className="w-10 shrink-0" />
              <div className="h-px flex-1 bg-line/25" />
            </div>
          ))}

          {/*
            当前时间线:只在空档里画。
            现在正落在某个已排块里时,线会被块切成一左一右两截、圆点还被块压掉一半,
            块本身已经说明「此刻在做这个」,再画线只会显脏。
          */}
          {showNow && !nowInBlock && (
            <div
              className="pointer-events-none absolute inset-x-0 z-[5]"
              style={{ top: `calc(var(--hour) * ${(now - DAY_START) / 60})` }}
            >
              {/* 此刻锚点:不可见,挂载时 scrollIntoView 把容器带到当前时间附近 */}
              <div ref={nowAnchorRef} aria-hidden className="absolute left-0 h-px w-1" />
              <div className="flex items-center">
                <span className="w-10 pr-2 text-right text-[10px] font-medium tabular-nums text-danger">
                  {fmtTime(now)}
                </span>
                <div className="relative h-px flex-1 bg-danger/60">
                  <span className="absolute -left-[3px] -top-[2.5px] h-[6px] w-[6px] rounded-full bg-danger" />
                </div>
              </div>
            </div>
          )}

          {/* 时间块 */}
          {planned.map((item) => (
            <PlanBlock
              key={item.id}
              item={item}
              layout={layouts.get(item.id) ?? { lane: 0, lanes: 1, gapMin: Infinity }}
              selected={selectedId === item.id}
              onSelect={() => onSelect(item.id)}
              onToggleDone={() => onToggleDone(item.id)}
            />
          ))}

          {/* 空状态:今天还没排 */}
          {!loading && planned.length === 0 && (
            <div className="absolute inset-x-0 top-[28%] flex flex-col items-center gap-2 px-8 text-center">
              <p className="text-sm text-content-secondary">今天还是一张白纸</p>
              <p className="max-w-[240px] text-xs leading-relaxed text-content-muted">
                把想做的事先丢进「待安排」，点一下排今天。
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
