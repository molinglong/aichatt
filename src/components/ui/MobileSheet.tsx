'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { useBackToClose } from '@/hooks/useBackToClose'

/**
 * 手机端底部面板统一外壳。
 *
 * 统一了此前四套各写一遍的东西：遮罩浓度、顶角 28、surface 95% + blur 28 的玻璃底、
 * 4×40 把手、居中 15px 标题、底部取消行、安全区、320/240ms 进出场、下滑关闭、滚动锁。
 * 容器不描边（改用向上三层投影分层），列表行之间也不画分隔线（选中靠整行浅底）。
 *
 * 内容由调用方给：列表型面板直接铺 SheetRow + SheetGroup，对话型面板给自定义内容。
 */

const IN_MS = 320
const OUT_MS = 240
const EASE = 'cubic-bezier(.32,.72,.28,1)'
/** 下滑超过 96px，或轻扫速度超过 0.5px/ms，即关闭 */
const CLOSE_DISTANCE = 96
const CLOSE_VELOCITY = 0.5

export interface MobileSheetProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  /** 底部取消行文案；传 null 隐藏整行 */
  cancelLabel?: string | null
  /** 内容区额外样式 */
  bodyClassName?: string
  /**
   * 内容区是否自己滚动。列表型面板给 true（默认）；
   * 对话型面板要「中间滚、底部输入钉住」时给 false，改由内部自己分栏。
   */
  scrollBody?: boolean
  /** 面板最大高度，默认 78dvh（内容少时按内容收） */
  maxHeight?: string
  ariaLabel?: string
  /**
   * 面板层级，默认 58（遮罩自动取 57）。
   * 从设置页（z-100）里开出来的面板要传 102，否则会被设置页盖住点不到。
   */
  zIndex?: number
}

export function MobileSheet({
  open,
  onClose,
  title,
  children,
  cancelLabel,
  bodyClassName,
  scrollBody = true,
  maxHeight = '78dvh',
  ariaLabel,
  zIndex = 58,
}: MobileSheetProps) {
  const [mounted, setMounted] = useState(false)
  const [rendered, setRendered] = useState(false)
  const [shown, setShown] = useState(false)

  const panelRef = useRef<HTMLDivElement | null>(null)
  const scrimRef = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{ active: boolean; startY: number; startAt: number; dy: number } | null>(null)

  useEffect(() => setMounted(true), [])

  // 开：挂载后双 RAF 置 shown 触发上滑；关：先落 shown，播完 240ms 再卸载
  useEffect(() => {
    if (open) {
      setRendered(true)
      let raf2 = 0
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setShown(true))
      })
      return () => {
        cancelAnimationFrame(raf1)
        if (raf2) cancelAnimationFrame(raf2)
      }
    }
    setShown(false)
    if (!rendered) return
    const reduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) {
      setRendered(false)
      return
    }
    const timer = window.setTimeout(() => setRendered(false), OUT_MS)
    return () => window.clearTimeout(timer)
  }, [open, rendered])

  // 面板开着时锁住页面滚动，列表自己滚
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // 安卓返回键先关面板，不穿透到壳层
  useBackToClose(open, onClose)

  const beginDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = panelRef.current
    if (!el) return
    drag.current = { active: true, startY: e.clientY, startAt: performance.now(), dy: 0 }
    el.style.transitionDuration = '0ms'
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const moveDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    const el = panelRef.current
    if (!d?.active || !el) return
    d.dy = Math.max(0, e.clientY - d.startY)
    el.style.transform = `translate3d(0, ${d.dy}px, 0)`
    if (scrimRef.current) {
      scrimRef.current.style.opacity = String(Math.max(0, 1 - d.dy / 420))
    }
  }

  const endDrag = () => {
    const d = drag.current
    const el = panelRef.current
    if (!d?.active || !el) return
    d.active = false
    const elapsed = Math.max(1, performance.now() - d.startAt)
    const shouldClose = d.dy > CLOSE_DISTANCE || (d.dy > 24 && d.dy / elapsed > CLOSE_VELOCITY)
    if (shouldClose) {
      el.style.transitionDuration = `${OUT_MS}ms`
      onClose()
      return
    }
    // 没拖够：回弹，然后把行内值交回 React，避免挡住下一次开合
    el.style.transitionDuration = `${IN_MS}ms`
    el.style.transform = 'translate3d(0, 0, 0)'
    if (scrimRef.current) scrimRef.current.style.opacity = ''
    window.setTimeout(() => {
      el.style.transitionDuration = ''
      el.style.transform = ''
    }, IN_MS)
  }

  if (!mounted || !rendered) return null

  return createPortal(
    <>
      <div
        ref={scrimRef}
        aria-hidden
        onClick={onClose}
        className="fixed inset-0 bg-black/40 dark:bg-black/55"
        style={{
          zIndex: zIndex - 1,
          opacity: shown ? 1 : 0,
          transition: `opacity ${shown ? IN_MS : OUT_MS}ms ${EASE}`,
          pointerEvents: shown ? 'auto' : 'none',
        }}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? title}
        data-sheet-panel
        className="fixed inset-x-0 bottom-0 flex flex-col overflow-hidden rounded-t-[28px] bg-surface/95"
        style={{
          zIndex,
          maxHeight,
          WebkitBackdropFilter: 'blur(28px) saturate(1.6)',
          backdropFilter: 'blur(28px) saturate(1.6)',
          // 阴影代替描边：1px 定轮廓、6px 贴合、28px 浮起
          boxShadow:
            '0 -1px 2px rgba(0,0,0,.05), 0 -6px 16px -8px rgba(0,0,0,.14), 0 -28px 60px -24px rgba(0,0,0,.16)',
          paddingBottom: 'max(var(--sab, 0px), 8px)',
          transform: shown ? 'translate3d(0,0,0)' : 'translate3d(0,100%,0)',
          transition: `transform ${shown ? IN_MS : OUT_MS}ms ${EASE}`,
        }}
      >
        {/* 把手 + 标题一起作为下滑热区；touch-none 避免和内部滚动抢手势 */}
        <div
          className="shrink-0 touch-none select-none"
          onPointerDown={beginDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div aria-hidden className="mx-auto mt-2.5 h-[4px] w-10 rounded-full bg-line-strong/50" />
          <p className="px-5 pb-3 pt-3.5 text-center text-[15px] font-semibold text-content-primary">
            {title}
          </p>
        </div>
        <div
          className={cn(
            'min-h-0 flex-1',
            scrollBody && 'overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
            bodyClassName
          )}
        >
          {children}
        </div>
        {cancelLabel !== null && (
          <div className="shrink-0 px-3 pb-1 pt-2">
            <button
              type="button"
              onClick={onClose}
              data-sheet-cancel
              className="w-full rounded-2xl bg-surface-muted/60 py-2.5 text-center text-[15px] text-accent transition-colors active:bg-surface-muted"
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              {cancelLabel ?? '取消'}
            </button>
          </div>
        )}
      </div>
    </>,
    document.body
  )
}

export interface SheetRowProps {
  title: ReactNode
  subtitle?: ReactNode
  /** 行首图标/头像，尺寸统一压到 18px */
  lead?: ReactNode
  /** 行尾内容（标签、开关等） */
  trailing?: ReactNode
  selected?: boolean
  onClick?: () => void
  disabled?: boolean
  className?: string
}

/**
 * 面板里的标准行：48 高（双行自然撑到 54）、左右 16、主文 14 / 副文 11.5。
 * 选中态只用整行浅底，不加勾也不加左侧竖条，也不画分隔线。
 */
export function SheetRow({
  title,
  subtitle,
  lead,
  trailing,
  selected,
  onClick,
  disabled,
  className,
}: SheetRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected === undefined ? undefined : selected}
      data-sheet-row
      className={cn(
        'flex min-h-[48px] w-full items-center gap-3 px-4 py-2.5 text-left',
        'text-[14px] leading-[1.35] text-content-primary transition-colors touch-manipulation',
        selected ? 'bg-surface-muted' : 'active:bg-surface-subtle/60',
        disabled && 'opacity-50',
        className
      )}
      style={{ WebkitTapHighlightColor: 'transparent' }}
    >
      {lead !== undefined && (
        <span className="grid w-[22px] shrink-0 place-items-center text-content-secondary [&_svg]:h-[18px] [&_svg]:w-[18px]">
          {lead}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{title}</span>
        {subtitle !== undefined && (
          <span className="mt-[3px] block truncate text-[11.5px] leading-[1.4] text-content-muted">
            {subtitle}
          </span>
        )}
      </span>
      {trailing}
    </button>
  )
}

/** 分组标题：11px / 600，字距 0.08em */
export function SheetGroup({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 pb-1.5 pt-3.5 text-[11px] font-semibold tracking-[0.08em] text-content-muted">
      {children}
    </div>
  )
}

export interface SheetToggleRowProps {
  title: ReactNode
  subtitle?: ReactNode
  lead?: ReactNode
  /** 右侧控件（开关等）。行本体是 div，避免 button 套 button 触发 hydration 报错 */
  trailing?: ReactNode
  on: boolean
  onToggle: () => void
}

/**
 * 带开关的行：整行语义与 SheetRow 一致（54 高、14px 主文），
 * 只是把「文本 + 图标」这块单独做成可点的 button，右侧留给 MiniSwitch 一类控件。
 */
export function SheetToggleRow({ title, subtitle, lead, trailing, on, onToggle }: SheetToggleRowProps) {
  return (
    <div className="flex min-h-[54px] w-full items-center gap-3 px-4 py-2.5" data-sheet-toggle>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={on}
        className="flex min-w-0 flex-1 items-center gap-3 text-left text-[14px] leading-[1.35] text-content-primary touch-manipulation"
        style={{ WebkitTapHighlightColor: 'transparent' }}
      >
        {lead !== undefined && (
          <span className="grid w-[22px] shrink-0 place-items-center text-content-secondary [&_svg]:h-[18px] [&_svg]:w-[18px]">
            {lead}
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate">{title}</span>
          {subtitle !== undefined && (
            <span className="mt-[3px] block truncate text-[11.5px] leading-[1.4] text-content-muted">
              {subtitle}
            </span>
          )}
        </span>
      </button>
      {trailing}
    </div>
  )
}
