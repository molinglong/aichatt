'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronLeft, ChevronRight, Shield, Target } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { tauri, useIsTauri, type FocusLockStatus } from '@/lib/tauri'
import {
  syncFocusLockStatus,
  clearFocusLock,
  getFocusLockState,
  getFocusCounters,
  resetFocusCounters,
  setFocusGoal,
  getFocusGoal,
  clearFocusGoal,
  refreshSchedule,
  getScheduleConfig,
  getScheduleHint,
  isScheduleSkippedToday,
  findActiveScheduleWindow,
  getSkipUsage,
  consumeSkipDay,
  isSchedLockActive,
  setSchedLockActive,
  setSchedWindowInfo,
  getSchedWindowInfo,
} from '@/lib/focus-lock-store'
import { useChatStore } from '@/store/chat-store'
import { getBuiltinMask } from '@/lib/ai/builtin-masks'
import { isMaskRestricted, isPlatformRestricted } from '@/lib/ai/focus-restrict'
import { getSearchPlatform } from '@/lib/ai/search-platforms'
import { CrayonChick } from './CrayonChick'

/**
 * 监管模式(窗口硬锁)——仅 Tauri 桌面客户端,Web/安卓不渲染。
 * 方案: design/focus-lock-plan.md;原型: design/preview-focus-lock.html
 *
 * 锁定能力本体在 Rust 侧(focus_lock.rs):真全屏 + 置顶 + 拦关闭/最小化 +
 * 失焦拉回 + 落盘续锁。前端只负责启动入口与状态呈现 —— 按方案定案,
 * 锁定期内前端不提供任何解锁入口,到点由 Rust 自动放行。
 *
 * 交互面:
 * - 入口: 顶栏盾形按钮(锁定中变为倒计时徽章,点击弹剩余时间提示)
 * - 开启弹层: 时长档 + 自定义(5-240) + 追焦开关 + 两击确认
 * - B 沉浸覆盖层: 进入锁定时弹一次大字倒计时,点击任意处关闭
 * - 回执 toast: 被拦(警告)/到期(成功)/重启续锁(提示)
 */

/** 预设时长档(分钟) */
const PRESETS = [25, 45, 60, 90, 120]
const MIN_MIN = 5
const MAX_MIN = 360
const FOCUS_REFOCUS_KEY = 'focusLock:refocus'
const FOCUS_LAST_MIN_KEY = 'focusLock:lastMinutes'

/** 剩余毫秒 → "mm:ss" / "h:mm:ss" */
function fmtRemaining(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** 开启过场总时长(黑场让位完成后卸载;CSS 编排到 2.87s) */
const INTRO_MS = 2900
/** 退场过场淡出卸载延迟(收 ended 后播 .fl-tr-out 0.42s,留余量后卸载) */
const ENDING_OUT_MS = 450
/** B 覆盖层无操作自动关:露出后 3s 收掉;点击任意处仍即时关,计时只是免点击的兜底 */
const OVERLAY_AUTO_CLOSE_MS = 3000

/** F 案蜡笔小鸡(日式可爱版吉祥物):2026-11-18 抽出至 components/CrayonChick.tsx 供学习台书桌共用(直接 import FocusLock 会带 tauri 依赖链) */

/**
 * 监管模式过场层(开场 intro / 退场 ending 共用),导出给今晚测验
 * (EveningQuiz)外部启动锁定时复用同一套视觉语言。
 * A 案「大字定格」(原型 design/preview-fl-transition-redo.html):开场四字放大撑场 +
 * 蜡笔黄划线托底 + 小鸡站字上,远角一颗星一颗心;退场四字淡化成小注(顺修旧版
 * 只亮「监管」两字的半残),大「完」章居中盖落、小鸡蹦到章边,副文案换收尾口径。
 * 样式见 globals.css「监管模式蜡笔绘本皮肤」过场段。
 */
export function FlTransition({ kind, out, hold, label }: { kind: 'intro' | 'ending'; out?: boolean; hold?: boolean; label: string }) {
  return (
    <div className={cn('fl-tr-layer', kind === 'intro' ? 'fl-intro' : 'fl-ending', kind === 'intro' && hold && 'fl-intro-hold', out && 'fl-tr-out')} role="dialog" aria-label={label}>
      <svg className="fl-tr-frame" viewBox="0 0 400 260" preserveAspectRatio="none" aria-hidden>
        <rect x="6" y="6" width="388" height="248" rx="20" pathLength={100} fill="none" stroke="currentColor" strokeWidth={2.5} />
      </svg>
      <svg className="fl-tr-dd fl-tr-dd-star" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M12 2.5 13.9 10.1 21.5 12 13.9 13.9 12 21.5 10.1 13.9 2.5 12 10.1 10.1 Z" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
      </svg>
      <svg className="fl-tr-dd fl-tr-dd-heart" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M12 20 C 5.2 14.2, 3.2 9.2, 6.6 6.2 C 9 4.2, 11.5 5.6, 12 7.6 C 12.5 5.6, 15 4.2, 17.4 6.2 C 20.8 9.2, 18.8 14.2, 12 20 Z" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
      </svg>
      <span className="fl-tr-em"><CrayonChick /></span>
      <div className="fl-tr-word">
        <span>监</span>
        <span>管</span>
        <span>模</span>
        <span>式</span>
      </div>
      <svg className="fl-tr-swash" viewBox="0 0 200 14" preserveAspectRatio="none" aria-hidden>
        <path d="M4 8 C 40 2, 80 12, 120 7 S 180 4, 196 8" pathLength={100} fill="none" stroke="currentColor" strokeWidth={5} strokeLinecap="round" />
      </svg>
      <div className="fl-tr-sub">到点准时放你走 · 期间没有退出按钮</div>
      <div className="fl-tr-sub2">写完这一页啦 · 即刻解锁</div>
      <span className="fl-tr-stamp" aria-hidden>完</span>
    </div>
  )
}

/** 解锁回执数据(R5):ended 后右下角轻回执条一次性展示 */
export interface FocusReceipt {
  /** 本次专注分钟数(Rust ended 事件给出) */
  min: number
  /** 锁中发送成功的消息条数 */
  msgs: number
  /** 锁中触碰限制(置灰面具/平台/发送守卫)次数 */
  intercepts: number
  /** 本轮目标原文;空串=未定目标 */
  goal: string
  /** AI 一句话点评:undefined=未请求(短锁),null=生成中,string=完成;失败回落 undefined 不展示 */
  ai?: string | null
}

/** AI 点评门槛(R5 定案):≥20 分钟才调一次轻接口 —— 预设档最小 25 分钟全覆盖,短锁不浪费 */
const RECEIPT_AI_MIN_MINUTES = 20

/** 目标预设 chips(R7):两秒点一颗摩擦最低;更长的话走「自己写」输入框 */
const GOAL_PRESETS = ['背 20 个单词', '刷完一套卷子', '写完作业', '把错题过一遍']

/** 锁中会话最近几条消息 → 点评 prompt 的对话片段(拉不到就空串,点评只看统计) */
async function fetchRecentChatDigest(convId: string): Promise<string> {
  try {
    const res = await fetch(`/api/conversations/${convId}/messages?limit=4`)
    if (!res.ok) return ''
    const data = (await res.json()) as { messages?: Array<{ role?: string; content?: unknown }> }
    return (data.messages ?? [])
      .map((m) => {
        const role = m.role === 'assistant' ? 'AI' : '用户'
        const text = typeof m.content === 'string' ? m.content : ''
        return `${role}: ${text.slice(0, 80)}`
      })
      .filter(Boolean)
      .join('\n')
  } catch {
    return ''
  }
}

/**
 * 解锁回执的 AI 一句话点评:走 /api/quick-chat(站内 cookie 认证,不落库),
 * 成功 resolve 文本;任何失败 resolve 空串 —— 回执静默不展示点评,绝不阻塞卡片。
 */
async function fetchReceiptReview(input: FocusReceipt): Promise<string> {
  try {
    const convId = useChatStore.getState().currentConversationId
    const digest = convId ? await fetchRecentChatDigest(convId) : ''
    const prompt = [
      `刚结束一次专注锁定:专注 ${input.min} 分钟，发送 ${input.msgs} 条消息，触碰限制 ${input.intercepts} 次${input.goal ? `，本轮目标「${input.goal}」` : ''}。`,
      digest ? `锁中对话片段:\n${digest}` : '',
      '请用一句自然中文口语点评这轮专注(不超过 40 字):像陪伴者随口说一句,内容具体不空洞,不打分、不说教、不堆语气词,直接给句子本身,不要任何前缀或引号。',
    ]
      .filter(Boolean)
      .join('\n')
    const res = await fetch('/api/quick-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] }),
    })
    if (!res.ok) return ''
    // SSE 轻协议:收集 type:"text" 增量,遇 error 事件即放弃
    const reader = res.body?.getReader()
    if (!reader) return ''
    const decoder = new TextDecoder()
    let buf = ''
    let out = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('data:')) continue
        try {
          const payload = JSON.parse(t.slice(5).trim()) as { type?: string; value?: unknown }
          if (payload.type === 'text' && typeof payload.value === 'string') out += payload.value
          if (payload.type === 'error') return ''
        } catch {
          // 半行/非 JSON 跳过
        }
      }
    }
    return out.trim().slice(0, 80)
  } catch {
    return ''
  }
}

/**
 * 锁前处理(R3, focus-lock-restrict-plan.md §3.2):手动锁与定时锁共用的启动前置 ——
 * 当前会话挂受限面具(游戏/闲聊向)→ 自动切回默认助手;搜索档受限 → 回退全网。
 * 二者皆为锁定启动的组成部分,解锁后不自动恢复(会话还在列表里,档位以全网为准)。
 */
async function runLockPreflight(): Promise<void> {
  const store = useChatStore.getState()
  if (isMaskRestricted({ id: store.conversationMaskId })) {
    store.setConversationMaskId(null)
    toast.info('已切回默认助手 · 受限会话锁定期间暂停，解锁后可回到原会话', { title: '监管模式' })
  }
  if (isPlatformRestricted(store.searchPlatform)) {
    const label = getSearchPlatform(store.searchPlatform).label
    store.setSearchPlatform('auto')
    toast.info(`搜索档已从「${label}」回退全网`, { title: '监管模式' })
  }
}

export function FocusLockButton() {
  const inTauri = useIsTauri()
  // dev-only Web 预览门:URL 带 ?__flmock=1 时在 Web 端(3456)渲染锁定 UI(徽章/覆盖层/
  // 弹层/过场)供截图自检 —— 状态为前端模拟(1 小时),Rust 锁本体不在,IPC 全部跳过。
  // 生产构建无此路径;与 focus-lock-store 的 ?__flmock=1 同一约定。
  // 必须像 useIsTauri 一样 mount 后置位:初始化器里读 location 会造成 SSR/CSR 水合不匹配。
  const [webMock, setWebMock] = useState(false)
  // dev-only 跳过面板预览门:?__flmock=1&__flskip=1 时徽章面板切到「今日跳过」版,
  // 供 Web 端(3456)截图回归定时锁的锁内 UI;不带 __flskip 保持原有测试面板。
  const [skipPreview, setSkipPreview] = useState(false)
  useEffect(() => {
    if (process.env.NODE_ENV === 'development') {
      const params = new URLSearchParams(window.location.search)
      if (params.get('__flmock') === '1') setWebMock(true)
      if (params.get('__flskip') === '1') setSkipPreview(true)
    }
  }, [])
  const showUi = inTauri || webMock

  // ── 锁状态 ────────────────────────────────────────────────
  const [status, setStatus] = useState<FocusLockStatus | null>(null)
  const [remaining, setRemaining] = useState(0)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [overlayOpen, setOverlayOpen] = useState(false)
  // 过场动画:开启黑场(挂载即播,INTRO_MS 后卸载)/ 退场黑场(cross=盖上播入,
  // out=收 ended 后淡出,ENDING_OUT_MS 后卸载)
  const [introOn, setIntroOn] = useState(false)
  // dev 预览门 __flintro=hold:开场过场挂住定格(压掉 CSS 淡出让位),供逐态截图
  const [flIntroHold, setFlIntroHold] = useState(false)
  const [endingPhase, setEndingPhase] = useState<null | 'cross' | 'out'>(null)
  const introTimer = useRef<number | null>(null)
  const endingTimer = useRef<number | null>(null)

  // ── 弹层表单 ──────────────────────────────────────────────
  const [preset, setPreset] = useState(60)
  const [customOn, setCustomOn] = useState(false)
  const [test30On, setTest30On] = useState(false)
  // 正计时档(D13,入口 D17 拍板 A 案):步进器旁胶囊,与自定义/测试档互斥
  const [countUpOn, setCountUpOn] = useState(false)
  // 课程面板(2.3 收尾,拍板 B 案):开关展开输入行,贴 B 站链接随启动透传 Rust
  const [courseOn, setCourseOn] = useState(false)
  const [courseUrl, setCourseUrl] = useState('')
  const [customVal, setCustomVal] = useState('')
  const [refocus, setRefocus] = useState(true)
  const [confirming, setConfirming] = useState(false)
  const confirmTimer = useRef<number | null>(null)
  // 正计时档唯一出口(D15):徽章面板「结束专注」两击确认
  const [endConfirming, setEndConfirming] = useState(false)
  const endTimer = useRef<number | null>(null)
  // 测试阶段逃生口:锁定徽章点开的暂停面板(验收后移除)
  const [testPanelOpen, setTestPanelOpen] = useState(false)
  const [stopConfirming, setStopConfirming] = useState(false)
  const stopTimer = useRef<number | null>(null)
  // 定时锁「今日跳过」两击确认(跳过只免当天剩余锁段,每月 2 次)
  const [skipConfirming, setSkipConfirming] = useState(false)
  const skipTimer = useRef<number | null>(null)

  // ── 目标制(R7):本轮小目标,可整体跳过 ──────────────────────────────
  const [goalText, setGoalText] = useState('')
  const [goalCustomOn, setGoalCustomOn] = useState(false)
  // 锁定中展示用目标(locked 翻转时读 localStorage;解锁回执同样消费)
  const [lockedGoal, setLockedGoal] = useState('')
  // ── 解锁回执(R5):ended 后一次性展示,AI 点评异步淡入 ──────────────────
  const [receipt, setReceipt] = useState<FocusReceipt | null>(null)

  // ── 锁前检查(R3, focus-lock-restrict-plan.md §3.2)────────────────
  // 当前会话挂受限面具(游戏/闲聊向)时:弹层出琥珀提示,启动时自动切回默认助手
  const conversationMaskId = useChatStore((s) => s.conversationMaskId)
  const preflightRestricted = isMaskRestricted({ id: conversationMaskId })
  const preflightMaskName = preflightRestricted
    ? getBuiltinMask(conversationMaskId)?.name ?? '该面具'
    : ''

  // 上次使用的时长与追焦开关(mount 后读 localStorage)
  useEffect(() => {
    try {
      const r = localStorage.getItem(FOCUS_REFOCUS_KEY)
      if (r !== null) setRefocus(r === '1')
      const lm = localStorage.getItem(FOCUS_LAST_MIN_KEY)
      if (lm) {
        const n = Number(lm)
        if (n >= MIN_MIN && n <= MAX_MIN) {
          if (PRESETS.includes(n)) setPreset(n)
          else {
            setCustomOn(true)
            setCustomVal(String(n))
          }
        }
      }
    } catch {
      // ignore
    }
    return () => {
      if (confirmTimer.current) window.clearTimeout(confirmTimer.current)
      if (endTimer.current) window.clearTimeout(endTimer.current)
      if (stopTimer.current) window.clearTimeout(stopTimer.current)
      if (skipTimer.current) window.clearTimeout(skipTimer.current)
      if (introTimer.current) window.clearTimeout(introTimer.current)
      if (endingTimer.current) window.clearTimeout(endingTimer.current)
    }
  }, [])

  // 桌面 mount:查询锁状态(restored=重启续锁 → 弹覆盖层 + toast);
  // Rust 侧 boot restore 的 restored 事件在 listen 建立前就发了,这里以 status 查询为主通道。
  useEffect(() => {
    if (!inTauri) {
      if (webMock) {
        // __flcountup=1:webMock 正计时档演示(徽章累计 + 结束专注按钮 + 回执链路)
        const params = new URLSearchParams(window.location.search)
        const cu = params.get('__flcountup') === '1'
        const now = Date.now()
        const st: FocusLockStatus = cu
          ? {
              locked: true,
              endsAtMs: 0,
              remainingMs: 0,
              countUp: true,
              startedAtMs: now,
              refocus: true,
              courseUrl: null,
              restored: false,
            }
          : {
              locked: true,
              endsAtMs: now + 60 * 60 * 1000,
              remainingMs: 60 * 60 * 1000,
              countUp: false,
              startedAtMs: now,
              refocus: true,
              courseUrl: null,
              restored: false,
            }
        syncFocusLockStatus(st)
        setStatus(st)
        setRemaining(st.remainingMs)
        // __flintro=1:模拟「进入锁定」链路(开场过场 → B 覆盖层),供 Web 端回归
        // 覆盖层与其 3s 无操作自动关;Web 端 focusLockStart 会 reject,走不了真启动,
        // 不带此参数保持原样,不影响徽章/弹层截图配方。=hold:挂住开场定格不淡出卸载
        // (压掉 CSS 2.45s 退场动画,见 .fl-intro-hold),供逐态截图
        if (params.get('__flintro')) {
          setOverlayOpen(true)
          setIntroOn(true)
          if (params.get('__flintro') === 'hold') {
            setFlIntroHold(true)
          } else {
            if (introTimer.current) window.clearTimeout(introTimer.current)
            introTimer.current = window.setTimeout(() => setIntroOn(false), INTRO_MS)
          }
        }
        // __flending=1:模拟「退场过场」链路(cross 盖上 → 2.7s 后 out 淡出 → 卸载),
        // 供 Web 端截图回归退场大完章构图;真实链路由 Rust ending/ended 事件驱动,
        // Web 端走不到(finishLockLocally 只在已 cross 时才转 out)。=hold:挂住 cross
        // 态不自动退场,供逐态截图(IAB 截图时机追不上 3.15s 生命周期)。
        if (params.get('__flending')) {
          setEndingPhase('cross')
          if (params.get('__flending') !== 'hold') {
            if (endingTimer.current) window.clearTimeout(endingTimer.current)
            endingTimer.current = window.setTimeout(() => {
              setEndingPhase('out')
              endingTimer.current = window.setTimeout(() => setEndingPhase(null), ENDING_OUT_MS)
            }, 2700)
          }
        }
      }
      return
    }
    let alive = true
    tauri.focusLockStatus().then((st) => {
      if (!alive) return
      // 全局锁状态同步(store 消费方:面具置灰/平台档回退/监工注入/发送守卫)
      syncFocusLockStatus(st)
      if (!st?.locked) {
        // 查询明确返回未锁定(非 IPC 失败的 null)时,清掉上一轮定时锁残留的
        // 调度标记,避免跳过入口/面板信息跨锁泄漏
        if (st) {
          setSchedLockActive(false)
          setSchedWindowInfo(null)
        }
        return
      }
      setStatus(st)
      setRemaining(st.remainingMs)
      if (st.restored) {
        setOverlayOpen(true)
        toast.info(
          st.countUp ? '已自动恢复锁定 · 正计时继续累计' : `已自动恢复锁定 · 剩余 ${fmtRemaining(st.remainingMs)}`,
          { title: '监管模式' }
        )
      }
    })
    const offBlocked = tauri.onFocusLockBlocked((ms) => {
      const cu = getFocusLockState().countUp
      toast.warning(
        cu ? `窗口我看着呢 · 已专注 ${fmtRemaining(ms)}，学完点徽章结束` : `窗口我看着呢 · 剩余 ${fmtRemaining(ms)}，到点自动解锁`,
        { title: '监管模式' }
      )
    })
    // 退场过场:Rust 广播 ending(黑场盖上、四字重播;窗口仍全屏锁定)→
    // 约 2.7s 后窗口还原、ended 到达 → 淡出让位 + 统一清理状态
    const offEnding = tauri.onFocusLockEnding(() => {
      setEndingPhase('cross')
    })
    const offEnded = tauri.onFocusLockEnded((min) => {
      // R5:ended 全链路统一走 finishLockLocally(清状态 + 退场过场 + 出回执);
      // 原「画完这一页啦」toast 由回执卡取代,避免重复播报
      finishLockLocally(min)
    })
    const offRestored = tauri.onFocusLockRestored((ms) => {
      const cu = getFocusLockState().countUp
      toast.info(
        cu ? `已自动恢复锁定 · 已专注 ${fmtRemaining(ms)}` : `已自动恢复锁定 · 剩余 ${fmtRemaining(ms)}`,
        { title: '监管模式' }
      )
    })
    // 外部启动感知:今晚测验(EveningQuiz)在组件外直调 focus_lock_start(30 分钟
    // 兜底),Rust 侧无 started 广播,监听窗口事件重查状态补上徽章与倒计时。
    const onExternalSync = () => {
      tauri.focusLockStatus().then((st) => {
        if (!alive) return
        syncFocusLockStatus(st)
        if (!st?.locked) return
        setStatus(st)
        setRemaining(st.remainingMs)
      })
    }
    window.addEventListener('fl:sync', onExternalSync)
    return () => {
      alive = false
      offBlocked()
      offEnding()
      offEnded()
      offRestored()
      window.removeEventListener('fl:sync', onExternalSync)
    }
  }, [inTauri, webMock])

  // ── 定时锁定调度(R1,定案口径 preview-focus-lock-schedule.html)──────────
  // 周一至周五在家时段自动上锁:打开即补触发 + 30s 轮询(与今晚测验引擎同款)。
  // 跳过当日剩余锁段(isScheduleSkippedToday)与课表开关都在 store,每 tick 重读。
  // Rust 锁本体零改动:复用 focus_lock_start(minutes=到本段结束剩余分钟,追焦常开);
  // Rust 档位下限 5 分钟,窗口尾段不足 5 分钟时不补锁(已近解锁点,视为饭点尾)。
  const startingRef = useRef(false)
  useEffect(() => {
    if (!inTauri) return
    refreshSchedule()
    const maybeStart = async () => {
      if (startingRef.current) return
      if (getFocusLockState().locked) return
      const cfg = getScheduleConfig()
      if (!cfg.enabled) return
      const now = new Date()
      if (isScheduleSkippedToday()) return
      const hit = findActiveScheduleWindow(cfg, now)
      if (!hit) return
      startingRef.current = true
      try {
        // 状态以 Rust 为准防脱同步(store 可能因 IPC 抖动误判未锁)
        const cur = await tauri.focusLockStatus().catch(() => null)
        if (cur?.locked) {
          syncFocusLockStatus(cur)
          return
        }
        if (hit.minutesLeft < 5) return
        await runLockPreflight()
        // 定时锁不带小目标、计数从零起算(手动锁目标制不适用自动触发)
        setFocusGoal('')
        resetFocusCounters()
        const st = await tauri.focusLockStart(hit.minutesLeft, true)
        if (!st) throw new Error('定时锁启动失败')
        setSchedLockActive(true)
        setSchedWindowInfo({ id: hit.win.id, label: hit.win.label, end: hit.win.end })
        syncFocusLockStatus(st)
        setStatus(st)
        setRemaining(st.remainingMs)
        setSheetOpen(false)
        setOverlayOpen(true)
        setIntroOn(true)
        if (introTimer.current) window.clearTimeout(introTimer.current)
        introTimer.current = window.setTimeout(() => setIntroOn(false), INTRO_MS)
        toast.info(`定时锁 · ${hit.win.label}已自动开启，${hit.win.end} 解锁`, { title: '监管模式' })
      } catch (err) {
        // 定时启动失败不打断用户:30s 后下一 tick 重试,只落日志
        console.error('[FocusLock] scheduled start failed:', err)
      } finally {
        startingRef.current = false
      }
    }
    maybeStart()
    const id = window.setInterval(maybeStart, 30000)
    return () => window.clearInterval(id)
  }, [inTauri])

  // 定时锁提示条 tick:弹层提示行/跳过面板配额每 30s 刷新(Web 预览门也要走)
  const [schedTick, setSchedTick] = useState(0)
  useEffect(() => {
    if (!showUi) return
    const id = window.setInterval(() => setSchedTick((t) => t + 1), 30000)
    return () => window.clearInterval(id)
  }, [showUi])

  // 弹层提示行文案:课表态势一行(开弹层即取最新 + 每 30s tick 重算;课表关闭为 null)
  const schedHint = useMemo(
    () => (showUi ? getScheduleHint(new Date()) : null),
    [showUi, schedTick, sheetOpen]
  )

  // 计秒:锁定中每秒墙钟重算(休眠唤醒后自动校正)。
  // 倒计时档按 endsAtMs 算剩余;正计时档(D13)无截止时刻,按 startedAtMs 累计
  // 已专注时长 —— remaining 复用为「已专注毫秒」,徽章/覆盖层渲染逻辑不变
  const locked = status?.locked ?? false
  const endsAtMs = status?.endsAtMs ?? 0
  const countUp = status?.countUp ?? false
  const startedAtMs = status?.startedAtMs ?? 0

  // 受限模式(监管锁)期间保持纯聊天:进入锁定若仍在「工作模式」(右侧产物区),
  // 自动切回聊天模式(2026-11-20 用户口径)。手动/定时/重启续锁/外部启动四条
  // 路径最终都落到 status.locked,故以 locked 作为唯一触发点。
  useEffect(() => {
    if (!locked) return
    const store = useChatStore.getState()
    if (store.workMode) store.setWorkMode(false)
  }, [locked])
  useEffect(() => {
    if (!locked) return
    if (countUp) {
      if (!startedAtMs) return
      setRemaining(Math.max(0, Date.now() - startedAtMs))
      const id = window.setInterval(() => {
        setRemaining(Math.max(0, Date.now() - startedAtMs))
      }, 1000)
      return () => window.clearInterval(id)
    }
    if (!endsAtMs) return
    setRemaining(Math.max(0, endsAtMs - Date.now()))
    const id = window.setInterval(() => {
      setRemaining(Math.max(0, endsAtMs - Date.now()))
    }, 1000)
    return () => window.clearInterval(id)
  }, [locked, endsAtMs, countUp, startedAtMs])

  // 锁定中展示本轮目标:锁定开始/恢复时读一次,解锁即清
  useEffect(() => {
    setLockedGoal(locked ? getFocusGoal() : '')
  }, [locked])

  // B 覆盖层 3s 无操作自动关:从真正露出起算(手动/定时锁要等开场黑场让位,
  // restored 续锁无过场即时起算);点击任意处仍是即时关,计时只兜「人不在/懒得点」,
  // 不被键盘等其他输入重置 —— 覆盖层是告示牌,到点就该让位给锁中工作面
  useEffect(() => {
    if (!overlayOpen || introOn) return
    const id = window.setTimeout(() => setOverlayOpen(false), OVERLAY_AUTO_CLOSE_MS)
    return () => window.clearTimeout(id)
  }, [overlayOpen, introOn])

  // R5 解锁收尾:ended 事件与 webMock 模拟解锁共用 —— 清锁状态、退场过场淡出、出回执。
  // 退场过场(「完」章)淡出后展示,衔接不抢戏;AI 点评 ≥20 分钟才异步请求。
  const finishLockLocally = (min: number) => {
    const data: FocusReceipt = {
      min,
      msgs: getFocusCounters().msgs,
      intercepts: getFocusCounters().intercepts,
      goal: getFocusGoal(),
      ai: min >= RECEIPT_AI_MIN_MINUTES ? null : undefined,
    }
    // 统一清理锁状态:store(clearFocusLock)驱动徽章/面具置灰/发送守卫复原,
    // 组件 status 置空解除整窗换肤(data-fl-locked);退场过场 cross → out 播
    // .fl-tr-out 淡出,ENDING_OUT_MS 后卸载 —— 此步曾缺失,ended 后过场层永久盖窗。
    clearFocusLock()
    setStatus(null)
    setOverlayOpen(false)
    setEndingPhase((p) => (p === 'cross' ? 'out' : p))
    clearFocusGoal()
    resetFocusCounters()
    // 定时锁的调度标记随解锁一并清掉(手动锁本就没有,清了也无副作用)
    setSchedLockActive(false)
    setSchedWindowInfo(null)
    window.setTimeout(() => {
      setEndingPhase(null)
      setReceipt(data)
      if (data.ai === null) {
        fetchReceiptReview(data)
          .then((ai) => setReceipt((r) => (r ? { ...r, ai: ai || undefined } : r)))
          .catch(() => setReceipt((r) => (r ? { ...r, ai: undefined } : r)))
      }
    }, ENDING_OUT_MS)
  }

  // 回执 8s 自动收:AI 点评生成中不计时(否则 8s 早于点评返回,用户永远看不到点评);
  // 点评落地(string)或放弃(undefined)后才起 8s —— receipt 变化时重置
  useEffect(() => {
    if (!receipt || receipt.ai === null) return
    const id = window.setTimeout(() => setReceipt(null), 8000)
    return () => window.clearTimeout(id)
  }, [receipt])

  // 锁定全屏期去窗口圆角:透明窗口的 CSS 圆角在全屏下会于四角裁出透明缺口。
  // data-fl-locked 同时是「蜡笔绘本」整窗换肤的门(html[data-fl-locked],globals.css)
  useEffect(() => {
    if (!showUi) return
    if (locked) document.documentElement.setAttribute('data-fl-locked', '')
    else document.documentElement.removeAttribute('data-fl-locked')
  }, [showUi, locked])

  // 锁定期禁用窗口拖动区:Tauri 注入脚本在 mousedown 冒泡阶段发现 target 自带
  // data-tauri-drag-region 就调 start_dragging,全屏窗口会被系统拖离全屏。
  // 在 window 捕获阶段(早于注入脚本的 document 监听)掐掉;判据与注入脚本一致
  // (仅 target 本身带属性),drag 区内的按钮/输入不受影响。Rust 侧另有
  // Moved/Resized 强制拉回全屏兜底(防 Alt+Space 系统菜单等非常规路径)。
  useEffect(() => {
    if (!locked) return
    const h = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.hasAttribute?.('data-tauri-drag-region')) {
        e.stopImmediatePropagation()
      }
    }
    window.addEventListener('mousedown', h, true)
    return () => window.removeEventListener('mousedown', h, true)
  }, [locked])

  if (!showUi) return null

  // 定时锁分支:调度器起始的锁(或 Web 预览门 __flskip)露出「今日跳过」;
  // 手动开锁保持无退出入口不变
  const schedSkipMode = isSchedLockActive() || (webMock && skipPreview)
  const skipUsage = getSkipUsage()
  const schedWinInfo = getSchedWindowInfo()

  // ── 两击确认启动 ──────────────────────────────────────────
  const handleConfirm = async () => {
    if (!confirming) {
      setConfirming(true)
      if (confirmTimer.current) window.clearTimeout(confirmTimer.current)
      confirmTimer.current = window.setTimeout(() => setConfirming(false), 3000)
      return
    }
    if (confirmTimer.current) {
      window.clearTimeout(confirmTimer.current)
      confirmTimer.current = null
    }
    setConfirming(false)

    // 锁前处理(R3):受限面具切回默认助手、受限搜索档回退全网(与定时锁共用)
    await runLockPreflight()

    const minutes = customOn ? Math.round(Number(customVal)) : preset
    if (!test30On && !countUpOn && !(minutes >= MIN_MIN && minutes <= MAX_MIN)) {
      toast.warning(`时长需为 ${MIN_MIN} - ${MAX_MIN} 分钟`, { title: '监管模式' })
      return
    }
    try {
      // 30 秒测试档:走 Rust test_seconds 通道(落盘 total_min=0,结束 toast 显示"测试")
      // 正计时档(D13):countUp=true,无截止时刻,唯一出口=徽章面板「结束专注」
      // 课程面板(2.3):开关开着才透传链接(留空=仅开面板不导航,进空态)
      const courseParam = courseOn ? courseUrl.trim() || null : null
      const st = test30On
        ? await tauri.focusLockStart(0, refocus, courseParam, 30)
        : await tauri.focusLockStart(minutes, refocus, courseParam, undefined, countUpOn)
      if (!st) throw new Error('启动失败')
      syncFocusLockStatus(st)
      setStatus(st)
      setRemaining(st.remainingMs)
      setSheetOpen(false)
      // R7:本轮目标随启动写入(空串=清掉旧目标);R5 计数从零起算
      // (重启续锁 restored 走 mount 分支,不经过这里,计数与目标保留)
      setFocusGoal(goalText.trim())
      resetFocusCounters()
      setOverlayOpen(true)
      // 开场黑场过场:B 覆盖层此刻已挂在黑场之下,2.45s 黑场让位露出大字倒计时
      setIntroOn(true)
      if (introTimer.current) window.clearTimeout(introTimer.current)
      introTimer.current = window.setTimeout(() => setIntroOn(false), INTRO_MS)
      try {
        // 正计时档无「分钟数」概念,不落 lastMinutes(下次弹层不回填)
        if (!countUpOn) localStorage.setItem(FOCUS_LAST_MIN_KEY, String(minutes))
        localStorage.setItem(FOCUS_REFOCUS_KEY, refocus ? '1' : '0')
      } catch {
        // ignore
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), { title: '监管模式启动失败' })
    }
  }

  // 测试阶段:两击确认手动暂停锁定
  const handleStop = async () => {
    if (!stopConfirming) {
      setStopConfirming(true)
      if (stopTimer.current) window.clearTimeout(stopTimer.current)
      stopTimer.current = window.setTimeout(() => setStopConfirming(false), 3000)
      return
    }
    if (stopTimer.current) {
      window.clearTimeout(stopTimer.current)
      stopTimer.current = null
    }
    setStopConfirming(false)
    setTestPanelOpen(false)
    if (webMock) {
      // dev 预览门:Web 端无 Rust 锁,本地模拟 ended 全链路(退场过场+回执+目标清理),
      // 按真实经过时长计 min;暂停面板另有「45 分钟演示」按钮验 AI 点评链路。
      // 正计时档 remaining 已是已专注毫秒,直接换算(不足 1 分钟记 1,同 Rust 口径)
      const elapsedMin = getFocusLockState().countUp
        ? Math.max(1, Math.round(remaining / 60000))
        : Math.max(0, Math.round((60 * 60 * 1000 - remaining) / 60000))
      finishLockLocally(elapsedMin)
      return
    }
    try {
      // 两段式退场:命令返回时锁仍在(过场中),UI 清理一律由 ending/ended
      // 事件驱动 —— ending 播退场黑场,ended(约 2.7s 后)清状态 + 让位
      await tauri.focusLockStop()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), { title: '暂停失败' })
    }
  }

  // 正计时档唯一出口(D15/D16):徽章面板「结束专注」两击确认 → focus_lock_end。
  // 主动结束不算破戒;ended 载荷 = Rust 侧算的实际累计分钟,回执链路与倒计时共用
  const handleEnd = async () => {
    if (!endConfirming) {
      setEndConfirming(true)
      if (endTimer.current) window.clearTimeout(endTimer.current)
      endTimer.current = window.setTimeout(() => setEndConfirming(false), 3000)
      return
    }
    if (endTimer.current) {
      window.clearTimeout(endTimer.current)
      endTimer.current = null
    }
    setEndConfirming(false)
    setTestPanelOpen(false)
    if (webMock) {
      finishLockLocally(Math.max(1, Math.round(remaining / 60000)))
      return
    }
    try {
      await tauri.focusLockEnd()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), { title: '结束失败' })
    }
  }

  // 定时锁「今日跳过」(R2):两击确认 → 扣月度配额(每月 2 次)→ 走与测试暂停
  // 相同的退场链路(focus_lock_stop,不记破戒)。跳过只免当天剩余锁段:
  // store 的 skipDate 标记会让调度器今天不再自动上锁,明天照常。
  const handleSkip = async () => {
    if (!skipConfirming) {
      setSkipConfirming(true)
      if (skipTimer.current) window.clearTimeout(skipTimer.current)
      skipTimer.current = window.setTimeout(() => setSkipConfirming(false), 3000)
      return
    }
    if (skipTimer.current) {
      window.clearTimeout(skipTimer.current)
      skipTimer.current = null
    }
    setSkipConfirming(false)
    setTestPanelOpen(false)
    if (webMock) {
      // dev 预览门:先扣配额再本地模拟 ended 全链路(计时口径与测试暂停一致)
      consumeSkipDay()
      const elapsedMin = getFocusLockState().countUp
        ? Math.max(1, Math.round(remaining / 60000))
        : Math.max(0, Math.round((60 * 60 * 1000 - remaining) / 60000))
      finishLockLocally(elapsedMin)
      return
    }
    try {
      // 两段式退场:UI 清理由 ending/ended 事件驱动;先停锁再扣配额,
      // 停锁失败不消耗次数
      await tauri.focusLockStop()
      consumeSkipDay()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), { title: '跳过失败' })
    }
  }

  // 自定义输入失焦:越界钳回范围
  const clampCustom = () => {
    const n = Math.round(Number(customVal))
    if (Number.isFinite(n) && n > 0) setCustomVal(String(Math.min(MAX_MIN, Math.max(MIN_MIN, n))))
  }

  const selectedMinutes = customOn ? Math.round(Number(customVal) || 0) : preset
  const valid = test30On || countUpOn || (selectedMinutes >= MIN_MIN && selectedMinutes <= MAX_MIN)

  // 时长步进器(B 案,学科切换器同款):箭头在预设档间逐档移动,到头禁用;
  // 点胶囊展开自定义输入,点 30 秒测试/正计时胶囊切档 —— 互斥切换先清另外两态
  const presetIdx = Math.max(0, PRESETS.indexOf(preset))
  const customNum = Math.round(Number(customVal))
  const stepMinLabel = test30On
    ? '《 30s》'
    : countUpOn
      ? '《 ∞ 》'
      : customOn
        ? `《 ${customNum >= MIN_MIN && customNum <= MAX_MIN ? customNum : '—'}min》`
        : `《 ${preset}min》`
  const stepPreset = (dir: number) => {
    setPreset(PRESETS[Math.min(PRESETS.length - 1, Math.max(0, presetIdx + dir))])
    setCustomOn(false)
    setTest30On(false)
    setCountUpOn(false)
  }

  return (
    <>
      {/* 锁定中:倒计时徽章(测试阶段点击弹暂停面板;正式版改为纯提示)。
          webMock 预览门额外保留入口按钮,便于在 Web 端一并验收开启弹层 */}
      {locked ? (
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setTestPanelOpen(true)}
            className="fl-badge shrink-0 inline-flex items-center gap-1 px-2 h-[26px] rounded-full text-[11px] font-semibold transition duration-150 active:scale-95"
            aria-label={
              countUp
                ? `监管模式锁定中,已专注 ${fmtRemaining(remaining)}`
                : `监管模式锁定中,剩余 ${fmtRemaining(remaining)}`
            }
            title={
              countUp
                ? `监管模式锁定中 · 已专注 ${fmtRemaining(remaining)},学完在面板手动结束`
                : endsAtMs
                  ? `监管模式锁定中 · ${new Date(endsAtMs).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 自动解锁`
                  : '监管模式锁定中'
            }
            style={{ WebkitTapHighlightColor: 'transparent', WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <span className="fl-badge-chick" aria-hidden><CrayonChick /></span>
            {fmtRemaining(remaining)}
          </button>
          {testPanelOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setTestPanelOpen(false)} />
              <div
                className="absolute left-0 top-full mt-1.5 z-50 w-64 rounded-xl border border-line bg-surface shadow-lg p-4"
                role="dialog"
                aria-label={schedSkipMode ? '定时锁进行中' : '监管模式锁定中'}
              >
                <div className="flex items-baseline gap-2">
                  <span className="text-3xl font-semibold tracking-tight text-content-primary">
                    {fmtRemaining(remaining)}
                  </span>
                  <span className="text-[11px] text-content-muted">
                    {schedSkipMode
                      ? '定时锁'
                      : countUp
                        ? '已专注 · 学完手动结束'
                        : endsAtMs
                          ? `${new Date(endsAtMs).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 自动解锁`
                          : '锁定中'}
                  </span>
                </div>
                {schedSkipMode ? (
                  <>
                    {/* 本段信息:调度器上锁时落盘;重启续锁丢信息时降级为通用文案 */}
                    {schedWinInfo ? (
                      <p className="mt-1.5 text-[11px] leading-5 text-content-secondary flex items-start gap-1">
                        <Shield className="w-3 h-3 text-[#a4762c] dark:text-[#fff6c9] shrink-0 mt-0.5" aria-hidden />
                        <span className="min-w-0">定时锁 · {schedWinInfo.label} · {schedWinInfo.end} 自动解锁</span>
                      </p>
                    ) : (
                      <p className="mt-1.5 text-[11px] leading-5 text-content-secondary flex items-start gap-1">
                        <Shield className="w-3 h-3 text-[#a4762c] dark:text-[#fff6c9] shrink-0 mt-0.5" aria-hidden />
                        <span className="min-w-0">定时锁进行中 · 到点自动解锁</span>
                      </p>
                    )}
                    {lockedGoal && (
                      <p className="mt-2 text-[11px] leading-5 text-content-secondary flex items-start gap-1">
                        <Target className="w-3 h-3 text-[#a4762c] dark:text-[#fff6c9] shrink-0 mt-0.5" aria-hidden />
                        <span className="min-w-0">这轮目标:{lockedGoal}</span>
                      </p>
                    )}
                    <p className="mt-2 text-[11px] leading-5 text-content-muted">
                      {skipUsage.unlimited
                        ? '测试期不限次 · 两击确认 · 跳过后今天剩余锁段全免,明天照常。'
                        : '每月仅 2 次 · 两击确认 · 跳过后今天剩余锁段全免，明天照常。'}
                    </p>
                    <button
                      type="button"
                      onClick={handleSkip}
                      disabled={!skipUsage.unlimited && skipUsage.left <= 0}
                      className={cn(
                        'mt-2.5 h-9 w-full rounded-lg text-xs font-medium transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed',
                        skipConfirming
                          ? 'bg-red-500 text-white hover:bg-red-600'
                          : 'border border-line bg-surface-muted text-content-secondary hover:bg-surface-subtle'
                      )}
                    >
                      {!skipUsage.unlimited && skipUsage.left <= 0
                        ? '本月跳过次数已用完'
                        : skipConfirming
                          ? '再次点击确认跳过今天'
                          : skipUsage.unlimited
                            ? '今日跳过(测试期不限次)'
                            : `今日跳过(本月剩 ${skipUsage.left} 次)`}
                    </button>
                    <p className="mt-2 text-[11px] leading-5 text-content-muted">
                      {skipUsage.unlimited
                        ? `本月已用 ${skipUsage.used} 次 · 测试期不限次 · 周末不自动锁`
                        : `本月已用 ${skipUsage.used} / 2 次 · 周末不自动锁`}
                    </p>
                  </>
                ) : (
                  <>
                    {lockedGoal && (
                      <p className="mt-2 text-[11px] leading-5 text-content-secondary flex items-start gap-1">
                        <Target className="w-3 h-3 text-[#a4762c] dark:text-[#fff6c9] shrink-0 mt-0.5" aria-hidden />
                        <span className="min-w-0">
                          这轮目标:{lockedGoal}
                        </span>
                      </p>
                    )}
                    {countUp && (
                      <button
                        type="button"
                        onClick={handleEnd}
                        className={cn(
                          'mt-2.5 h-9 w-full rounded-lg text-xs font-medium transition-colors duration-150',
                          endConfirming
                            ? 'bg-red-500 text-white hover:bg-red-600'
                            : 'bg-[#fff6c9] text-[#433a2e] hover:bg-[#ffe98f]'
                        )}
                      >
                        {endConfirming ? '再次点击确认结束专注' : '结束专注'}
                      </button>
                    )}
                    <p className="mt-2 text-[11px] leading-5 text-[#a4762c] dark:text-[#fff6c9]">
                      {countUp
                        ? '正计时没有到点,「结束专注」是唯一出口。'
                        : '测试阶段临时入口:允许随时暂停。正式版将移除,锁定期内到点自动解锁。'}
                    </p>
                    <button
                      type="button"
                      onClick={handleStop}
                      className={cn(
                        'mt-2.5 h-9 w-full rounded-lg text-xs font-medium transition-colors duration-150',
                        stopConfirming
                          ? 'bg-red-500 text-white hover:bg-red-600'
                          : 'border border-line bg-surface-muted text-content-secondary hover:bg-surface-subtle'
                      )}
                    >
                      {stopConfirming ? '再次点击确认暂停锁定' : '暂停锁定(测试)'}
                    </button>
                    {webMock && (
                      <button
                        type="button"
                        onClick={() => finishLockLocally(45)}
                        className="mt-2 h-9 w-full rounded-lg text-xs font-medium border border-line bg-surface-muted text-content-secondary hover:bg-surface-subtle transition-colors duration-150"
                      >
                        模拟 45 分钟解锁(演示回执+点评)
                      </button>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      ) : null}
      {/* 入口按钮:未锁定时渲染(桌面+webMock);锁定中仅 webMock 预览门保留,
          真实 Tauri 锁定中只显示倒计时徽章 */}
      {(!locked || webMock) && (
        <div className="relative shrink-0">
          {/* 入口按钮 */}
          <button
            type="button"
            onClick={() => setSheetOpen((v) => !v)}
            className="shrink-0 inline-flex items-center justify-center p-1.5 rounded-full text-content-secondary hover:text-content-primary hover:bg-surface-subtle transition duration-150 active:scale-95 touch-manipulation"
            aria-label="监管模式"
            title="监管模式(锁定窗口专注学习)"
            aria-haspopup="dialog"
            aria-expanded={sheetOpen}
            style={{ WebkitTapHighlightColor: 'transparent', WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <Shield className="w-3.5 h-3.5" />
          </button>
          {sheetOpen && (
            <>
              {/* 点外部关闭(同快捷键面板:TopBar 内 fixed 遮罩可用) */}
              <div className="fixed inset-0 z-40" onClick={() => setSheetOpen(false)} />
              <div
                className="fl-sheet absolute left-0 top-full mt-1.5 z-50 w-72 rounded-xl border border-line bg-surface shadow-lg p-4"
                role="dialog"
                aria-label="监管模式"
              >
                <div className="flex items-center gap-2.5 text-xs font-semibold text-content-primary">
                  <span className="fl-sheet-chick" aria-hidden><CrayonChick /></span>
                  监管模式
                </div>
                <p className="fl-cheer-line">
                  开始后我会把窗口看得紧紧的：<b>全屏置顶</b>、切窗拉回，
                  <b>{countUpOn ? '学完点徽章手动结束' : '中途没有退出按钮，到点准时放你走'}</b>哦！
                </p>

                {/* 定时锁定提示条(R1):课表开着时展示今天的自动锁态势(30s tick 刷新) */}
                {schedHint && (
                  <p className="mt-1.5 flex items-start gap-1 text-[11px] leading-5 text-content-muted">
                    <span aria-hidden className="shrink-0">⏱</span>
                    <span>定时锁:{schedHint.text}</span>
                  </p>
                )}

                {/* 时长档:B 案黄虚线纸块 + 学科切换器同款步进器(左右箭头逐档/胶囊点开自定义) */}
                <div className="fl-sec fl-sec-dur">
                  <div className="fl-sec-label">
                    <span className="fl-sec-num">①</span>
                    锁定时长
                    <span className="fl-sec-rule">{countUpOn ? '无到点 · 学完手动结束' : '到点自动放行'}</span>
                  </div>
                  <div className="fl-stepper mt-2">
                    <button
                      type="button"
                      className="fl-step-btn"
                      onClick={() => stepPreset(-1)}
                      disabled={presetIdx <= 0}
                      aria-label="上一档时长"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCustomOn((v) => !v)
                        setTest30On(false)
                        setCountUpOn(false)
                      }}
                      className={cn('fl-step-value', customOn && 'fl-custom-open')}
                      aria-label="当前时长,点击改为自定义输入"
                    >
                      <span className="fl-step-min">{stepMinLabel}</span>
                      <ChevronDown className="fl-step-chev" aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="fl-step-btn"
                      onClick={() => stepPreset(1)}
                      disabled={presetIdx >= PRESETS.length - 1}
                      aria-label="下一档时长"
                    >
                      <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                    </button>
                    <span className="fl-step-count">{MIN_MIN}-{MAX_MIN} 分钟</span>
                    {/* 30 秒测试档:验证到点自动解锁,验收后可移除。
                        radio 语义:点已亮档保持开 —— toggle 语义下双击会自关,
                        「30 秒测试没生效」的隐形坑(2026-11-20 用户实测反馈) */}
                    <button
                      type="button"
                      onClick={() => {
                        setTest30On(true)
                        setCustomOn(false)
                        setCountUpOn(false)
                      }}
                      className={cn(
                        'px-2.5 py-1 rounded-full text-xs transition-colors duration-150 shrink-0',
                        test30On
                          ? 'fl-chip-on bg-[#fff6c9] text-[#433a2e]'
                          : 'border border-dashed border-line bg-transparent text-content-secondary hover:bg-surface-subtle'
                      )}
                    >
                      30 秒(测试)
                    </button>
                    {/* 正计时档(D13,入口 D17 拍板 A 案):无截止时刻,学完在徽章面板手动结束。
                        radio 语义同 30 秒测试档(双击不自关) */}
                    <button
                      type="button"
                      onClick={() => {
                        setCountUpOn(true)
                        setCustomOn(false)
                        setTest30On(false)
                      }}
                      className={cn(
                        'px-2.5 py-1 rounded-full text-xs transition-colors duration-150 shrink-0',
                        countUpOn
                          ? 'fl-chip-on bg-[#fff6c9] text-[#433a2e]'
                          : 'border border-dashed border-line bg-transparent text-content-secondary hover:bg-surface-subtle'
                      )}
                      aria-pressed={countUpOn}
                    >
                      正计时
                    </button>
                  </div>
                  {/* 自定义输入 */}
                  {customOn && (
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        type="number"
                        min={MIN_MIN}
                        max={MAX_MIN}
                        value={customVal}
                        onChange={(e) => setCustomVal(e.target.value)}
                        onBlur={clampCustom}
                        placeholder={`${MIN_MIN}-${MAX_MIN}`}
                        autoFocus
                        className="w-20 h-7 rounded-lg border border-line bg-surface-muted px-2 text-xs text-content-primary placeholder:text-content-muted/60 outline-none focus:border-[#d4ac3c]/70"
                      />
                      <span className="text-[11px] text-content-muted">分钟，再点胶囊收回</span>
                    </div>
                  )}
                </div>

                {/* 本轮小目标(R7):预设 chips 两秒点一颗,可整体跳过;解锁回执会带上(B 案黄油虚线便利贴块) */}
                <div className="fl-sec fl-sec-goal mt-3">
                  <div className="fl-sec-label">
                    <span className="fl-sec-num">②</span>
                    这轮的小目标
                    <span className="fl-sec-opt">可选 · 解锁回执会带上</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {GOAL_PRESETS.map((g) => (
                      <button
                        key={g}
                        type="button"
                        onClick={() => {
                          setGoalText((v) => (v === g ? '' : g))
                          setGoalCustomOn(false)
                        }}
                        className={cn(
                          'fl-goal-chip px-2.5 py-1 rounded-full text-xs transition-colors duration-150',
                          goalText === g
                            ? 'fl-chip-on bg-[#fff6c9] text-[#433a2e]'
                            : 'border border-line bg-surface-muted text-content-secondary hover:bg-surface-subtle'
                        )}
                      >
                        {g}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setGoalCustomOn((v) => !v)}
                      className={cn(
                        'fl-goal-chip px-2.5 py-1 rounded-full text-xs transition-colors duration-150',
                        goalText && !GOAL_PRESETS.includes(goalText)
                          ? 'fl-chip-on bg-[#fff6c9] text-[#433a2e]'
                          : 'border border-line bg-surface-muted text-content-secondary hover:bg-surface-subtle'
                      )}
                    >
                      自己写…
                    </button>
                  </div>
                  {goalCustomOn && (
                    <input
                      type="text"
                      value={goalText}
                      onChange={(e) => setGoalText(e.target.value)}
                      maxLength={40}
                      placeholder="例如:背完 unit 5 的 20 个单词"
                      autoFocus
                      className="mt-2 w-full h-7 rounded-lg border border-line bg-surface-muted px-2 text-xs text-content-primary placeholder:text-content-muted/60 outline-none focus:border-[#d4ac3c]/70"
                    />
                  )}
                  {goalText && (
                    <p className="mt-1.5 text-[11px] leading-5 text-content-muted">
                      解锁时会带上:「{goalText}」
                    </p>
                  )}
                </div>

                {/* 课程面板(2.3 收尾,拍板 B 案):开关展开输入行。贴 B 站视频链接启动
                    → 锁定 + 面板自动开进课程模式(门卫白名单 + 净化注入);留空 = 仅开面板 */}
                <div className="mt-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs text-content-primary">锁定时打开课程面板</div>
                    <div className="text-[11px] text-content-muted">右侧分栏看课,锁定期只放行视频页</div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={courseOn}
                    aria-label="锁定时打开课程面板"
                    onClick={() => setCourseOn((v) => !v)}
                    className={cn(
                      'relative w-9 h-5 rounded-full transition-colors duration-150 shrink-0 cursor-pointer',
                      courseOn ? 'fl-switch-on' : 'bg-surface-subtle'
                    )}
                  >
                    <span
                      className={cn(
                        'absolute top-[2px] left-[2px] w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-150',
                        courseOn && 'translate-x-4'
                      )}
                    />
                  </button>
                </div>
                {courseOn && (
                  <div className="fl-sec fl-sec-course mt-2">
                    <input
                      type="url"
                      value={courseUrl}
                      onChange={(e) => setCourseUrl(e.target.value)}
                      placeholder="粘贴 B 站视频链接(选填)"
                      className="w-full h-7 rounded-lg border border-line bg-surface-muted px-2 text-xs text-content-primary placeholder:text-content-muted/60 outline-none focus:border-[#d4ac3c]/70"
                    />
                    <p className="fl-sec-rule mt-1.5">
                      锁定期首页/搜索/推荐全拦掉,只留播放器和选集;留空则只开面板不导航
                    </p>
                  </div>
                )}

                {/* 追焦开关:失焦自动拉回 */}
                <div className="mt-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs text-content-primary">失焦自动拉回</div>
                    <div className="text-[11px] text-content-muted">切去别的窗口时自动抢回前台</div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={refocus}
                    aria-label="失焦自动拉回"
                    onClick={() => setRefocus((v) => !v)}
                    className={cn(
                      'relative w-9 h-5 rounded-full transition-colors duration-150 shrink-0 cursor-pointer',
                      refocus ? 'fl-switch-on' : 'bg-surface-subtle'
                    )}
                  >
                    <span
                      className={cn(
                        'absolute top-[2px] left-[2px] w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-150',
                        refocus && 'translate-x-4'
                      )}
                    />
                  </button>
                </div>

                {/* 锁前检查提示(R3):当前会话挂受限面具 */}
                {preflightRestricted && (
                  <div className="mt-3 flex items-start gap-1.5 px-2.5 py-2 rounded-lg bg-[#fff6c9]/20 border border-[#d4ac3c]/40">
                    <Shield className="w-3.5 h-3.5 text-[#a4762c] dark:text-[#fff6c9] shrink-0 mt-0.5" aria-hidden />
                    <p className="text-[11px] leading-5 text-[#a4762c] dark:text-[#fff6c9]">
                      当前会话挂着「{preflightMaskName}」——锁定期间将暂停，自动切回默认助手，解锁后可回到原会话。
                    </p>
                  </div>
                )}

                {/* 边界说明 */}
                <p className="fl-bound mt-3">
                  重启电脑也会自动续锁剩余时间，请确认好时长再出发。
                </p>

                {/* 两击确认 */}
                <button
                  type="button"
                  onClick={handleConfirm}
                  disabled={!valid}
                  className={cn(
                    'fl-confirm mt-2.5 h-9 w-full rounded-lg text-xs font-medium transition-colors duration-150 disabled:opacity-50',
                    confirming && 'fl-confirm-armed'
                  )}
                >
                  {confirming ? '再次点击确认启动(锁定期内不可退出!)' : test30On ? '开始专注 30 秒(测试)' : countUpOn ? '开始专注(正计时 · 学完手动结束)' : valid ? `开始专注 ${selectedMinutes} 分钟` : `请选择 ${MIN_MIN}-${MAX_MIN} 分钟`}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* B 沉浸覆盖层:进入锁定时弹一次,点击任意处关闭。Portal 到 body
          (TopBar 祖先带 backdrop-filter 时 fixed 会退化)。F 案蜡笔绘本:
          纸卡倒计时 + 「完」章,落樱/闪星装饰;样式见 globals.css .fl-ov-* */}
      {overlayOpen &&
        createPortal(
          <div
            className="fl-ov"
            onClick={() => setOverlayOpen(false)}
            role="dialog"
            aria-label="已进入监管模式"
          >
            <div className="fl-ov-decor" aria-hidden>
              <span className="fl-petal p1" />
              <span className="fl-petal p2" />
              <span className="fl-petal p3" />
              <span className="fl-spark s1" />
              <span className="fl-spark s2" />
              <span className="fl-spark s3" />
            </div>
            <div className="fl-paper-card">
              <span className="fl-ov-chick"><CrayonChick /></span>
              <div className="fl-ov-clock">{fmtRemaining(remaining)}</div>
              <span className="fl-stamp" aria-hidden>完</span>
            </div>
            <div className="fl-ov-cap">已进入监管模式 · 一起写完这一页吧！</div>
            <div className="fl-ov-meta">
              <span className="fl-ov-pill">关闭已拦截</span>
              <span className="fl-ov-pill">切走自动拉回</span>
              {lockedGoal && (
                <span className="fl-ov-pill fl-ov-pill-goal">
                  <Target className="w-3 h-3 shrink-0" aria-hidden />
                  目标 · {lockedGoal}
                </span>
              )}
            </div>
            <div className="fl-ov-hint">点击任意位置，一起安心写完这一页</div>
          </div>,
          document.body
        )}

      {/* 开场过场:黑场盖入 → 盾徽/四字/副文案 → 2.45s 让位露出 B 覆盖层 */}
      {introOn &&
        createPortal(<FlTransition kind="intro" hold={flIntroHold} label="已进入监管模式" />, document.body)}

      {/* 退场过场:ending 黑场盖上重播四字(窗口仍全屏锁定);ended 后 out 淡出让位 */}
      {endingPhase &&
        createPortal(<FlTransition kind="ending" out={endingPhase === 'out'} label="监管模式解除中" />, document.body)}

      {/* R5 解锁回执:右下角轻回执条(方案 A),8s 自动收、点击关闭;AI 点评异步淡入,失败静默不渲染 */}
      {receipt &&
        createPortal(
          <div
            className="fixed right-4 bottom-4 z-[99998] w-[300px] max-w-[calc(100vw-32px)] fl-receipt p-3.5 cursor-pointer"
            role="status"
            aria-label={`本次专注 ${receipt.min > 0 ? `${receipt.min} 分钟` : '不到 1 分钟'}`}
            onClick={() => setReceipt(null)}
          >
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 shrink-0" aria-hidden><CrayonChick /></span>
              <span className="text-[13px] font-semibold fl-receipt-title">画完这一页啦</span>
              <span className="ml-auto text-lg font-bold leading-none fl-gold-text tabular-nums">
                {receipt.min > 0 ? (
                  <>
                    {receipt.min}
                    <span className="text-[10px] font-normal text-content-muted ml-0.5">分钟</span>
                  </>
                ) : (
                  // 30 秒测试档 / 正计时不足 1 分钟的会话:显示「不到 1 分钟」而不是 0
                  <span className="text-[11px] font-semibold">不到 1 分钟</span>
                )}
              </span>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              <span className="px-2 py-0.5 rounded-full bg-surface-muted text-[11px] text-content-secondary">
                发送 {receipt.msgs} 条
              </span>
              <span
                className={cn(
                  'px-2 py-0.5 rounded-full text-[11px]',
                  receipt.intercepts > 0
                    ? 'fl-butter-chip'
                    : 'bg-surface-muted text-content-secondary'
                )}
              >
                拦截 {receipt.intercepts} 次
              </span>
            </div>
            {receipt.goal && (
              <div className="mt-2 flex items-start gap-1.5 px-2.5 py-1.5 rounded-lg fl-receipt-goal pr-8">
                <span className="text-[11px] font-semibold fl-gold-text shrink-0">目标</span>
                <span className="text-[11px] leading-5 text-content-secondary min-w-0 flex-1">{receipt.goal}</span>
              </div>
            )}
            {receipt.ai !== undefined && (
              <div className="mt-2 pt-2 border-t border-line/70 pr-7 text-[11.5px] leading-5">
                {receipt.ai === null ? (
                  <span className="text-content-muted">小鸡正在想想这一轮…</span>
                ) : (
                  <span className="fl-receipt-ai text-content-secondary italic">
                    <span className="not-italic font-semibold fl-gold-text mr-1">小鸡说</span>
                    {receipt.ai}
                  </span>
                )}
              </div>
            )}
            <span className="fl-receipt-stamp" aria-hidden>完</span>
          </div>,
          document.body
        )}
    </>
  )
}
