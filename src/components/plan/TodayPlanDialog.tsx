"use client"

/**
 * 「今日计划」弹窗(2026-11-19 方案B「双栏工作台」挑稿落码,原型 design/preview-plan-dialog.html):
 * 左侧时间轴 + 右栏常驻待安排(逐条「排今天」)+ 顶部快速记入;回顾/备忘录收右栏底部工具钮唤二级弹层。
 * 原 plan 独立应用(时间轴/收集箱/quick-parse/AI 排程)的并入落点,数据落 PlanItem 表。
 *
 * 骨架与 StudyPanelDialog 同配方:桌面居中磨砂遮罩玻璃卡 + ESC,移动端全屏 + 返回键收口。
 * 入口:TopBar 日历钮(全局)。开关走本文件导出的模块级 store,任意入口都能唤起。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { ArrowRight, RotateCcw, StickyNote, X, Sparkles, Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { useIsMobileViewport } from "@/hooks/useIsMobileViewport"
import { useBackToClose } from "@/hooks/useBackToClose"
import { useFocusLock } from "@/lib/focus-lock-store"
import { planApi, type CreateItemInput } from "@/lib/plan/client"
import { fmtDuration, fmtTime, nowMinutes, todayKey, todayParts } from "@/lib/plan/time"
import type { PlanItem } from "@/lib/plan/types"
import { PlanComposer } from "./PlanComposer"
import { PlanTimeline } from "./PlanTimeline"
import { PlanReviewSheet } from "./PlanReviewSheet"
import { PlanMemoSheet } from "./PlanMemoSheet"

// ── 模块级开关 store:TopBar 等任意入口 openTodayPlan() 即可唤起 ──
let openState = false
const listeners = new Set<() => void>()
/** SSR 安全:服务端恒为关闭态(client snapshot 一致,不产生 hydration 分歧) */
const subscribe = (onStoreChange: () => void) => {
  listeners.add(onStoreChange)
  return () => {
    listeners.delete(onStoreChange)
  }
}

export function openTodayPlan() {
  openState = true
  listeners.forEach((l) => l())
}

export function closeTodayPlan() {
  openState = false
  listeners.forEach((l) => l())
}

function useTodayPlanOpen(): boolean {
  return useSyncExternalStore(subscribe, () => openState, () => openState)
}

/** 一天可用精力,分母不随当前时间变化(早上和晚上看到同一个分母) */
const AVAILABLE_MIN = 8 * 60

interface Toast {
  text: string
  /** 撤销删除:带删除前快照,一键放回 */
  undo?: { id: string; snapshot: Record<string, unknown> }
}

/** 排程结果说人话:AI 排的报 AI,兜底的把原因带出来 */
function scheduleMessage(res: { added: number; source: "ai" | "local"; note?: string; deferred?: { itemId: string }[] }) {
  if (!res.added) return res.note ?? "今天放不下了，先留到明天"
  const left = res.deferred?.length ?? 0
  if (res.source === "ai") {
    return left ? `AI 排入 ${res.added} 项，${left} 项今天放不下` : `AI 排入 ${res.added} 项 · 留了缓冲`
  }
  return `${res.note ?? "已按空档顺排"} · ${res.added} 项`
}

export function TodayPlanDialog() {
  const open = useTodayPlanOpen()
  const isMobile = useIsMobileViewport()
  // 监管模式锁定时切换小鸡主题皮肤(蜡笔纸卡+黄油系);?__flmock=1 可在 Web 预览
  const { locked } = useFocusLock()
  useBackToClose(open, closeTodayPlan)

  const [items, setItems] = useState<PlanItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [scheduling, setScheduling] = useState(false)
  const [schedulingOne, setSchedulingOne] = useState<string | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [memoOpen, setMemoOpen] = useState(false)
  const busy = useRef(false)

  const date = todayKey()

  // toast 4 秒自动收(撤销窗口),比原版(6s)短一点,弹窗内空间更紧
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(t)
  }, [toast])

  const refresh = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    try {
      const res = await planApi.list(date)
      setItems(res.items)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取失败")
    } finally {
      busy.current = false
      setLoading(false)
    }
  }, [date])

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setSelectedId(null)
    setToast(null)
    refresh()
  }, [open, refresh])

  // 弹窗开着时窗口重新可见(如从聊天切回来)自动刷新:
  // AI 在对话里通过 manage_plan 工具改了计划,这里拿到的是最新数据
  useEffect(() => {
    if (!open) return
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh()
    }
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("focus", onVisible)
    return () => {
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("focus", onVisible)
    }
  }, [open, refresh])

  // ESC 关闭(桌面)
  useEffect(() => {
    if (!open || isMobile) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeTodayPlan()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, isMobile])

  async function handleAdd(inputs: CreateItemInput[]) {
    try {
      for (const input of inputs) {
        await planApi.create({ ...input, plannedDate: input.startMin != null ? date : undefined })
      }
      await refresh()
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : "记入失败" })
    }
  }

  async function handleToggleDone(id: string) {
    const target = items.find((i) => i.id === id)
    if (!target) return
    const done = !target.done
    // 本地先翻,失败回滚;排程/复盘口径由服务端按 done 落库
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, done, status: done ? "done" : "planned" } : i)))
    try {
      await planApi.update(id, { done, status: done ? "done" : "planned" })
    } catch {
      setItems((prev) => prev.map((i) => (i.id === id ? target : i)))
      setToast({ text: "没记上,再试一次" })
    }
  }

  async function handleSchedule(mode: "all" | "one", id?: string) {
    if (mode === "one") setSchedulingOne(id ?? null)
    else setScheduling(true)
    try {
      const res = await planApi.schedule(date, mode, id)
      setItems(res.items)
      setToast({ text: scheduleMessage(res) })
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : "排程失败" })
    } finally {
      setScheduling(false)
      setSchedulingOne(null)
    }
  }

  async function handleRemove(item: PlanItem) {
    const snapshot = {
      title: item.title,
      note: item.note ?? "",
      kind: item.kind,
      status: item.status,
      priority: item.priority,
      estimateMin: item.estimateMin,
      energy: item.energy,
      plannedDate: item.plannedDate ?? null,
      startMin: item.startMin ?? null,
      endMin: item.endMin ?? null,
      reason: item.reason ?? null,
      done: item.done ?? false,
      postponeCount: item.postponeCount ?? 0,
      restore: true,
    }
    setItems((prev) => prev.filter((i) => i.id !== item.id))
    try {
      await planApi.remove(item.id)
      setToast({ text: `已删除「${item.title}」`, undo: { id: item.id, snapshot } })
    } catch (e) {
      setItems((prev) => [...prev, item])
      setToast({ text: e instanceof Error ? e.message : "删除失败" })
    }
  }

  async function handleUndo() {
    const t = toast
    if (!t?.undo) return
    setToast(null)
    try {
      const restored = await planApi.update(t.undo.id, t.undo.snapshot)
      setItems((prev) => [...prev, restored])
    } catch (e) {
      setToast({ text: e instanceof Error ? e.message : "撤销失败" })
    }
  }

  if (!open) return null

  const inbox = items.filter((i) => i.status === "inbox")
  const schedulable = inbox.filter((i) => i.kind !== "memo").length
  const scheduled = items.filter((i) => i.status === "planned" || (i.status === "done" && i.startMin != null))
  const scheduledMin = scheduled.reduce(
    (sum, i) => sum + (i.startMin != null && i.endMin != null ? i.endMin - i.startMin : i.estimateMin),
    0
  )
  const doneCount = items.filter((i) => i.done).length
  const plannedCount = scheduled.length
  const { md, week } = todayParts()
  const now = nowMinutes()

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      {/* 磨砂遮罩(StudyPanelDialog 同配方);小鸡主题下换奶油纸色遮罩 */}
      <div
        aria-label="关闭"
        onClick={closeTodayPlan}
        className={cn(
          "absolute inset-0",
          locked
            ? "bg-[rgb(var(--fl-ink-rgb)/0.22)]"
            : "bg-black/20 backdrop-blur-[12px] saturate-150 dark:bg-white/15 dark:saturate-150"
        )}
      />

      <div
        role="dialog"
        aria-label="今日计划"
        data-fl-skin={locked ? "chick" : undefined}
        className={cn(
          "relative z-10 flex flex-col overflow-hidden",
          locked
            ? isMobile
              ? "h-full w-full bg-[var(--fl-paper)]"
              : "h-[74vh] w-full max-w-[880px] rounded-panel border-2 border-dashed border-[rgb(var(--fl-ink-rgb)/0.4)] bg-[var(--fl-paper)] shadow-2xl enter-pop"
            : isMobile
              ? "h-full w-full bg-surface"
              : "h-[74vh] w-full max-w-[880px] rounded-xl border border-line/60 bg-surface-glass glass-blur shadow-2xl enter-pop"
        )}
      >
        {/* ── 头部:日期 + 精力条 + 关闭 ── */}
        <div
          className={cn(
            "flex flex-none flex-col gap-2.5 border-b px-5 pb-3 pt-4",
            locked ? "border-[rgb(var(--fl-ink-rgb)/0.15)]" : "border-line"
          )}
          style={isMobile ? { paddingTop: "max(12px, calc(var(--m-chrome-top, 0px) + 12px))" } : undefined}
        >
          <div className="flex items-center gap-3">
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <h2 className="text-[15px] font-bold tracking-wide">{md} · {week}</h2>
                <span className="text-[12px] text-content-secondary">今日计划</span>
              </div>
              <p className="mt-0.5 text-[11.5px] text-content-muted">
                已排 {fmtDuration(scheduledMin)} / 8h · 完成 {doneCount}/{plannedCount || scheduled.length || 0}
                {now >= 6 * 60 && now < 24 * 60 ? ` · 现在 ${fmtTime(now)}` : ""}
              </p>
            </div>
            <button
              type="button"
              aria-label="关闭"
              onClick={closeTodayPlan}
              className="ml-auto flex h-8 w-8 flex-none items-center justify-center rounded-full text-content-muted transition-colors duration-micro hover:bg-surface-subtle hover:text-content-primary"
            >
              <X size={16} />
            </button>
          </div>

          {/* 精力条:已排时长占一天可用精力的比例,不区分浅深,accent 一枚 */}
          <div className="flex items-center gap-2.5">
            <div className={cn("h-1.5 flex-1 overflow-hidden rounded-full", locked ? "bg-[var(--fl-cream)]" : "bg-surface-subtle")}>
              <div
                className={cn("h-full rounded-full transition-[width] duration-base", locked ? "bg-[var(--fl-crayon)]" : "bg-accent")}
                style={{ width: `${Math.min(100, Math.round((scheduledMin / AVAILABLE_MIN) * 100))}%` }}
              />
            </div>
            <span className="shrink-0 text-[10.5px] tabular-nums text-content-muted">
              {Math.round((scheduledMin / AVAILABLE_MIN) * 100)}%
            </span>
          </div>

          {/* 快速记入:横跨全宽,拆条胶囊即时预览 */}
          <PlanComposer onAdd={handleAdd} />
        </div>

        {/* ── 主体:左时间轴 + 右栏待安排 ── */}
        <div className="flex min-h-0 flex-1">
          <PlanTimeline
            items={items}
            loading={loading}
            selectedId={selectedId}
            onSelect={(id) => setSelectedId((v) => (v === id ? null : id))}
            onToggleDone={handleToggleDone}
          />

          {/* 右栏:待安排 + 工具(桌面 260px;移动端收进底部横条,见下方 footer) */}
          {!isMobile && (
            <aside className={cn("flex w-[260px] flex-none flex-col border-l", locked ? "border-[rgb(var(--fl-ink-rgb)/0.15)] bg-[var(--fl-paper-deep)]" : "border-line")}>
              <div className="px-4 pb-1.5 pt-3.5">
                <h3 className="text-[13px] font-semibold">待安排</h3>
                <p className="mt-0.5 text-[11px] text-content-muted">
                  {inbox.length ? `${inbox.length} 条 · 先记下来,晚点排` : "想到什么先丢进来"}
                </p>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                {inbox.map((item) => (
                  <InboxRow
                    key={item.id}
                    item={item}
                    scheduling={schedulingOne === item.id}
                    onSchedule={() => handleSchedule("one", item.id)}
                    onRemove={() => handleRemove(item)}
                  />
                ))}

                {inbox.length === 0 && !loading && (
                  <div className="flex flex-col items-center gap-1.5 px-4 py-8 text-center">
                    <p className="text-xs text-content-secondary">都排完了</p>
                    <p className="text-[11px] leading-relaxed text-content-muted">有新的想法随时记,明天再排。</p>
                  </div>
                )}
              </div>

              <div className={cn("border-t p-3", locked ? "border-[rgb(var(--fl-ink-rgb)/0.15)]" : "border-line")}>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleSchedule("all")}
                    disabled={scheduling || schedulable === 0}
                    className={cn(
                      "flex h-9 flex-1 items-center justify-center gap-1.5 rounded-control",
                      "text-[12.5px] font-medium",
                      "transition-[transform,opacity] duration-micro active:scale-[0.99] disabled:opacity-35",
                      locked
                        ? "bg-[var(--fl-crayon)] text-[var(--fl-ink)] hover:bg-[var(--fl-crayon-deep)]"
                        : "bg-accent text-accent-foreground"
                    )}
                  >
                    <Sparkles size={13} className={scheduling ? "animate-pulse" : ""} />
                    {scheduling ? "正在排…" : "排今天"}
                  </button>
                  <button
                    type="button"
                    aria-label="今日复盘"
                    title="今日复盘"
                    onClick={() => setReviewOpen(true)}
                    className={cn(
                      "flex h-9 w-9 flex-none items-center justify-center rounded-control border text-[rgb(var(--fl-ink-rgb)/0.65)] transition-colors duration-micro",
                      locked
                        ? "border-dashed border-[rgb(var(--fl-ink-rgb)/0.35)] hover:bg-[var(--fl-cream)] hover:text-[var(--fl-ink)]"
                        : "border-line text-content-secondary hover:bg-surface-muted hover:text-content-primary"
                    )}
                  >
                    <RotateCcw size={14} />
                  </button>
                  <button
                    type="button"
                    aria-label="备忘录"
                    title="备忘录"
                    onClick={() => setMemoOpen(true)}
                    className={cn(
                      "flex h-9 w-9 flex-none items-center justify-center rounded-control border text-[rgb(var(--fl-ink-rgb)/0.65)] transition-colors duration-micro",
                      locked
                        ? "border-dashed border-[rgb(var(--fl-ink-rgb)/0.35)] hover:bg-[var(--fl-cream)] hover:text-[var(--fl-ink)]"
                        : "border-line text-content-secondary hover:bg-surface-muted hover:text-content-primary"
                    )}
                  >
                    <StickyNote size={14} />
                  </button>
                </div>
                <p className="mt-1.5 text-center text-[10px] text-content-muted">只排 70%,给意外留点余地</p>
              </div>
            </aside>
          )}
        </div>

        {/* ── 移动端底栏:排今天 + 复盘 + 备忘录(右栏在移动端并入这里) ── */}
        {isMobile && (
          <div className={cn("flex flex-none items-center gap-1.5 border-t px-3 pb-[max(10px,env(safe-area-inset-bottom))] pt-2.5", locked ? "border-[rgb(var(--fl-ink-rgb)/0.15)]" : "border-line")}>
            <button
              type="button"
              onClick={() => handleSchedule("all")}
              disabled={scheduling || schedulable === 0}
              className={cn(
                "flex h-10 flex-1 items-center justify-center gap-1.5 rounded-control",
                "text-[13px] font-medium",
                "transition-[transform,opacity] duration-micro active:scale-[0.99] disabled:opacity-35",
                locked ? "bg-[var(--fl-crayon)] text-[var(--fl-ink)]" : "bg-accent text-accent-foreground"
              )}
            >
              <Sparkles size={14} className={scheduling ? "animate-pulse" : ""} />
              {scheduling ? "正在排…" : `排今天${inbox.length ? `(${schedulable})` : ""}`}
            </button>
            <button
              type="button"
              aria-label="待安排"
              title="待安排"
              onClick={() => setToast({ text: inbox.length ? `待安排 ${inbox.length} 条 · 用上面的输入条继续记` : "想到什么先记进来" })}
              className={cn(
                "flex h-10 flex-none items-center gap-1 rounded-control border px-3 text-[12px]",
                locked ? "border-dashed border-[rgb(var(--fl-ink-rgb)/0.35)] text-[rgb(var(--fl-ink-rgb)/0.7)]" : "border-line text-content-secondary"
              )}
            >
              待安排 {inbox.length}
            </button>
            <button
              type="button"
              aria-label="今日复盘"
              onClick={() => setReviewOpen(true)}
              className={cn(
                "flex h-10 w-10 flex-none items-center justify-center rounded-control border",
                locked ? "border-dashed border-[rgb(var(--fl-ink-rgb)/0.35)] text-[rgb(var(--fl-ink-rgb)/0.7)]" : "border-line text-content-secondary"
              )}
            >
              <RotateCcw size={15} />
            </button>
            <button
              type="button"
              aria-label="备忘录"
              onClick={() => setMemoOpen(true)}
              className={cn(
                "flex h-10 w-10 flex-none items-center justify-center rounded-control border",
                locked ? "border-dashed border-[rgb(var(--fl-ink-rgb)/0.35)] text-[rgb(var(--fl-ink-rgb)/0.7)]" : "border-line text-content-secondary"
              )}
            >
              <StickyNote size={15} />
            </button>
          </div>
        )}

        {/* 错误/加载条 */}
        {(error || (loading && items.length === 0)) && (
          <div className="absolute inset-x-0 top-0 flex justify-center pt-2">
            <span className="rounded-full border border-line bg-surface px-3 py-1 text-[11px] text-content-secondary shadow-sm">
              {error ?? "读取中…"}
            </span>
          </div>
        )}

        {/* toast:底部浮条 + 撤销 */}
        {toast && (
          <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4">
            <div
              className={cn(
                "pointer-events-auto flex max-w-[90%] items-center gap-3 rounded-full border px-4 py-2 shadow-lg",
                locked
                  ? "border-[rgb(var(--fl-ink-rgb)/0.3)] bg-[var(--fl-yellow)]"
                  : "border-line bg-surface"
              )}
            >
              <span className={cn("min-w-0 truncate text-[12px]", locked ? "text-[var(--fl-ink)]" : "text-content-primary")}>{toast.text}</span>
              {toast.undo && (
                <button
                  type="button"
                  onClick={handleUndo}
                  className={cn("flex flex-none items-center gap-1 text-[12px] font-medium", locked ? "text-[var(--fl-gold)]" : "text-accent")}
                >
                  <RotateCcw size={12} />撤销
                </button>
              )}
            </div>
          </div>
        )}

        {/* 二级弹层 */}
        <PlanReviewSheet open={reviewOpen} date={date} onClose={() => setReviewOpen(false)} />
        <PlanMemoSheet open={memoOpen} onClose={() => setMemoOpen(false)} />
      </div>
    </div>
  )
}

/** 待安排行:优先级圆点 + 时长 + hover 出「排今天」与删除(备忘行不参与排程) */
function InboxRow({
  item,
  scheduling,
  onSchedule,
  onRemove,
}: {
  item: PlanItem
  scheduling: boolean
  onSchedule: () => void
  onRemove: () => void
}) {
  const isMemo = item.kind === "memo"

  return (
    <div
      className={cn(
        "group flex cursor-default items-start gap-2 rounded-control px-2 py-2 transition-colors duration-micro",
        "hover:bg-surface-muted"
      )}
    >
      <span className="mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center">
        {isMemo ? (
          <StickyNote size={13} className="text-[rgb(var(--note-sub))]" />
        ) : (
          <span
            className={cn(
              "h-[7px] w-[7px] rounded-full border",
              item.priority === 2
                ? "border-content-primary bg-content-primary"
                : item.priority === 1
                  ? "border-content-secondary"
                  : "border-line-strong"
            )}
          />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-[13px] leading-snug text-content-primary">{item.title}</p>
        <p className="mt-0.5 flex items-center gap-1.5 text-[10px] text-content-muted">
          {item.estimateMin > 0 && <span>{fmtDuration(item.estimateMin)}</span>}
          {item.priority === 2 && (
            <>
              <span className="text-line-strong">·</span>
              <span>重要</span>
            </>
          )}
          {isMemo && (
            <>
              <span className="text-line-strong">·</span>
              <span>备忘</span>
            </>
          )}
        </p>
      </div>

      <div className="mt-0.5 flex flex-none items-center gap-0.5">
        {!isMemo && (
          <button
            type="button"
            aria-label="排到今天"
            onClick={onSchedule}
            disabled={scheduling}
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-full",
              "text-content-muted transition-all duration-micro",
              "hover:bg-surface-subtle hover:text-content-primary active:scale-95",
              "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
              scheduling && "animate-pulse opacity-100"
            )}
          >
            <ArrowRight size={14} />
          </button>
        )}
        <button
          type="button"
          aria-label="删除"
          onClick={onRemove}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-full",
            "text-content-muted transition-all duration-micro",
            "hover:bg-danger-soft hover:text-danger active:scale-95",
            "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          )}
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  )
}
