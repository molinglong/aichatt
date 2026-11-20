"use client"

/**
 * 今日复盘弹层(原 plan/src/components/ReviewSheet.tsx 并入版)。
 * 纯规则统计,不调 AI:完成率/顺延大户/过时未动/待安排存量 + 一句 headshot + tips。
 * 只在打开时拉一次数据——复盘看的是当下的账,不需要实时刷新。
 */
import { useEffect, useState } from "react"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"
import { planApi } from "@/lib/plan/client"
import { fmtDuration } from "@/lib/plan/time"
import type { ReviewResult } from "@/lib/plan/types"

export function PlanReviewSheet({
  open,
  date,
  onClose,
}: {
  open: boolean
  date: string
  onClose: () => void
}) {
  const [data, setData] = useState<ReviewResult | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!open) return
    let alive = true
    setFailed(false)
    planApi
      .review(date)
      .then((res) => {
        if (alive) setData(res)
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [open, date])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[80]" aria-hidden={!open}>
      <div className="absolute inset-0 bg-black/25" onClick={onClose} />

      <div
        role="dialog"
        aria-label="今日复盘"
        className={cn(
          "absolute inset-x-0 bottom-0 max-h-[80vh] overflow-y-auto rounded-t-[20px] border-t border-line bg-surface px-5 pb-[max(20px,env(safe-area-inset-bottom))] pt-3",
          "sm:inset-x-auto sm:bottom-8 sm:left-1/2 sm:w-[440px] sm:-translate-x-1/2 sm:rounded-panel sm:border enter-pop"
        )}
      >
        <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-line-strong sm:hidden" />

        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] text-content-muted">今天结束了？先看一眼</p>
            <h2 className="mt-0.5 text-[17px] font-semibold leading-snug">
              {data?.headline ?? "今日复盘"}
            </h2>
          </div>
          <button
            type="button"
            aria-label="关闭复盘"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-content-muted transition-colors duration-micro hover:bg-surface-subtle hover:text-content-primary"
          >
            <X size={16} />
          </button>
        </div>

        {failed && <p className="mt-4 text-[12px] text-content-muted">没拿到复盘数据,稍后再试。</p>}

        {!failed && !data && (
          <div className="mt-4 space-y-2">
            <div className="h-12 animate-pulse rounded-control bg-surface-subtle" />
            <div className="h-12 animate-pulse rounded-control bg-surface-subtle" />
          </div>
        )}

        {data && (
          <>
            <div className="mt-4 grid grid-cols-3 gap-2">
              <Cell label="完成" value={`${data.done}/${data.planned}`} strong />
              <Cell label="完成率" value={`${data.rate}%`} />
              <Cell label="顺延" value={String(data.postponed.length)} />
            </div>

            <div className="mt-2 space-y-2 rounded-control bg-surface-muted px-3 py-2.5">
              <Row label="已排" value={fmtDuration(data.plannedMinutes)} />
              <Row label="完成时长" value={fmtDuration(data.doneMinutes)} />
              <Row label="过了时间没动" value={data.skipped ? `${data.skipped} 项` : "没有"} />
              <Row label="待安排还留着" value={data.remaining ? `${data.remaining} 项` : "空"} />
            </div>

            <ul className="mt-4 space-y-2">
              {data.tips.map((tip) => (
                <li
                  key={tip}
                  className="flex gap-2 text-[12px] leading-relaxed text-content-secondary"
                >
                  <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-content-muted" />
                  <span>{tip}</span>
                </li>
              ))}
            </ul>

            <button
              type="button"
              onClick={onClose}
              className="mt-5 flex h-10 w-full items-center justify-center rounded-control bg-accent text-[13px] font-medium text-accent-foreground transition-[transform,opacity] duration-micro active:scale-[0.99]"
            >
              知道了
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function Cell({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-control border border-line/70 px-3 py-2">
      <p className="text-[10px] text-content-muted">{label}</p>
      <p
        className={cn(
          "mt-0.5 tabular-nums",
          strong ? "text-[16px] font-medium" : "text-[16px] text-content-secondary"
        )}
      >
        {value}
      </p>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-[11px] text-content-muted">{label}</span>
      <span className="text-[12px] tabular-nums text-content-secondary">{value}</span>
    </div>
  )
}
