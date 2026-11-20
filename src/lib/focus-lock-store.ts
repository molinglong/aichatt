'use client'

import { useSyncExternalStore } from 'react'

/**
 * 监管模式全局锁状态 —— 方案: design/focus-lock-restrict-plan.md §3.1。
 *
 * FocusLock.tsx 是唯一写入方(mount 查询 + start/ended/restored 四个节点同步);
 * 其余组件只读:useFocusLock()(React) / getFocusLockState()(transport getter、
 * 发送守卫等非 hook 场景)。未订阅的轻量读走 getFocusLockState 避免无谓重渲染。
 *
 * Web/安卓端 useIsTauri()=false → FocusLock 不挂载 → locked 恒 false,
 * 所有下游限制(面具置灰/平台档回退/监工注入/发送守卫)自然不生效。
 */

export interface FocusLockState {
  /** 锁定中(窗口硬锁生效) */
  locked: boolean
  /** 锁定截止时刻(墙钟毫秒);未锁定为 0;正计时档恒 0 */
  endsAtMs: number
  /** 正计时档(D13):无截止时刻,从 startedAtMs 起累计,唯一出口 focusLockEnd */
  countUp: boolean
  /** 锁开始时刻(正计时计秒起点;倒计时档用于展示解锁时刻) */
  startedAtMs: number
}

let state: FocusLockState = { locked: false, endsAtMs: 0, countUp: false, startedAtMs: 0 }

const listeners = new Set<() => void>()

function setState(next: FocusLockState) {
  if (
    state.locked === next.locked &&
    state.endsAtMs === next.endsAtMs &&
    state.countUp === next.countUp &&
    state.startedAtMs === next.startedAtMs
  ) {
    return
  }
  state = next
  listeners.forEach((l) => l())
}

/** FocusLock.tsx 同步写入:status 查询 / start 成功 / restored 事件 */
export function syncFocusLockStatus(
  st: { locked: boolean; endsAtMs: number; countUp?: boolean; startedAtMs?: number } | null
) {
  setState(
    st?.locked
      ? {
          locked: true,
          endsAtMs: st.endsAtMs,
          countUp: st.countUp ?? false,
          startedAtMs: st.startedAtMs ?? 0,
        }
      : { locked: false, endsAtMs: 0, countUp: false, startedAtMs: 0 }
  )
}

/** ended 事件写入 */
export function clearFocusLock() {
  setState({ locked: false, endsAtMs: 0, countUp: false, startedAtMs: 0 })
}

export function getFocusLockState(): FocusLockState {
  return state
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): FocusLockState {
  return state
}

/** React 读取 hook:锁定状态变化驱动重渲染 */
export function useFocusLock(): FocusLockState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

// ── 锁中统计与目标(回执/目标制数据源,R5+R7) ─────────────────────────────
// 锁定期间累计「发送条数 / 拦截次数」与「本轮目标」,解锁回执卡消费。
// localStorage 持久:锁可能跨重启续锁(restored),页面刷新不丢计数。
// 计数器只在 locked 时累加,模块加载时从 localStorage 恢复内存态。

const FL_COUNTERS_KEY = 'focusLock:counters'
const FL_GOAL_KEY = 'focusLock:goal'

export interface FocusLockCounters {
  /** 锁中发送成功的 /api/chat 请求数(ChatPanel / CompareLane transport fetch 计) */
  msgs: number
  /** 锁中触碰限制的次数(点置灰面具/平台项、受限会话发送守卫计) */
  intercepts: number
}

let counters: FocusLockCounters = { msgs: 0, intercepts: 0 }

function readCountersFromStorage(): FocusLockCounters {
  try {
    const raw = localStorage.getItem(FL_COUNTERS_KEY)
    if (!raw) return { msgs: 0, intercepts: 0 }
    const obj = JSON.parse(raw) as Partial<FocusLockCounters>
    return {
      msgs: Number.isFinite(obj.msgs) ? Math.max(0, obj.msgs!) : 0,
      intercepts: Number.isFinite(obj.intercepts) ? Math.max(0, obj.intercepts!) : 0,
    }
  } catch {
    return { msgs: 0, intercepts: 0 }
  }
}

if (typeof window !== 'undefined') {
  counters = readCountersFromStorage()
}

function writeCountersToStorage() {
  try {
    localStorage.setItem(FL_COUNTERS_KEY, JSON.stringify(counters))
  } catch {
    // ignore
  }
}

/** 锁中发送成功计数(非锁定期调用是空操作) */
export function bumpFocusMsgCount() {
  if (!state.locked) return
  counters = { ...counters, msgs: counters.msgs + 1 }
  writeCountersToStorage()
}

/** 锁中触碰限制计数(非锁定期调用是空操作) */
export function bumpFocusIntercept() {
  if (!state.locked) return
  counters = { ...counters, intercepts: counters.intercepts + 1 }
  writeCountersToStorage()
}

export function getFocusCounters(): FocusLockCounters {
  return counters
}

/** 解锁回执展示后清零(下一次锁定从零起算) */
export function resetFocusCounters() {
  counters = { msgs: 0, intercepts: 0 }
  try {
    localStorage.removeItem(FL_COUNTERS_KEY)
  } catch {
    // ignore
  }
}

/** 本轮目标原文(开锁弹层写入,回执卡消费;解锁后清掉) */
export function setFocusGoal(text: string) {
  try {
    if (text) localStorage.setItem(FL_GOAL_KEY, text)
    else localStorage.removeItem(FL_GOAL_KEY)
  } catch {
    // ignore
  }
}

export function getFocusGoal(): string {
  try {
    return localStorage.getItem(FL_GOAL_KEY) ?? ''
  } catch {
    return ''
  }
}

export function clearFocusGoal() {
  setFocusGoal('')
}

// ── dev-only 模拟钩子 ─────────────────────────────────────────────────────
// URL 带 ?__flmock=1 时把锁状态置为 true(1 小时),供 Web 端(3456)回归锁定期 UI:
// 面具置灰/平台档禁用/停用横幅/监工注入(focusLock 字段会真实随请求上报)。
// 仅 development 生效;生产构建无此路径。锁本体在 Rust,模拟只覆盖前端 UI 层。
if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  const params = new URLSearchParams(window.location.search)
  if (params.get('__flmock') === '1') {
    const now = Date.now()
    setState({ locked: true, endsAtMs: now + 60 * 60 * 1000, countUp: false, startedAtMs: now })
  }
}

// ── 定时锁定课表(R1)与今日跳过配额(R2) ───────────────────────────────────
// 方案: design/preview-focus-lock-schedule.html 定案口径。
// 周一至周五,锁「人在家」的时段(午休段/傍晚段);吃饭 15 分钟自由段不在课表内。
// 触发引擎在前端(FocusLock.tsx 调度 effect),Rust 锁本体零改动。
// 配置/配额全部 localStorage 持久 —— 设置开在独立 Tauri 子窗口,存储事件
// 能否跨窗口送达不保证,所以 getter 每次都重读 localStorage,事件监听只是加速。

const FL_SCHEDULE_KEY = 'focusLock:schedule'
const FL_SKIP_DATE_KEY = 'focusLock:skipDate'
const FL_SKIPS_KEY = 'focusLock:skips' // 完整 key = `${FL_SKIPS_KEY}:${YYYY-MM}`
const FL_SCHED_ACTIVE_KEY = 'focusLock:schedActive'
const FL_SCHED_WIN_KEY = 'focusLock:schedWin'

export const FOCUS_SKIP_QUOTA_PER_MONTH = 2
/** 测试期跳过不限次(2026-11-20 用户口径:测试模式别卡人)。正式版改回 false
 *  即恢复每月 2 次;used 计数照记,只是不再挡住入口。 */
export const FOCUS_SKIP_QUOTA_UNLIMITED = true

export interface FocusLockWindow {
  id: string
  label: string
  on: boolean
  /** HH:mm(当天内,start < end,不支持跨夜段) */
  start: string
  end: string
}

export interface FocusLockScheduleConfig {
  enabled: boolean
  windows: FocusLockWindow[]
}

export const DEFAULT_SCHEDULE_CONFIG: FocusLockScheduleConfig = {
  enabled: true,
  windows: [
    { id: 'noon', label: '午休段', on: true, start: '12:55', end: '14:26' },
    { id: 'dusk', label: '傍晚段', on: true, start: '17:55', end: '18:30' },
  ],
}

/** HH:mm → 当天分钟数;非法输入返回 null */
export function hhmmToMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hhmm ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** 当天分钟数(带秒的小数,供剩余时长向上取整) */
export function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 周一至周五 */
export function isWeekdayNow(d: Date): boolean {
  const day = d.getDay()
  return day >= 1 && day <= 5
}

/** 读盘 + 清洗(独立窗口写入可能半途损坏,单段非法丢弃,全非法回默认) */
function sanitizeWindows(raw: unknown): FocusLockWindow[] {
  if (!Array.isArray(raw)) return DEFAULT_SCHEDULE_CONFIG.windows
  const wins = raw
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x) => {
      const s = typeof x.start === 'string' ? x.start : ''
      const e = typeof x.end === 'string' ? x.end : ''
      return {
        id: typeof x.id === 'string' ? x.id : '',
        label: typeof x.label === 'string' && x.label ? x.label : '时段',
        on: x.on !== false,
        start: s,
        end: e,
      }
    })
    .filter(
      (w) =>
        w.id &&
        hhmmToMinutes(w.start) !== null &&
        hhmmToMinutes(w.end) !== null &&
        (hhmmToMinutes(w.start) as number) < (hhmmToMinutes(w.end) as number)
    )
  return wins.length ? wins : DEFAULT_SCHEDULE_CONFIG.windows
}

function readConfigFromStorage(): FocusLockScheduleConfig {
  if (typeof window === 'undefined') return DEFAULT_SCHEDULE_CONFIG
  try {
    const raw = localStorage.getItem(FL_SCHEDULE_KEY)
    if (!raw) return DEFAULT_SCHEDULE_CONFIG
    const obj = JSON.parse(raw) as Record<string, unknown>
    return { enabled: obj.enabled !== false, windows: sanitizeWindows(obj.windows) }
  } catch {
    return DEFAULT_SCHEDULE_CONFIG
  }
}

// useSyncExternalStore 的快照必须引用稳定,缓存 + 显式刷新,不随 getter 每次重读换引用
let cfgSnapshot: FocusLockScheduleConfig =
  typeof window !== 'undefined' ? readConfigFromStorage() : DEFAULT_SCHEDULE_CONFIG

const cfgListeners = new Set<() => void>()

function notifyCfg() {
  cfgListeners.forEach((l) => l())
}

/** 重读 localStorage 并按需通知订阅方(挂载/30s 轮询/storage 事件后调) */
export function refreshSchedule(): FocusLockScheduleConfig {
  const next = readConfigFromStorage()
  if (next !== cfgSnapshot) {
    const same =
      next.enabled === cfgSnapshot.enabled &&
      next.windows.length === cfgSnapshot.windows.length &&
      next.windows.every((w, i) => {
        const o = cfgSnapshot.windows[i]
        return w.id === o.id && w.label === o.label && w.on === o.on && w.start === o.start && w.end === o.end
      })
    if (!same) {
      cfgSnapshot = next
      notifyCfg()
    }
  }
  return next
}

/** 非-hook 场景读课表(每次重读,天然跨窗口一致) */
export function getScheduleConfig(): FocusLockScheduleConfig {
  return readConfigFromStorage()
}

function subscribeCfg(listener: () => void) {
  cfgListeners.add(listener)
  return () => {
    cfgListeners.delete(listener)
  }
}

function getCfgSnapshot(): FocusLockScheduleConfig {
  return cfgSnapshot
}

/** React hook:课表配置(设置分区/弹层提示条消费) */
export function useFocusLockSchedule(): FocusLockScheduleConfig {
  return useSyncExternalStore(subscribeCfg, getCfgSnapshot, getCfgSnapshot)
}

/** 写回课表(设置分区保存入口);写入即通知本窗口订阅方 */
export function setScheduleConfig(next: FocusLockScheduleConfig) {
  cfgSnapshot = { enabled: next.enabled, windows: sanitizeWindows(next.windows) }
  try {
    localStorage.setItem(FL_SCHEDULE_KEY, JSON.stringify(cfgSnapshot))
  } catch {
    // ignore
  }
  notifyCfg()
}

// 跨窗口同步保险:设置开在独立 Tauri 子窗口,本窗口靠 storage 事件跟进
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === FL_SCHEDULE_KEY || e.key === null) refreshSchedule()
  })
}

export interface ActiveScheduleWindow {
  win: FocusLockWindow
  /** 距窗口结束剩余分钟(向上取整,至少 1,直接喂 focus_lock_start) */
  minutesLeft: number
}

/** 当前是否正处在某个启用中的锁定时段内(不查跳过标记,调用方自行叠加) */
export function findActiveScheduleWindow(
  cfg: FocusLockScheduleConfig,
  now: Date
): ActiveScheduleWindow | null {
  if (!cfg.enabled || !isWeekdayNow(now)) return null
  const cur = minutesOfDay(now)
  for (const w of cfg.windows) {
    if (!w.on) continue
    const s = hhmmToMinutes(w.start)
    const e = hhmmToMinutes(w.end)
    if (s === null || e === null || s >= e) continue
    if (cur >= s && cur < e) {
      return { win: w, minutesLeft: Math.max(1, Math.ceil(e - cur)) }
    }
  }
  return null
}

export interface NextScheduleWindow {
  win: FocusLockWindow
  /** 距下一锁开始还有多少分钟(带秒小数) */
  minutesUntilStart: number
  /** 今天剩余会自动上锁的段数(含这一段) */
  remainingToday: number
}

/** 今天下一个还没开始的锁定时段(过点后由调度器上锁) */
export function findNextScheduleWindow(
  cfg: FocusLockScheduleConfig,
  now: Date
): NextScheduleWindow | null {
  if (!cfg.enabled || !isWeekdayNow(now)) return null
  const cur = minutesOfDay(now)
  const candidates = cfg.windows
    .filter((w) => w.on)
    .map((w) => ({ w, s: hhmmToMinutes(w.start), e: hhmmToMinutes(w.end) }))
    .filter((x) => x.s !== null && x.e !== null && x.s < x.e && x.s > cur)
    .sort((a, b) => (a.s as number) - (b.s as number))
  if (candidates.length === 0) return null
  const first = candidates[0]
  return {
    win: first.w,
    minutesUntilStart: (first.s as number) - cur,
    remainingToday: candidates.length,
  }
}

// ── 今日跳过:每月 2 次,跳过只免当天剩余锁段 ───────────────────────────────

export interface SkipUsage {
  month: string
  used: number
  left: number
  /** 测试期不限次:true 时入口永不置灰,left 只作真实配额展示 */
  unlimited: boolean
}

export function getSkipUsage(): SkipUsage {
  const month = monthKey(new Date())
  let used = 0
  try {
    const raw = localStorage.getItem(`${FL_SKIPS_KEY}:${month}`)
    used = raw ? Math.max(0, Number(raw) || 0) : 0
  } catch {
    // 0
  }
  return {
    month,
    used,
    left: Math.max(0, FOCUS_SKIP_QUOTA_PER_MONTH - used),
    unlimited: FOCUS_SKIP_QUOTA_UNLIMITED,
  }
}

/** 今天是否已按过「今日跳过」(当天剩余锁段全免) */
export function isScheduleSkippedToday(): boolean {
  try {
    return localStorage.getItem(FL_SKIP_DATE_KEY) === dayKey(new Date())
  } catch {
    return false
  }
}

/** 消耗一次跳过:记当天标记 + 月度计数。配额用尽返回 false,不写任何状态。
 *  测试期(unlimited)不看配额,计数照记,便于正式版估算真实用量。 */
export function consumeSkipDay(): boolean {
  if (isScheduleSkippedToday()) return true // 同一天重复消耗不占第二次
  const usage = getSkipUsage()
  if (!usage.unlimited && usage.left <= 0) return false
  try {
    localStorage.setItem(FL_SKIP_DATE_KEY, dayKey(new Date()))
    localStorage.setItem(`${FL_SKIPS_KEY}:${usage.month}`, String(usage.used + 1))
  } catch {
    return false
  }
  return true
}

// ── 调度器起始的锁标记(跳过入口只对定时锁露出,手动锁不变) ─────────────────

export function isSchedLockActive(): boolean {
  try {
    return localStorage.getItem(FL_SCHED_ACTIVE_KEY) === '1'
  } catch {
    return false
  }
}

export function setSchedLockActive(on: boolean) {
  try {
    if (on) localStorage.setItem(FL_SCHED_ACTIVE_KEY, '1')
    else localStorage.removeItem(FL_SCHED_ACTIVE_KEY)
  } catch {
    // ignore
  }
}

export interface SchedWindowInfo {
  id: string
  label: string
  end: string
}

/** 调度器上锁时记录本段信息,跳过面板直接展示(重启续锁丢失时面板降级为通用文案) */
export function setSchedWindowInfo(info: SchedWindowInfo | null) {
  try {
    if (info) localStorage.setItem(FL_SCHED_WIN_KEY, JSON.stringify(info))
    else localStorage.removeItem(FL_SCHED_WIN_KEY)
  } catch {
    // ignore
  }
}

export function getSchedWindowInfo(): SchedWindowInfo | null {
  try {
    const raw = localStorage.getItem(FL_SCHED_WIN_KEY)
    if (!raw) return null
    const obj = JSON.parse(raw) as Partial<SchedWindowInfo>
    if (typeof obj.label !== 'string' || typeof obj.end !== 'string') return null
    return { id: typeof obj.id === 'string' ? obj.id : '', label: obj.label, end: obj.end }
  } catch {
    return null
  }
}

/** 弹层提示条:一行文案描述当前定时锁态势(null = 提示条不显示) */
export interface ScheduleHint {
  text: string
  /** 跳过配额还能不能用(仅提示条展示层判断,真正扣减看 consumeSkipDay) */
  left: number
}

export function getScheduleHint(now: Date): ScheduleHint | null {
  const cfg = getScheduleConfig()
  if (!cfg.enabled || cfg.windows.every((w) => !w.on)) return null
  const skip = getSkipUsage()
  const { left } = skip
  // 测试期不限次:文案别再说「本月跳过剩 0 次」,免得像入口已废
  const leftText = skip.unlimited ? '测试期不限次' : `本月跳过剩 ${left} 次`
  if (!isWeekdayNow(now)) return { text: '周末不自动锁 · 周一至周五生效', left }
  if (isScheduleSkippedToday()) return { text: `今日已跳过自动锁 · ${leftText}`, left }
  const act = findActiveScheduleWindow(cfg, now)
  if (act) return { text: `${act.win.label} 锁定中 · ${act.win.end} 自动解锁`, left }
  const nxt = findNextScheduleWindow(cfg, now)
  if (nxt) {
    return {
      text: `下一锁 ${nxt.win.start}–${nxt.win.end} · 今天剩 ${nxt.remainingToday} 段 · ${leftText}`,
      left,
    }
  }
  return { text: '今天没有更多自动锁时段', left }
}

// ── dev-only Web 预览门 ─────────────────────────────────────────────────────
// ?__flsched=1: Web 端(3456)露出定时锁设置分区截图用(真实调度只在 Tauri 跑)。
// ?__flmock=1: 既有锁态模拟,同时把徽章面板切到跳过面板方便回归锁内 UI。
// 仅 development 生效;生产构建无此路径。
export function isFocusLockPreview(): boolean {
  if (typeof window === 'undefined' || process.env.NODE_ENV !== 'development') return false
  try {
    const p = new URLSearchParams(window.location.search)
    return p.get('__flmock') === '1' || p.get('__flsched') === '1'
  } catch {
    return false
  }
}
