'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ContextMenuItem } from '@/store/contextMenuStore'

/**
 * 毛玻璃扇形轮盘 —— ContextMenuHost 的"转盘模式"渲染器。
 * 数据仍来自 contextMenuStore(ContextMenuItem),仅替换视觉与交互:
 * 扇区只放图标,hub 悬停显示全名;二级子菜单不支持(由 Host 回退列表)。
 */

const GAP_DEG = 2.2
const START = -90
/** 长按松手判定"甩出盘外=取消"的外扩余量:贴缘 30px 内仍算瞄向扇区 */
const OUT_MARGIN = 30

function geo(size: number) {
  const C = size / 2
  const R_OUT = size / 2 - 2
  const HOLE = size * 0.175
  return { C, R_OUT, HOLE, ICON_R: (HOLE + R_OUT) / 2 }
}

function polar(cx: number, cy: number, r: number, deg: number) {
  const a = (deg * Math.PI) / 180
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
}

function sectorPath(cx: number, cy: number, rO: number, rI: number, a0: number, a1: number) {
  const large = (a1 - a0) % 360 > 180 ? 1 : 0
  const s1 = polar(cx, cy, rO, a0)
  const e1 = polar(cx, cy, rO, a1)
  const s2 = polar(cx, cy, rI, a1)
  const e2 = polar(cx, cy, rI, a0)
  return (
    `M ${s1.x} ${s1.y} A ${rO} ${rO} 0 ${large} 1 ${e1.x} ${e1.y} ` +
    `L ${s2.x} ${s2.y} A ${rI} ${rI} 0 ${large} 0 ${e2.x} ${e2.y} Z`
  )
}

function truncate(text: string, size: number) {
  const maxLen = Math.max(3, Math.floor(size / 32))
  return text.length > maxLen ? text.slice(0, maxLen - 1) + '…' : text
}

export interface WheelMenuProps {
  items: ContextMenuItem[]
  x: number
  y: number
  size?: number
  onAction: (item: ContextMenuItem) => void
  menuRef?: React.Ref<HTMLDivElement>
  /** 长按模式:隐藏光标,移动鼠标瞄准扇区,松手结算 */
  holdMode?: boolean
  /**
   * 松手结算回调:
   * executed=扇区执行(Host 需吞掉随后的原生 contextmenu);
   * cancelled=甩出盘外/移动后回中心取消(Host 吞原生 contextmenu 并关菜单);
   * stay=中心原地/禁用扇区松手,轮盘保留转点击模式
   */
  onHoldEnd?: (outcome: 'executed' | 'cancelled' | 'stay') => void
}

export function WheelMenu({ items, x, y, size = 180, onAction, menuRef, holdMode, onHoldEnd }: WheelMenuProps) {
  const [hover, setHover] = useState(-1)
  /** 长按瞄准中的扇区索引;-1=在中心 hub 或取消区;null=尚未移动 */
  const [aim, setAim] = useState<number | null>(null)
  /** 长按中指针处于取消区(盘外 30px 以外,或"真离开过 hub 又回到 hub") */
  const [canceling, setCanceling] = useState(false)
  const aimRef = useRef(aim)
  aimRef.current = aim
  const cancelRef = useRef(canceling)
  cancelRef.current = canceling
  // moved 只增不减:必须真正离开过 hub 圆(手抖不算),再回中心才判取消
  const movedRef = useRef(false)
  // 长按松手会先后触发 window mouseup 结算与扇区 click,单次挂载只允许执行一次
  const settledRef = useRef(false)
  const fire = useCallback(
    (it: ContextMenuItem) => {
      if (settledRef.current) return
      settledRef.current = true
      onAction(it)
    },
    [onAction],
  )
  const sheenId = 'wheel-sheen' + useId().replace(/[^a-zA-Z0-9]/g, '')
  const { C, R_OUT, HOLE, ICON_R } = useMemo(() => geo(size), [size])
  const step = 360 / items.length

  const pos = useMemo(
    () => ({
      left: Math.max(8, Math.min(x - C, window.innerWidth - size - 8)),
      top: Math.max(8, Math.min(y - C, window.innerHeight - size - 8)),
    }),
    [x, y, C, size],
  )

  // ←→ 循环聚焦,Enter 执行;Esc/外点/滚动由 ContextMenuHost 全局监听负责
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') setHover((h) => (h + 1) % items.length)
      else if (e.key === 'ArrowLeft') setHover((h) => (h - 1 + items.length) % items.length)
      else if (e.key === 'Enter' && hover >= 0) {
        const it = items[hover]
        if (!it.disabled) fire(it)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items, hover, fire])

  // 长按模式:隐藏光标,mousemove 按极角瞄准,mouseup(button 2)结算。
  // 松手在可用扇区=执行;甩出盘外(>R_OUT+30)或"离开过 hub 再回中心"=取消并关盘;
  // 中心原地/禁用扇区松手=退出长按、轮盘留点击模式;窗口失焦=兜底退出(光标恢复)。
  useEffect(() => {
    if (!holdMode) return
    movedRef.current = false
    setCanceling(false)
    document.body.classList.add('wheel-holding')
    const onMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - (pos.left + C)
      const dy = e.clientY - (pos.top + C)
      const dist = Math.hypot(dx, dy)
      if (dist > R_OUT + OUT_MARGIN) {
        movedRef.current = true
        setAim(-1)
        setCanceling(true)
        return
      }
      if (dist < HOLE + 6) {
        setAim(-1)
        setCanceling(movedRef.current)
        return
      }
      movedRef.current = true
      setCanceling(false)
      const deg = (Math.atan2(dy, dx) * 180) / Math.PI
      const rel = ((deg - START) % 360 + 360) % 360
      setAim(Math.min(items.length - 1, Math.floor(rel / step)))
    }
    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 2) return
      if (cancelRef.current) {
        settledRef.current = true
        onHoldEnd?.('cancelled')
        return
      }
      const a = aimRef.current
      const it = a !== null && a >= 0 ? items[a] : undefined
      if (it && !it.disabled) {
        onHoldEnd?.('executed')
        fire(it)
      } else {
        onHoldEnd?.('stay')
      }
    }
    const onBlur = () => onHoldEnd?.('stay')
    window.addEventListener('mousemove', onMouseMove, true)
    window.addEventListener('mouseup', onMouseUp, true)
    window.addEventListener('blur', onBlur)
    return () => {
      document.body.classList.remove('wheel-holding')
      window.removeEventListener('mousemove', onMouseMove, true)
      window.removeEventListener('mouseup', onMouseUp, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [holdMode, pos, C, R_OUT, HOLE, step, items, fire, onHoldEnd])

  const activeIdx = holdMode ? (aim ?? -1) : hover
  const hubText = canceling ? '松手取消' : activeIdx >= 0 ? truncate(items[activeIdx].label, size) : holdMode ? '松手选择' : '选择操作'

  return (
    <>
      <style>{WHEEL_CSS}</style>
      <div
        ref={menuRef}
        className={'wheel-wrap' + (canceling ? ' cancel' : '')}
        role="menu"
        data-context-menu
        aria-label="上下文轮盘"
        style={{ left: pos.left, top: pos.top }}
      >
        <svg className="wheel-svg" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <defs>
            <linearGradient id={sheenId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="rgb(255 255 255)" stopOpacity=".22" />
              <stop offset=".45" stopColor="rgb(255 255 255)" stopOpacity=".05" />
              <stop offset="1" stopColor="rgb(255 255 255)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <circle className="wheel-base" cx={C} cy={C} r={R_OUT + 2} />
          {items.map((it, i) => {
            const a0 = START + i * step + GAP_DEG / 2
            const a1 = START + (i + 1) * step - GAP_DEG / 2
            const mid = (a0 + a1) / 2
            const ip = polar(C, C, ICON_R, mid)
            const cls =
              'seg' +
              (it.danger ? ' danger' : '') +
              (it.disabled ? ' disabled' : '') +
              (activeIdx === i ? ' kb-focus' : '')
            return (
              <g
                key={it.id}
                className={cls}
                role="menuitem"
                aria-label={it.label}
                aria-disabled={it.disabled || undefined}
                style={{ transformOrigin: `${C}px ${C}px`, animationDelay: `${i * 22}ms` }}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(-1)}
                onClick={() => {
                  if (!it.disabled) fire(it)
                }}
              >
                <path d={sectorPath(C, C, R_OUT, HOLE, a0, a1)} />
                <foreignObject className="icon" x={ip.x - 11} y={ip.y - 11} width={22} height={22} style={{ pointerEvents: 'none' }}>
                  <div style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {it.icon ?? <span style={{ fontSize: 10 }}>{it.label.slice(0, 1)}</span>}
                  </div>
                </foreignObject>
              </g>
            )
          })}
          <circle cx={C} cy={C} r={R_OUT + 2} fill={`url(#${sheenId})`} style={{ pointerEvents: 'none' }} />
          <circle className="wheel-ring" cx={C} cy={C} r={R_OUT + 1.5} />
          <circle className="wheel-ring-inner" cx={C} cy={C} r={R_OUT - 1} />
          <circle className="wheel-hub-circle" cx={C} cy={C} r={HOLE} />
          <text className="wheel-hub-text" x={C} y={C} style={{ fontSize: Math.max(8, Math.round(size * 0.055)) }}>
            {hubText}
          </text>
        </svg>
      </div>
    </>
  )
}

const WHEEL_CSS = `
.wheel-wrap {
  position: fixed; z-index: 80; border-radius: 50%;
  --wheel-danger: 220 38 38;
  -webkit-backdrop-filter: blur(34px) saturate(1.9);
  backdrop-filter: blur(34px) saturate(1.9);
  box-shadow: 0 14px 32px rgba(0,0,0,.22), inset 0 1px 0 rgba(255,255,255,.25);
}
.dark .wheel-wrap { --wheel-danger: 248 113 113; }
.wheel-svg { display: block; overflow: visible; }
.wheel-svg .seg { cursor: pointer; transition: opacity .15s; animation: wheelIn .28s cubic-bezier(.2,.9,.3,1.2) backwards; }
@keyframes wheelIn { from { opacity: 0; transform: scale(.3); } to { opacity: 1; transform: scale(1); } }
.wheel-svg .seg path { fill: rgb(255 255 255 / .34); stroke: rgb(15 23 42 / .1); stroke-width: 1.5; transition: fill .12s, stroke .12s; }
.dark .wheel-svg .seg path { fill: rgb(255 255 255 / .06); stroke: rgb(255 255 255 / .14); }
.wheel-base { fill: rgb(100 116 139 / .1); }
.dark .wheel-base { fill: rgb(var(--surface-muted) / .2); }
.wheel-ring { fill: none; stroke: rgb(var(--line-strong) / .6); stroke-width: 1; }
.wheel-ring-inner { fill: none; stroke: rgb(255 255 255 / .5); stroke-width: 1; }
.dark .wheel-ring-inner { stroke: rgb(255 255 255 / .16); }
.wheel-svg .seg:hover path, .wheel-svg .seg.kb-focus path { fill: rgb(var(--accent-soft) / .55); stroke: rgb(var(--line-strong) / .8); }
.dark .wheel-svg .seg:hover path, .dark .wheel-svg .seg.kb-focus path { fill: rgb(var(--accent-soft) / .4); }
.wheel-svg .seg.danger:hover path, .wheel-svg .seg.danger.kb-focus path { fill: rgb(var(--wheel-danger) / .16); stroke: rgb(var(--wheel-danger) / .55); }
.wheel-svg .seg .icon { color: rgb(var(--content-primary)); opacity: .8; transition: opacity .12s; pointer-events: none; }
.wheel-svg .seg:hover .icon, .wheel-svg .seg.kb-focus .icon { opacity: 1; }
.wheel-svg .seg.danger .icon { color: rgb(var(--wheel-danger)); opacity: .9; }
.wheel-svg .seg.danger:hover .icon, .wheel-svg .seg.danger.kb-focus .icon { opacity: 1; }
.wheel-svg .seg.disabled { opacity: .35; cursor: not-allowed; }
.wheel-hub-circle { fill: rgb(255 255 255 / .72); stroke: rgb(15 23 42 / .08); stroke-width: 1.5; }
.dark .wheel-hub-circle { fill: rgb(24 26 32 / .62); stroke: rgb(255 255 255 / .12); }
.wheel-hub-text {
  font-family: var(--font-sans, inherit); font-size: 11px; fill: rgb(var(--content-primary));
  text-anchor: middle; dominant-baseline: central; pointer-events: none;
}
body.wheel-holding, body.wheel-holding * { cursor: none !important; }
.wheel-wrap.cancel .wheel-svg .seg { opacity: .35; }
.wheel-wrap.cancel .wheel-hub-text { fill: rgb(var(--wheel-danger)); }
`
