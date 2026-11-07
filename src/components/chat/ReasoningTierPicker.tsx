'use client'

/**
 * 推理强度选择器(触发胶囊 + 面板 + 滑杆 + 最高档充能流)。
 * 定稿自 public/preview-reasoning-tier.html「A 充能流」。
 *
 * 第一波范围:所有模型都只有 2 段(标准 / MAX),直接映射现有 deepThink boolean,
 * 不碰请求管线。多档(GPT/Gemini 真 4 档)留到第二波引入 reasoningControl 字段后再做。
 * 粒子流用 WAAPI 驱动:进最高档那一刻 playbackRate 冲 2.8×,再 520ms easeOut 回落 1×,
 * 只在「面板打开 + 最高档」时运行(关闭即停,省 CPU)。
 */
import { useState, useRef, useEffect, useCallback } from 'react'
import { Brain, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

const TIERS = ['标准', 'MAX']
const N = TIERS.length
const PARTICLE_COUNT = 16

export function ReasoningTierPicker({
  deepThink,
  onDeepThinkChange,
  modelName,
  disabled,
  className,
}: {
  deepThink: boolean
  onDeepThinkChange: (enabled: boolean) => void
  modelName?: string
  disabled?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const tierIdx = deepThink ? N - 1 : 0
  const atMax = tierIdx === N - 1

  const sliderRef = useRef<HTMLDivElement>(null)
  const burstRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const flowingRef = useRef(false)
  const surgeRafRef = useRef<number | null>(null)
  const draggingRef = useRef(false)

  const t = N === 1 ? 0 : tierIdx / (N - 1)
  const pos = `calc(16px + (100% - 32px) * ${t})`

  const stopFlow = useCallback(() => {
    flowingRef.current = false
    if (surgeRafRef.current) { cancelAnimationFrame(surgeRafRef.current); surgeRafRef.current = null }
    if (burstRef.current) burstRef.current.innerHTML = ''
  }, [])

  // 刚进最高档的冲刺:全体粒子先冲 2.8×,再 easeOutCubic 回落 1×(520ms)
  const surge = useCallback(() => {
    const burst = burstRef.current
    if (!burst) return
    if (surgeRafRef.current) cancelAnimationFrame(surgeRafRef.current)
    const anims = burst.getAnimations({ subtree: true })
    if (!anims.length) return
    const FROM = 2.8, DUR = 520, t0 = performance.now()
    anims.forEach((a) => { a.playbackRate = FROM })
    const tick = (now: number) => {
      if (!flowingRef.current) { anims.forEach((a) => { a.playbackRate = 1 }); surgeRafRef.current = null; return }
      const p = Math.min(1, (now - t0) / DUR)
      const eased = 1 - Math.pow(1 - p, 3)
      anims.forEach((a) => { a.playbackRate = FROM + (1 - FROM) * eased })
      if (p < 1) surgeRafRef.current = requestAnimationFrame(tick)
      else { anims.forEach((a) => { a.playbackRate = 1 }); surgeRafRef.current = null }
    }
    surgeRafRef.current = requestAnimationFrame(tick)
  }, [])

  const startFlow = useCallback(() => {
    const burst = burstRef.current
    if (!burst || flowingRef.current) return
    flowingRef.current = true
    burst.innerHTML = ''
    for (let k = 0; k < PARTICLE_COUNT; k++) {
      const el = document.createElement('i')
      const depth = Math.random()               // 0 远 .. 1 近
      const w = 3 + depth * 5
      const dur = 2.7 - depth * 1.3             // 近处更快
      el.style.width = `${w}px`
      el.style.height = `${w}px`
      el.style.setProperty('--o', (0.72 + depth * 0.28).toFixed(2))
      el.style.top = `${16 + Math.random() * 68}%`
      // 负延迟:粒子一进最高档就均匀铺满整条,不会先空一段再冒
      el.style.animationDelay = `${-Math.random() * dur}s, ${-Math.random() * 1.7}s`
      el.style.animationDuration = `${dur}s, ${0.9 + Math.random() * 0.8}s`
      burst.appendChild(el)
    }
  }, [])

  // 粒子流只在「面板打开 + 最高档」时运行;开面板即冲一次。
  // surge 延后一帧:startFlow 刚 appendChild 的 <i> 其 CSS 动画要等一次样式重算才注册,
  // 同步调 getAnimations 会拿到空数组导致冲刺静默失效。
  useEffect(() => {
    if (open && atMax) {
      startFlow()
      const id = requestAnimationFrame(() => surge())
      return () => cancelAnimationFrame(id)
    }
    stopFlow()
  }, [open, atMax, startFlow, stopFlow, surge])

  // 卸载清理 rAF
  useEffect(() => () => {
    if (surgeRafRef.current) cancelAnimationFrame(surgeRafRef.current)
  }, [])

  // 点外部关闭:胶囊所在输入区有 backdrop-blur/transform 祖先,组件内 fixed 遮罩会被
  // 困在该祖先盒内盖不住整屏,故改用 document 捕获阶段 pointerdown + 子树判外点。
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open])

  const idxFromX = useCallback((clientX: number) => {
    const r = sliderRef.current?.getBoundingClientRect()
    if (!r) return tierIdx
    const tt = Math.min(1, Math.max(0, (clientX - r.left - 16) / (r.width - 32)))
    return Math.round(tt * (N - 1))
  }, [tierIdx])

  const applyFromX = useCallback((clientX: number) => {
    onDeepThinkChange(idxFromX(clientX) === N - 1)
  }, [idxFromX, onDeepThinkChange])

  useEffect(() => {
    const move = (e: PointerEvent) => { if (draggingRef.current) applyFromX(e.clientX) }
    const up = () => { draggingRef.current = false }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  }, [applyFromX])

  return (
    <div ref={wrapRef} className={cn('relative hidden sm:block', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className={cn('rt-trigger', open && 'open', deepThink && 'on')}
        title="推理强度(思考深度)"
        aria-label="推理强度"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-pressed={deepThink}
      >
        <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: 'absolute' }}>
          {/* 与 --slider-grad 同色的渐变,供 MAX 档脑图标描边 stroke=url(#rt-grad) 用 */}
          <defs>
            <linearGradient id="rt-grad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#f472b6" />
              <stop offset="50%" stopColor="#c084fc" />
              <stop offset="100%" stopColor="#818cf8" />
            </linearGradient>
          </defs>
        </svg>
        <Brain className="w-3.5 h-3.5 rt-ico-brain" />
        <span className="rt-val">{TIERS[tierIdx]}</span>
        <ChevronDown className="rt-chev" />
      </button>

      <div className={cn('rt-panel', open && 'show')} role="menu">
        <div className="rt-head">
          <span className="rt-ico"><Brain /></span>
          <div className={cn('rt-title', atMax && 'max')}>{TIERS[tierIdx]}</div>
          <div className="rt-model">{modelName ?? '推理强度'}</div>
        </div>
        <div
          ref={sliderRef}
          className={cn('rt-slider', atMax && 'at-max')}
          onPointerDown={(e) => { draggingRef.current = true; applyFromX(e.clientX) }}
        >
          <div className="rt-track">
            <div className="rt-fill" style={{ width: pos }} />
            <div className="rt-burst" ref={burstRef} />
          </div>
          <div className="rt-ticks">{TIERS.map((_, i) => <i key={i} />)}</div>
          <div className="rt-thumb" style={{ left: pos }} />
        </div>
      </div>
    </div>
  )
}
