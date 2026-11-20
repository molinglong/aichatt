/**
 * 小鸡事件反应 · 全局浮层 —— 事件目录与总线(2026-11-18,design/preview-chick-reactions.html 形态 A 拍板)。
 *
 * 分工:这里只放纯数据 + emit;渲染/排队/每日上限都在 components/chick/ChickReactions.tsx 宿主里。
 * 各业务流(import 本文件 chickPlay)只管在事件发生处喊一嗓子,不关心浮层是否真的弹出
 * (上限/冷却/去重统一由宿主裁决,调用方零成本)。
 *
 * 上限口径(预览页定案):每「组」每日弹次数上限,防刷屏 ——
 * 学习流程 8 / 时间习惯 2 / 任务状态 2 / 彩蛋 1;另全局冷却 3s、同事件 30s 去重、排队上限 3。
 */

/** 四类 19 事件(键即预览页 SEQ 的 key,便于对照) */
export type ChickKey =
  | 'correct'
  | 'wrong'
  | 'streak3'
  | 'group'
  | 'quizSoon'
  | 'wordNew'
  | 'wordReview'
  | 'wrongSaved'
  | 'wrongClear'
  | 'dailyHi'
  | 'streakDay'
  | 'lateNight'
  | 'longAbsent'
  | 'planDone'
  | 'paperReady'
  | 'festival'
  | 'gaokao'

/** 动作语言(预览页 note 口径):跳=对/完成,缩壳=错,点头记一笔=入库/准备,挥手=问候,三连蹦=里程碑,打盹=睡,摇头=想念 */
export type ChickAct = 'jump' | 'triple' | 'shake' | 'sleep' | 'bow' | 'wave' | 'sad'
export type ChickFx = 'star1' | 'star3' | 'confetti' | 'sticker' | 'ribbon'
export type ChickProp = 'book' | 'paper' | 'sign'

export interface ChickSpec {
  /** 所属组序号:0 学习流程 / 1 时间习惯 / 2 任务状态 / 3 彩蛋 */
  group: 0 | 1 | 2 | 3
  act: ChickAct
  fx?: ChickFx
  prop?: ChickProp
  /** 浮层停留 ms(不含入场 430ms / 退场 300ms);缺省 1500 */
  hold?: number
  /** 主体文案;vars 由触发方带(打卡天数/高考倒计时/钟点等) */
  text: (vars?: Record<string, string | number>) => string
}

export const CHICK_EVENTS: Record<ChickKey, ChickSpec> = {
  correct:    { group: 0, act: 'jump',   fx: 'star1',    text: () => '答对啦!' },
  wrong:      { group: 0, act: 'sad',                    hold: 2200, text: () => '错啦…再想想' },
  streak3:    { group: 0, act: 'triple', fx: 'star3',    hold: 2000, text: () => '连对 3 题!' },
  group:      { group: 0, act: 'jump',   fx: 'confetti', text: () => '这组完成!' },
  quizSoon:   { group: 0, act: 'bow',                    text: () => '坐好了啊,开测!' },
  wordNew:    { group: 0, act: 'bow',    prop: 'book',   text: () => '记住新词咯' },
  wordReview: { group: 0, act: 'jump',   fx: 'star1',    text: () => '这轮复习完!' },
  wrongSaved: { group: 0, act: 'bow',    prop: 'book',   text: () => '我帮你记下了' },
  wrongClear: { group: 0, act: 'jump',   fx: 'confetti', hold: 2000, text: () => '错题清零!' },
  dailyHi:    { group: 1, act: 'wave',                   hold: 2200, text: (v) => (v?.hi as string) ?? '早安!今天也一起加油呀' },
  streakDay:  { group: 1, act: 'triple', fx: 'confetti', hold: 2000, text: (v) => `连续打卡 ${v?.days ?? 7} 天!` },
  lateNight:  { group: 1, act: 'sleep',                  hold: 2600, text: (v) => `都 ${v?.hour ?? 0} 点了…先睡吧` },
  longAbsent: { group: 1, act: 'shake',                  hold: 2000, text: () => '你终于回来啦!' },
  planDone:   { group: 2, act: 'jump',   fx: 'sticker',  hold: 1800, text: () => '今天的日程全完成!' },
  paperReady: { group: 2, act: 'bow',    prop: 'paper',  text: () => '卷组好了,来写!' },
  festival:   { group: 3, act: 'triple', fx: 'ribbon',   hold: 2200, text: (v) => (v?.hi as string) ?? '节日快乐!' },
  gaokao:     { group: 3, act: 'bow',    prop: 'sign',   text: () => '冲!' },
}

/** 每组每日弹次数上限(预览页定案口径) */
export const CHICK_GROUP_CAPS: [number, number, number, number] = [8, 2, 2, 1]
export const CHICK_GROUP_NAMES = ['学习流程', '时间习惯', '任务状态', '彩蛋']

/** 总线事件名(宿主监听) */
export const CHICK_BUS_EVENT = 'chick:play'

export interface ChickPlayDetail {
  key: ChickKey
  vars?: Record<string, string | number>
  /** 顶层带 force:无视上限/冷却/去重(仅验收与开发钩子用) */
  force?: boolean
}

/**
 * 喊一嗓子:任何业务流在事件发生处调用;是否真弹由宿主按上限/冷却裁决。
 * 无宿主挂载(如登录页)时静默丢弃,调用方无需判断环境。
 */
export function chickPlay(key: ChickKey, vars?: Record<string, string | number>) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<ChickPlayDetail>(CHICK_BUS_EVENT, { detail: { key, vars } }))
  mirrorToPet(key, vars)
}

/**
 * 桌面小鸡镜像:Tauri 壳内把事件广播给 pet 窗(浏览器端静默跳过)。
 * 不吃本宿主的上限/锁门裁决 —— 桌面小鸡有自己的 8s 冷却 + 同事件 30s 去重,自行裁决。
 * 带 spec.text(vars) 文案(小鸡气泡直接有嘴);硬事件在主窗失焦/最小化时补一条系统通知
 * (语义/开关复用 tauri.notifyReplyDone:用户正看着窗口时不打扰)。
 */
const HARD_NOTIFY_KEYS: ReadonlySet<ChickKey> = new Set<ChickKey>([
  'paperReady',
  'planDone',
  'wrongClear',
  'streakDay',
  'festival',
  'gaokao',
])

function mirrorToPet(key: ChickKey, vars?: Record<string, string | number>) {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return
  const spec = CHICK_EVENTS[key]
  const text = spec ? spec.text(vars) : undefined
  import('@tauri-apps/api/event')
    .then((m) => m.emit('pet-event', { key, vars, text }))
    .catch(() => {
      /* 事件桥不可用:静默 */
    })
  if (text && HARD_NOTIFY_KEYS.has(key)) {
    import('@/lib/tauri')
      .then((m) => m.tauri.notifyReplyDone('桌面小鸡', text))
      .catch(() => {
        /* 通知通道不可用:静默 */
      })
  }
}

/** 时段问候文案(桌面小鸡定时问候 / 点击补问候共用;<6 深夜,<11 早,<14 午,<18 下午,else 晚上好) */
export function chickHiText(h: number): string {
  if (h < 6) return '这么晚还不睡呀?早点休息哦'
  if (h < 11) return '早安!今天也一起加油呀'
  if (h < 14) return '午安!歇好了再战'
  if (h < 18) return '下午好!今天学了多少啦'
  return '晚上好!今天也辛苦啦'
}

/* ── 开机型事件的本地标记(lastVisit / 每日已弹),宿主与 study 页共用 ── */

const CKR_FLAG = 'chick-startup'

export interface ChickStartupFlag {
  /** 最后一次打开应用的日子 YYYY-MM-DD */
  lastDay: string
  /** 每个开机型事件当日已弹标记 */
  fired: Record<string, string>
}

export function readStartupFlag(): ChickStartupFlag {
  const empty: ChickStartupFlag = { lastDay: '', fired: {} }
  if (typeof window === 'undefined') return empty
  try {
    const raw = window.localStorage.getItem(CKR_FLAG)
    if (!raw) return empty
    const obj = JSON.parse(raw) as Partial<ChickStartupFlag>
    return { lastDay: obj.lastDay ?? '', fired: obj.fired ?? {} }
  } catch {
    return empty
  }
}

export function writeStartupFlag(f: ChickStartupFlag) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(CKR_FLAG, JSON.stringify(f))
  } catch {
    /* 隐私模式等:静默 */
  }
}

/** 今日 YYYY-MM-DD(本地时区,与 stats API dayKey 同口径) */
export function chickToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 两个 YYYY-MM-DD 之间的自然日差(纯日历,不吃时区亏) */
export function chickDayGap(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00`).getTime()
  const b = new Date(`${to}T00:00:00`).getTime()
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.round((b - a) / 86_400_000)
}

/** 太阳历节日表(农历节日不硬编码,后续要再加);hi=浮层文案 */
const FESTIVALS: Record<string, string> = {
  '01-01': '新年快乐!',
  '06-01': '六一快乐!大朋友也快乐',
  '10-01': '国庆快乐!玩几天再学',
  '09-01': '开学啦!新学期一起加油',
  '12-25': '圣诞快乐!记得吃颗糖',
}

/** 今天是否节日;命中返回文案 */
export function chickFestivalToday(): string | null {
  const t = chickToday()
  return FESTIVALS[t.slice(5)] ?? null
}

/** 距下一次高考(6 月 7 日)天数 */
export function chickGaokaoDays(): number {
  const now = new Date()
  let year = now.getFullYear()
  let target = new Date(`${year}-06-07T00:00:00`)
  if (target.getTime() < new Date(`${chickToday()}T00:00:00`).getTime()) {
    year += 1
    target = new Date(`${year}-06-07T00:00:00`)
  }
  return Math.round((target.getTime() - new Date(`${chickToday()}T00:00:00`).getTime()) / 86_400_000)
}
