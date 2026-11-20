'use client'

/**
 * 桌面小鸡 · /pet 路由:由 Tauri pet 窗(440×176,透明置顶)加载,沿任务栏上沿生活。
 *
 * 移动大脑:140ms 一拍(JS 驱动,CSS 只做 140ms 线性过渡平滑)。
 *   - 巡游:来回散步,端点/随机小停
 *   - 吸引:光标进窝边(含窗口上方 170px)稳定 2 拍 → 凑到光标跟前蹭蹭头;睡着被盯会醒
 *   - 躲避:30s 内被摸 3 次,第 4 次摸 → 快步走开
 *   - 打盹/站岗/被拎起/表演中 → 不挪窝
 *
 * 按压状态机(mousedown 起):
 *   - 移动 ≥5px → 拎起扑腾 + 拖拽窗(Tauri)
 *   - 按住 ≥600ms 不动 → 摸头(眯 happy 眼 + 蹭);30s 内摸满 3 次触发躲避
 *   - 松开(未移动) → 点击反应池:叽 / 歪头 / 抖毛 随机;1.5s 内点满 3 次 → 急眼缩壳;
 *     站岗中 → 摇头拒绝;夜里(按下前在睡) → 打哈欠轻醒
 *   - 双击 → 开主窗
 *
 * 事件来自主窗 lib/chick/reactions.ts chickPlay() 的 pet-event 广播(带文案),
 * 本侧 8s 冷却 + 同事件 30s 去重;完成类事件在右侧攒蛋(localStorage 持久)。
 * 自娱小剧场:无聊(空闲 ≥30s + 掷骰,日上限 3 次,白天+非站岗)看到天上有鸟 →
 *   追跑避障 3~10s,追到攒蛋、没追到目送;摸/拎/事件反应/报时/锁屏/夜里 → 立即让位。
 * 问候:定时时刻表(早安/午安/晚上好/晚安,每类每天一次)+ 今日首点补问候;
 * 节日/高考倒计时复用 reactions.ts 现成函数;计划到点提醒轮询 /api/plan/items。
 * 点击穿透:整窗默认穿透,130ms 轮询 pet_probe,光标落在小鸡/菜单上才收穿透。
 *
 * 预览/验收钩子(development):
 *   ?__pet=night|day   锁定时段        ?__petstill=1   动画全关(截图)
 *   ?__petevt=hop1     载入后直演一个动作   ?__petlock=1  强制监管执勤态
 *   window.__pet.act('pat模拟不了(按压态)') / .egg() / .probe() / .chase() / .report().chase
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow, LogicalPosition, LogicalSize } from '@tauri-apps/api/window'
import { chickFestivalToday, chickGaokaoDays, chickHiText, chickToday, type ChickKey } from '@/lib/chick/reactions'
import s from './pet.module.css'

interface PetProbe {
  cx: number
  cy: number
  wx: number
  wy: number
  ww: number
  wh: number
  scale: number
}
/** perf_probe 返回:占用率百分比 + GPU 温度(非 NVIDIA 为 null) */
type Perf1 = { cpu: number; mem: number; gpu: number | null; gpuTemp: number | null }

interface PetEventDetail {
  key: ChickKey
  vars?: Record<string, string | number>
  /** 事件文案(主窗 spec.text 带过来),小鸡气泡直接有嘴 */
  text?: string
  /** 硬事件(主窗失焦时已另发系统通知;pet 侧照常气泡) */
  hard?: boolean
}

/** 执勤小报告:监管模式悬停小鸡,拽上来一张今日学习报告 */
interface ReportRow {
  id: string
  title: string
  done: boolean
  time: string
  past: boolean
  now: boolean
  /** 已顺延次数:顺延时 +1,复习规则里 ≥2 会提示拆小 */
  postponeCount: number
}
interface ReportData {
  goals: ReportRow[]
  plans: ReportRow[]
  doneCount: number
  total: number
  empty: boolean
}
/** 纸条区额外长高的逻辑高度(窗口 176 → 496) */
const REPORT_EXTRA = 320

/** 举牌:时间压力三态(挑稿定稿:黄/橙/红) */
type SignVariant = 'plain' | 'warn' | 'bad'
interface SignState {
  variant: SignVariant
  title: string
  sub: string
  /** 牌面小角标:计划牌不带,复习牌带「复习」书签 */
  tag?: 'review'
}
/** 举牌停留时长 */
const SIGN_MS = 6000

type Act =
  | 'hop1'
  | 'hop3'
  | 'sad'
  | 'wave'
  | 'chirp'
  | 'flail'
  | 'curious'
  | 'shiver'
  | 'shake'
  | 'yawn'
  /** 催促:身体前倾、双翅连拍(复习积压时) */
  | 'urge'
  /** 跺脚:原地跺三下 + 皱眉(复习拖太久时) */
  | 'stomp'
/** 每个动作的表演时长(与 pet.module.css keyframes 对齐,播完摘类回摇摆) */
const ACT_MS: Record<Act, number> = {
  hop1: 1400,
  hop3: 1800,
  sad: 2600,
  wave: 1800,
  chirp: 1050,
  flail: 2600,
  curious: 1000,
  shiver: 900,
  shake: 900,
  yawn: 1150,
  urge: 1700,
  stomp: 1500,
}
/** 事件 → 动作;完成类顺带攒蛋 */
const ACT_OF: Partial<Record<ChickKey, Act>> = {
  correct: 'hop1',
  streak3: 'hop3',
  group: 'hop1',
  wordReview: 'hop1',
  wrongClear: 'hop1',
  planDone: 'hop1',
  streakDay: 'hop3',
  dailyHi: 'wave',
  longAbsent: 'wave',
  festival: 'hop3',
  wrong: 'sad',
}
const EGG_KEYS: ReadonlySet<ChickKey> = new Set<ChickKey>(['planDone', 'group', 'wrongClear', 'streakDay'])

const EGGS_KEY = 'pet-eggs'
const POS_KEY = 'pet-pos'
const EGG_MAX = 99
const EGG_SHOW = 5
const COOL_MS = 8000
const DEDUP_MS = 30_000
/** 漫步道逻辑宽度(mover translateX 范围) */
const WALK_MIN = 4
const WALK_MAX = 268
const CHICK_HALF = 37

/* ── 撸过头小剧场:连摸 N 次气成红蛋,红蛋期躲手 ──
   与性能过载蛋(HotEgg:橙红+蒸汽+裂纹+指标字)刻意区分:玫红肤 + 怒气眉 + 鼓腮,不冒热气。 */
const ANGRY_PATS = 4
/** 两次摸头间隔超过它,连续计数清零(歇一会儿就消气) */
const ANGRY_GAP_MS = 10_000
/** 红蛋期:期间靠近就跑、点它就弹开;结束后先"试探"一次再恢复 */
const ANGRY_MS = 45_000
/** 感应距离(窗口逻辑坐标) */
const ANGRY_SENSE = 150
/** 每拍(140ms)位移 ≈ 143px/s,远快于光标吸引的 6px/拍 */
const ANGRY_STEP = 20
/** 贴边被逼时跳换边的冷却 */
const ANGRY_LEAP_GAP = 1700
/** 右键横幅菜单宽(实测 ~215px):宽侧避让夹窗内时用 */
const MENU_W = 216

/* ── 自娱小剧场:无聊时追鸟避障(自己玩 3~10s,日上限防腻;样式源 design/preview-chick-chase.html) ── */
const CHASE_KEY = 'chick-pet-chase'
const CHASE_IDLE_MS = 30_000
const CHASE_MAX_DAY = 3
/** 鸟常速(px/s)与飞行高度(窗口顶往下);追速 9.0px/拍(≈64px/s)略快于鸟,距离缓收 */
const CHASE_BIRD_V = 62
const CHASE_BIRD_Y = 26
/** 障碍 left 池(鸡可达跑道内;dir 反向时按 440 镜像) */
const CHASE_ROCK_XS = [96, 168, 240]

function loadEggs(): number {
  try {
    const n = Number(window.localStorage.getItem(EGGS_KEY))
    return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), EGG_MAX) : 0
  } catch {
    return 0
  }
}

/* ── 问候时刻表(每类每天最多一次;pet-greet 落 localStorage) ── */

const GREET_KEY = 'chick-pet-greet'
interface GreetFlag {
  date: string
  fired: Record<string, string>
}

function loadGreet(): GreetFlag {
  try {
    const raw = window.localStorage.getItem(GREET_KEY)
    if (raw) {
      const o = JSON.parse(raw) as Partial<GreetFlag>
      if (o.date && o.fired) return { date: o.date, fired: o.fired }
    }
  } catch {
    /* ignore */
  }
  return { date: '', fired: {} }
}

function saveGreet(f: GreetFlag) {
  try {
    window.localStorage.setItem(GREET_KEY, JSON.stringify(f))
  } catch {
    /* ignore */
  }
}

/* ── 计划到点提醒(已提醒 id 按日记账) ── */

const REMIND_KEY = 'chick-pet-remind'
interface RemindFlag {
  date: string
  ids: Record<string, string>
}

function loadRemind(): RemindFlag {
  try {
    const raw = window.localStorage.getItem(REMIND_KEY)
    if (raw) {
      const o = JSON.parse(raw) as Partial<RemindFlag>
      if (o.date && o.ids) return { date: o.date, ids: o.ids }
    }
  } catch {
    /* ignore */
  }
  return { date: '', ids: {} }
}

function saveRemind(f: RemindFlag) {
  try {
    window.localStorage.setItem(REMIND_KEY, JSON.stringify(f))
  } catch {
    /* ignore */
  }
}

/* ── 复习到期举牌账本(一天最多 3 次 / 30 分钟冷却) ── */

const REVIEW_KEY = 'chick-pet-review'
interface ReviewFlag {
  date: string
  count: number
  lastAt: number
}

function loadReviewFlag(): ReviewFlag {
  try {
    const raw = window.localStorage.getItem(REVIEW_KEY)
    if (raw) {
      const o = JSON.parse(raw) as Partial<ReviewFlag>
      if (typeof o.date === 'string') {
        return { date: o.date, count: Number(o.count) || 0, lastAt: Number(o.lastAt) || 0 }
      }
    }
  } catch {
    /* ignore */
  }
  return { date: '', count: 0, lastAt: 0 }
}

function saveReviewFlag(f: ReviewFlag) {
  try {
    window.localStorage.setItem(REVIEW_KEY, JSON.stringify(f))
  } catch {
    /* ignore */
  }
}

/* ── 自娱小剧场记账:{date, n, on};on 缺省视为开(开关 UI 随菜单升级轮再接) ── */

interface ChaseFlag {
  date: string
  n: number
  on?: boolean
}

/** spot=看见鸟一愣;run=追跑避障;settle=结局结算(idle=没在玩) */
type ChasePhase = 'idle' | 'spot' | 'run' | 'settle'
interface ChaseRock {
  /** 障碍 left(窗口逻辑坐标) */
  x: number
  shown: boolean
  jumped: boolean
}

function loadChase(): ChaseFlag {
  try {
    const raw = window.localStorage.getItem(CHASE_KEY)
    if (raw) {
      const o = JSON.parse(raw) as Partial<ChaseFlag>
      if (o.date && typeof o.n === 'number') return { date: o.date, n: o.n, on: o.on }
    }
  } catch {
    /* ignore */
  }
  return { date: '', n: 0 }
}

function saveChase(f: ChaseFlag) {
  try {
    window.localStorage.setItem(CHASE_KEY, JSON.stringify(f))
  } catch {
    /* ignore */
  }
}

export default function PetPage() {
  const [night, setNight] = useState(false)
  const [still, setStill] = useState(false)
  const [locked, setLocked] = useState(false)
  const [act, setAct] = useState<Act | null>(null)
  const [asleep, setAsleep] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [patting, setPatting] = useState(false)
  const [nuzzling, setNuzzling] = useState(false)
  /** 撸过头气成红蛋(连摸 4 次):红蛋期躲手,不进其它动作 */
  const [angry, setAngry] = useState(false)
  const [reportPhase, setReportPhase] = useState<'closed' | 'pulling' | 'open'>('closed')
  const [reportData, setReportData] = useState<ReportData | null>(null)
  /** 举牌:到点/濒临/逾期三态 */
  const [sign, setSign] = useState<SignState | null>(null)
  /** 逾期盯人:举过红牌后小鸡皱眉(与执勤装共用 brows) */
  const [overdue, setOverdue] = useState(false)
  const [eggs, setEggs] = useState(0)
  const [bubble, setBubble] = useState<string | null>(null)
  const [menu, setMenu] = useState(false)
  /** 横幅菜单位置与展开起点:打开时按鸡头居中算(默认 = 原 CSS fallback) */
  const [menuLeft, setMenuLeft] = useState(108)
  const [menuOrigin, setMenuOrigin] = useState<'left bottom' | 'right bottom'>('left bottom')
  /** 整点报时横幅(2026-11-20 用户挑 A 案):时刻 + 摆放方向(右/左/头顶自动避让) */
  const [chimeBanner, setChimeBanner] = useState<{ label: string; side: 'right' | 'left' | 'top' } | null>(null)
  /** 性能采样(仅 Tauri):3s 一次,驱动过热档位与红蛋 */
  const [perf, setPerf] = useState<Perf1 | null>(null)
  /** 性能角标常驻开关(localStorage 记忆) */
  const [hudOn, setHudOn] = useState(false)
  /** 角标横幅摆位:右侧贴鸡 → 放不下翻左侧 */
  const [hudSide, setHudSide] = useState<'right' | 'left'>('right')
  /** 量角标实际宽度用(随温度有值/无值变化) */
  const hudRef = useRef<HTMLDivElement | null>(null)
  /** 过热缩回红蛋(≥95% 持续 3s 触发,60s 冷却) */
  const [eggMode, setEggMode] = useState(false)
  const [hatching, setHatching] = useState(false)
  /** 终极形态:CPU 与内存同时 ≥85% → 熔岩蛋,优先级压过所有档位 */
  const [ultimate, setUltimate] = useState(false)

  const chickRef = useRef<HTMLDivElement | null>(null)
  const moverRef = useRef<HTMLDivElement | null>(null)
  const actTimerRef = useRef<number>(0)
  const actRef = useRef<Act | null>(null)
  const lastActAtRef = useRef(0)
  const lastKeyRef = useRef<{ key: ChickKey; at: number } | null>(null)
  /** 按压统一状态:拎起 / 摸头 / 点击都从这里分流 */
  const pressRef = useRef({ down: false, x: 0, y: 0, moved: false, patTimer: 0, wasAsleep: false })
  const pattingRef = useRef(false)
  const clickTimesRef = useRef<number[]>([])
  /** 连续摸头记账 + 红蛋计时/躲避节流 */
  const angryRef = useRef(false)
  const angryUntilRef = useRef(0)
  const angryJoltRef = useRef({ until: 0, dir: 1 })
  const patStreakRef = useRef(0)
  const lastPatAtRef = useRef(0)
  const forgivingRef = useRef(false)
  const leapUntilRef = useRef(0)
  const leapReadyRef = useRef(0)
  const sidestepAtRef = useRef(0)
  const clickThroughRef = useRef(false)
  const menuRef = useRef(false)
  /** 右键让位等待:鸡居中放不下横幅时,等它退到安全位再展开(60ms 轮询 + 1.5s 超时兜底) */
  const menuWaitRef = useRef(0)
  const menuWaitDeadlineRef = useRef(0)
  useEffect(
    () => () => {
      if (menuWaitRef.current) window.clearInterval(menuWaitRef.current)
    },
    []
  )
  const asleepRef = useRef(false)
  const lockedRef = useRef(false)
  const nightRef = useRef(false)
  const bubbleTimerRef = useRef<number>(0)
  /** 气泡是否正在台上(报时判据用;timer id 不清零,单看它必然误判「永远在播」) */
  const bubbleBusyRef = useRef(false)
  const audioRef = useRef<AudioContext | null>(null)
  /** 性能过热:≥95% 起始时刻 / 冷却截止 / 当前是否红蛋 */
  const hotSinceRef = useRef(0)
  const cooldownUntilRef = useRef(0)
  const eggModeRef = useRef(false)
  /** 红蛋 episode 起止记账:破壳时传给 Rust perf_log_event,性能体检面板的过热记录与动画同源 */
  const eggStartRef = useRef(0)
  const eggKindRef = useRef('CPU')
  /** 终极形态(双高)当前态,带迟滞 */
  const ultimateRef = useRef(false)
  /** 光标(窗口内逻辑坐标):Tauri 由 probe 喂,浏览器由 mousemove 喂 */
  const cursorRef = useRef({ lx: -1, ly: -1, inside: false })
  /** 吸引感应区(窗口逻辑尺寸;窗口上方 170px 悬停也算凑热闹) */
  const zoneRef = useRef({ w: 440, h: 176 })
  /** 拖拽增量合流:鼠标事件只攒账,rAF 一帧一次 IPC */
  const dragAccRef = useRef({ x: 0, y: 0 })
  const dragRafRef = useRef(0)
  /** 整点报时:上一枚已敲的小时 + 报时钟在台截止时刻 */
  const chimeHourRef = useRef(-1)
  const chimeUntilRef = useRef(0)
  /** 移动大脑状态 */
  const walkRef = useRef({ x: 20, dir: 1, pause: 0, attract: 0, curiousAt: 0, notice: false, dash: null as { x: number } | null })
  const chimeBannerTimerRef = useRef(0)
  const nuzzlingRef = useRef(false)
  /** 执勤小报告 */
  const cardRef = useRef<HTMLDivElement | null>(null)
  const reportPhaseRef = useRef<'closed' | 'pulling' | 'open'>('closed')
  const reportHoverRef = useRef(0)
  const reportInsideRef = useRef(0)
  const reportTimerRef = useRef(0)
  const reportResizedRef = useRef(false)
  const reportAnchorRef = useRef(160)
  /** 举牌计时 + 今日计划快照(剩余件数驱动节律,逾期驱动表情) */
  const signTimerRef = useRef(0)
  /** 当前举着的牌(给别的轮询让路,避免两块牌抢) */
  const signRef = useRef<SignState | null>(null)
  const planRef = useRef({ remaining: 0, overdue: false })
  /** 自娱小剧场:相位 ref 驱动大脑,React state 只管渲染切换 */
  const [, setChasePhase] = useState<ChasePhase>('idle')
  const [chaseRocks, setChaseRocks] = useState<ChaseRock[]>([])
  const [chaseJump, setChaseJump] = useState(false)
  const [chaseStars, setChaseStars] = useState(false)
  const [chaseStarsAt, setChaseStarsAt] = useState(200)
  const chasePhaseRef = useRef<ChasePhase>('idle')
  const chaseRocksRef = useRef<ChaseRock[]>([])
  const birdRef = useRef({ x: 0, y: CHASE_BIRD_Y, v: 0, dir: 1, mode: 'off' as 'off' | 'fly' | 'slow' | 'boost' })
  const birdElRef = useRef<HTMLDivElement | null>(null)
  const chaseTimersRef = useRef<number[]>([])
  const chaseJumpTimerRef = useRef(0)
  const chaseRunAtRef = useRef(0)
  /** 最后一次互动时刻(按压/表演/小剧场都会刷新),小剧场只挑真无聊的空档 */
  const lastInteractRef = useRef(Date.now())

  const tauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

  const isNightHour = useCallback(() => {
    const h = new Date().getHours()
    return h >= 23 || h < 7
  }, [])

  const showBubble = useCallback((text: string, ms = 1900) => {
    setBubble(text)
    bubbleBusyRef.current = true
    window.clearTimeout(bubbleTimerRef.current)
    bubbleTimerRef.current = window.setTimeout(() => {
      setBubble(null)
      bubbleBusyRef.current = false
    }, ms)
  }, [])

  /** 点复习牌:把主窗提到前台并直落学习台复习抽屉(/study?panel=review 现成深链) */
  const openReview = useCallback(() => {
    setSign(null)
    signRef.current = null
    window.clearTimeout(signTimerRef.current)
    if (!('__TAURI_INTERNALS__' in window)) {
      showBubble('去学习台 · 复习(浏览器预览不跳转)', 2600)
      return
    }
    invoke('open_main_path', { path: '/study?panel=review' })
      .then(() => showBubble('主窗开了,去翻一轮', 2600))
      .catch(() => {
        invoke('focus_main_window').catch(() => {})
        showBubble('打开主窗了', 2400)
      })
  }, [showBubble])

  /** 表演一个动作;夜里只允许叫一声/哈欠/睡眼挥手(轻轻醒),其余不扰梦 */
  const perform = useCallback((a: Act) => {
    if (asleepRef.current && a !== 'chirp' && a !== 'yawn' && a !== 'wave') return
    // 红蛋期不叠别的动作:气鼓鼓的姿势别被叽一声/蹦一下盖掉
    if (angryRef.current) return
    actRef.current = a
    setAct(a)
    window.clearTimeout(actTimerRef.current)
    actTimerRef.current = window.setTimeout(() => {
      actRef.current = null
      setAct(null)
    }, ACT_MS[a])
  }, [])

  const chirpSound = useCallback(() => {
    try {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AC) return
      audioRef.current ||= new AC()
      const ctx = audioRef.current
      const t0 = ctx.currentTime
      ;[0, 0.16].forEach((off, i) => {
        const o = ctx.createOscillator()
        const g = ctx.createGain()
        const f = i === 0 ? 1900 : 2400
        o.type = 'sine'
        o.frequency.setValueAtTime(f, t0 + off)
        o.frequency.exponentialRampToValueAtTime(f * 1.35, t0 + off + 0.05)
        o.frequency.exponentialRampToValueAtTime(f * 0.8, t0 + off + 0.11)
        g.gain.setValueAtTime(0.0001, t0 + off)
        g.gain.exponentialRampToValueAtTime(0.06, t0 + off + 0.02)
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.13)
        o.connect(g)
        g.connect(ctx.destination)
        o.start(t0 + off)
        o.stop(t0 + off + 0.15)
      })
    } catch {
      /* 无声环境静默 */
    }
  }, [])

  const chirp = useCallback(() => {
    perform('chirp')
    chirpSound()
  }, [perform, chirpSound])

  const addEgg = useCallback(() => {
    setEggs((prev) => {
      const n = Math.min(prev + 1, EGG_MAX)
      try {
        window.localStorage.setItem(EGGS_KEY, String(n))
      } catch {
        /* ignore */
      }
      return n
    })
  }, [])

  /** 到点/点击问候:每类每天最多一次,pet-greet 记账 */
  const greetCheck = useCallback(() => {
    const now = new Date()
    const t = now.getHours() * 60 + now.getMinutes()
    const today = chickToday()
    const f = loadGreet()
    if (f.date !== today) {
      f.date = today
      f.fired = {}
    }
    const fire = (slot: string, text: string, act: Act = 'wave') => {
      if (f.fired[slot]) return
      f.fired[slot] = today
      saveGreet(f)
      showBubble(text, 3600)
      perform(act)
    }
    const fest = chickFestivalToday()
    if (fest) {
      fire('festival', fest, 'hop3')
      return
    }
    const gd = chickGaokaoDays()
    if (gd >= 1 && gd <= 100) {
      fire('gaokao', `距高考 ${gd} 天,冲!`, 'hop3')
      return
    }
    if (t >= 420 && t <= 570) fire('morning', chickHiText(now.getHours()))
    else if (t >= 690 && t <= 810) fire('noon', chickHiText(now.getHours()))
    else if (t >= 1080 && t <= 1230) fire('evening', chickHiText(now.getHours()))
    else if (t >= 1380 || t < 420)
      fire('night', now.getHours() >= 23 ? '晚安,今天辛苦啦,明天见!' : '这么晚还不睡呀?早点休息哦')
  }, [perform, showBubble])

  /** 举牌(到点 / 濒临 / 逾期 / 复习到期共用),SIGN_MS 后自动收 */
  const showSign = useCallback((next: SignState) => {
    signRef.current = next
    setSign(next)
    window.clearTimeout(signTimerRef.current)
    signTimerRef.current = window.setTimeout(() => {
      signRef.current = null
      setSign(null)
    }, SIGN_MS)
  }, [])

  /**
   * 复习到期举牌(60s):/api/study/stats 的 dueCount 是只读幂等接口,可安全轮询。
   * 分级按「压力」而不是「有没有」:
   *   1–3 个 → 黄牌「有 N 个到期」+ 歪头看你(curious)
   *   ≥4 个  → 橙牌「N 个到期 · 先翻一轮?」+ 催促拍翅(urge)
   *   ≥8 个,或 ≥3 个且 21 点后今天一次没复习 → 红牌「再拖就白背了」+ 跺脚皱眉(stomp)
   * 节流:30 分钟最多一次、一天最多 3 次;计划牌正在举时不抢;夜里睡着不举。
   */
  const studyTick = useCallback(() => {
    if (asleepRef.current || signRef.current) return
    const today = chickToday()
    const f = loadReviewFlag()
    if (f.date !== today) {
      f.date = today
      f.count = 0
      f.lastAt = 0
    }
    if (f.count >= 3 || Date.now() - f.lastAt < 30 * 60_000) return
    fetch('/api/study/stats', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { dueCount?: unknown; todayCount?: unknown } | null) => {
        const due = typeof data?.dueCount === 'number' ? data.dueCount : 0
        const doneToday = typeof data?.todayCount === 'number' ? data.todayCount : 0
        if (due <= 0) return
        if (signRef.current || asleepRef.current) return
        const h = new Date().getHours()
        const variant: SignVariant =
          due >= 8 || (due >= 3 && h >= 21 && doneToday === 0) ? 'bad' : due >= 4 ? 'warn' : 'plain'
        const title = `${due} 个到期`
        const sub =
          variant === 'bad' ? '再拖就白背了' : variant === 'warn' ? '先翻一轮?' : '睡前翻两下就清'
        f.count += 1
        f.lastAt = Date.now()
        saveReviewFlag(f)
        showSign({ variant, title, sub, tag: 'review' })
        // 表情跟着压力走:歪头 → 催促拍翅 → 跺脚皱眉
        perform(variant === 'bad' ? 'stomp' : variant === 'warn' ? 'urge' : 'curious')
      })
      .catch(() => {
        /* 未登录/离线:静默 */
      })
  }, [showSign, perform])

  /**
   * 计划轮询(60s 一次),一次拿当日计划喂三件事:
   *   ① 举牌三态:进行中「还剩 N 分」→ ≤10 分转橙 → 过点未勾转红「已超 N 分」(并让小鸡皱眉)
   *   ② 节律:剩余件数 → 步行速度(大脑里读 planRef)
   *   ③ 逾期标记 → 皱眉站定
   */
  const planTick = useCallback(() => {
    const now = new Date()
    const t = now.getHours() * 60 + now.getMinutes()
    const today = chickToday()
    fetch(`/api/plan/items?date=${today}`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { items?: Array<Record<string, unknown>> } | null) => {
        const items = Array.isArray(data?.items) ? data.items : []
        const rows = items
          .map((it) => ({
            id: it.id != null ? String(it.id) : '',
            title: typeof it.title === 'string' ? it.title.trim() : '',
            done: it.done === true,
            startMin: typeof it.startMin === 'number' ? it.startMin : null,
            endMin: typeof it.endMin === 'number' ? it.endMin : null,
            status: typeof it.status === 'string' ? it.status : '',
          }))
          .filter((r) => r.id && r.title && r.status !== 'dropped')

        // ② 节律:今天还剩几件
        planRef.current.remaining = rows.filter((r) => !r.done).length

        const scheduled = rows.filter((r) => r.startMin != null && !r.done)
        const ongoing = scheduled.find((r) => r.endMin != null && t >= (r.startMin ?? 0) && t < (r.endMin ?? 0))
        const late = scheduled
          .filter((r) => r.endMin != null && t >= (r.endMin ?? 0) && t <= (r.endMin ?? 0) + 90)
          .sort((a, b) => (b.endMin ?? 0) - (a.endMin ?? 0))[0]
        // ③ 逾期:小鸡皱起粗眉(与执勤装共用 .brows)
        const isLate = !!late
        planRef.current.overdue = isLate
        setOverdue(isLate)

        const f = loadRemind()
        if (f.date !== today) {
          f.date = today
          f.ids = {}
        }
        let dirty = false

        if (ongoing) {
          const left = Math.max(0, (ongoing.endMin ?? 0) - t)
          const variant: SignVariant = left <= 10 ? 'warn' : 'plain'
          const key = `${ongoing.id}@${variant}`
          if (!f.ids[key]) {
            f.ids[key] = today
            dirty = true
            showSign({ variant, title: ongoing.title, sub: `还剩 ${left} 分钟` })
          }
        } else if (late) {
          const key = `${late.id}@late`
          if (!f.ids[key]) {
            f.ids[key] = today
            dirty = true
            showSign({ variant: 'bad', title: late.title, sub: `已超 ${t - (late.endMin ?? 0)} 分钟` })
          }
        }
        if (dirty) saveRemind(f)
      })
      .catch(() => {
        /* 未登录/离线:静默 */
      })
  }, [showSign])

  /** 纸条行勾完成:乐观更新,失败回滚;B 案只有圆圈可点 */
  const toggleDone = useCallback(
    async (row: ReportRow) => {
      const next = !row.done
      const apply = (val: boolean) => {
        setReportData((prev) => {
          if (!prev) return prev
          const map = (r: ReportRow) => (r.id === row.id ? { ...r, done: val } : r)
          const delta = val === row.done ? 0 : val ? 1 : -1
          return {
            ...prev,
            goals: prev.goals.map(map),
            plans: prev.plans.map(map),
            doneCount: Math.max(0, Math.min(prev.total, prev.doneCount + delta)),
          }
        })
      }
      apply(next)
      try {
        const res = await fetch(`/api/plan/items/${row.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ done: next }),
        })
        if (!res.ok) throw new Error(String(res.status))
        if (next) {
          addEgg()
          perform('hop1')
        }
      } catch {
        apply(row.done)
        showBubble('没记上,再点一次', 2200)
      }
    },
    [addEgg, perform, showBubble]
  )

  /** 纸条行顺延:挪到明天收件箱(清掉时刻),拖延次数 +1 */
  const postponeItem = useCallback(
    async (row: ReportRow) => {
      const d = new Date()
      d.setDate(d.getDate() + 1)
      const tomorrow = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      try {
        const res = await fetch(`/api/plan/items/${row.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            plannedDate: tomorrow,
            startMin: null,
            endMin: null,
            postponeCount: row.postponeCount + 1,
          }),
        })
        if (!res.ok) throw new Error(String(res.status))
        showBubble('挪到明天了', 2200)
        perform('wave')
        // 乐观移出纸条(明天才回来)
        setReportData((prev) => {
          if (!prev) return prev
          const total = Math.max(0, prev.total - 1)
          return {
            ...prev,
            plans: prev.plans.filter((r) => r.id !== row.id),
            goals: prev.goals.filter((r) => r.id !== row.id),
            total,
            doneCount: Math.min(prev.doneCount, total),
          }
        })
      } catch {
        showBubble('没挪成,再点一次', 2200)
      }
    },
    [perform, showBubble]
  )

  /* ── 自娱小剧场:无聊(空闲30s+)看到天上有鸟 → 追跑避障,追到攒蛋;摸/拎/锁屏/夜里/报时 → 立即中断 ── */

  const abortChase = useCallback(() => {
    chaseTimersRef.current.forEach((t) => window.clearTimeout(t))
    chaseTimersRef.current = []
    window.clearTimeout(chaseJumpTimerRef.current)
    birdRef.current.mode = 'off'
    if (birdElRef.current) birdElRef.current.style.display = 'none'
    if (chasePhaseRef.current === 'idle') return
    chasePhaseRef.current = 'idle'
    setChasePhase('idle')
    chaseRocksRef.current = []
    setChaseRocks([])
    setChaseJump(false)
    setChaseStars(false)
  }, [])

  /** 跳障碍:一次性上抛动画,播完摘类(与 act 类同挂时 CSS 以 chaseJump 为准) */
  const doChaseJump = useCallback(() => {
    setChaseJump(true)
    window.clearTimeout(chaseJumpTimerRef.current)
    chaseJumpTimerRef.current = window.setTimeout(() => setChaseJump(false), 540)
  }, [])

  /** 结算回归:清场 + 记账 + 缓一拍再恢复巡游 */
  const endChase = useCallback(() => {
    abortChase()
    try {
      const today = chickToday()
      const f = loadChase()
      if (f.date !== today) {
        f.date = today
        f.n = 0
      }
      f.n += 1
      saveChase(f)
    } catch {
      /* ignore */
    }
    lastInteractRef.current = Date.now()
    walkRef.current.pause = Math.max(walkRef.current.pause, 8)
  }, [abortChase])

  const startChase = useCallback(() => {
    if (chasePhaseRef.current !== 'idle') return
    const st = walkRef.current
    /** 从鸡身后一侧入窗,朝前飞 */
    const dir = st.x < 130 ? 1 : -1
    chasePhaseRef.current = 'spot'
    setChasePhase('spot')
    showBubble('!', 900)
    perform('curious')
    lastInteractRef.current = Date.now()
    /** 障碍 1~3 个;dir 反向时按 440 镜像,确保落在鸡前方跑道 */
    const picked = [...CHASE_ROCK_XS].sort(() => Math.random() - 0.5).slice(0, 1 + Math.floor(Math.random() * 3))
    const rocks: ChaseRock[] = picked.map((x) => ({ x: dir === 1 ? x : 440 - x - 26, shown: false, jumped: false }))
    rocks.sort((a, b) => Math.abs(a.x + 13 - (18 + st.x + CHICK_HALF)) - Math.abs(b.x + 13 - (18 + st.x + CHICK_HALF)))
    chaseRocksRef.current = rocks
    chaseTimersRef.current.push(
      window.setTimeout(() => {
        if (chasePhaseRef.current !== 'spot') return
        chasePhaseRef.current = 'run'
        chaseRunAtRef.current = Date.now()
        setChasePhase('run')
        chaseRocksRef.current = rocks.map((r) => ({ ...r, shown: true }))
        setChaseRocks(chaseRocksRef.current)
        birdRef.current = { x: dir === 1 ? -20 : 450, y: CHASE_BIRD_Y, v: CHASE_BIRD_V, dir, mode: 'fly' }
        if (birdElRef.current) birdElRef.current.style.display = 'block'
        // 结局判定:追跑 3.2s 后掷骰五五开(减速被追上 / 加速逃走)
        chaseTimersRef.current.push(
          window.setTimeout(() => {
            if (chasePhaseRef.current !== 'run') return
            const b = birdRef.current
            if (Math.random() < 0.5) {
              b.mode = 'slow'
            } else {
              // 结局B:没追到——鸟加速冲出窗,急停歪头目送
              chasePhaseRef.current = 'settle'
              setChasePhase('settle')
              b.mode = 'boost'
              perform('curious')
              showBubble('…', 1300)
              chaseTimersRef.current.push(window.setTimeout(() => endChase(), 1900))
            }
          }, 3200)
        )
      }, 900)
    )
  }, [perform, showBubble, endChase])

  /** 追跑每拍推进(大脑 140ms tick 调用):鸟运动 + 鸡追 + 跳障碍 + 结算判定 */
  const chaseTick = useCallback(() => {
    const b = birdRef.current
    const st = walkRef.current
    const phase = chasePhaseRef.current
    if (b.mode === 'fly') b.x += b.v * 0.14 * b.dir
    else if (b.mode === 'slow') {
      b.x += b.v * 0.14 * b.dir
      b.v = Math.max(0, b.v - 3.4)
    } else if (b.mode === 'boost') {
      b.v = Math.min(240, b.v + 15)
      b.x += b.v * 0.14 * b.dir
    }
    const el = birdElRef.current
    if (el) {
      el.style.transform = `translate(${Math.round(b.x)}px, ${b.y}px)`
      if (b.dir === 1 ? b.x > 470 : b.x < -80) el.style.display = 'none'
    }
    if (phase !== 'run') return
    // 看门狗:追跑超 10s 强制收场(防任何状态卡死)
    if (Date.now() - chaseRunAtRef.current > 10_000) {
      endChase()
      return
    }
    // 鸡朝鸟身后锚点追(每拍 9.0px,略快于鸟速才有「在追」的势)
    const want = Math.max(WALK_MIN, Math.min(WALK_MAX, b.x + 20 - 44 * b.dir - 55))
    const dx = want - st.x
    if (Math.abs(dx) > 2) st.x += Math.sign(dx) * Math.min(9.0, Math.abs(dx))
    // 跳最近的未跳障碍
    const center = 18 + st.x + CHICK_HALF
    for (const r of chaseRocksRef.current) {
      if (!r.jumped && Math.abs(center - (r.x + 13)) < 9) {
        r.jumped = true
        doChaseJump()
        break
      }
    }
    const dist = Math.abs(center - (b.x + 20))
    // 追得太快提前够到 → 直接进「鸟减速悬停」
    if (b.mode === 'fly' && dist < 44) b.mode = 'slow'
    if (b.mode === 'slow' && b.v === 0 && dist < 52) {
      // 结局A:追到——星星 + 攒蛋 + 开心蹦,鸟随后飞走
      chasePhaseRef.current = 'settle'
      setChasePhase('settle')
      setChaseStarsAt(center - 48)
      setChaseStars(true)
      addEgg()
      showBubble('又下一颗蛋!')
      perform('hop1')
      chaseTimersRef.current.push(
        window.setTimeout(() => {
          b.mode = 'fly'
          b.v = CHASE_BIRD_V
        }, 400)
      )
      chaseTimersRef.current.push(window.setTimeout(() => endChase(), 2100))
    }
  }, [addEgg, doChaseJump, endChase, perform, showBubble])

  /** 气成红蛋:连摸 4 次触发;红蛋期一靠近就反向跑,点它弹开 */
  const goAngry = useCallback(() => {
    const now = Date.now()
    angryRef.current = true
    setAngry(true)
    angryUntilRef.current = now + ANGRY_MS
    leapReadyRef.current = now + 600
    sidestepAtRef.current = now + 400
    patStreakRef.current = 0
    pattingRef.current = false
    setPatting(false)
    window.clearTimeout(pressRef.current.patTimer)
    pressRef.current.patTimer = 0
    if (chasePhaseRef.current !== 'idle') abortChase()
    const c = cursorRef.current
    const st = walkRef.current
    const cx = 18 + st.x + CHICK_HALF
    const near = c.inside && Math.abs(c.lx - cx) < ANGRY_SENSE
    angryJoltRef.current = { until: now + 360, dir: near && c.lx < cx ? 1 : -1 }
    showBubble('哼!', 1600)
  }, [abortChase, showBubble])

  /** 消气(或让位给站岗/打盹):褪红;forgive=true 时下一摸只给「…就一下哦」 */
  const calmAngry = useCallback(
    (forgive: boolean) => {
      angryRef.current = false
      setAngry(false)
      angryJoltRef.current = { until: 0, dir: 1 }
      const ck = chickRef.current
      if (ck) ck.classList.remove(s.angryRun, s.angryHop, s.angryLeap)
      if (forgive) {
        forgivingRef.current = true
        showBubble('…哼', 1000)
      }
    },
    [showBubble]
  )

  /** 红蛋期被碰:动一下激灵(位移交给大脑拍) + 「别碰!」 */
  const pokeAngry = useCallback(() => {
    const c = cursorRef.current
    const st = walkRef.current
    const cx = 18 + st.x + CHICK_HALF
    angryJoltRef.current = { until: Date.now() + 430, dir: c.inside && c.lx < cx ? 1 : -1 }
    leapReadyRef.current = Math.max(leapReadyRef.current, Date.now() + 300)
    showBubble('别碰!', 1200)
  }, [showBubble])

  const startPat = useCallback(() => {
    // 红蛋期摸不到:一碰就弹开
    if (angryRef.current) {
      pokeAngry()
      return
    }
    // 消气后的第一次:不计次,给个台阶
    if (forgivingRef.current) {
      forgivingRef.current = false
      patStreakRef.current = 0
      pattingRef.current = true
      setPatting(true)
      showBubble('…就一下哦', 1900)
      return
    }
    // 连续摸头记账:间隔超 10s 清零;站岗/夜里只蹭不气
    if (!lockedRef.current && !nightRef.current) {
      const now = Date.now()
      if (now - lastPatAtRef.current > ANGRY_GAP_MS) patStreakRef.current = 0
      lastPatAtRef.current = now
      patStreakRef.current += 1
      if (patStreakRef.current >= ANGRY_PATS) {
        goAngry()
        return
      }
    }
    pattingRef.current = true
    setPatting(true)
    showBubble('蹭蹭~', 1300)
  }, [goAngry, pokeAngry, showBubble])

  const endPat = useCallback(() => {
    pattingRef.current = false
    setPatting(false)
  }, [])

  /** 蹭蹭结束(光标挪走/拖走/进监管) */
  const endNuzzle = useCallback(() => {
    nuzzlingRef.current = false
    setNuzzling(false)
  }, [])

  /** 点击分流:今日首点补问候 / 反应池 / 连点急眼 / 站岗摇头 / 夜里轻醒 */
  const registerClick = useCallback(() => {
    const now = Date.now()
    clickTimesRef.current = [...clickTimesRef.current.filter((t) => now - t < 1500), now]
    if (clickTimesRef.current.length >= 3) {
      clickTimesRef.current = []
      perform('sad')
      return
    }
    if (lockedRef.current) {
      perform('shake')
      return
    }
    // 今日还没打过任何招呼 → 点它就是见面问候(代替反应池)
    const today = chickToday()
    const f = loadGreet()
    if (f.date !== today) {
      f.date = today
      f.fired = {}
    }
    if (Object.keys(f.fired).length === 0) {
      f.fired.met = today
      saveGreet(f)
      const h = new Date().getHours()
      showBubble(h >= 23 ? '还没睡呀?早点休息哦' : chickHiText(h), 3600)
      perform('wave')
      return
    }
    if (pressRef.current.wasAsleep) {
      perform('yawn')
      chirpSound()
      return
    }
    const pool: Act[] = ['chirp', 'curious', 'shiver']
    const pick = pool[Math.floor(Math.random() * pool.length)]
    if (pick === 'chirp') chirp()
    else perform(pick)
  }, [perform, chirp, chirpSound, showBubble])

  /** 整点报时(2026-11-20 用户挑 A 案 · 原型 design/preview-pet-chime-banner.html):
   *  鸡旁展开一条「卷轴小横幅」——白底橙边 + 两端卷轴杆 + 300ms 展开,停 3.6s 收起,
   *  与右键菜单同款。摆位按小鸡当前位置自动避让:右侧放得下贴右,否则贴左,
   *  两侧都放不下(鸡在中间)退化为头顶居中。气泡在播/手上有互动就顺延;
   *  睡着也报但只出横幅不蹦(不吵觉)。 */
  const chimeNow = useCallback(
    (force = false) => {
      const now = new Date()
      const h = now.getHours()
      if (!force) {
        if (now.getMinutes() !== 0) return
        if (chimeHourRef.current === h) return
        if (bubbleBusyRef.current) return
        if (pressRef.current.down) return
      }
      chimeHourRef.current = h
      // 报时优先:追跑中的小剧场收场,小鸡立正
      if (chasePhaseRef.current !== 'idle') abortChase()
      const label = `${String(h).padStart(2, '0')}:00`
      // 摆位:横幅约 150px,离鸡 10px(mover 74 + gap 10);放不下依次退让
      const x = walkRef.current.x
      const BW = 190
      const gap = 84
      let side: 'right' | 'left' | 'top' = 'right'
      if (x + gap + BW > window.innerWidth - 8) {
        side = x - gap - BW >= 8 ? 'left' : 'top'
      }
      setChimeBanner({ label, side })
      chimeUntilRef.current = Date.now() + 3600
      perform('hop1')
      window.clearTimeout(chimeBannerTimerRef.current)
      chimeBannerTimerRef.current = window.setTimeout(() => setChimeBanner(null), 3600)
    },
    [perform, abortChase]
  )

  /* ── 执勤小报告:监管模式悬停 450ms → 拽绳 480ms → 窗口长高纸条展开 ── */
  const winResize = useCallback(async (grow: boolean) => {
    if (!('__TAURI_INTERNALS__' in window)) return
    try {
      const p = await invoke<PetProbe>('pet_probe')
      const lh = p.wh / p.scale
      const lx = p.wx / p.scale
      const ly = p.wy / p.scale
      if (grow && !reportResizedRef.current) {
        // 长高多少上移多少,给屏幕顶留 40px
        const extra = Math.min(REPORT_EXTRA, Math.max(140, ly - 40))
        await getCurrentWindow().setSize(new LogicalSize(440, lh + extra))
        await getCurrentWindow().setPosition(new LogicalPosition(lx, ly - extra))
        reportResizedRef.current = true
      } else if (!grow && reportResizedRef.current) {
        await getCurrentWindow().setSize(new LogicalSize(440, 176))
        await getCurrentWindow().setPosition(new LogicalPosition(lx, ly + (lh - 176)))
        reportResizedRef.current = false
      }
    } catch {
      /* ignore */
    }
  }, [])

  const fetchReport = useCallback(async () => {
    const today = chickToday()
    const empty: ReportData = { goals: [], plans: [], doneCount: 0, total: 0, empty: true }
    try {
      const res = await fetch(`/api/plan/items?date=${today}`, { cache: 'no-store' })
      if (!res.ok) throw new Error('no-auth')
      const data = await res.json()
      const items = Array.isArray(data?.items) ? data.items : []
      if (!items.length) {
        setReportData(empty)
        return
      }
      const now = new Date()
      const nowMin = now.getHours() * 60 + now.getMinutes()
      const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
      const rowsAll: Array<ReportRow & { startMin: number | null }> = items.map((it: Record<string, unknown>) => {
        const sm = typeof it.startMin === 'number' ? it.startMin : null
        const title = typeof it.title === 'string' ? it.title.trim() : ''
        return {
          id: it.id != null ? String(it.id) : '',
          title,
          done: it.done === true,
          startMin: sm,
          time: sm != null ? fmt(sm) : '',
          past: sm != null && sm + 30 < nowMin,
          now: sm != null && sm <= nowMin && nowMin < sm + 30,
          postponeCount: typeof it.postponeCount === 'number' ? it.postponeCount : 0,
        }
      })
      const rows = rowsAll.filter((r) => r.title)
      const goals = rows.filter((r) => r.startMin == null)
      const plans = rows
        .filter((r) => r.startMin != null)
        .sort((a, b) => (a.startMin ?? 0) - (b.startMin ?? 0))
        .slice(0, 3)
      const total = rows.length
      const doneCount = rows.filter((r) => r.done).length
      if (!goals.length && !plans.length) setReportData(empty)
      else setReportData({ goals, plans, doneCount, total, empty: false })
    } catch {
      // 未登录/离线:空态指路
      setReportData(empty)
    }
  }, [])

  const startReport = useCallback(() => {
    if (reportPhaseRef.current !== 'closed') return
    reportPhaseRef.current = 'pulling'
    setReportPhase('pulling')
    reportAnchorRef.current = 18 + walkRef.current.x + CHICK_HALF
    fetchReport()
    reportTimerRef.current = window.setTimeout(() => {
      reportPhaseRef.current = 'open'
      setReportPhase('open')
      winResize(true)
    }, 480)
  }, [fetchReport, winResize])

  const collapseReport = useCallback(() => {
    if (reportPhaseRef.current === 'closed') return
    window.clearTimeout(reportTimerRef.current)
    reportPhaseRef.current = 'closed'
    setReportPhase('closed')
    winResize(false)
  }, [winResize])

  /* 报告触发器:监管模式里悬停小鸡 450ms 起,出界 260ms 收;解锁即收 */
  useEffect(() => {
    const tick = window.setInterval(() => {
      const now = Date.now()
      if (!lockedRef.current) {
        reportHoverRef.current = 0
        if (reportPhaseRef.current !== 'closed') collapseReport()
        return
      }
      if (pressRef.current.down) return
      const c = cursorRef.current
      const el = chickRef.current
      let inside = false
      if (el && c.inside) {
        const r = el.getBoundingClientRect()
        inside = c.lx >= r.left && c.lx <= r.right && c.ly >= r.top && c.ly <= r.bottom
      }
      let insideCard = false
      if (reportPhaseRef.current === 'open' && cardRef.current) {
        const r = cardRef.current.getBoundingClientRect()
        insideCard = c.inside && c.lx >= r.left && c.lx <= r.right && c.ly >= r.top && c.ly <= r.bottom
      }
      if (inside || insideCard) reportInsideRef.current = now
      if (reportPhaseRef.current !== 'closed') {
        if (!inside && !insideCard && now - reportInsideRef.current > 260) collapseReport()
        return
      }
      if (inside) {
        reportHoverRef.current += 1
        if (reportHoverRef.current >= 3) {
          reportHoverRef.current = 0
          startReport()
        }
      } else {
        reportHoverRef.current = 0
      }
    }, 150)
    return () => window.clearInterval(tick)
  }, [startReport, collapseReport])

  /* 性能采样 → 档位:双高终极形态 > ≥95 红蛋 > ≥90 发烧 > ≥80 微热 */
  const applyPerf = useCallback((p: Perf1) => {
    setPerf(p)
    const hot = Math.max(p.cpu, p.mem, p.gpu ?? 0)
    const now = Date.now()

    // 红蛋 episode 收尾记账:真实「缩红蛋」时刻写入 Rust 环形事件表,与性能体检面板同源
    // (浏览器演示钩子 __pet.perf 无 Tauri,静默失败)
    const endEggEvent = (endMs: number) => {
      const start = eggStartRef.current
      if (!start) return
      eggStartRef.current = 0
      try {
        invoke('perf_log_event', {
          start,
          dur: Math.max(1, Math.floor(endMs / 1000) - start),
          kind: eggKindRef.current,
        }).catch(() => {})
      } catch {
        /* 无 Tauri 环境 */
      }
    }

    // 终极形态:CPU 与内存同时高(双高),或 GPU 温度 ≥90°C(烧起来了);
    // 退出留迟滞:双高要两项都回到 80 以下、温度要降到 87 以下才退
    const tempUlt = p.gpuTemp != null && p.gpuTemp >= 90
    const stayUlt = (p.cpu >= 80 && p.mem >= 80) || (p.gpuTemp != null && p.gpuTemp >= 87)
    const ult = ultimateRef.current ? stayUlt : p.cpu >= 85 && p.mem >= 85 || tempUlt
    if (ult !== ultimateRef.current) {
      ultimateRef.current = ult
      setUltimate(ult)
    }
    if (ult) {
      // 终极形态压过单指标表演:清掉红蛋计时,蛋壳就地收起
      hotSinceRef.current = 0
      if (eggModeRef.current) {
        eggModeRef.current = false
        endEggEvent(now)
        setEggMode(false)
      }
      return
    }

    if (hot >= 95) {
      if (!hotSinceRef.current) hotSinceRef.current = now
      const sustained = now - hotSinceRef.current >= 3000
      if (!eggModeRef.current && sustained && now >= cooldownUntilRef.current) {
        eggModeRef.current = true
        eggStartRef.current = Math.floor(now / 1000)
        eggKindRef.current =
          p.cpu >= p.mem && p.cpu >= (p.gpu ?? 0) ? 'CPU' : p.mem >= (p.gpu ?? 0) ? '内存' : 'GPU'
        cooldownUntilRef.current = now + 60_000
        setEggMode(true)
      }
    } else {
      hotSinceRef.current = 0
      // 回落要明显(掉到 85 以下)才破壳,避免在阈值上反复烤
      if (eggModeRef.current && hot < 85) {
        eggModeRef.current = false
        endEggEvent(now)
        setEggMode(false)
        setHatching(true)
        window.setTimeout(() => setHatching(false), 700)
      }
    }
  }, [])

  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return
    const pull = () => {
      invoke<Perf1>('perf_probe')
        .then((p) => applyPerf(p))
        .catch(() => {})
    }
    pull()
    const timer = window.setInterval(pull, 3000)
    return () => window.clearInterval(timer)
  }, [applyPerf])

  /* 性能角标常驻开关:记忆在 localStorage */
  useEffect(() => {
    try {
      setHudOn(window.localStorage.getItem('pet-hud') === '1')
    } catch {
      /* ignore */
    }
  }, [])

  /* boot:时段/静态态/演示事件/位置记忆/监听 */
  useEffect(() => {
    const dev = process.env.NODE_ENV === 'development'
    const sp = new URLSearchParams(window.location.search)
    const petParam = sp.get('__pet')
    if (petParam === 'night') setNight(true)
    else if (petParam === 'day') setNight(false)
    else setNight(isNightHour())
    if (dev && sp.get('__petstill')) setStill(true)
    setEggs(loadEggs())

    const n0 = petParam === 'night' || (petParam !== 'day' && isNightHour())
    nightRef.current = n0
    asleepRef.current = n0 && !lockedRef.current
    setAsleep(asleepRef.current)

    const demoAct = dev ? (sp.get('__petevt') as Act | 'chime' | null) : null
    const demoTimer = demoAct && demoAct !== 'chime' ? window.setTimeout(() => perform(demoAct), 900) : 0
    const demoChime = demoAct === 'chime' ? window.setTimeout(() => chimeNow(true), 900) : 0
    if (dev && sp.get('__petlock')) {
      // 强制监管执勤态(截图/验收用)
      lockedRef.current = true
      setLocked(true)
    }

    // 问候 + 计划提醒 + 整点报时:浏览器预览也跑(提醒的 fetch 在未登录时静默失败)
    const greetTimer = window.setInterval(greetCheck, 60_000)
    const greetBoot = window.setTimeout(greetCheck, 2600)
    const remindTimer = window.setInterval(planTick, 60_000)
    const remindBoot = window.setTimeout(planTick, 4200)
    // 复习到期:错开 20s,免得跟计划牌同一秒抢牌
    const reviewTimer = window.setInterval(studyTick, 60_000)
    const reviewBoot = window.setTimeout(studyTick, 24_000)
    const chimeTimer = window.setInterval(() => {
      if (new Date().getMinutes() === 0) chimeNow()
    }, 60_000)
    const chimeBoot = window.setTimeout(() => {
      if (new Date().getMinutes() <= 1) chimeNow()
    }, 1500)

    if (!('__TAURI_INTERNALS__' in window)) {
      return () => {
        window.clearTimeout(demoTimer)
        window.clearTimeout(demoChime)
        window.clearInterval(greetTimer)
        window.clearTimeout(greetBoot)
        window.clearInterval(remindTimer)
        window.clearTimeout(remindBoot)
        window.clearInterval(reviewTimer)
        window.clearTimeout(reviewBoot)
        window.clearInterval(chimeTimer)
        window.clearTimeout(chimeBoot)
      }
    }

    // 位置记忆
    try {
      const raw = window.localStorage.getItem(POS_KEY)
      if (raw) {
        const p = JSON.parse(raw) as { x?: number; y?: number }
        if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
          invoke('pet_set_position', { x: p.x, y: p.y }).catch(() => {})
        }
      }
    } catch {
      /* ignore */
    }

    const unlisten = listen<PetEventDetail>('pet-event', (e) => {
      const { key, text } = e.payload ?? {}
      if (!key) return
      const now = Date.now()
      if (now - lastActAtRef.current < COOL_MS) return
      if (lastKeyRef.current && lastKeyRef.current.key === key && now - lastKeyRef.current.at < DEDUP_MS) return
      lastActAtRef.current = now
      lastKeyRef.current = { key, at: now }
      // 事件反应优先:追跑/看见中的小剧场立即让位
      if (chasePhaseRef.current === 'run' || chasePhaseRef.current === 'spot') abortChase()
      const isEgg = EGG_KEYS.has(key)
      if (isEgg) addEgg()
      if (typeof text === 'string' && text) showBubble(text, 2600)
      else if (isEgg) showBubble('又下一颗蛋!')
      const a = ACT_OF[key]
      if (a) perform(a)
    })

    // 监管模式站岗轮询
    const applyLock = (st: { locked: boolean } | null) => {
      lockedRef.current = !!st?.locked
      setLocked(lockedRef.current)
      const n = nightRef.current
      asleepRef.current = n && !lockedRef.current
      setAsleep(asleepRef.current)
    }
    const sentryTimer = window.setInterval(() => {
      invoke<{ locked: boolean }>('focus_lock_status')
        .then((st) => applyLock(st))
        .catch(() => {})
    }, 25_000)
    invoke<{ locked: boolean }>('focus_lock_status')
      .then((st) => applyLock(st))
      .catch(() => {})

    // 夜里打盹看门:光标不在窝边晃才续睡(被盯着看时不睡,大脑里会叫醒)
    const nightTimer = window.setInterval(() => {
      const n = isNightHour()
      nightRef.current = n
      setNight(n)
      const c = cursorRef.current
      const z = zoneRef.current
      const watched =
        c.inside && c.lx >= -30 && c.lx <= z.w + 30 && c.ly >= -170 && c.ly <= z.h + 24 && c.ly > 0
      asleepRef.current = n && !lockedRef.current && !watched
      setAsleep(asleepRef.current)
    }, 60_000)

    return () => {
      window.clearTimeout(demoTimer)
      window.clearTimeout(demoChime)
      window.clearInterval(greetTimer)
      window.clearTimeout(greetBoot)
      window.clearInterval(remindTimer)
      window.clearTimeout(remindBoot)
      window.clearInterval(reviewTimer)
      window.clearTimeout(reviewBoot)
      window.clearInterval(chimeTimer)
      window.clearTimeout(chimeBoot)
      unlisten.then((fn) => fn())
      window.clearInterval(sentryTimer)
      window.clearInterval(nightTimer)
    }
  }, [isNightHour, perform, addEgg, greetCheck, planTick, studyTick, chimeNow, abortChase])

  const savePos = useCallback(() => {
    invoke<PetProbe>('pet_probe')
      .then((p) => {
        try {
          window.localStorage.setItem(POS_KEY, JSON.stringify({ x: p.wx, y: p.wy }))
        } catch {
          /* ignore */
        }
      })
      .catch(() => {})
  }, [])

  /* 按压收尾:松手/划出窗界共用;按位移分流摸头、拖拽存位、点击反应 */
  const endPress = useCallback(() => {
    const pr = pressRef.current
    if (!pr.down) return
    pr.down = false
    window.clearTimeout(pr.patTimer)
    // 红蛋期松手:不走进点击反应池(别把「哼!」盖成一嗓子叽)
    if (angryRef.current) {
      if (pattingRef.current) endPat()
      return
    }
    // 互动完停一拍再恢复活动(别一松手就被吸引拽走)
    walkRef.current.attract = 0
    walkRef.current.pause = Math.max(walkRef.current.pause, 5)
    // 拖拽收尾:停泵 + 把尾巴上的增量发完
    if (dragRafRef.current) {
      cancelAnimationFrame(dragRafRef.current)
      dragRafRef.current = 0
    }
    const acc = dragAccRef.current
    if (acc.x || acc.y) {
      invoke('pet_move_window', { dx: acc.x, dy: acc.y }).catch(() => {})
      acc.x = 0
      acc.y = 0
    }
    if (pattingRef.current) {
      endPat()
      return
    }
    if (pr.moved) {
      setDragging(false)
      window.clearTimeout(actTimerRef.current)
      actRef.current = null
      setAct(null)
      if (tauri) savePos()
      return
    }
    registerClick()
  }, [endPat, registerClick, savePos, tauri])

  /* 移动大脑:巡游 / 吸引 / 躲避;140ms 一拍。
     感应区 = 窗口本体 ±30px + 窗口上方 170px(在窝边上晃也算);睡着被盯 2 拍会醒。 */
  useEffect(() => {
    const inZone = () => {
      const c = cursorRef.current
      const z = zoneRef.current
      return c.inside && c.lx >= -30 && c.lx <= z.w + 30 && c.ly >= -170 && c.ly <= z.h + 24
    }
    const tick = window.setInterval(() => {
      const st = walkRef.current
      const el = moverRef.current
      const pr = pressRef.current
      // 自愈:拎起动作失去拖拽就立刻收场(扑腾卡 60s 会僵住整只鸡)
      if (actRef.current === 'flail' && !(pr.down && pr.moved)) {
        actRef.current = null
        setAct(null)
      }
      // 按压期间一律站定:摸头/点击时小鸡不再被光标拽来拽去
      if (pr.down || pattingRef.current || actRef.current) return
      if (menuRef.current) return // 菜单开着:站定,别钻进菜单底下被盖住
      if (Date.now() < chimeUntilRef.current) return // 报时钟在台上,小鸡原地立正
      if (lockedRef.current) {
        if (angryRef.current) calmAngry(false) // 站岗优先:红蛋让位
        if (chasePhaseRef.current !== 'idle') abortChase() // 站岗要严肃,锁上即收
        if (nuzzlingRef.current) endNuzzle()
        return
      }
      if (asleepRef.current) {
        // 夜里打盹接管:小剧场/红蛋立即清场
        if (angryRef.current) calmAngry(false)
        if (chasePhaseRef.current !== 'idle') abortChase()
        return
      }
      /* 红蛋:光标在哪边就往反方向跑;贴脸激灵跳、贴边跳过光标换边 */
      if (angryRef.current) {
        if (Date.now() >= angryUntilRef.current) {
          calmAngry(true)
          return
        }
        if (chasePhaseRef.current !== 'idle') abortChase()
        if (nuzzlingRef.current) endNuzzle()
        const now = Date.now()
        const c = cursorRef.current
        const cx = 18 + st.x + CHICK_HALF
        let moved = false
        let boing = false
        if (now >= leapUntilRef.current) {
          let dir = 0
          let step = 0
          if (now < angryJoltRef.current.until) {
            dir = angryJoltRef.current.dir
            step = 9
          } else if (c.inside) {
            const dx = cx - c.lx
            if (Math.abs(dx) < ANGRY_SENSE) {
              dir = dx >= 0 ? 1 : -1
              step = ANGRY_STEP
            }
            // 差 26px 被摸到:原地激灵侧跳,这就是「就是不让你碰」
            if (dir && Math.abs(dx) < 26 && now >= sidestepAtRef.current) {
              const nx = Math.max(WALK_MIN, Math.min(WALK_MAX, st.x + dir * 54))
              if (nx !== st.x) {
                st.x = nx
                moved = true
                boing = true
                sidestepAtRef.current = now + 560
                leapUntilRef.current = now + 190
                const mv = moverRef.current
                if (mv) {
                  mv.style.transition = 'transform 180ms ease-out'
                  window.setTimeout(() => {
                    mv.style.transition = ''
                  }, 200)
                }
                const ck = chickRef.current
                if (ck) {
                  ck.classList.add(s.angryHop)
                  window.setTimeout(() => ck.classList.remove(s.angryHop), 320)
                }
                showBubble('哼!', 700)
              }
              dir = 0
            }
          }
          if (dir && step) {
            const pinned = (st.x <= WALK_MIN + 0.5 && dir < 0) || (st.x >= WALK_MAX - 0.5 && dir > 0)
            if (pinned && c.inside && Math.abs(cx - c.lx) < 64 && now >= leapReadyRef.current) {
              // 被逼到边角:跳过光标换到另一边,不进死角
              const far = Math.max(WALK_MIN, Math.min(WALK_MAX, c.lx - CHICK_HALF + (c.lx < 220 ? 165 : -165)))
              st.x = far
              moved = true
              boing = true
              leapUntilRef.current = now + 500
              leapReadyRef.current = now + ANGRY_LEAP_GAP
              const mv = moverRef.current
              if (mv) {
                mv.style.transition = 'transform 460ms cubic-bezier(.32,.9,.36,1)'
                window.setTimeout(() => {
                  mv.style.transition = ''
                }, 480)
              }
              const ck = chickRef.current
              if (ck) {
                ck.classList.add(s.angryLeap)
                window.setTimeout(() => ck.classList.remove(s.angryLeap), 520)
              }
              showBubble('嗖!', 700)
            } else {
              const nx = Math.max(WALK_MIN, Math.min(WALK_MAX, st.x + dir * step))
              if (nx !== st.x) {
                st.x = nx
                moved = true
              }
            }
          }
        }
        const ck = chickRef.current
        if (ck) ck.classList.toggle(s.angryRun, moved && !boing && Date.now() >= leapUntilRef.current)
        if (el) el.style.transform = `translateX(${st.x}px)`
        return
      }
      /* 右键让位冲刺:鸡居中放不下横幅时,快速退到近端安全位(16px/拍 ≈ 2 倍巡游速;到位后由 menuWait 展开横幅) */
      if (st.dash) {
        if (chasePhaseRef.current !== 'idle') abortChase()
        const ddx = st.dash.x - st.x
        if (Math.abs(ddx) <= 8) st.dash = null
        else st.x += Math.max(-16, Math.min(16, ddx))
        if (el) el.style.transform = `translateX(${st.x}px)`
        return
      }
      if (chasePhaseRef.current !== 'idle') {
        // 小剧场接管移动大脑:spot/settle 靠关键帧,run 每拍推进
        if (chasePhaseRef.current === 'run') chaseTick()
        if (el) el.style.transform = `translateX(${st.x}px)`
        return
      }
      if (inZone() && cursorRef.current.ly > 0) st.attract += 1
      else st.attract = 0
      if (st.attract >= 2) {
        // 被光标吸引:先歪头打个招呼,凑到跟前 → 蹭蹭头(贴住持续,光标挪走即停)
        if (asleepRef.current) {
          asleepRef.current = false
          setAsleep(false)
        }
        const target = Math.max(WALK_MIN, Math.min(WALK_MAX, cursorRef.current.lx - CHICK_HALF))
        const dx = target - st.x
        if (Math.abs(dx) > 8) {
          if (nuzzlingRef.current) endNuzzle()
          if (!st.notice) {
            st.notice = true
            if (Date.now() - st.curiousAt > 4000) {
              st.curiousAt = Date.now()
              perform('curious')
            }
          }
          st.x += Math.max(-6, Math.min(6, dx))
        } else if (!nuzzlingRef.current) {
          st.notice = false
          nuzzlingRef.current = true
          setNuzzling(true)
        }
      } else {
        st.notice = false
        if (nuzzlingRef.current) endNuzzle()
        if (asleepRef.current) return
        if (st.pause > 0) st.pause -= 1
        else {
          // 计划节律:今天剩得越多走得越急,全清之后放慢松下来
          const left = planRef.current.remaining
          const pace = left >= 4 ? 4.2 : left <= 0 ? 2.1 : 3.1
          st.x += st.dir * pace
          if (st.x >= WALK_MAX) {
            st.x = WALK_MAX
            st.dir = -1
            st.pause = 8 + Math.floor(Math.random() * 16)
          } else if (st.x <= WALK_MIN) {
            st.x = WALK_MIN
            st.dir = 1
            st.pause = 8 + Math.floor(Math.random() * 16)
          } else if (Math.random() < 0.015) {
            st.pause = 6 + Math.floor(Math.random() * 18)
          }
        }
        // 无聊掷骰:空闲 ≥30s + 白天 + 开关开 + 日上限内,期望 ~35s 后开演
        if (
          Date.now() - lastInteractRef.current >= CHASE_IDLE_MS &&
          !nightRef.current &&
          Math.random() < 0.004
        ) {
          const f = loadChase()
          if ((f.on ?? true) && f.n < CHASE_MAX_DAY) startChase()
        }
      }
      if (el) el.style.transform = `translateX(${st.x}px)`
    }, 140)
    return () => window.clearInterval(tick)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* 点击穿透动态命中:光标落在小鸡/菜单上才收穿透 */
  useEffect(() => {
    if (!tauri) return
    let stop = false
    const tick = () => {
      if (stop) return
      if (!(pressRef.current.down && pressRef.current.moved)) {
        invoke<PetProbe>('pet_probe')
          .then((p) => {
            if (stop) return
            const lx = (p.cx - p.wx) / p.scale
            const ly = (p.cy - p.wy) / p.scale
            const zw = p.ww / p.scale
            const zh = p.wh / p.scale
            zoneRef.current = { w: zw, h: zh }
            cursorRef.current = {
              lx,
              ly,
              inside: lx >= -30 && lx <= zw + 30 && ly >= -170 && ly <= zh + 24,
            }
            let over = menuRef.current
            const el = chickRef.current
            if (el) {
              const r = el.getBoundingClientRect()
              over = over || (lx >= r.left && lx <= r.right && ly >= r.top && ly <= r.bottom)
            }
            // 纸条展开时,纸条本体也算命中区(否则悬停纸条会掉穿透)
            const card = reportPhaseRef.current === 'open' ? cardRef.current : null
            if (card) {
              const r = card.getBoundingClientRect()
              over = over || (lx >= r.left && lx <= r.right && ly >= r.top && ly <= r.bottom)
            }
            if (over !== clickThroughRef.current) {
              clickThroughRef.current = over
              invoke('pet_set_click_through', { on: !over }).catch(() => {})
            }
          })
          .catch(() => {})
      }
      window.setTimeout(tick, 130)
    }
    tick()
    return () => {
      stop = true
    }
  }, [tauri])

  /* 浏览器预览:mousemove 喂光标(Tauri 侧由 probe 喂) */
  useEffect(() => {
    if (tauri) return
    const move = (e: MouseEvent) => {
      zoneRef.current = { w: window.innerWidth, h: window.innerHeight }
      cursorRef.current = { lx: e.clientX, ly: e.clientY, inside: true }
    }
    const leave = () => {
      cursorRef.current.inside = false
    }
    window.addEventListener('mousemove', move)
    document.documentElement.addEventListener('mouseleave', leave)
    return () => {
      window.removeEventListener('mousemove', move)
      document.documentElement.removeEventListener('mouseleave', leave)
    }
  }, [tauri])

  /* 按压状态机:拎起 / 摸头 / 点击分流 */
  useEffect(() => {
    /** 一帧一次把攒下的增量发给 Rust,拖完(按压结束)即停泵 */
    const pumpDrag = () => {
      dragRafRef.current = 0
      const acc = dragAccRef.current
      if (acc.x || acc.y) {
        invoke('pet_move_window', { dx: acc.x, dy: acc.y }).catch(() => {})
        acc.x = 0
        acc.y = 0
      }
      if (pressRef.current.down && pressRef.current.moved) {
        dragRafRef.current = requestAnimationFrame(pumpDrag)
      }
    }
    const move = (e: MouseEvent) => {
      if (!tauri) cursorRef.current = { lx: e.clientX, ly: e.clientY, inside: true }
      const pr = pressRef.current
      if (!pr.down) return
      const dx = e.clientX - pr.x
      const dy = e.clientY - pr.y
      if (!pr.moved && Math.abs(dx) + Math.abs(dy) >= 5) {
        pr.moved = true
        window.clearTimeout(pr.patTimer)
        if (pattingRef.current) endPat()
        if (nuzzlingRef.current) endNuzzle()
        setDragging(true)
        perform('flail')
      }
      if (pr.moved) {
        if (tauri) {
          // 增量只攒账,rAF 一帧送一次 IPC:窗口移动不再被事件频率抖成抽搐
          dragAccRef.current.x += dx
          dragAccRef.current.y += dy
          if (!dragRafRef.current) {
            dragRafRef.current = requestAnimationFrame(pumpDrag)
          }
        }
      }
      pr.x = e.clientX
      pr.y = e.clientY
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', endPress)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', endPress)
    }
  }, [tauri, perform, endPat, endPress])

  const onChickMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    // 红蛋期不让摸:按下即弹开(不进入按压/摸头/拖拽)
    if (angryRef.current) {
      e.preventDefault()
      pokeAngry()
      return
    }
    if (asleepRef.current) {
      // 拎起来/摸一把就醒;夜里这一下记成「轻醒」,松手打哈欠
      asleepRef.current = false
      setAsleep(false)
      pressRef.current.wasAsleep = true
    } else {
      pressRef.current.wasAsleep = false
    }
    pressRef.current.down = true
    pressRef.current.x = e.clientX
    pressRef.current.y = e.clientY
    pressRef.current.moved = false
    // 按下即站定:清吸引/招呼/蹭蹭/小剧场,别让小鸡边被摸边挪窝
    walkRef.current.attract = 0
    walkRef.current.notice = false
    if (nuzzlingRef.current) endNuzzle()
    lastInteractRef.current = Date.now()
    if (chasePhaseRef.current !== 'idle') abortChase()
    window.clearTimeout(pressRef.current.patTimer)
    pressRef.current.patTimer = window.setTimeout(() => {
      if (pressRef.current.down && !pressRef.current.moved) startPat()
    }, 400)
    e.preventDefault()
  }

  const onChickDoubleClick = () => {
    clickTimesRef.current = []
    if (tauri) invoke('focus_main_window').catch(() => {})
  }

  /** 关菜单:顺带清让位等待与冲刺残留(点空白/再右键/选菜单项三路都走这里) */
  const closeMenu = () => {
    if (menuWaitRef.current) {
      window.clearInterval(menuWaitRef.current)
      menuWaitRef.current = 0
    }
    walkRef.current.dash = null
    setMenu(false)
    menuRef.current = false
  }

  const onMenuSelect = (what: 'hide' | 'home' | 'main' | 'hud') => {
    closeMenu()
    if (what === 'hide') {
      invoke('pet_close').catch(() => {})
    } else if (what === 'hud') {
      setHudOn((prev) => {
        const next = !prev
        try {
          window.localStorage.setItem('pet-hud', next ? '1' : '0')
        } catch {
          /* ignore */
        }
        return next
      })
    } else if (what === 'home') {
      invoke<{ x: number; y: number }>('pet_home_position')
        .then((p) => {
          try {
            window.localStorage.removeItem(POS_KEY)
          } catch {
            /* ignore */
          }
          return invoke('pet_set_position', { x: p.x, y: p.y })
        })
        .catch(() => {})
    } else {
      invoke('focus_main_window').catch(() => {})
    }
  }

  /* 开发钩子 */
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return
    ;(window as unknown as { __pet?: unknown }).__pet = {
      act: (a: Act) => perform(a),
      egg: () => {
        addEgg()
        showBubble('又下一颗蛋!')
      },
      sleep: (v: boolean) => {
        asleepRef.current = v
        setAsleep(v)
      },
      lock: (v: boolean) => {
        lockedRef.current = v
        setLocked(v)
      },
      pos: (x: number) => {
        walkRef.current.x = x
      },
      chime: () => chimeNow(true),
      angry: (v: boolean) => {
        if (v) goAngry()
        else calmAngry(false)
      },
      pats: () => patStreakRef.current,
      sign: (variant: SignVariant, title: string, sub: string, tag?: 'review') =>
        showSign({ variant, title, sub, tag }),
      study: () => studyTick(),
      night: (v: boolean) => {
        nightRef.current = v
        setNight(v)
        asleepRef.current = v && !lockedRef.current
        setAsleep(asleepRef.current)
      },
      report: () => ({ phase: reportPhaseRef.current, resized: reportResizedRef.current, chase: chasePhaseRef.current }),
      chase: () => startChase(),
      probe: () => invoke<PetProbe>('pet_probe').catch(() => null),
      /** 注入假性能数据(浏览器预览/验收用):perf({cpu:96,mem:70,gpu:20}) */
      perf: (p: Perf1) => applyPerf(p),
      hud: (on: boolean) => {
        setHudOn(on)
        try {
          window.localStorage.setItem('pet-hud', on ? '1' : '0')
        } catch {
          /* ignore */
        }
      },
    }
  }, [perform, addEgg, showBubble, chimeNow, startChase, applyPerf, goAngry, calmAngry, studyTick])

  const actCls = [
    act
      ? {
          hop1: s.aHop1,
          hop3: s.aHop3,
          sad: s.aSad,
          wave: s.aWave,
          chirp: s.aChirp,
          flail: s.aFlail,
          curious: s.aCurious,
          shiver: s.aShiver,
          shake: s.aShake,
          yawn: s.aYawn,
          urge: s.aUrge,
          stomp: s.aStomp,
        }[act]
      : '',
    chaseJump ? s.chaseJump : '',
  ]
    .filter(Boolean)
    .join(' ')

  /** 过热档位:红蛋期间不再叠热度动作(蛋里没有小鸡) */
  const hot = perf ? Math.max(perf.cpu, perf.mem, perf.gpu ?? 0) : 0
  const crit = hot >= 90
  // 温度也参与热度:≥75°C 微热、≥85°C 发烧(与占用率档取高者)
  const tempTier = perf?.gpuTemp == null ? 0 : perf.gpuTemp >= 85 ? 2 : perf.gpuTemp >= 75 ? 1 : 0
  const occTier = hot >= 90 ? 2 : hot >= 80 ? 1 : 0
  const heatTier = eggMode || ultimate ? 0 : Math.max(tempTier, occTier)
  const showHud = hudOn || crit
  // 角标横幅摆位跟随小鸡(与地面平行的单行横幅):每 350ms 按当前 x 重算一次。
  // 宽度用实测 offsetWidth(随「温度 —/有值」会变);右侧放不下翻左侧,
  // 两侧都放不下就保持上一侧(窗口 440 下实测宽度可保证任意站位至少一侧贴得下)。
  useEffect(() => {
    if (!showHud) return
    const calc = () => {
      const x = walkRef.current.x
      const vw = window.innerWidth
      const W = hudRef.current?.offsetWidth ?? 170
      if (x + 84 + W <= vw - 4) {
        setHudSide((prev) => (prev === 'right' ? prev : 'right'))
      } else if (x - 10 - W >= 0) {
        setHudSide((prev) => (prev === 'left' ? prev : 'left'))
      }
      // 两侧都卡边:保持当前侧不动(避免来回跳)
    }
    calc()
    const id = window.setInterval(calc, 350)
    return () => window.clearInterval(id)
  }, [showHud])
  const perfName = perf ? (perf.cpu >= perf.mem && perf.cpu >= (perf.gpu ?? 0) ? 'CPU' : perf.mem >= (perf.gpu ?? 0) ? '内存' : 'GPU') : 'CPU'

  const rootCls = [
    s.root,
    night && s.night,
    heatTier === 1 && !angry && s.heat1,
    heatTier === 2 && !angry && s.heat2,
    eggMode && s.eggOn,
    ultimate && s.ult,
    hatching && s.eggHatch,
    still && s.still,
    locked && s.sentry,
    asleep && s.asleep,
    dragging && s.drag,
    patting && s.pat,
    angry && s.angry,
    nuzzling && s.nuz,
    reportPhase === 'pulling' && s.reportPulling,
    reportPhase === 'open' && s.reportOpen,
    (overdue || act === 'stomp') && s.stare,
    act && s.perf,
  ]
    .filter(Boolean)
    .join(' ')

  const shownEggs = Math.min(eggs, EGG_SHOW)

  return (
    <div
      className={rootCls}
      // 菜单开着时窗口整体收穿透,这里能收到全部窗内点击:点空白(非菜单/非鸡)即关
      onMouseDown={(e) => {
        if (!menuRef.current) return
        const t = e.target as HTMLElement
        if (t.closest('[data-menu],[data-chick-hit]')) return
        closeMenu()
      }}
    >
      {/* 防不透明底:root layout 的 body 带 bg-background 类,必须 !important 才压得过 */}
      <style>{'html,body{background:transparent!important;margin:0;overflow:hidden}'}</style>
      {/* 整点报时改为鸡头气泡(2026-11-20 用户挑 B),不再挂挂钟 */}
      <div className={s.ground} />
      {/* 举牌:到点 / 濒临 ≤10 分 / 逾期(红牌+皱眉) */}
      {sign ? (
        <div
          className={`${s.signCard} ${sign.variant === 'warn' ? s.signWarn : sign.variant === 'bad' ? s.signBad : ''}`}
          onClick={() => {
            if (sign.tag === 'review') openReview()
            else setSign(null)
          }}
        >
          {sign.variant === 'bad' ? <span className={s.signFlag} /> : null}
          <div className={s.signTitle}>
            {sign.tag === 'review' ? <span className={s.signTag}>复习</span> : null}
            {sign.title}
          </div>
          <div className={s.signSub}>{sign.sub}</div>
          <span className={s.signStick} />
        </div>
      ) : null}
      {/* 自娱小剧场:鸟在窗外入镜,障碍蹲在跑道上;全部 pointer-events:none,命中区不受影响 */}
      <div ref={birdElRef} className={s.chaseBird} style={{ display: 'none', transform: 'translate(-80px, 26px)' }} aria-hidden>
        <ChaseBirdSvg />
      </div>
      {chaseRocks.map((r, i) => (
        <svg key={i} className={`${s.chaseRock} ${r.shown ? s.chaseRockShow : ''}`} style={{ left: r.x }} viewBox="0 0 26 20" aria-hidden>
          <path d="M4 16 L7 8 L14 5 L21 9 L23 16 Z" fill="#c9c2b2" stroke="#a89f8a" strokeWidth={2} strokeLinejoin="round" />
        </svg>
      ))}
      {chaseStars ? (
        <div className={`${s.chaseStars} ${s.chaseStarsOn}`} style={{ left: chaseStarsAt }} aria-hidden>
          <svg viewBox="-8 -8 16 16" width="26" height="26" style={{ left: 4, top: 2 }}>
            <path d="M0 -7 L1.9 -1.9 L7 0 L1.9 1.9 L0 7 L-1.9 1.9 L-7 0 L-1.9 -1.9 Z" fill="#f5b93c" />
          </svg>
          <svg viewBox="-8 -8 16 16" width="20" height="20" style={{ left: 52, top: 20 }}>
            <path d="M0 -7 L1.9 -1.9 L7 0 L1.9 1.9 L0 7 L-1.9 1.9 L-7 0 L-1.9 -1.9 Z" fill="#f28a9b" />
          </svg>
          <svg viewBox="-8 -8 16 16" width="16" height="16" style={{ left: 26, top: 36 }}>
            <path d="M0 -7 L1.9 -1.9 L7 0 L1.9 1.9 L0 7 L-1.9 1.9 L-7 0 L-1.9 -1.9 Z" fill="#7da7d9" />
          </svg>
        </div>
      ) : null}
      <div className={s.eggs} aria-hidden>
        {Array.from({ length: shownEggs }, (_, i) => (
          <EggSvg key={i} />
        ))}
      </div>
      {/* 执勤小报告:拽拉绳 + 纸条(监管模式悬停触发) */}
      {reportPhase === 'pulling' ? (
        <div className={s.reportRope} style={{ left: reportAnchorRef.current - 1 }} />
      ) : null}
      {reportPhase === 'open' ? (
        <div className={s.reportCard} ref={cardRef} style={{ left: Math.max(8, Math.min(440 - 320, reportAnchorRef.current - 156)) }}>
          <div className={s.reportBand}>
            <b>今日学习报告</b>
            <span className={s.reportDate}>{chickToday().slice(5).replace('-', '/')} 周{'日一二三四五六'[new Date().getDay()]}</span>
          </div>
          <div className={s.reportStamp}>执勤</div>
          <div className={s.reportBody}>
            {!reportData ? (
              <div className={s.reportRow}>…</div>
            ) : reportData.empty ? (
              <div className={s.reportEmpty}>
                <div className={s.reportEmptyBox}>今天还没有安排</div>
                <div className={s.reportEmptyGo}>
                  去主窗 <b>写一条计划</b>,我来盯
                </div>
              </div>
            ) : (
              <>
                {reportData.goals.length ? (
                  <>
                    <div className={s.reportSec}>今日目标</div>
                    {reportData.goals.slice(0, 3).map((g, i) => (
                      <div key={i} className={`${s.reportRow} ${g.done ? s.reportDone : ''}`}>
                        <button
                          type="button"
                          className={s.reportCheck}
                          aria-label={g.done ? '取消完成' : '标记完成'}
                          onClick={() => toggleDone(g)}
                        >
                          <span className={s.reportBox} />
                        </button>
                        <span className={s.reportTxt}>{g.title}</span>
                        <span className={s.reportActs}>
                          <button
                            type="button"
                            className={s.reportIc}
                            title="顺延到明天"
                            onClick={() => postponeItem(g)}
                          >
                            <svg viewBox="0 0 16 16" aria-hidden>
                              <path d="M3 8h8" />
                              <path d="M8 5l3 3-3 3" />
                            </svg>
                          </button>
                        </span>
                      </div>
                    ))}
                  </>
                ) : null}
                {reportData.plans.length ? (
                  <>
                    <div className={s.reportSec}>接下来</div>
                    {reportData.plans.map((p, i) => (
                      <div key={i} className={`${s.reportRow} ${p.done ? s.reportDone : ''} ${p.past ? s.reportPast : ''} ${p.now ? s.reportNow : ''}`}>
                        <span className={s.reportTm}>{p.time}</span>
                        <button
                          type="button"
                          className={s.reportCheck}
                          aria-label={p.done ? '取消完成' : '标记完成'}
                          onClick={() => toggleDone(p)}
                        >
                          <span className={s.reportBox} />
                        </button>
                        <span className={s.reportTxt}>{p.title}</span>
                        <span className={s.reportActs}>
                          {p.postponeCount >= 2 ? <em className={s.reportLate}>拖 {p.postponeCount} 次</em> : null}
                          <button
                            type="button"
                            className={s.reportIc}
                            title="顺延到明天"
                            onClick={() => postponeItem(p)}
                          >
                            <svg viewBox="0 0 16 16" aria-hidden="true">
                              <path d="M3 8h8" />
                              <path d="M8 5l3 3-3 3" />
                            </svg>
                          </button>
                        </span>
                      </div>
                    ))}
                  </>
                ) : null}
              </>
            )}
          </div>
          {reportData && !reportData.empty ? (
            <div className={s.reportFoot}>
              <span className={s.reportBar}>
                {Array.from({ length: Math.max(1, reportData.total) }, (_, i) => (
                  <i key={i} className={i < reportData.doneCount ? s.reportOn : ''} />
                ))}
              </span>
              <span>
                {reportData.doneCount >= reportData.total && reportData.total > 0 ? (
                  <b>全部清完!</b>
                ) : (
                  <>
                    已完成 <b>{reportData.doneCount} / {reportData.total}</b>
                  </>
                )}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className={s.mover} ref={moverRef} style={{ transform: 'translateX(20px)' }}>
        <div
          ref={chickRef}
          className={s.chickBox}
          data-chick-hit
          onMouseDown={onChickMouseDown}
          onDoubleClick={onChickDoubleClick}
          onContextMenu={(e) => {
            e.preventDefault()
            // 再右键 = 关(toggle);同时清掉上一轮让位等待
            if (menuRef.current) {
              closeMenu()
              return
            }
            if (menuWaitRef.current) {
              window.clearInterval(menuWaitRef.current)
              menuWaitRef.current = 0
            }
            // 横幅与鸡身平行并排(宽侧优先,从鸡侧拉开);
            // 鸡居中两侧都放不下时,先快速让位到近端安全位,到位后再展开
            const vw = window.innerWidth
            const fits = (r: DOMRect) =>
              r.right + 10 + MENU_W <= vw - 8 || r.left - 10 - MENU_W >= 8
            const openAt = (r: DOMRect) => {
              const cx = r.left + r.width / 2
              const left = cx < vw / 2 ? r.right + 10 : r.left - MENU_W - 10
              setMenuLeft(Math.max(8, Math.min(vw - MENU_W - 8, left)))
              setMenuOrigin(cx < vw / 2 ? 'left bottom' : 'right bottom')
              setMenu(true)
              menuRef.current = true
            }
            const el = moverRef.current
            if (!el) return
            const r0 = el.getBoundingClientRect()
            if (fits(r0)) {
              openAt(r0)
              return
            }
            const st = walkRef.current
            st.dash = { x: r0.left + r0.width / 2 < vw / 2 ? 110 : 220 }
            if (menuWaitRef.current) window.clearInterval(menuWaitRef.current)
            menuWaitDeadlineRef.current = Date.now() + 1500
            menuWaitRef.current = window.setInterval(() => {
              const el2 = moverRef.current
              if (!el2) {
                window.clearInterval(menuWaitRef.current)
                menuWaitRef.current = 0
                return
              }
              const r = el2.getBoundingClientRect()
              const ok = fits(r)
              if (ok || Date.now() > menuWaitDeadlineRef.current) {
                window.clearInterval(menuWaitRef.current)
                menuWaitRef.current = 0
                walkRef.current.dash = null // 超时兜底:停在当前位,夹窗内展开
                openAt(r)
              } else if (walkRef.current.dash == null) {
                // 让位被别的行为打断:重新指路
                walkRef.current.dash = {
                  x: r.left + r.width / 2 < window.innerWidth / 2 ? 110 : 220,
                }
              }
            }, 60)
          }}
          onMouseLeave={() => {
            // 按住拖出窗口边界:按按压收尾处理,避免卡在拎起/摸头态
            if (pressRef.current.down) endPress()
          }}
        >
          <ChickSvg cls={actCls} />
          {/* 过热缩回红蛋:盖在小鸡原位,小鸡淡出 */}
          {eggMode ? <HotEgg label={perfName} /> : null}
          {/* 终极形态:CPU 与内存双高 → 熔岩蛋 */}
          {ultimate ? <LavaEgg /> : null}
        </div>
        {/* 气泡挂在 mover 里跟着小鸡走(尾巴恒指鸡头顶);穿透命中按 chickRef 判,气泡 pointer-events:none 无影响 */}
        {bubble ? <div className={`${s.bubble} ${s.bubbleShow}`}>{bubble}</div> : null}
        {/* 整点报时横幅(C 案 2026-11-20 用户最终挑定):大号时间横幅贴鸡旁,
            左 26px 大字时刻 + 右列「整点啦 / 起来活动一下」;随小鸡移动,三向避让 */}
        {chimeBanner ? (
          <div
            className={`${s.chimeBanner} ${
              chimeBanner.side === 'left' ? s.chimeBannerLeft : chimeBanner.side === 'top' ? s.chimeBannerTop : ''
            } ${s.chimeBannerShow}`}
            aria-hidden
          >
            <span className={s.chimeBannerTime}>{chimeBanner.label}</span>
            <span className={s.chimeBannerCol}>
              <span className={s.chimeBannerTitle}>整点啦</span>
              <span className={s.chimeBannerHint}>起来活动一下</span>
            </span>
          </div>
        ) : null}
        {/* 性能角标(2026-11-20 用户口径):保持原来的「标签 + 竖条 + 数值」三/四列样式,
            但不再钉在右下角(会被漫步小鸡压住),改成贴在小鸡侧面、与地面平行、
            跟着小鸡走;右侧放不下翻左侧(实测宽度下任意站位都至少一侧贴得下)。 */}
        {showHud ? (
          <div
            className={`${s.hud} ${hudSide === 'left' ? s.hudLeft : ''} ${crit ? s.hudAlert : ''}`}
            ref={hudRef}
            aria-hidden
          >
            {(
              [
                ['CPU', perf?.cpu ?? 0, 80, 90, ''],
                ['内存', perf?.mem ?? 0, 80, 90, ''],
                ['GPU', perf?.gpu ?? null, 80, 90, ''],
                ['温度', perf?.gpuTemp ?? null, 75, 85, '°'],
              ] as Array<[string, number | null, number, number, string]>
            ).map(([label, v, warn, danger, unit]) => (
              <div key={label} className={s.hudCol}>
                <span className={s.hudM}>{label}</span>
                <span className={s.hudTrack}>
                  <i
                    className={s.hudFill}
                    style={{
                      height: `${Math.max(0, Math.min(100, v ?? 0))}%`,
                      background: v == null ? 'transparent' : v >= danger ? '#e05a4a' : v >= warn ? '#e8a23c' : '#8fb96e',
                    }}
                  />
                </span>
                <span className={s.hudV}>{v == null ? '—' : Math.round(v) + unit}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {menu ? (
        <div className={s.menu} data-menu style={{ left: menuLeft, transformOrigin: menuOrigin }}>
          <button type="button" className={s.menuItem} onClick={() => onMenuSelect('main')}>
            打开 aichatt
          </button>
          <button type="button" className={s.menuItem} onClick={() => onMenuSelect('home')}>
            回到角落
          </button>
          <button type="button" className={s.menuItem} onClick={() => onMenuSelect('hide')}>
            收起小鸡
          </button>
          <button type="button" className={s.menuItem} onClick={() => onMenuSelect('hud')}>
            {hudOn ? '隐藏性能角标' : '显示性能角标'}
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** 蛋壳宝宝(与 CrayonChick C 案同一只),部位分组以便 CSS 驱动 */
function ChickSvg({ cls }: { cls: string }) {
  return (
    <svg className={`${s.chickSvg} ${cls}`} viewBox="0 0 64 64" aria-hidden>
      <g className={s.ckAll}>
        <g>
          <path d="M27 18.8 l2.4 -5.8 3 5.2" style={{ stroke: 'var(--ck-line)' }} strokeWidth={2.4} fill="none" strokeLinecap="round" />
          <path d="M34.5 18.6 l3.4 -5.6 1.6 6" style={{ stroke: 'var(--ck-line)' }} strokeWidth={2.2} fill="none" strokeLinecap="round" />
        </g>
        <ellipse className={s.bodyFill} cx="32" cy="34" rx="18.5" ry="15.5" style={{ fill: 'var(--ck-body)' }} />
        <ellipse cx="32" cy="34" rx="18.5" ry="15.5" style={{ stroke: 'var(--ck-line)' }} strokeWidth={2.2} fill="none" />
        <g className={s.handL}>
          <path d="M13.5 38 q-4.5 1.5 -3 5.5 q1.5 3.5 5.5 3" style={{ stroke: 'var(--ck-line)' }} strokeWidth={2} fill="none" strokeLinecap="round" />
        </g>
        <g className={s.handR}>
          <path d="M50.5 38 q4.5 1.5 3 5.5 q-1.5 3.5 -5.5 3" style={{ stroke: 'var(--ck-line)' }} strokeWidth={2} fill="none" strokeLinecap="round" />
        </g>
        {/* 监管执勤装(仅 .sentry 显形):红袖章钉右翅 */}
        <g className={s.armband} transform="translate(49.8 40.8) rotate(-18)">
          <rect x="-5.2" y="-3.6" width="10.4" height="7.2" rx="2.8" style={{ fill: '#f2635a' }} stroke="#d94a3f" strokeWidth={1.8} />
          <path d="M0 -3.4 L1 -1 L3.4 -0.8 L1.5 0.8 L2.1 3.2 L0 1.8 L-2.1 3.2 L-1.5 0.8 L-3.4 -0.8 L-1 -1 Z" style={{ fill: '#ffe08a' }} />
        </g>
        {/* 监管严肃粗眉(内低外高,压着眼上沿) */}
        <g className={s.brows}>
          <path d="M23 26.4 L28.6 28.2" style={{ stroke: 'var(--ck-eye)' }} strokeWidth={2.1} fill="none" strokeLinecap="round" />
          <path d="M41 26.4 L35.4 28.2" style={{ stroke: 'var(--ck-eye)' }} strokeWidth={2.1} fill="none" strokeLinecap="round" />
        </g>
        <g className={s.open}>
          <g className={s.eye}>
            <ellipse cx="26.8" cy="31.2" rx="2.2" ry="2.7" style={{ fill: 'var(--ck-eye)' }} />
            <circle cx="27.6" cy="30.2" r=".85" fill="#fff" />
            <circle cx="26" cy="32.4" r=".45" fill="#fff" opacity={0.75} />
          </g>
          <g className={s.eye}>
            <ellipse cx="37.2" cy="31.2" rx="2.2" ry="2.7" style={{ fill: 'var(--ck-eye)' }} />
            <circle cx="38" cy="30.2" r=".85" fill="#fff" />
            <circle cx="36.4" cy="32.4" r=".45" fill="#fff" opacity={0.75} />
          </g>
        </g>
        <g className={s.shut}>
          <path d="M24.4 31.4 q2.4 2.2 4.8 0" style={{ stroke: 'var(--ck-eye)' }} strokeWidth={1.8} fill="none" strokeLinecap="round" />
          <path d="M34.8 31.4 q2.4 2.2 4.8 0" style={{ stroke: 'var(--ck-eye)' }} strokeWidth={1.8} fill="none" strokeLinecap="round" />
        </g>
        <ellipse className={s.blush} cx="20.8" cy="36.5" rx="3.9" ry="2.5" style={{ fill: 'var(--ck-blush)' }} />
        <ellipse className={s.blush} cx="43.2" cy="36.5" rx="3.9" ry="2.5" style={{ fill: 'var(--ck-blush)' }} />
        <path d="M29.7 35.4 q2.4 -2 4.7 0 q-.85 2.5 -2.35 2.5 q-1.5 0 -2.35 -2.5 z" style={{ fill: 'var(--ck-beak)' }} />
        <path
          d="M13.5 44 q4.7 -4.2 9.6 0 q4.9 4.2 9.7 0 q4.7 -4.2 9.6 0 q4.8 4.2 9.6 0 l-.4 6.5 q-.5 6.5 -7.5 6.5 h-22.8 q-7 0 -7.5 -6.5 z"
          style={{ fill: 'var(--ck-shell)' }}
          stroke="var(--ck-line)"
          strokeWidth={2.2}
          strokeLinejoin="round"
        />
        <circle cx="26" cy="52" r="1.5" style={{ fill: 'var(--ck-blush)' }} opacity={0.8} />
        <circle cx="37" cy="54" r="1.2" style={{ fill: 'var(--ck-line)' }} opacity={0.45} />
        {/* 80% 微热:额角一滴汗 + 小扇子 */}
        <g className={s.heat1Fx}>
          <path d="M46 20 q2.4 3.6 0 4.9 q-2.4 -1.3 0 -4.9 z" style={{ fill: '#a8d0ec' }} stroke="#7da7d9" strokeWidth={1.1} />
          <g className={s.fan} transform="translate(52 40)">
            <path d="M0 0 L11 -7 A9 9 0 0 1 11 7 Z" style={{ fill: '#ffe9a8' }} stroke="var(--ck-line)" strokeWidth={1.5} strokeLinejoin="round" />
            <path d="M0 0 L11 -7 M0 0 L13 0 M0 0 L11 6" style={{ stroke: 'var(--ck-line)' }} strokeWidth={0.9} opacity={0.6} />
          </g>
        </g>
        {/* 90% 发烧:一缕热气(腮红在 .heat2 下加深) */}
        <g className={s.heat2Fx}>
          <path className={s.wisp} d="M32 15 q-4 -5 0 -9 q4 -4 0 -8" style={{ stroke: '#e05a4a' }} strokeWidth={2} fill="none" strokeLinecap="round" opacity={0.55} />
        </g>
        <g className={s.zzz}>
          <g transform="translate(46 12)">
            <g className={s.z}>
              <path d="M0 6 h6 l-6 6 h6" style={{ stroke: 'var(--ck-line)' }} strokeWidth={1.8} fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </g>
          </g>
          <g transform="translate(54 4)">
            <g className={`${s.z} ${s.z2}`}>
              <path d="M0 5 h5 l-5 5 h5" style={{ stroke: 'var(--ck-line)' }} strokeWidth={1.6} fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </g>
          </g>
          <g transform="translate(61 -3)">
            <g className={`${s.z} ${s.z3}`}>
              <path d="M0 4 h4.4 l-4.4 4.4 h4.4" style={{ stroke: 'var(--ck-line)' }} strokeWidth={1.4} fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </g>
          </g>
        </g>
        <g className={s.notes}>
          <g transform="translate(44 14)">
            <g className={s.nf}>
              <ellipse cx="0" cy="0" rx="3.2" ry="2.6" style={{ fill: 'var(--ck-line)' }} transform="rotate(-18)" />
              <path d="M2.8 -.8 V-12 q4.5 1.5 6 4.5" style={{ stroke: 'var(--ck-line)' }} strokeWidth={1.8} fill="none" strokeLinecap="round" />
            </g>
          </g>
          <g transform="translate(52 6)">
            <g className={`${s.nf} ${s.nf2}`}>
              <ellipse cx="0" cy="0" rx="2.6" ry="2.1" style={{ fill: 'var(--ck-line)' }} transform="rotate(-18)" />
              <path d="M2.3 -.7 V-10 q3.6 1.2 4.8 3.6" style={{ stroke: 'var(--ck-line)' }} strokeWidth={1.6} fill="none" strokeLinecap="round" />
            </g>
          </g>
        </g>
        {/* 撸过头:鼓腮 + 撇嘴 + 怒气符号 + 横向喷气(只有 .angry 显形) */}
        <g className={s.angryExtra}>
          <path className={`${s.cheekPuff} ${s.cheekPuffL}`} d="M14.2 33.4 q-6 1.2 -5.4 6.2 q.6 4 5.6 3.2" />
          <path className={`${s.cheekPuff} ${s.cheekPuffR}`} d="M49.8 33.4 q6 1.2 5.4 6.2 q-.6 4 -5.6 3.2" />
          <path className={s.grumpMouth} d="M28.6 37.6 q1.6 -2.2 3.1 0 q1.5 2.2 3 0" />
          <g className={s.angerMark}>
            <path d="M45.4 17.2 l5.2 5.2" />
            <path d="M50.6 17.2 l-5.2 5.2" />
          </g>
          <g className={s.huff}>
            <path d="M11.6 22.4 q-3.6 1.4 -6.2 .4" />
            <path d="M9.2 26 q-3 1 -5.2 .2" />
          </g>
          <g className={`${s.huff} ${s.huffR}`}>
            <path d="M52.4 22.4 q3.6 1.4 6.2 .4" />
            <path d="M54.8 26 q3 1 5.2 .2" />
          </g>
        </g>
      </g>
    </svg>
  )
}

function EggSvg() {
  return (
    <svg className={s.egg} viewBox="0 0 15 19" aria-hidden>
      <ellipse cx="7.5" cy="9.5" rx="6.4" ry="8.3" style={{ fill: 'var(--ck-shell)' }} stroke="var(--ck-line)" strokeWidth={1.7} />
      <circle cx="5.4" cy="8" r="1.1" style={{ fill: 'var(--ck-blush)' }} opacity={0.8} />
      <circle cx="9.2" cy="11" r="0.9" style={{ fill: 'var(--ck-line)' }} opacity={0.5} />
    </svg>
  )
}

/** 终极形态:CPU 与内存双高 —— 熔岩蛋(蛋壳裂开透光 + 两圈热度波纹) */
function LavaEgg() {
  return (
    <div className={s.lavaEgg}>
      <svg viewBox="0 0 64 64" aria-hidden>
        <defs>
          <radialGradient id="petLava" cx="50%" cy="58%" r="58%">
            <stop offset="0" stopColor="#ffe08a" />
            <stop offset="0.45" stopColor="#ff7a4a" />
            <stop offset="1" stopColor="#b32a1d" />
          </radialGradient>
        </defs>
        <circle className={s.lavaRing} cx="32" cy="36" r="24" fill="none" stroke="#ff7a4a" strokeWidth={2} opacity={0.7} />
        <circle className={`${s.lavaRing} ${s.lavaRing2}`} cx="32" cy="36" r="24" fill="none" stroke="#ff9a5c" strokeWidth={1.6} opacity={0.6} />
        <g className={s.lavaShell}>
          <ellipse cx="32" cy="36" rx="19" ry="22" fill="url(#petLava)" stroke="#8f2318" strokeWidth={2.2} />
          <path className={s.lavaVein} d="M18 30 l7 5 -4 6 7 4 -3 6" stroke="#ffe9a8" strokeWidth={2.4} fill="none" strokeLinejoin="round" />
          <path className={s.lavaVein} d="M46 32 l-6 5 3 6 -6 4" stroke="#ffe9a8" strokeWidth={2} fill="none" strokeLinejoin="round" opacity={0.8} />
          <path className={s.lavaVein} d="M33 20 l-3 7 5 4 -2 6" stroke="#fff3d6" strokeWidth={1.6} fill="none" strokeLinejoin="round" opacity={0.65} />
        </g>
      </svg>
    </div>
  )
}

/** 过热红蛋:≥95% 持续 3s 触发,小鸡缩回壳里;蛋壳上标过热的那个指标名 */
function HotEgg({ label }: { label: string }) {
  return (
    <div className={s.hotEgg}>
      <svg viewBox="0 0 64 64" aria-hidden>
        <defs>
          <linearGradient id="petHotEgg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ff8a6a" />
            <stop offset="0.55" stopColor="#e8543f" />
            <stop offset="1" stopColor="#c73a2e" />
          </linearGradient>
        </defs>
        <g className={s.eggSteam}>
          <path d="M24 12 q-3 -6 1 -10 q3 -3 1 -7" style={{ stroke: '#e05a4a' }} strokeWidth={2} fill="none" strokeLinecap="round" opacity={0.6} />
        </g>
        <g className={`${s.eggSteam} ${s.eggSteam2}`}>
          <path d="M40 11 q3 -6 -1 -10 q-3 -3 -1 -7" style={{ stroke: '#e05a4a' }} strokeWidth={2} fill="none" strokeLinecap="round" opacity={0.45} />
        </g>
        <g className={s.eggShell}>
          <ellipse cx="32" cy="36" rx="19" ry="22" fill="url(#petHotEgg)" stroke="#a92f26" strokeWidth={2.2} />
          <ellipse cx="25" cy="27" rx="4.6" ry="3.4" fill="#ffb59f" opacity={0.65} transform="rotate(-20 25 27)" />
          <circle cx="38" cy="30" r="1.6" fill="#a92f26" opacity={0.55} />
          <circle cx="27" cy="37" r="1.2" fill="#a92f26" opacity={0.45} />
          <text x="32" y="45" textAnchor="middle" fontSize="7.5" fill="#ffe8d6" opacity={0.9} fontWeight={700}>
            {label}
          </text>
        </g>
        <g className={s.eggCrack}>
          <path d="M17 30 l6 4 -3 5 6 3 -2 6" style={{ stroke: '#fff3d6' }} strokeWidth={2.2} fill="none" strokeLinejoin="round" />
          <path d="M47 32 l-5 4 3 5 -5 3" style={{ stroke: '#fff3d6' }} strokeWidth={2} fill="none" strokeLinejoin="round" opacity={0.8} />
        </g>
      </svg>
    </div>
  )
}

/** 蜡笔小鸟(自娱小剧场追捕对象,色系独立不跟昼夜变量;样式源 design/preview-chick-chase.html) */
function ChaseBirdSvg() {
  return (
    <svg viewBox="0 0 40 34" aria-hidden>
      <g className={s.chaseBirdWing}>
        <path d="M9 26 L2 22 L9 19" fill="none" stroke="#5f8cb8" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        <ellipse cx="21" cy="18" rx="13" ry="9.5" fill="#eaf2fb" stroke="#5f8cb8" strokeWidth={2.2} />
        <path d="M8 14 Q14 4 24 7 Q30 9 30 14 Z" fill="#7da7d9" stroke="#5f8cb8" strokeWidth={2} strokeLinejoin="round" />
        <path d="M12 13 Q17 6 25 9" fill="none" stroke="#5f8cb8" strokeWidth={1.6} strokeLinecap="round" />
        <path d="M33 17 L39 19 L33 21 Z" fill="#7da7d9" stroke="#5f8cb8" strokeWidth={1.8} strokeLinejoin="round" />
        <circle cx="27" cy="14.5" r="1.7" fill="#4a3a28" />
      </g>
    </svg>
  )
}

