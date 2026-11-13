'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useBackToClose } from '@/hooks/useBackToClose'
import type { Attachment } from '@/lib/attachment-types'

/**
 * 聊天图片浏览器(全屏 Lightbox)。
 *
 * 背景:用户上传的图片缩略图原来是 <a target="_blank">——手机端(Tauri 安卓壳/手机浏览器)
 * 点开即离开应用,"返回"要么掉回上一页丢聊天状态、要么干脆没反应(见 useBackToClose 注释
 * 里的同类事故)。改为应用内全屏预览:点缩略图开、点纱面/✕/系统返回/Escape 关。
 *
 * 渲染走 createPortal 到 body:聊天列存在 backdrop-blur 祖先,fixed 遮罩会被降级成
 * 相对祖先定位(见 backdrop-blur-fixed 记忆),挂 body 根治。
 *
 * 缩放:双击图片在 1x/2.5x 间切换,滚轮以指针为中心缩放,触屏双指捏合缩放;
 * 放大后单指/鼠标拖动平移。1x 时单指横向滑动仍用于换图,放大态下不再换图。
 */

/** 滑动换图的最小位移(px),小于视为点按 */
const SWIPE_THRESHOLD = 48
const MIN_SCALE = 1
const MAX_SCALE = 4
const DOUBLE_CLICK_SCALE = 2.5

type Transform = { scale: number; x: number; y: number }
const IDENTITY: Transform = { scale: 1, x: 0, y: 0 }

type Metrics = { iw: number; ih: number; availW: number; availH: number }

type Gesture =
  | { mode: 'swipe'; startX: number; startY: number }
  | { mode: 'pan'; startX: number; startY: number; origin: Transform }
  | { mode: 'pinch'; startDist: number; startMidX: number; startMidY: number; origin: Transform }

function measure(stage: HTMLDivElement, img: HTMLImageElement): Metrics {
  const cs = getComputedStyle(stage)
  const availW =
    stage.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0)
  const availH =
    stage.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0)
  return {
    iw: img.offsetWidth,
    ih: img.offsetHeight,
    availW: Math.max(0, availW),
    availH: Math.max(0, availH),
  }
}

/** 平移边界:图片小于可视区时该轴锁定居中,避免拖出空白 */
function clampOffset(x: number, y: number, scale: number, m: Metrics): { x: number; y: number } {
  const maxX = Math.max(0, (m.iw * scale - m.availW) / 2)
  const maxY = Math.max(0, (m.ih * scale - m.availH) / 2)
  return {
    x: Math.max(-maxX, Math.min(maxX, x)),
    y: Math.max(-maxY, Math.min(maxY, y)),
  }
}

export function ChatImageLightbox({
  images,
  index,
  onClose,
  onIndexChange,
}: {
  /** 仅图片类附件(调用方过滤好),至少 1 条 */
  images: Attachment[]
  /** 当前查看的下标 */
  index: number
  onClose: () => void
  onIndexChange: (next: number) => void
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  // 系统返回/浏览器手势返回先关本层,不跳页(与设置弹窗同一套哨兵机制)
  useBackToClose(true, onClose)

  const closeRef = useRef(onClose)
  closeRef.current = onClose

  const stageRef = useRef<HTMLDivElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const transformRef = useRef<Transform>(IDENTITY)
  const [transform, setTransform] = useState<Transform>(IDENTITY)
  const [interacting, setInteracting] = useState(false)
  const pointersRef = useRef(new Map<number, { x: number; y: number }>())
  const gestureRef = useRef<Gesture | null>(null)
  const draggedRef = useRef(false)
  // pointer capture 会把后续 click 的 target 改到舞台层,需要记住起手是否落在图片上
  const pressedImageRef = useRef(false)

  const apply = useCallback((next: Transform) => {
    transformRef.current = next
    setTransform(next)
  }, [])

  const measureCurrent = useCallback((): Metrics | null => {
    const stage = stageRef.current
    const img = imgRef.current
    if (!stage || !img || img.offsetWidth === 0) return null
    return measure(stage, img)
  }, [])

  /** 以屏幕坐标 (clientX, clientY) 为不动点缩放到 nextScale */
  const zoomAt = useCallback(
    (clientX: number, clientY: number, nextScale: number) => {
      const stage = stageRef.current
      const m = measureCurrent()
      if (!stage || !m) return
      const cur = transformRef.current
      const s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, nextScale))
      const rect = stage.getBoundingClientRect()
      const mx = clientX - (rect.left + rect.width / 2)
      const my = clientY - (rect.top + rect.height / 2)
      const ratio = s / cur.scale
      const x = mx - (mx - cur.x) * ratio
      const y = my - (my - cur.y) * ratio
      if (s <= MIN_SCALE + 0.001) {
        apply(IDENTITY)
        return
      }
      const c = clampOffset(x, y, s, m)
      apply({ scale: s, x: c.x, y: c.y })
    },
    [apply, measureCurrent]
  )

  // 换图时归位,避免上一张的缩放/平移带到下一张
  useEffect(() => {
    pointersRef.current.clear()
    gestureRef.current = null
    setInteracting(false)
    apply(IDENTITY)
  }, [index, apply])

  // 桌面端键盘:Esc 关闭,左右键换图
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current()
      else if (e.key === 'ArrowLeft' && index > 0) onIndexChange(index - 1)
      else if (e.key === 'ArrowRight' && index < images.length - 1) onIndexChange(index + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, images.length, onIndexChange])

  // 滚轮缩放。React 的 wheel 监听是 passive 的,preventDefault 会被忽略,这里挂原生监听
  useEffect(() => {
    const stage = stageRef.current
    if (!mounted || !stage) return
    const onWheel = (e: WheelEvent) => {
      if (!imgRef.current) return
      e.preventDefault()
      const factor = Math.exp(-e.deltaY * 0.0015)
      zoomAt(e.clientX, e.clientY, transformRef.current.scale * factor)
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [mounted, zoomAt])

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    // 左右切换按钮上的点击交给按钮,不能抢 pointer capture(否则 click 不再落到按钮)
    if ((e.target as HTMLElement).closest('button')) return

    const stage = e.currentTarget
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    stage.setPointerCapture(e.pointerId)
    draggedRef.current = false
    pressedImageRef.current = !!(e.target as HTMLElement).closest('img')
    setInteracting(true)

    if (pointersRef.current.size === 1) {
      const cur = transformRef.current
      gestureRef.current =
        cur.scale > MIN_SCALE + 0.001
          ? { mode: 'pan', startX: e.clientX, startY: e.clientY, origin: cur }
          : { mode: 'swipe', startX: e.clientX, startY: e.clientY }
    } else if (pointersRef.current.size === 2) {
      const pts = Array.from(pointersRef.current.values())
      const rect = stage.getBoundingClientRect()
      gestureRef.current = {
        mode: 'pinch',
        startDist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
        startMidX: (pts[0].x + pts[1].x) / 2 - (rect.left + rect.width / 2),
        startMidY: (pts[0].y + pts[1].y) / 2 - (rect.top + rect.height / 2),
        origin: transformRef.current,
      }
      // 捏合结束后浏览器可能补发 click,标记为拖动避免误关
      draggedRef.current = true
    }
  }, [])

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const pts = pointersRef.current
      if (!pts.has(e.pointerId)) return
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
      const g = gestureRef.current
      if (!g) return

      if (g.mode === 'pinch' && pts.size >= 2) {
        const [a, b] = Array.from(pts.values())
        const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1
        const m = measureCurrent()
        if (!m) return
        const s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, g.origin.scale * (dist / g.startDist)))
        const ratio = s / g.origin.scale
        const x = g.startMidX - (g.startMidX - g.origin.x) * ratio
        const y = g.startMidY - (g.startMidY - g.origin.y) * ratio
        if (s <= MIN_SCALE + 0.001) {
          apply(IDENTITY)
        } else {
          const c = clampOffset(x, y, s, m)
          apply({ scale: s, x: c.x, y: c.y })
        }
        return
      }

      if (g.mode === 'pan' && pts.size === 1) {
        const m = measureCurrent()
        if (!m) return
        const dx = e.clientX - g.startX
        const dy = e.clientY - g.startY
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) draggedRef.current = true
        const c = clampOffset(g.origin.x + dx, g.origin.y + dy, g.origin.scale, m)
        apply({ scale: g.origin.scale, x: c.x, y: c.y })
        return
      }

      if (g.mode === 'swipe') {
        const dx = e.clientX - g.startX
        const dy = e.clientY - g.startY
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) draggedRef.current = true
      }
    },
    [apply, measureCurrent]
  )

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const pts = pointersRef.current
      pts.delete(e.pointerId)
      const g = gestureRef.current

      if (pts.size === 0) {
        try {
          e.currentTarget.releasePointerCapture(e.pointerId)
        } catch {}

        if (g?.mode === 'swipe') {
          const dx = e.clientX - g.startX
          const dy = e.clientY - g.startY
          if (Math.abs(dx) >= SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
            if (dx < 0 && index < images.length - 1) onIndexChange(index + 1)
            else if (dx > 0 && index > 0) onIndexChange(index - 1)
          }
        }

        // 捏合回到 1x 附近时彻底归位,避免留下 0.99x 的模糊态
        if (transformRef.current.scale < MIN_SCALE + 0.05) apply(IDENTITY)

        gestureRef.current = null
        setInteracting(false)
        return
      }

      if (pts.size === 1) {
        // 双指松开一指:以剩余手指重新锚定,避免图片跳回原点
        const [p] = Array.from(pts.values())
        const cur = transformRef.current
        gestureRef.current =
          cur.scale > MIN_SCALE + 0.001
            ? { mode: 'pan', startX: p.x, startY: p.y, origin: cur }
            : { mode: 'swipe', startX: p.x, startY: p.y }
      }
    },
    [apply, images.length, index, onIndexChange]
  )

  const handlePointerCancel = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      pointersRef.current.delete(e.pointerId)
      if (pointersRef.current.size === 0) {
        if (transformRef.current.scale < MIN_SCALE + 0.05) apply(IDENTITY)
        gestureRef.current = null
        setInteracting(false)
        return
      }
      if (pointersRef.current.size === 1) {
        const [p] = Array.from(pointersRef.current.values())
        const cur = transformRef.current
        gestureRef.current =
          cur.scale > MIN_SCALE + 0.001
            ? { mode: 'pan', startX: p.x, startY: p.y, origin: cur }
            : { mode: 'swipe', startX: p.x, startY: p.y }
      }
    },
    [apply]
  )

  if (!mounted || images.length === 0) return null
  const att = images[Math.min(index, images.length - 1)]

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`图片预览:${att.name}`}
      className="overlay-fade fixed inset-0 z-[300] flex flex-col bg-black/90 select-none"
      style={{ overscrollBehavior: 'contain' }}
      onClick={onClose}
    >
      {/* 顶栏:文件名 + 缩放倍率 + 关闭(不随图切换变化,独立成层避免被大图顶开) */}
      <div
        className="flex items-center gap-2 px-3 pt-[max(env(safe-area-inset-top),12px)] pb-2"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="min-w-0 flex-1 truncate text-xs text-white/70">{att.name}</p>
        {transform.scale > MIN_SCALE + 0.001 && (
          <button
            type="button"
            onClick={() => apply(IDENTITY)}
            title="还原大小(双击图片也可)"
            aria-label={`当前缩放 ${transform.scale.toFixed(1)} 倍,点击还原`}
            className="flex h-8 shrink-0 items-center rounded-full px-2.5 text-xs tabular-nums text-white/70 hover:bg-white/10 hover:text-white transition-colors"
          >
            {transform.scale.toFixed(1)}×
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭图片预览"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white/80 hover:bg-white/10 hover:text-white transition-colors"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* 大图区:点图不关(误触率高),点纱面才关;1x 左右滑动换图,放大后拖动平移 */}
      <div
        ref={stageRef}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-3 pb-2"
        style={{ touchAction: 'none' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onClick={(e) => {
          const startedOnImage = pressedImageRef.current
          pressedImageRef.current = false
          // 拖动/捏合松手后浏览器补发的 click、以及图片上起手的 click 不放行,否则会误触纱面关闭
          if (draggedRef.current) {
            draggedRef.current = false
            e.stopPropagation()
            return
          }
          if (startedOnImage) e.stopPropagation()
        }}
        onDoubleClick={(e) => {
          // 空白处双击的第一下已经关闭查看器,能走到这里的只有图片区域
          e.stopPropagation()
          if (transformRef.current.scale > MIN_SCALE + 0.001) apply(IDENTITY)
          else zoomAt(e.clientX, e.clientY, DOUBLE_CLICK_SCALE)
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          key={att.url}
          src={att.url}
          alt={att.name}
          draggable={false}
          className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
          style={{
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
            transformOrigin: 'center center',
            transition: interacting ? 'none' : 'transform 180ms ease-out',
            cursor: transform.scale > MIN_SCALE + 0.001 ? 'grab' : 'zoom-in',
            willChange: 'transform',
          }}
          onClick={(e) => e.stopPropagation()}
        />

        {index > 0 && (
          <button
            type="button"
            aria-label="上一张"
            onClick={(e) => {
              e.stopPropagation()
              onIndexChange(index - 1)
            }}
            className="absolute left-2 top-1/2 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white/80 hover:bg-white/20 hover:text-white transition-colors sm:flex"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
        )}
        {index < images.length - 1 && (
          <button
            type="button"
            aria-label="下一张"
            onClick={(e) => {
              e.stopPropagation()
              onIndexChange(index + 1)
            }}
            className="absolute right-2 top-1/2 hidden h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white/80 hover:bg-white/20 hover:text-white transition-colors sm:flex"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        )}
      </div>

      {/* 底部计数:多图时显示 2 / 3 */}
      {images.length > 1 && (
        <div
          className="pb-[max(env(safe-area-inset-bottom),12px)] text-center text-xs text-white/60"
          onClick={(e) => e.stopPropagation()}
        >
          {index + 1} / {images.length}
        </div>
      )}
    </div>,
    document.body
  )
}
