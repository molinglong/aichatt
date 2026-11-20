"use client"

/**
 * 备忘录弹层(原 plan/src/components/MemoDrawer.tsx 并入精简版)。
 * 列表/编辑双视图 + 自动保存(签名对比 + 防抖)+ 置顶 + 删除确认 + 搜索。
 * 原版的离线缓存/outbox 重放不并入:merged 后双端直连 Postgres。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, Pin, PinOff, Plus, Search, Trash2, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { planApi } from "@/lib/plan/client"
import type { PlanMemo } from "@/lib/plan/types"

interface Draft {
  title: string
  content: string
  pinned: boolean
}

const EMPTY: Draft = { title: "", content: "", pinned: false }
const signature = (draft: Draft) => JSON.stringify([draft.title, draft.content, draft.pinned])
const hasContent = (draft: Draft) => Boolean(draft.title.trim() || draft.content.trim())

/** 标题回退链:标题 → 正文首个非空行 → 「无标题备忘」 */
function displayTitle(memo: PlanMemo): string {
  const title = memo.title.trim()
  if (title) return title
  const firstLine = memo.content.split("\n").map((line) => line.trim()).find(Boolean)
  return firstLine?.slice(0, 40) || "无标题备忘"
}

function preview(memo: PlanMemo): string {
  if (memo.title.trim()) {
    return memo.content.replace(/\s+/g, " ").trim().slice(0, 90)
  }
  const lines = memo.content.split("\n").map((line) => line.trim()).filter(Boolean)
  return lines.slice(1).join(" ").slice(0, 90) || "…"
}

function fmtUpdated(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) {
    return `今天 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
  }
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

function sortMemos(list: PlanMemo[]): PlanMemo[] {
  return [...list].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || (a.updatedAt < b.updatedAt ? 1 : -1)
  )
}

export function PlanMemoSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [memos, setMemos] = useState<PlanMemo[]>([])
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [view, setView] = useState<"list" | "edit">("list")
  const [activeId, setActiveId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle")
  const [confirming, setConfirming] = useState<PlanMemo | null>(null)
  const [deleting, setDeleting] = useState(false)

  const savedRef = useRef("")
  const draftRef = useRef(draft)
  draftRef.current = draft
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const titleRef = useRef<HTMLInputElement | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await planApi.memos()
      setMemos(sortMemos(res.memos))
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "读取备忘录失败")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setView("list")
    setActiveId(null)
    setQuery("")
    setNotice(null)
    setConfirming(null)
    refresh()
  }, [open, refresh])

  // ESC:编辑态先回列表,列表态才关弹层
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      if (confirming) {
        setConfirming(null)
        return
      }
      if (view === "edit") {
        setView("list")
        return
      }
      onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, view, confirming, onClose])

  /** 自动保存:签名变了就排队写;切走/关弹层时 flush 一次 */
  const flushSave = useCallback(async () => {
    const current = draftRef.current
    const sig = signature(current)
    if (sig === savedRef.current) return
    savedRef.current = sig
    if (!hasContent(current)) return
    setSaveState("saving")
    try {
      const saved = activeId
        ? await planApi.memoUpdate(activeId, { title: current.title, content: current.content, pinned: current.pinned })
        : await planApi.memoCreate({ title: current.title, content: current.content, pinned: current.pinned })
      if (!activeId) setActiveId(saved.id)
      setSaveState("saved")
      setMemos((prev) => sortMemos([...prev.filter((m) => m.id !== saved.id), saved]))
    } catch (e) {
      savedRef.current = ""
      setSaveState("error")
      setNotice(e instanceof Error ? e.message : "保存失败")
    }
  }, [activeId])

  const scheduleSave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => void flushSave(), 800)
  }, [flushSave])

  // 卸载/关闭时兜底 flush
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      const current = draftRef.current
      if (open && hasContent(current) && signature(current) !== savedRef.current) {
        void flushSave()
      }
    }
  }, [open, flushSave])

  function openNew() {
    setDraft(EMPTY)
    savedRef.current = signature(EMPTY)
    setActiveId(null)
    setSaveState("idle")
    setView("edit")
    setTimeout(() => titleRef.current?.focus(), 50)
  }

  function openEdit(memo: PlanMemo) {
    const next = { title: memo.title, content: memo.content, pinned: memo.pinned }
    setDraft(next)
    savedRef.current = signature(next)
    setActiveId(memo.id)
    setSaveState("idle")
    setView("edit")
    setTimeout(() => titleRef.current?.focus(), 50)
  }

  async function togglePin(memo: PlanMemo) {
    try {
      const saved = await planApi.memoUpdate(memo.id, { pinned: !memo.pinned })
      setMemos((prev) => sortMemos([...prev.filter((m) => m.id !== saved.id), saved]))
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "置顶失败")
    }
  }

  async function confirmDelete() {
    const target = confirming
    if (!target) return
    setDeleting(true)
    try {
      await planApi.memoRemove(target.id)
      setMemos((prev) => prev.filter((m) => m.id !== target.id))
      setConfirming(null)
      if (activeId === target.id) {
        setActiveId(null)
        setDraft(EMPTY)
        setView("list")
      }
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "删除失败")
    } finally {
      setDeleting(false)
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return memos
    return memos.filter(
      (m) => m.title.toLowerCase().includes(q) || m.content.toLowerCase().includes(q)
    )
  }, [memos, query])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[80]">
      <div className="absolute inset-0 bg-black/25" onClick={onClose} />

      <div
        role="dialog"
        aria-label="备忘录"
        className={cn(
          "absolute inset-x-0 bottom-0 flex max-h-[80vh] flex-col overflow-hidden rounded-t-[20px] border-t border-line bg-surface",
          "sm:inset-x-auto sm:bottom-8 sm:left-1/2 sm:h-[560px] sm:max-h-[80vh] sm:w-[520px] sm:-translate-x-1/2 sm:rounded-panel sm:border enter-pop"
        )}
      >
        {/* 头:列表态=搜索+新建;编辑态=返回+保存态 */}
        {view === "list" ? (
          <div className="flex flex-none items-center gap-2 border-b border-line px-4 py-3">
            <div className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-control border border-line bg-surface-muted px-2">
              <Search size={13} className="shrink-0 text-content-muted" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜备忘…"
                className="h-full min-w-0 flex-1 bg-transparent text-[12.5px] text-content-primary outline-none placeholder:text-content-muted"
              />
            </div>
            <button
              type="button"
              aria-label="新建备忘"
              onClick={openNew}
              className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-accent text-accent-foreground transition-[transform,opacity] duration-micro active:scale-95"
            >
              <Plus size={15} />
            </button>
            <button
              type="button"
              aria-label="关闭"
              onClick={onClose}
              className="flex h-8 w-8 flex-none items-center justify-center rounded-full text-content-muted transition-colors duration-micro hover:bg-surface-subtle hover:text-content-primary"
            >
              <X size={16} />
            </button>
          </div>
        ) : (
          <div className="flex flex-none items-center gap-2 border-b border-line px-4 py-3">
            <button
              type="button"
              aria-label="返回列表"
              onClick={() => {
                void flushSave()
                setView("list")
              }}
              className="flex h-8 w-8 flex-none items-center justify-center rounded-full text-content-muted transition-colors duration-micro hover:bg-surface-subtle hover:text-content-primary"
            >
              <ArrowLeft size={16} />
            </button>
            <span className="min-w-0 flex-1 truncate text-[12px] text-content-muted">
              {saveState === "saving"
                ? "保存中…"
                : saveState === "saved"
                  ? "已保存"
                  : saveState === "error"
                    ? "保存失败,改一下会重试"
                    : ""}
            </span>
            <button
              type="button"
              aria-label={draft.pinned ? "取消置顶" : "置顶"}
              onClick={() => setDraft((d) => ({ ...d, pinned: !d.pinned }))}
              className={cn(
                "flex h-8 w-8 flex-none items-center justify-center rounded-full transition-colors duration-micro",
                draft.pinned
                  ? "bg-accent-soft text-accent"
                  : "text-content-muted hover:bg-surface-subtle hover:text-content-primary"
              )}
            >
              {draft.pinned ? <Pin size={14} /> : <PinOff size={14} />}
            </button>
            <button
              type="button"
              aria-label="关闭"
              onClick={onClose}
              className="flex h-8 w-8 flex-none items-center justify-center rounded-full text-content-muted transition-colors duration-micro hover:bg-surface-subtle hover:text-content-primary"
            >
              <X size={16} />
            </button>
          </div>
        )}

        {notice && (
          <p className="flex-none border-b border-line bg-danger-soft px-4 py-1.5 text-[11.5px] text-danger">
            {notice}
          </p>
        )}

        {/* 列表态 */}
        {view === "list" && (
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {loading && (
              <div className="space-y-2 px-2 py-2">
                <div className="h-14 animate-pulse rounded-control bg-surface-subtle" />
                <div className="h-14 animate-pulse rounded-control bg-surface-subtle" />
              </div>
            )}

            {!loading &&
              filtered.map((memo) => (
                <div
                  key={memo.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => openEdit(memo)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      openEdit(memo)
                    }
                  }}
                  className="group flex cursor-pointer items-start gap-2 rounded-control px-2.5 py-2.5 transition-colors duration-micro hover:bg-surface-muted"
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 text-[13px] font-medium leading-snug text-content-primary">
                      <span className="truncate">{displayTitle(memo)}</span>
                      {memo.pinned && <Pin size={11} className="shrink-0 text-accent" />}
                    </p>
                    {preview(memo) && (
                      <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-relaxed text-content-secondary">
                        {preview(memo)}
                      </p>
                    )}
                    <p className="mt-1 text-[10px] text-content-muted">{fmtUpdated(memo.updatedAt)}</p>
                  </div>
                  <div className="mt-0.5 flex flex-none items-center gap-0.5 opacity-0 transition-opacity duration-micro group-hover:opacity-100">
                    <button
                      type="button"
                      aria-label={memo.pinned ? "取消置顶" : "置顶"}
                      onClick={(e) => {
                        e.stopPropagation()
                        void togglePin(memo)
                      }}
                      className="flex h-7 w-7 items-center justify-center rounded-full text-content-muted hover:bg-surface-subtle hover:text-content-primary"
                    >
                      {memo.pinned ? <PinOff size={13} /> : <Pin size={13} />}
                    </button>
                    <button
                      type="button"
                      aria-label="删除备忘"
                      onClick={(e) => {
                        e.stopPropagation()
                        setConfirming(memo)
                      }}
                      className="flex h-7 w-7 items-center justify-center rounded-full text-content-muted hover:bg-danger-soft hover:text-danger"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}

            {!loading && filtered.length === 0 && (
              <div className="flex flex-col items-center gap-1.5 px-4 py-10 text-center">
                <p className="text-xs text-content-secondary">
                  {query ? "没有匹配的备忘" : "还没有备忘"}
                </p>
                <p className="text-[11px] leading-relaxed text-content-muted">
                  {query ? "换个词试试" : "长期要记住的话都放这里,和待办分开。"}
                </p>
              </div>
            )}
          </div>
        )}

        {/* 编辑态:标题 + 正文,自动保存 */}
        {view === "edit" && (
          <div className="flex min-h-0 flex-1 flex-col">
            <input
              ref={titleRef}
              value={draft.title}
              onChange={(e) => {
                setDraft((d) => ({ ...d, title: e.target.value }))
                scheduleSave()
              }}
              onBlur={() => void flushSave()}
              placeholder="标题(可空,回退正文首行)"
              className="flex-none border-b border-line bg-transparent px-4 py-2.5 text-[14px] font-medium text-content-primary outline-none placeholder:text-content-muted"
            />
            <textarea
              value={draft.content}
              onChange={(e) => {
                setDraft((d) => ({ ...d, content: e.target.value }))
                scheduleSave()
              }}
              onBlur={() => void flushSave()}
              placeholder="写点什么…"
              className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 text-[13px] leading-relaxed text-content-primary outline-none placeholder:text-content-muted"
            />
          </div>
        )}

        {/* 删除确认 */}
        {confirming && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/25 px-6">
            <div className="w-full max-w-[300px] rounded-panel border border-line bg-surface p-4 shadow-xl">
              <p className="text-[13.5px] font-medium text-content-primary">
                删除「{displayTitle(confirming)}」?
              </p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-content-secondary">
                删除后不能撤销。
              </p>
              <div className="mt-3.5 flex gap-2">
                <button
                  type="button"
                  onClick={() => setConfirming(null)}
                  className="h-9 flex-1 rounded-control border border-line text-[12.5px] text-content-secondary transition-colors duration-micro hover:bg-surface-muted"
                >
                  先留着
                </button>
                <button
                  type="button"
                  onClick={confirmDelete}
                  disabled={deleting}
                  className="h-9 flex-1 rounded-control bg-danger text-[12.5px] font-medium text-white transition-[transform,opacity] duration-micro active:scale-[0.99] disabled:opacity-50"
                >
                  {deleting ? "删除中…" : "删除"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
