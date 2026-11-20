'use client'

/**
 * 小鸡事件反应 · 全局浮层宿主(design/preview-chick-reactions.html 形态 A「蜡笔贴纸卡」拍板落码)。
 *
 * **只在监管模式启用**(2026-11-18 用户定案):以 html[data-fl-locked] 为门(FocusLock 设置/移除),
 * 未锁定时业务事件在门口丢弃、正在播的立即收场、开机型问候不做。Tauri 真锁与 ?__flmock=1 均置该属性。
 *
 * 结构:业务流通过 lib/chick/reactions.ts 的 chickPlay() 喊事件 → 本宿主监听总线,
 * 按「每组每日上限 / 全局冷却 / 同事件 30s 去重」裁决后排队播放(一次一张,队满 3 丢弃)。
 * 事件目录/文案/上限口径都在 reactions.ts;这里只管渲染与节奏。
 *
 * 开发验收钩子(仅 development,force 绕过锁门/上限):
 *   ?__chick=wrong      播一次指定事件(无视上限)
 *   ?__chickhold=wrong  静态帧定格(动画全关,道具/哭脸定格直出,截图用)
 *   window.__chick.play(key) / .hold(key) / .dismiss() / .list()
 *
 * 挂载点:(app)/layout.tsx(与 ConfirmDialogHost 同级),登录页不挂。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties } from 'react'
import {
  CHICK_BUS_EVENT,
  CHICK_EVENTS,
  CHICK_GROUP_CAPS,
  type ChickAct,
  type ChickFx,
  type ChickKey,
  type ChickPlayDetail,
  type ChickProp,
  type ChickSpec,
  chickDayGap,
  chickFestivalToday,
  chickGaokaoDays,
  chickToday,
  readStartupFlag,
  writeStartupFlag,
} from '@/lib/chick/reactions'
import s from './ChickReactions.module.css'

/* ── 蛋壳宝宝表情帧(64×64,与 CrayonChick 同一只:身体 #fff0b8 / 描边 #e8a23c) ── */

const CK_LINE = '#e8a23c'
const CK_EYE = '#4a3a28'
const CK_BLUSH = '#ffb3a0'
const CK_BEAK = '#ff9a5c'

const SHELL = (
  <>
    <path
      d="M13.5 44 q4.7 -4.2 9.6 0 q4.9 4.2 9.7 0 q4.7 -4.2 9.6 0 q4.8 4.2 9.6 0 l-.4 6.5 q-.5 6.5 -7.5 6.5 h-22.8 q-7 0 -7.5 -6.5 z"
      fill="#f8efd6"
      stroke={CK_LINE}
      strokeWidth={2.2}
      strokeLinejoin="round"
    />
    <circle cx="26" cy="52" r="1.5" fill={CK_BLUSH} opacity={0.8} />
    <circle cx="37" cy="54" r="1.2" fill="#ffd75e" opacity={0.75} />
  </>
)

const BODY = (
  <>
    <ellipse cx="32" cy="34" rx="18.5" ry="15.5" fill="#fff0b8" />
    <ellipse cx="32" cy="34" rx="18.5" ry="15.5" stroke={CK_LINE} strokeWidth={2.2} fill="none" />
  </>
)

const HANDS_HOLD = (
  <>
    <path d="M13.5 38 q-4.5 1.5 -3 5.5 q1.5 3.5 5.5 3" stroke={CK_LINE} strokeWidth={2} strokeLinecap="round" fill="none" />
    <path d="M50.5 38 q4.5 1.5 3 5.5 q-1.5 3.5 -5.5 3" stroke={CK_LINE} strokeWidth={2} strokeLinecap="round" fill="none" />
  </>
)

const HANDS_UP = (
  <>
    <path d="M15.5 37 q-5.5 -4.5 -3.5 -11" stroke={CK_LINE} strokeWidth={2} strokeLinecap="round" fill="none" />
    <path d="M48.5 37 q5.5 -4.5 3.5 -11" stroke={CK_LINE} strokeWidth={2} strokeLinecap="round" fill="none" />
  </>
)

/** 挥手帧:左手独立 class(动画摆),右手扶壳 */
const WAVE_BODY = (
  <>
    {BODY}
    <path className={s.arm} d="M15.5 37 q-5.5 -4.5 -3.5 -11" stroke={CK_LINE} strokeWidth={2} strokeLinecap="round" fill="none" />
    <path d="M50.5 38 q4.5 1.5 3 5.5 q-1.5 3.5 -5.5 3" stroke={CK_LINE} strokeWidth={2} strokeLinecap="round" fill="none" />
  </>
)

const TUFT_UP = (
  <>
    <path d="M27 18.8 l2.4 -5.8 3 5.2" stroke={CK_LINE} strokeWidth={2.4} strokeLinecap="round" fill="none" />
    <path d="M34.5 18.6 l3.4 -5.6 1.6 6" stroke={CK_LINE} strokeWidth={2.2} strokeLinecap="round" fill="none" />
  </>
)

const TUFT_DROOP = <path d="M28 19.5 q4 -2.5 8 -.5" stroke={CK_LINE} strokeWidth={2.4} strokeLinecap="round" fill="none" />

const BLUSH = (
  <>
    <ellipse cx="20.8" cy="36.5" rx="3.9" ry="2.5" fill={CK_BLUSH} />
    <ellipse cx="43.2" cy="36.5" rx="3.9" ry="2.5" fill={CK_BLUSH} />
  </>
)

type Face = 'happy' | 'smile' | 'omg' | 'sad' | 'sleep' | 'yawn'

const FACES: Record<Face, React.ReactNode> = {
  happy: (
    <>
      <path d="M24.6 32 q2.2 -3.8 4.4 0" stroke={CK_EYE} strokeWidth={2.2} strokeLinecap="round" fill="none" />
      <path d="M35 32 q2.2 -3.8 4.4 0" stroke={CK_EYE} strokeWidth={2.2} strokeLinecap="round" fill="none" />
      <path d="M29.2 36.6 q2.8 .5 5.6 0 q-.5 4.4 -2.8 4.4 q-2.3 0 -2.8 -4.4 z" fill={CK_BEAK} />
    </>
  ),
  smile: (
    <>
      <ellipse cx="26.8" cy="31.2" rx="2.2" ry="2.7" fill={CK_EYE} />
      <circle cx="27.6" cy="30.2" r=".85" fill="#fff" />
      <ellipse cx="37.2" cy="31.2" rx="2.2" ry="2.7" fill={CK_EYE} />
      <circle cx="38" cy="30.2" r=".85" fill="#fff" />
      <path d="M29.7 35.4 q2.4 -2 4.7 0 q-.85 2.5 -2.35 2.5 q-1.5 0 -2.35 -2.5 z" fill={CK_BEAK} />
    </>
  ),
  omg: (
    <>
      <ellipse cx="26.8" cy="31" rx="2.6" ry="3" fill={CK_EYE} />
      <circle cx="27.7" cy="30" r=".85" fill="#fff" />
      <ellipse cx="37.2" cy="31" rx="2.6" ry="3" fill={CK_EYE} />
      <circle cx="38.1" cy="30" r=".85" fill="#fff" />
      <ellipse cx="32" cy="38" rx="2.4" ry="2.8" fill={CK_BEAK} />
    </>
  ),
  sad: (
    <>
      <path d="M24.8 31.6 q2 2.4 4 0" stroke={CK_EYE} strokeWidth={2.2} strokeLinecap="round" fill="none" />
      <path d="M35.2 31.6 q2 2.4 4 0" stroke={CK_EYE} strokeWidth={2.2} strokeLinecap="round" fill="none" />
      <path d="M29.6 39.6 q2.4 -2.6 4.8 0" stroke={CK_BEAK} strokeWidth={2.2} strokeLinecap="round" fill="none" />
    </>
  ),
  sleep: (
    <>
      <path d="M24.8 31.6 h4.2" stroke={CK_EYE} strokeWidth={2.2} strokeLinecap="round" />
      <path d="M35 31.6 h4.2" stroke={CK_EYE} strokeWidth={2.2} strokeLinecap="round" />
      <ellipse cx="32" cy="37.6" rx="1.7" ry="2" fill={CK_BEAK} />
    </>
  ),
  yawn: (
    <>
      <path d="M24.8 31.6 h4.2" stroke={CK_EYE} strokeWidth={2.2} strokeLinecap="round" />
      <path d="M35 31.6 h4.2" stroke={CK_EYE} strokeWidth={2.2} strokeLinecap="round" />
      <ellipse cx="32" cy="38.4" rx="2.5" ry="3.4" fill={CK_BEAK} />
    </>
  ),
}

interface FrameSpec {
  hands: 'hold' | 'up' | 'wave'
  tuft?: boolean
  face: Face
  sink?: boolean
}

/** 每事件的小鸡表情帧(与预览页 SEQ 一一对照) */
const FRAMES: Record<ChickKey, FrameSpec> = {
  correct: { hands: 'hold', face: 'happy' },
  wrong: { hands: 'hold', face: 'omg', sink: true },
  streak3: { hands: 'up', face: 'happy' },
  group: { hands: 'up', face: 'happy' },
  quizSoon: { hands: 'hold', face: 'smile' },
  wordNew: { hands: 'hold', face: 'smile' },
  wordReview: { hands: 'hold', face: 'happy' },
  wrongSaved: { hands: 'hold', face: 'smile' },
  wrongClear: { hands: 'up', face: 'happy' },
  dailyHi: { hands: 'wave', tuft: true, face: 'happy' },
  streakDay: { hands: 'up', face: 'happy' },
  lateNight: { hands: 'hold', tuft: true, face: 'yawn' },
  longAbsent: { hands: 'hold', face: 'happy' },
  planDone: { hands: 'up', face: 'happy' },
  paperReady: { hands: 'hold', face: 'smile' },
  festival: { hands: 'up', face: 'happy' },
  gaokao: { hands: 'hold', face: 'smile' },
}

const ACT_CLS: Record<ChickAct, string> = {
  jump: s.aJump,
  triple: s.aTriple,
  shake: s.aShake,
  sleep: s.aSleep,
  bow: s.aBow,
  wave: s.aWave,
  sad: s.aSad,
}

function ChickFrame({ frame }: { frame: FrameSpec }) {
  if (frame.sink) {
    return (
      <svg className={s.chick} viewBox="0 0 64 64" aria-hidden>
        <g className={s.lower}>
          {BODY}
          <g className={s.fOmg}>
            {TUFT_UP}
            {FACES.omg}
          </g>
          <g className={s.fSad}>
            {TUFT_DROOP}
            {FACES.sad}
          </g>
          {BLUSH}
        </g>
        {SHELL}
      </svg>
    )
  }
  return (
    <svg className={s.chick} viewBox="0 0 64 64" aria-hidden>
      <g className={s.wrapG}>
        {frame.tuft ? TUFT_UP : null}
        {frame.hands === 'wave' ? WAVE_BODY : frame.hands === 'up' ? HANDS_UP : HANDS_HOLD}
        {FACES[frame.face]}
        {BLUSH}
      </g>
      {SHELL}
    </svg>
  )
}

/* ── 特效层(参数内联,节奏与预览页一致) ── */

const FX_DELAY = [0.15, 0.3, 0.45, 0.55, 0.62, 0.7, 0.78, 0.85]
const FX_ML = [0, -46, 44, -76, 74, -24, 22, 0]

function fxd(dx: number, dy: number, dr: number): CSSProperties {
  return { '--dx': `${dx}px`, '--dy': `${dy}px`, '--dr': `${dr}deg` } as CSSProperties
}

function FxLayer({ kind }: { kind: ChickFx }) {
  const spans: { style: CSSProperties; star?: boolean }[] = []
  if (kind === 'star1') {
    spans.push({ style: { ...fxd(2, -56, 120), color: '#f5b93c', fontSize: 15, animationDelay: '.15s' }, star: true })
  } else if (kind === 'star3') {
    spans.push(
      { style: { ...fxd(-8, -62, 90), color: '#f5b93c', fontSize: 15, animationDelay: '.25s', marginLeft: -44 }, star: true },
      { style: { ...fxd(-2, -50, -60), color: '#f28a9b', fontSize: 12, animationDelay: '.85s', marginLeft: 42 }, star: true },
      { style: { ...fxd(6, -58, 150), color: '#f5b93c', fontSize: 15, animationDelay: '1.45s', marginLeft: 0 }, star: true }
    )
  } else if (kind === 'confetti') {
    const colors = ['#f28a9b', '#8fb96e', '#7da7d9', '#f5b93c', '#c9a0dc', '#e8825c', '#8fb96e', '#f5b93c']
    const dxs = [-30, -72, -52, 6, 58, 30, -6, 80]
    const dys = [-64, -40, -84, -70, -46, -88, -58, -30]
    const drs = [140, -90, 200, -160, 120, -80, 180, -120]
    colors.forEach((c, i) =>
      spans.push({
        style: {
          ...fxd(dxs[i], dys[i], drs[i]),
          width: 7,
          height: 10,
          borderRadius: 2,
          background: c,
          animationDelay: `${FX_DELAY[i]}s`,
          marginLeft: FX_ML[i],
          ...(i === 7 ? { marginTop: -40 } : {}),
        },
      })
    )
  } else if (kind === 'sticker') {
    const cs: [string, string][] = [
      ['#ffe9a8', '#e8a23c'],
      ['#dcebf7', '#7da7d9'],
      ['#fde3ea', '#f28a9b'],
    ]
    const dxs = [-46, 2, 50]
    const dys = [-58, -72, -50]
    const drs = [-120, 150, -80]
    cs.forEach((c, i) =>
      spans.push({
        style: {
          ...fxd(dxs[i], dys[i], drs[i]),
          width: 11,
          height: 13,
          background: c[0],
          border: `1.5px solid ${c[1]}`,
          animationDelay: `${FX_DELAY[i]}s`,
          marginLeft: FX_ML[i],
        },
      })
    )
  } else if (kind === 'ribbon') {
    const colors = ['#f28a9b', '#8fb96e', '#7da7d9', '#f5b93c', '#c9a0dc', '#e8825c']
    const dxs = [-64, -30, 8, 40, 70, -6]
    const dys = [-78, -56, -84, -50, -70, -40]
    const drs = [220, -180, 260, -220, 200, -160]
    colors.forEach((c, i) =>
      spans.push({
        style: {
          ...fxd(dxs[i], dys[i], drs[i]),
          width: 4,
          height: 17,
          borderRadius: 2,
          background: c,
          animationDelay: `${FX_DELAY[i]}s`,
          marginLeft: FX_ML[i],
        },
      })
    )
  }
  return (
    <div className={s.fx} aria-hidden>
      {spans.map((sp, i) =>
        sp.star ? (
          <span key={i} style={sp.style}>
            ★
          </span>
        ) : (
          <span key={i} style={sp.style} />
        )
      )}
    </div>
  )
}

/* ── 宿主 ── */

interface Payload {
  key: ChickKey
  spec: ChickSpec
  vars?: Record<string, string | number>
}

const CKR_CAPS_KEY = 'chick-caps'
/** 全局冷却:任意两次弹出的最小间隔 */
const COOLDOWN_MS = 3000
/** 同事件去重窗口 */
const DEDUP_MS = 30_000
/** 入场时长(act 起拍点),与 CSS .enter 过程一致 */
const ENTER_MS = 430
/** 退场时长 */
const LEAVE_MS = 300
/** 队列上限(超出丢弃) */
const QUEUE_MAX = 3

function loadCaps(today: string): { date: string; counts: [number, number, number, number] } {
  try {
    const raw = window.localStorage.getItem(CKR_CAPS_KEY)
    if (raw) {
      const obj = JSON.parse(raw) as { date?: string; counts?: number[] }
      if (obj.date === today && obj.counts?.length === 4) {
        return { date: today, counts: obj.counts as [number, number, number, number] }
      }
    }
  } catch {
    /* ignore */
  }
  return { date: today, counts: [0, 0, 0, 0] }
}

function hiText(h: number): string {
  if (h < 11) return '早安!今天也一起加油呀'
  if (h < 14) return '午安!歇好了再战'
  if (h < 18) return '下午好!今天学了多少啦'
  return '晚上好!今天也辛苦啦'
}

export function ChickReactions() {
  const [mounted, setMounted] = useState(false)
  const [ev, setEv] = useState<Payload | null>(null)
  const [shown, setShown] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'enter' | 'act' | 'leave'>('idle')
  const [hold, setHold] = useState(false)
  const [fxon, setFxon] = useState(false)

  const queueRef = useRef<Payload[]>([])
  const busyRef = useRef(false)
  const timersRef = useRef<number[]>([])
  const lastAtRef = useRef(0)
  const lastKeyRef = useRef<{ key: ChickKey; at: number } | null>(null)
  const capsRef = useRef<{ date: string; counts: [number, number, number, number] } | null>(null)
  /** 监管模式锁门:html[data-fl-locked] 在位才放行(用户定案:浮层只在监管模式启用) */
  const lockedRef = useRef(false)

  useEffect(() => setMounted(true), [])

  const clearTimers = useCallback(() => {
    timersRef.current.forEach((t) => window.clearTimeout(t))
    timersRef.current = []
  }, [])

  /** 锁门关闭(解锁):队列清空、正在播的立即收场 */
  const flushOnUnlock = useCallback(() => {
    clearTimers()
    queueRef.current = []
    busyRef.current = false
    setEv(null)
    setShown(false)
    setPhase('idle')
    setHold(false)
    setFxon(false)
  }, [clearTimers])

  // 跟随 FocusLock 的 data-fl-locked 属性(锁定/解锁都可能发生在任意时刻)
  useEffect(() => {
    const el = document.documentElement
    lockedRef.current = el.hasAttribute('data-fl-locked')
    const obs = new MutationObserver(() => {
      const locked = el.hasAttribute('data-fl-locked')
      if (lockedRef.current && !locked) flushOnUnlock()
      lockedRef.current = locked
    })
    obs.observe(el, { attributes: true, attributeFilter: ['data-fl-locked'] })
    return () => obs.disconnect()
  }, [flushOnUnlock])

  /** 上限/冷却/去重/锁门裁决;通过返回 payload 并记账,拒绝返回 null */
  const consume = useCallback((key: ChickKey, force: boolean, vars?: Record<string, string | number>): Payload | null => {
    const spec = CHICK_EVENTS[key]
    if (!spec) return null
    if (!force) {
      // 只在监管模式启用:未锁定时业务事件一律不弹
      if (!lockedRef.current) return null
      const now = Date.now()
      if (now - lastAtRef.current < COOLDOWN_MS) return null
      if (lastKeyRef.current && lastKeyRef.current.key === key && now - lastKeyRef.current.at < DEDUP_MS) return null
      const today = chickToday()
      if (!capsRef.current || capsRef.current.date !== today) capsRef.current = loadCaps(today)
      if (capsRef.current.counts[spec.group] >= CHICK_GROUP_CAPS[spec.group]) return null
      capsRef.current.counts[spec.group] += 1
      try {
        window.localStorage.setItem(CKR_CAPS_KEY, JSON.stringify(capsRef.current))
      } catch {
        /* ignore */
      }
      lastAtRef.current = now
      lastKeyRef.current = { key, at: now }
    }
    return { key, spec, vars }
  }, [])

  const playNext = useCallback(() => {
    const next = queueRef.current.shift()
    if (next) show(next, false)
    else {
      busyRef.current = false
      setEv(null)
      setShown(false)
      setPhase('idle')
      setHold(false)
      setFxon(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const show = useCallback(
    (p: Payload, staticHold: boolean) => {
      clearTimers()
      busyRef.current = true
      setHold(staticHold)
      setEv(p)
      setFxon(false)
      if (staticHold) {
        setShown(true)
        setPhase('idle')
        return
      }
      setShown(false)
      setPhase('idle')
      const hold = p.spec.hold ?? 1500
      // 双 rAF:让 idle 态(屏外)先落一帧,再加 show/enter 触发滑入过渡
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          setShown(true)
          setPhase('enter')
          if (p.spec.fx) setFxon(true)
        })
      )
      timersRef.current.push(window.setTimeout(() => setPhase('act'), ENTER_MS))
      timersRef.current.push(window.setTimeout(() => setPhase('leave'), ENTER_MS + hold))
      timersRef.current.push(window.setTimeout(() => playNext(), ENTER_MS + hold + LEAVE_MS))
    },
    [clearTimers, playNext]
  )

  const enqueue = useCallback(
    (p: Payload) => {
      if (busyRef.current) {
        if (queueRef.current.length < QUEUE_MAX) queueRef.current.push(p)
        return
      }
      show(p, false)
    },
    [show]
  )

  /* 总线监听 */
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<ChickPlayDetail>).detail
      if (!d) return
      const p = consume(d.key, !!d.force, d.vars)
      if (p) enqueue(p)
    }
    window.addEventListener(CHICK_BUS_EVENT, on)
    return () => window.removeEventListener(CHICK_BUS_EVENT, on)
  }, [consume, enqueue])

  /* 开机型事件(每次硬加载最多弹一条,优先级从上到下)+ 开发验收参数 */
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (process.env.NODE_ENV === 'development') {
        const sp = new URLSearchParams(window.location.search)
        const demoKey = sp.get('__chick') as ChickKey | null
        const holdKey = sp.get('__chickhold') as ChickKey | null
        if (holdKey && CHICK_EVENTS[holdKey]) {
          const p = consume(holdKey, true, holdKey === 'gaokao' ? { days: chickGaokaoDays() } : undefined)
          if (p) show(p, true)
          return
        }
        if (demoKey && CHICK_EVENTS[demoKey]) {
          const p = consume(demoKey, true, demoKey === 'gaokao' ? { days: chickGaokaoDays() } : undefined)
          if (p) enqueue(p)
          return
        }
      }

      // 只在监管模式启用:未锁定时不做开机型问候(lastDay 不推进,久未回访按「久未锁着学习」算)
      if (!lockedRef.current) return

      const today = chickToday()
      const flag = readStartupFlag()
      const gap = flag.lastDay ? chickDayGap(flag.lastDay, today) : 0
      const firedToday = (k: string) => flag.fired[k] === today
      const h = new Date().getHours()

      let pick: { key: ChickKey; vars?: Record<string, string | number> } | null = null
      if (gap >= 7 && !firedToday('longAbsent')) pick = { key: 'longAbsent' }
      else if ((h >= 23 || h < 5) && !firedToday('lateNight')) pick = { key: 'lateNight', vars: { hour: h } }
      else {
        const fest = chickFestivalToday()
        const gd = chickGaokaoDays()
        if (fest && !firedToday('festival')) pick = { key: 'festival', vars: { hi: fest } }
        else if (gd >= 1 && gd <= 100 && !firedToday('gaokao')) pick = { key: 'gaokao', vars: { days: gd } }
        else if (!firedToday('dailyHi')) pick = { key: 'dailyHi', vars: { hi: hiText(h) } }
      }

      if (pick) flag.fired[pick.key] = today
      writeStartupFlag({ lastDay: today, fired: flag.fired })
      if (pick) {
        const p = consume(pick.key, false, pick.vars)
        if (p) enqueue(p)
      }
    }, 900)
    return () => window.clearTimeout(t)
  }, [consume, enqueue, show])

  /* 开发钩子 */
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return
    ;(window as unknown as { __chick?: unknown }).__chick = {
      play: (key: ChickKey, vars?: Record<string, string | number>) => {
        const p = consume(key, true, vars)
        if (p) enqueue(p)
      },
      hold: (key: ChickKey, vars?: Record<string, string | number>) => {
        const p = consume(key, true, vars)
        if (p) show(p, true)
      },
      dismiss: () => {
        clearTimers()
        queueRef.current = []
        busyRef.current = false
        setEv(null)
        setShown(false)
        setPhase('idle')
        setHold(false)
        setFxon(false)
      },
      list: () => Object.keys(CHICK_EVENTS),
    }
  }, [consume, enqueue, show, clearTimers])

  useEffect(
    () => () => {
      clearTimers()
    },
    [clearTimers]
  )

  if (!mounted || !ev) return null

  const text = ev.spec.text(ev.vars)
  const actCls = !hold && (phase === 'act' || phase === 'leave') ? ACT_CLS[ev.spec.act] : ''
  const signText = ev.key === 'gaokao' ? `距高考 ${ev.vars?.days ?? 0} 天` : ''
  const propEl = (p: ChickProp) => {
    if (p === 'book')
      return (
        <div className={`${s.prop} ${s.pBook}`}>
          <i />
          <i />
        </div>
      )
    if (p === 'paper')
      return (
        <div className={`${s.prop} ${s.pPaper}`}>
          <i />
          <i />
          <i />
        </div>
      )
    return (
      <div className={`${s.prop} ${s.pSign}`} aria-hidden>
        {signText}
      </div>
    )
  }

  const rootCls = [
    s.pop,
    shown && !hold && s.show,
    shown && hold && `${s.show} ${s.hold}`,
    !hold && phase === 'enter' && s.enter,
    !hold && phase === 'leave' && s.leave,
    actCls,
    fxon && s.fxon,
  ]
    .filter(Boolean)
    .join(' ')

  return createPortal(
    <div className={rootCls} role="status" aria-live="polite">
      <div className={s.card}>
        <ChickFrame frame={FRAMES[ev.key]} />
        <div className={s.bubble}>{text}</div>
        {ev.spec.prop ? propEl(ev.spec.prop) : null}
        {ev.key === 'lateNight' && (
          <>
            <span className={s.zzz}>Z</span>
            <span className={`${s.zzz} ${s.z2}`} style={{ animationDelay: '.85s' }}>
              Z
            </span>
            <span className={`${s.zzz} ${s.z3}`} style={{ animationDelay: '1.7s' }}>
              Z
            </span>
          </>
        )}
      </div>
      {ev.spec.fx ? <FxLayer kind={ev.spec.fx} /> : null}
    </div>,
    document.body
  )
}
