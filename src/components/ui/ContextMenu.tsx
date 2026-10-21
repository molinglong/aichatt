'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useContextMenuStore, type ContextMenuItem } from '@/store/contextMenuStore'
import { WheelMenu } from './WheelMenu'

/** 转盘模式总开关:false 一键回退旧列表菜单 */
const WHEEL_MODE = true
/** 转盘直径(px)。140/160/180/210 四档体验后定稿 */
const WHEEL_SIZE = 180
/** 游戏式长按:右键按住超过该毫秒数即呼出轮盘并隐藏光标 */
const HOLD_WHEEL_MS = 180

/** 菜单与屏幕边缘的最小留白 */
const VIEWPORT_MARGIN = 8
/**
 * 菜单打开后 50ms 内的 mousedown / contextmenu 事件视为"打开动作本身",
 * 不触发关闭(同 MessageBubble 复制菜单的外点保护模式)。
 */
const OPEN_GRACE_MS = 50
/**
 * 触屏专用宽限期:菜单是"手指抬起后"才弹的,紧随的惯性微滚与长按补发的合成
 * mousedown/click 都在抬手瞬间到达,不能算"用户放弃菜单"(手机真机报"菜单一闪就没")。
 */
const TOUCH_CLOSE_GRACE_MS = 350

/**
 * 触屏设备(手机/纯平板,pointer:coarse 为主指针)判定:
 * 禁用轮盘与长按右键合成,右键/长按回退默认列表菜单。
 */
function isTouchPrimary() {
  return typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
}

/**
 * 全局右键菜单宿主 —— 单例挂载在 (app) layout,任何场景通过
 * contextMenuStore.openContextMenu() 弹出菜单,本组件统一负责:
 * - Portal 到 body + position:fixed(规避父容器 overflow/z-index 层叠坑)
 * - 视口边缘自动翻转(右/下越界翻左/上)
 * - 关闭时机:Esc / 外点 mousedown / 菜单外右键 / 任意滚动 / resize
 * - 键盘导航:↑↓ 移动焦点,Enter 执行(按钮原生),Home/End 跳转
 * - 二级子菜单:hover 展开,右缘越界自动翻到左侧
 */
export function ContextMenuHost() {
  const open = useContextMenuStore((s) => s.open)
  const x = useContextMenuStore((s) => s.x)
  const y = useContextMenuStore((s) => s.y)
  const items = useContextMenuStore((s) => s.items)
  const header = useContextMenuStore((s) => s.header)
  const closeContextMenu = useContextMenuStore((s) => s.closeContextMenu)

  const menuRef = useRef<HTMLDivElement>(null)
  /** 长按模式:轮盘跟随准星,松手即结算(交互在 WheelMenu 内实现) */
  const [holdMode, setHoldMode] = useState(false)
  /** 长按松手后短暂吞掉原生 contextmenu,防止场景方把它当"轻点右键"重开菜单 */
  const ignoreContextMenuUntil = useRef(0)
  // null = 未测量,按 x/y 原位渲染;useLayoutEffect 会在绘制前纠正,不产生闪烁
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  /**
   * 子菜单状态:id + 锚点(父行右缘/顶缘)。
   * 必须用 fixed 定位 —— 若作为 root(overflow-y-auto)内的 absolute 子元素,
   * left:100% 会被 overflow 裁剪(症状:DOM 存在/断言通过,但视觉不可见)。
   */
  const [submenu, setSubmenu] = useState<{ id: string; anchor: { left: number; top: number } } | null>(null)
  const [submenuPos, setSubmenuPos] = useState<{ left: number; top: number } | null>(null)
  const submenuRef = useRef<HTMLDivElement>(null)
  // 鼠标离开 root → 延迟关闭子菜单;移入子菜单(root 外的 fixed 元素)时取消
  const submenuCloseTimer = useRef<number | null>(null)

  const cancelSubmenuClose = useCallback(() => {
    if (submenuCloseTimer.current !== null) {
      window.clearTimeout(submenuCloseTimer.current)
      submenuCloseTimer.current = null
    }
  }, [])

  const scheduleSubmenuClose = useCallback(() => {
    cancelSubmenuClose()
    submenuCloseTimer.current = window.setTimeout(() => setSubmenu(null), 150)
  }, [cancelSubmenuClose])

  // hover/点击行时打开子菜单:锚点取父行右缘/顶缘
  const openSubmenuAt = useCallback((el: HTMLElement, id: string) => {
    cancelSubmenuClose()
    const rect = el.getBoundingClientRect()
    setSubmenu((prev) => (prev && prev.id === id ? prev : { id, anchor: { left: rect.right, top: rect.top } }))
  }, [cancelSubmenuClose])

  // 每次关闭后清理子菜单状态与计时器
  useEffect(() => {
    if (open) return
    setSubmenu(null)
    cancelSubmenuClose()
    setHoldMode(false)
  }, [open, cancelSubmenuClose])

  // ── 游戏式长按右键检测(常驻,不依赖 open 状态) ──
  // mousedown(右键) → 按住超 HOLD_WHEEL_MS 仍在 → 进入 holdMode,
  // 并向锚点元素合成一次 contextmenu,复用场景方既有的"组装菜单项"逻辑。
  // 松手结算在 WheelMenu 内做;这里只负责吞掉松手后紧跟的原生 contextmenu。
  useEffect(() => {
    let holdTimer: number | null = null
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 2) return
      // 触屏设备不进入长按轮盘(移动端已在 wheelEligible 回退列表,这里连合成也不做)
      if (isTouchPrimary()) return
      const { clientX: ax, clientY: ay } = e
      holdTimer = window.setTimeout(() => {
        holdTimer = null
        setHoldMode(true)
        document
          .elementFromPoint(ax, ay)
          ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: ax, clientY: ay }))
      }, HOLD_WHEEL_MS)
    }
    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 2) return
      if (holdTimer !== null) {
        window.clearTimeout(holdTimer)
        holdTimer = null
      }
      // 长按处无场景响应(空白区右键什么都没开出)→ WheelMenu 不会挂载,
      // 它的 mouseup 结算不存在,这里兜底复位 holdMode
      window.setTimeout(() => {
        if (!useContextMenuStore.getState().open) setHoldMode(false)
      }, 0)
    }
    const onContextMenuCapture = (e: MouseEvent) => {
      if (Date.now() < ignoreContextMenuUntil.current) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('mousedown', onMouseDown, true)
    window.addEventListener('mouseup', onMouseUp, true)
    window.addEventListener('contextmenu', onContextMenuCapture, true)
    return () => {
      window.removeEventListener('mousedown', onMouseDown, true)
      window.removeEventListener('mouseup', onMouseUp, true)
      window.removeEventListener('contextmenu', onContextMenuCapture, true)
    }
  }, [])

  const endHold = useCallback((outcome: 'executed' | 'cancelled' | 'stay') => {
    // executed/cancelled 后浏览器会补发原生 contextmenu,吞掉防止场景方在松手点重开菜单;
    // stay(中心原地松手)不吞:让 Host 的"菜单上右键"分支压住默认菜单即可
    if (outcome !== 'stay') ignoreContextMenuUntil.current = Date.now() + 300
    setHoldMode(false)
    if (outcome === 'cancelled') closeContextMenu()
  }, [closeContextMenu])

  // 定位:渲染后测量实际尺寸,越界即翻转(useLayoutEffect 保证绘制前完成,无闪烁)
  useLayoutEffect(() => {
    if (!open) return
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    let left = x
    let top = y
    if (left + rect.width + VIEWPORT_MARGIN > window.innerWidth) {
      left = Math.max(VIEWPORT_MARGIN, x - rect.width)
    }
    if (top + rect.height + VIEWPORT_MARGIN > window.innerHeight) {
      top = Math.max(VIEWPORT_MARGIN, y - rect.height)
    }
    setPos((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }))
  }, [open, x, y, items, submenu])

  // 子菜单定位:渲染后测量,右缘越界翻到锚点左侧,下缘越界上移钳制
  useLayoutEffect(() => {
    if (!submenu) return
    const el = submenuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    let left = submenu.anchor.left
    let top = submenu.anchor.top
    if (left + rect.width + VIEWPORT_MARGIN > window.innerWidth) {
      left = Math.max(VIEWPORT_MARGIN, submenu.anchor.left - rect.width)
    }
    if (top + rect.height + VIEWPORT_MARGIN > window.innerHeight) {
      top = Math.max(VIEWPORT_MARGIN, window.innerHeight - rect.height - VIEWPORT_MARGIN)
    }
    setSubmenuPos((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }))
  }, [submenu])

  // 打开时聚焦第一个可用项(键盘导航起点)
  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLButtonElement>('button[data-menuitem]:not(:disabled)')
        ?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [open, items])

  // 全局关闭时机(仅 open 期间挂载)
  useEffect(() => {
    if (!open) return
    const openedAt = Date.now()
    const closeGraceMs = isTouchPrimary() ? TOUCH_CLOSE_GRACE_MS : OPEN_GRACE_MS
    const isInsideMenu = (target: EventTarget | null) =>
      !!menuRef.current && menuRef.current.contains(target as Node)

    function onDocMouseDown(e: MouseEvent) {
      if (Date.now() - openedAt < closeGraceMs) return
      if (!isInsideMenu(e.target)) closeContextMenu()
    }
    function onDocContextMenu(e: MouseEvent) {
      if (isInsideMenu(e.target)) {
        // 菜单自身上右键:压住浏览器默认菜单,保持当前菜单不闪
        e.preventDefault()
        return
      }
      if (Date.now() - openedAt < closeGraceMs) return
      // 菜单外再次右键:关掉自己,让浏览器默认菜单(或场景方重开)接管
      closeContextMenu()
    }
    function onDocKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') closeContextMenu()
    }
    function onDocScroll(e: Event) {
      // 菜单内部滚动(长菜单 overflow-y-auto)不关闭
      if (e.target instanceof Node && isInsideMenu(e.target)) return
      if (Date.now() - openedAt < closeGraceMs) return
      closeContextMenu()
    }
    function onResize() {
      closeContextMenu()
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('contextmenu', onDocContextMenu)
    document.addEventListener('keydown', onDocKeyDown)
    document.addEventListener('scroll', onDocScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('contextmenu', onDocContextMenu)
      document.removeEventListener('keydown', onDocKeyDown)
      document.removeEventListener('scroll', onDocScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open, closeContextMenu])

  // 子菜单展开后测量右缘 → 已改为 fixed 定位,由上方 useLayoutEffect 依赖 submenu 处理

  // 键盘导航:焦点在菜单内时 ↑↓ 循环移动,Home/End 跳转(Enter 走按钮原生)
  const handleMenuKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    const focusable = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('button[data-menuitem]:not(:disabled)') ?? []
    )
    if (!focusable.length) return
    const idx = focusable.indexOf(document.activeElement as HTMLButtonElement)
    e.preventDefault()
    if (e.key === 'Home') focusable[0].focus()
    else if (e.key === 'End') focusable[focusable.length - 1].focus()
    else if (e.key === 'ArrowDown') focusable[(idx + 1) % focusable.length].focus()
    else focusable[(idx - 1 + focusable.length) % focusable.length].focus()
  }, [])
  // 执行叶子项:先关菜单再跑回调(回调里的 DOM 操作不被菜单遮挡)
  // ⚠️ 必须在所有 hook 之后、早退 return 之前定义 —— 条件性跳过 hook 会导致 React hooks 数量不匹配崩溃
  const runItem = useCallback(
    (item: ContextMenuItem) => {
      closeContextMenu()
      item.onSelect?.()
    },
    [closeContextMenu]
  )

  if (!open) return null

  const visibleItems = items.filter((it) => !it.hidden)

  // 转盘模式:3~8 项且无二级子菜单时以轮盘渲染,其余场景(代码块子菜单等)回退列表。
  // 触屏设备(手机)整体禁用轮盘,一律回退默认列表菜单
  const wheelEligible =
    WHEEL_MODE &&
    !isTouchPrimary() &&
    !items.some((it) => it.submenu) &&
    visibleItems.length >= 3 &&
    visibleItems.length <= 8
  if (wheelEligible) {
    return createPortal(
      <WheelMenu
        items={visibleItems}
        x={x}
        y={y}
        size={WHEEL_SIZE}
        onAction={runItem}
        menuRef={menuRef}
        holdMode={holdMode}
        onHoldEnd={endHold}
      />,
      document.body
    )
  }

  // isSubmenu=true 时行不再接管顶层子菜单开合(否则悬停子菜单叶子项会把父菜单重置关闭)
  const renderItems = (list: ContextMenuItem[], isSubmenu = false) =>
    list.map((item, i) => {
      const hasSubmenu = !!item.submenu && item.submenu.some((sub) => !sub.hidden)
      return (
        <div
          key={item.id}
          className={cn('relative', item.dividerBefore && i > 0 && 'border-t border-line/40 my-1')}
          onMouseEnter={
            isSubmenu
              ? undefined
              : (e) => {
                  if (hasSubmenu) openSubmenuAt(e.currentTarget, item.id)
                  else setSubmenu(null)
                }
          }
        >
          <button
            type="button"
            data-menuitem
            role="menuitem"
            aria-haspopup={hasSubmenu || undefined}
            aria-expanded={hasSubmenu ? submenu?.id === item.id : undefined}
            disabled={item.disabled}
            onClick={(e) => {
              if (hasSubmenu) {
                // 触屏没有 hover:点击切换子菜单展开
                if (submenu?.id === item.id) setSubmenu(null)
                else openSubmenuAt(e.currentTarget, item.id)
                return
              }
              runItem(item)
            }}
            className={cn(
              'w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors',
              'text-content-secondary hover:bg-surface-subtle hover:text-content-primary',
              item.danger && 'hover:text-red-500 dark:hover:text-red-400',
              item.disabled && 'opacity-40 cursor-not-allowed hover:bg-transparent'
            )}
          >
            {item.icon}
            <span className="flex-1 truncate">{item.label}</span>
            {hasSubmenu && <ChevronRight className="w-3 h-3 shrink-0 opacity-60" />}
          </button>
          {hasSubmenu && submenu?.id === item.id && (
            <div
              ref={submenuRef}
              role="menu"
              onMouseEnter={cancelSubmenuClose}
              style={{ left: submenuPos?.left ?? submenu.anchor.left, top: submenuPos?.top ?? submenu.anchor.top }}
              className={cn(
                'context-menu-enter fixed z-[81] min-w-[140px] max-h-[60vh] overflow-y-auto',
                'rounded-lg border border-line/60 bg-surface shadow-xl py-1 text-xs'
              )}
            >
              {renderItems(item.submenu!.filter((sub) => !sub.hidden), true)}
            </div>
          )}
        </div>
      )
    })

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      data-context-menu
      aria-label={header ?? '上下文菜单'}
      onKeyDown={handleMenuKeyDown}
      onMouseLeave={scheduleSubmenuClose}
      style={{ left: pos?.left ?? x, top: pos?.top ?? y }}
      className={cn(
        'context-menu-enter fixed z-[80] min-w-[160px] max-h-[70vh] overflow-y-auto',
        'rounded-lg border border-line/60 bg-surface shadow-xl py-1 text-xs',
        'origin-top-left'
      )}
    >
      {header && (
        <div className="px-2.5 pt-1.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-content-muted/70 select-none">
          {header}
        </div>
      )}
      {renderItems(visibleItems)}
    </div>,
    document.body
  )
}
