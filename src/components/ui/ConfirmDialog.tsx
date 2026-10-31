'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ConfirmDialogProps {
  open: boolean
  /** 标题行,如「删除 3 个对话」 */
  title: string
  /** 正文说明,写清后果(不可恢复/连带删除什么) */
  description: string
  confirmLabel?: string
  cancelLabel?: string
  /** 危险操作:确认按钮走红底 */
  danger?: boolean
  /** 确认动作执行中:两个按钮都禁用,确认按钮显示「正在删除…」 */
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * 通用危险操作确认弹窗,替代原生 window.confirm。
 *
 * 必须 Portal 到 body:侧边栏 aside 带 glass-blur(backdrop-filter),
 * 在其内部 `fixed` 会以 aside 而不是视口为包含块,遮罩罩不住主内容区。
 * 面板按弹窗纯色背景规范用 bg-surface,不做玻璃拟态。
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '确认',
  cancelLabel = '取消',
  danger,
  busy,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null)

  // 打开即把焦点交给取消按钮(默认回车不该执行不可恢复的操作),Esc 取消
  useEffect(() => {
    if (!open) return
    confirmRef.current?.focus({ preventScroll: true })
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onCancel()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, busy, onCancel])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center px-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={() => { if (!busy) onCancel() }}
    >
      <div className="absolute inset-0 bg-black/40" />
      <div
        className={cn(
          'relative w-full max-w-sm rounded-xl border border-line bg-surface shadow-2xl',
          'px-4 pt-4 pb-3.5'
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-2.5">
          {danger && (
            <span className="mt-0.5 shrink-0 flex h-6 w-6 items-center justify-center rounded-full bg-red-500/10">
              <AlertTriangle className="h-3.5 w-3.5 text-red-500 dark:text-red-400" aria-hidden />
            </span>
          )}
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-content-primary">{title}</h3>
            <p className="mt-1 text-xs leading-5 text-content-muted">{description}</p>
          </div>
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="h-8 px-3 rounded-lg text-xs font-medium border border-line/40 bg-surface-muted/60
              text-content-secondary hover:bg-surface-subtle transition-colors disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={cn(
              'h-8 px-3 rounded-lg text-xs font-medium transition-colors disabled:opacity-60',
              danger
                ? 'bg-red-500 text-white hover:bg-red-600 dark:bg-red-500/90 dark:hover:bg-red-500'
                : 'bg-accent text-white hover:bg-accent-hover'
            )}
          >
            {busy ? '正在删除…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

/* ── 命令式确认框(方案 C 手机端「弹窗三通道」之③)─────────────────
   与上方声明式 ConfirmDialog 并存:Sidebar 等老调用仍走 props 版,
   新增移动端浮层走 Promise 版 —— confirmDialog(opts) => Promise<boolean>,
   由 <ConfirmDialogHost /> 在 (app)/layout.tsx 单点挂载。 */
export interface ConfirmOptions {
  /** 标题;省略时用默认「确认操作」 */
  title?: string
  message: string
  /** 次级说明,灰色小字 */
  detail?: string
  okText?: string
  cancelText?: string
  /** 不可恢复操作:主按钮转红并默认聚焦取消,防误按回车 */
  danger?: boolean
}

interface Item extends ConfirmOptions {
  resolve: (v: boolean) => void
}

let submit: ((item: Item) => void) | null = null
/** host 挂载前的调用先进队,挂载后立即补弹,避免点击静默失效 */
const pending: Item[] = []

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const item = { ...opts, resolve }
    if (submit) submit(item)
    else pending.push(item)
  })
}

const CLOSE_MS = 180

export function ConfirmDialogHost() {
  const [stack, setStack] = useState<Item[]>([])
  const [leaving, setLeaving] = useState(false)
  const okRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  const push = useCallback((item: Item) => setStack((s) => [...s, item]), [])

  useEffect(() => {
    submit = push
    pending.splice(0).forEach(push)
    return () => {
      if (submit === push) submit = null
    }
  }, [push])

  const current = stack[stack.length - 1]

  const settle = useCallback(
    (v: boolean) => {
      if (!current || leaving) return
      setLeaving(true)
      window.setTimeout(() => {
        setStack((s) => s.slice(0, -1))
        setLeaving(false)
        current.resolve(v)
      }, CLOSE_MS)
    },
    [current, leaving]
  )

  useEffect(() => {
    if (!current) return
    setLeaving(false)
    // danger 时焦点给「取消」: 回车不该直接落进不可恢复的操作
    ;(current.danger ? cancelRef : okRef).current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        settle(false)
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [current, settle])

  if (!current) return null
  const danger = !!current.danger

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-6">
      <div
        onClick={() => settle(false)}
        className={`absolute inset-0 bg-black/45 transition-opacity duration-fast ${
          leaving ? 'opacity-0' : 'opacity-100'
        }`}
      />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={current.title ?? '确认操作'}
        className={`relative w-[300px] max-w-full rounded-3xl bg-surface px-5 pt-5 pb-4 shadow-[0_24px_70px_rgba(0,0,0,0.28)] transition-[opacity,transform] duration-fast ease-standard ${
          leaving ? 'scale-[0.97] opacity-0' : 'scale-100 opacity-100'
        }`}
      >
        <p className="text-center text-[15px] font-semibold leading-6 text-content-primary">
          {current.title ?? '确认操作'}
        </p>
        <p className="mt-1.5 text-center text-[13px] leading-relaxed text-content-secondary">
          {current.message}
        </p>
        {current.detail && (
          <p className="mt-1 text-center text-[11px] leading-relaxed text-content-muted">
            {current.detail}
          </p>
        )}
        <div className="mt-4 flex gap-2">
          <button
            ref={cancelRef}
            onClick={() => settle(false)}
            className="flex-1 rounded-xl bg-surface-subtle py-2.5 text-[13px] font-medium text-content-secondary transition-colors hover:bg-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line-strong"
          >
            {current.cancelText ?? '取消'}
          </button>
          <button
            ref={okRef}
            onClick={() => settle(true)}
            className={`flex-1 rounded-xl py-2.5 text-[13px] font-medium text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line-strong ${
              danger ? 'bg-danger hover:bg-danger/85' : 'bg-accent hover:bg-accent-hover'
            }`}
          >
            {current.okText ?? '确认'}
          </button>
        </div>
      </div>
    </div>
  )
}
