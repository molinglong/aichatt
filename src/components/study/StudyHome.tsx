'use client'

/**
 * 学习台首页 v3「小鸡书桌」(2026-11-18 第二轮整页替换,挑稿 design/preview-study-home-replace.html 新案二):
 * - 蜡笔绘本同源(监管模式 F 案):CrayonChick 小鸡报日程,数据变贴纸(虚线描边 + 和纸胶带 + 微歪斜)
 * - 场景 = 台词气泡(今日到期/进行中 + 日期·距期末·连续打卡)+ 「＋小组件」弹层(勾选增减,localStorage 按 userId 存)
 * - 数据贴纸条:连续打卡(→复习统计)/ 期末倒计时(→冲刺计划)/ 今日进度(→今日任务弹窗)/ 错题·收藏(→错题抽屉)/ 成绩趋势(→成绩分析)
 * - 主贴纸 = 今日复习(便利贴黄:重做练习/翻卡速览);侧列 = 背词(EnglishEntryCell 自取数)/ 继续学习(Resume)
 * - 入口贴纸行:学新题 / 组一张卷 / 记一次成绩 / 收藏 / 课本 / 学习会话(就地展开列表)
 * v2「今日聚焦」三格卡/练习两列/chips 行被整页替换;shortTitle/dateRel 仍导出给拟卷列表页与今日任务弹窗共用。
 * 小组件无假指标:数据缺位(无冲刺计划/无考试记录)对应贴纸不渲染,勾选状态仅控制「有数据的贴纸」。
 */
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import { cn } from '@/lib/utils'
import { EnglishEntryCell } from '@/components/english/EnglishEntryCard'
import { CrayonChick } from '@/components/CrayonChick'
import { deleteUploadedFile, FileUpload, type UploadingItem } from '@/components/chat/FileUpload'
import type { Attachment } from '@/lib/attachment-types'
import { useIsTauri } from '@/lib/tauri'
import { useFocusLock } from '@/lib/focus-lock-store'
import { storePendingExtAsk } from '@/lib/input-bridge'
import { COURSE_SHELL_OPEN_EVENT, courseShellOpenNow, courseScreenshotAsk } from '@/lib/course-shot'
import { localEventISO, type StudyEventToolRow } from '@/lib/ai/study-event-tool'
import { todayKey } from '@/lib/plan/time'
import { openTodayPlan } from '@/components/plan/TodayPlanDialog'
import s from './StudyHome.module.css'

/** 冲刺计划摘要(阶段四方案A:学习台常驻条卡;详情在 PlanDialog) */
export interface StudyPlanSummary {
  title: string
  examDate: string
  /** 今天应做的项数与已完成数(父组件从 plan items 聚合) */
  todayTotal: number
  todayDone: number
  totalItems: number
  totalDone: number
}

export interface StudySessionListItem {
  id: string
  question: string
  status: 'explaining' | 'completed'
  stepCount: number
  updatedAt: string
  /** 上次讲解末尾的摘要(API 返回,content 前 60 字),进行中条卡用 */
  lastStepBrief?: string | null
}

/** 拟卷列表条目(GET /api/papers/composed);区块展示最近几张,统计行 chip 显总数 */
export interface ComposedPaperListItem {
  id: string
  title: string
  subject: string
  totalScore: number
  durationMin: number
  onlyChoice: boolean
  createdAt: string
  slotCount: number
}

/** 卷库列表条目(GET /api/papers;学校考试记录卡关联卷选择器用;公共库合并只读) */
export interface LibraryPaperItem {
  id: string
  slug: string
  title: string
  subject: string
  examType: string | null
  year: string | null
  totalScore: number
  questionCount: number
}

/** 学校考试成绩条目(GET /api/exam-records;paper 元信息拍平下发) */
export interface ExamRecordListItem {
  id: string
  paperId: string
  examType: string
  examName: string
  /** 'YYYY-MM-DD' 字符串存,免时区换算 */
  date: string
  score: number
  fullScore: number
  rank: string | null
  paper: { id: string; slug: string; title: string; subject: string; examType: string | null; totalScore: number }
  /** 仅单卷视图(?slug=)携带:勾错题 → 考点丢分(服务端按 PaperQuestion 反推) */
  topicLoss?: Array<{ topic: string; count: number; loss: number }>
}

interface Props {
  sessions: StudySessionListItem[]
  dueCount: number
  /** 到期卡里可重做题库原题的张数(主贴纸副行「其中 M 道可重做」) */
  dueRedoCount: number
  noteCount: number
  favoriteCount: number
  kbCount: number
  /** 课本接口失败:数字显示「—」而不是假 0(区分加载失败与真的没有) */
  kbUnavailable?: boolean
  /** StudyNote.mastery 均值(0-1);无笔记为 null */
  masteryAvg: number | null
  /** 连续复习天数(stats 接口;加载中为 null) */
  streakDays: number | null
  /** 累计学习场次(列表接口 total) */
  totalSessions: number
  /** 当前生效冲刺计划摘要;null = 无计划不渲染冲刺相关贴纸 */
  activePlan: StudyPlanSummary | null
  /** 拟卷列表(createdAt 倒序全量);v3 书桌版不再常驻展示,入口收进「组一张卷」 */
  papers: ComposedPaperListItem[]
  /** 学校考试成绩台账(GET /api/exam-records,date 倒序);「成绩趋势」贴纸数据源 */
  examRecords: ExamRecordListItem[]
  /** 记成绩入口:开「记一次学校考试」弹窗 */
  onRecordExam: () => void
  onOpenExamRecords: () => void
  /** 会话列表单独刷新中(整页骨架屏由 booting 承担,这里只管会话展开区的重取态) */
  loading: boolean
  /** 首屏数据未齐(list/queue/notes/favorites/kb/papers 任一仍在首取):整页骨架屏,不渲染零值 */
  booting: boolean
  onResume: (id: string) => void
  /** text = 输入框里已敲的题目,带进 setup 预填 */
  onNew: (text?: string) => void
  onOpenDrawer: (tab: 'review' | 'notes' | 'favorites', mode?: 'flip' | 'redo') => void
  onOpenStats: () => void
  onOpenPlan: () => void
  /** 打开「今日任务」弹窗(入口挂「今日进度」贴纸) */
  onOpenTasks: () => void
  /** 学习记录流水(GET /api/study/events 最近 30 天,与弹层共用同一 query);undefined=首取中 */
  events?: StudyEventToolRow[]
  /** 打开学习记录弹层(「学习记录」贴纸 + 入口行「记一笔」共用) */
  onOpenEvents: () => void
}

/** 会话题目标题清洗(弹窗「继续学习」行共用) */
export function shortTitle(q: string): string {
  return q.replace(/[#*`>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24) || '未命名题目'
}

/** 相对时间:今天/昨天/N 天前,超过一周回退日期(学习台条卡与拟卷列表页共用) */
export function dateRel(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  return `${d.getMonth() + 1}-${d.getDate()}`
}

/* 线性 SVG 图标(禁 emoji 当图标) */
function RepeatIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  )
}

function BookIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </svg>
  )
}

function PlusIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  )
}

function DocIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M8 13h8" />
      <path d="M8 17h5" />
    </svg>
  )
}

function ArrowRightIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  )
}

function FlameIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3c2.6 3.1 6 5.7 6 10a6 6 0 0 1-12 0c0-2 .7-3.7 1.9-5.3.7 1 1.6 1.8 2.7 2.3C10.3 7.6 11 5.2 12 3z" />
    </svg>
  )
}

function CalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18" />
      <path d="M8 3v4" />
      <path d="M16 3v4" />
    </svg>
  )
}

function CheckCircleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12 2.5 2.5 5-5" />
    </svg>
  )
}

function MarkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3h12v18l-6-4-6 4z" />
    </svg>
  )
}

function TrendIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 17l6-6 4 4 8-8" />
      <path d="M21 7v5h-5" />
    </svg>
  )
}

function ChatIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a8 8 0 0 1-8 8H4l2.4-2.9A8 8 0 1 1 21 12z" />
    </svg>
  )
}

function PenIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      <path d="m15 5 4 4" />
    </svg>
  )
}

function ChatBubbleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a8 8 0 0 1-8 8H4l2.4-2.9A8 8 0 1 1 21 12z" />
    </svg>
  )
}

/** 突击测试入口:闪电(突袭感) */
function ZapIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
    </svg>
  )
}

/** 课堂截图提问(2026-11-19 A 案第③入口):相机 */
function CameraIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
      <circle cx="12" cy="13" r="3" />
    </svg>
  )
}

/** 添加附件:回形针 */
function ClipIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  )
}

/** 连续打卡周点:过去 N 天必在连击内(可推导的真数据),今日恒为空心——当天还没过完,不冒认 */
function StreakDots({ days }: { days: number }) {
  const done = Math.min(6, Math.max(0, days))
  return (
    <span className={s.dots} aria-hidden>
      {Array.from({ length: 6 }).map((_, i) => (
        <span key={i} className={i < done ? s.done : undefined} />
      ))}
      <span className={s.today} />
    </span>
  )
}

/** 小组件 key(增减状态按此存 localStorage) */
type WidgetKey = 'streak' | 'due' | 'today' | 'wrong' | 'trend' | 'events' | 'plan'

export function StudyHome({
  sessions,
  dueCount,
  dueRedoCount,
  noteCount,
  favoriteCount,
  kbCount,
  kbUnavailable,
  masteryAvg,
  streakDays,
  totalSessions,
  activePlan,
  examRecords,
  onRecordExam,
  onOpenExamRecords,
  loading,
  booting,
  onResume,
  onNew,
  onOpenDrawer,
  onOpenStats,
  onOpenPlan,
  onOpenTasks,
  events,
  onOpenEvents,
}: Props) {
  const router = useRouter()
  const { data: session } = useSession()
  // sessions 已按 updatedAt 倒序;进行中的题全部参与计数,气泡/贴纸只露最近一道
  const inProgress = sessions.filter((x) => x.status === 'explaining')
  // 会话历史默认收起,点「学习会话」入口贴纸就地展开(v2 口径沿用)
  const [showSessions, setShowSessions] = useState(false)

  // ── 实时日期(挂载后起算,免 SSR 水合错位)──
  const [now, setNow] = useState<Date | null>(null)
  useEffect(() => {
    setNow(new Date())
    const t = setInterval(() => setNow(new Date()), 10_000)
    return () => clearInterval(t)
  }, [])
  const dateLabel = now
    ? `${now.getMonth() + 1}月${now.getDate()}日 周${'日一二三四五六'[now.getDay()]}`
    : ''

  // ── 小组件增减:localStorage 按 userId 存;初始全开,挂载后应用存档 ──
  const uid = session?.user?.id
  const widgetStoreKey = uid ? `study-home-widgets:${uid}` : null
  const [widgetOff, setWidgetOff] = useState<WidgetKey[]>([])
  useEffect(() => {
    if (!widgetStoreKey) return
    try {
      const raw = localStorage.getItem(widgetStoreKey)
      if (raw) setWidgetOff(JSON.parse(raw) as WidgetKey[])
    } catch { /* 存档损坏按全开处理 */ }
  }, [widgetStoreKey])
  const toggleWidget = (k: WidgetKey) => {
    setWidgetOff((prev) => {
      const next = prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]
      if (widgetStoreKey) {
        try { localStorage.setItem(widgetStoreKey, JSON.stringify(next)) } catch { /* 忽略配额错误 */ }
      }
      return next
    })
  }
  const wOn = (k: WidgetKey) => !widgetOff.includes(k)

  // ── 今日计划贴纸:今天已排/待安排条数(轻量一拉;失败/null 按 — 处理,不闪假 0) ──
  const [planStats, setPlanStats] = useState<{ planned: number; inbox: number } | null>(null)
  useEffect(() => {
    let alive = true
    fetch(`/api/plan/items?date=${todayKey()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { items?: { status: string; startMin: number | null }[] } | null) => {
        if (!alive || !data?.items) return
        setPlanStats({
          planned: data.items.filter((i) => i.startMin != null).length,
          inbox: data.items.filter((i) => i.status === 'inbox').length,
        })
      })
      .catch(() => { /* 静默:贴纸显示 — */ })
    return () => { alive = false }
  }, [])

  // ── 问答输入框(胶带便签):回车/键帽 → /chat?q= 跳转桥自动发送(chat/page.tsx 现成
  //    autoSendText 机制,bento AI 卡片同源),落地即原首页的问答体验;空文本不触发 ──
  //    2026-11-19 增:附件上传(FileUpload 复用,openRef 触发)+ 课堂截图提问钮
  //    (仅 Tauri 桌面 + 课程面板开着)。带附件走 EXT_ASK 预填管道进 /chat,不自动
  //    发送(用户确认再发,与课堂截图口径一致);纯文字保持 ?q= 自动发送。
  const [newqText, setNewqText] = useState('')
  const [newqAtts, setNewqAtts] = useState<Attachment[]>([])
  const [newqUploading, setNewqUploading] = useState<UploadingItem[]>([])
  const newqAttachOpenRef = useRef<(() => void) | null>(null)
  const newqReady = newqText.trim().length > 0 || newqAtts.length > 0
  const submitNewq = () => {
    const text = newqText.trim()
    if (!text && newqAtts.length === 0) return
    if (newqAtts.length > 0) {
      storePendingExtAsk({
        id: `studyq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ...(text ? { text } : {}),
        attachments: newqAtts,
      })
      router.push('/chat')
      setNewqText('')
      setNewqAtts([])
      return
    }
    router.push(`/chat?q=${encodeURIComponent(text)}`)
    setNewqText('')
  }
  // 移除未发送附件时同步删服务端文件(与 ChatInput 移除行为同源)
  const removeNewqAtt = (i: number) => {
    const removed = newqAtts[i]
    setNewqAtts((prev) => prev.filter((_, idx) => idx !== i))
    if (removed) deleteUploadedFile(removed.url)
  }

  // 课堂截图提问(第③入口):仅 Tauri 桌面 + 课程面板开着显示;初值读 body 属性,
  // 开合变化靠 CourseBrowser 的 COURSE_SHELL_OPEN_EVENT 广播跟变。
  const inTauriShot = useIsTauri()
  const { locked: flLocked } = useFocusLock()
  const [courseShellOpen, setCourseShellOpen] = useState(courseShellOpenNow)
  useEffect(() => {
    // 订阅时先同步一次当前态:挂载顺序不可控,CourseBrowser 可能已先广播过
    // (错过事件就读 body 属性兜底),两种顺序都收敛到正确值
    setCourseShellOpen(courseShellOpenNow())
    const sync = (e: Event) =>
      setCourseShellOpen(!!(e as CustomEvent<{ open?: boolean }>).detail?.open)
    window.addEventListener(COURSE_SHELL_OPEN_EVENT, sync)
    return () => window.removeEventListener(COURSE_SHELL_OPEN_EVENT, sync)
  }, [])
  const [newqShooting, setNewqShooting] = useState(false)
  const handleNewqShot = async () => {
    if (newqShooting) return
    setNewqShooting(true)
    try {
      await courseScreenshotAsk({ navigate: (p) => router.push(p) })
    } finally {
      setNewqShooting(false)
    }
  }

  // ── 小组件挑选弹层:点外/Escape 关闭 ──
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerWrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!pickerOpen) return
    const onDoc = (e: MouseEvent) => {
      if (pickerWrapRef.current && !pickerWrapRef.current.contains(e.target as Node)) setPickerOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPickerOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [pickerOpen])

  const planDays = activePlan
    ? Math.max(0, Math.round((new Date(`${activePlan.examDate}T00:00:00`).getTime() - new Date(new Date().setHours(0, 0, 0, 0)).getTime()) / 86_400_000))
    : 0
  const lastRecord = examRecords[0] ?? null

  // ── 学习记录贴纸:今天条数(undefined=首取中显示 —,不闪假 0)+ 最近一条(按 createdAt 取最新) ──
  const todayIso = now ? localEventISO(now) : ''
  const eventsToday = events ? events.filter((r) => r.eventDate === todayIso).length : null
  const latestEventText =
    events && events.length > 0
      ? [...events].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0].text
      : null

  // 首屏骨架屏:形状对齐书桌布局(气泡 + 贴纸条 + 主贴纸行),加载中不闪「0 张」
  if (booting) {
    return (
      <div className="h-full min-h-0 overflow-y-auto">
        <div className="mx-auto max-w-[1060px] px-7 py-7">
          <div className={cn('flex gap-4', s.scene)}>
            <div className="study-sk h-[72px] w-[72px] shrink-0 rounded-2xl" />
            <div className="study-sk h-[88px] w-full max-w-[560px] rounded-[20px]" />
          </div>
          <div className={cn('mt-6', s.strip)}>
            <div className="study-sk h-[104px] rounded-[14px]" />
            <div className="study-sk h-[104px] rounded-[14px]" />
            <div className="study-sk h-[104px] rounded-[14px]" />
            <div className="study-sk h-[104px] rounded-[14px]" />
          </div>
          <div className={cn('mt-6', s.mainRow)}>
            <div className="study-sk h-[190px] rounded-[14px]" />
            <div className="study-sk h-[190px] rounded-[14px]" />
          </div>
          <div className="study-sk mt-5 h-9 w-full rounded-full" />
        </div>
      </div>
    )
  }

  // 气泡台词(全部真数据推导;全空时给行动邀请)
  const bubbleMain = dueCount > 0 && inProgress.length > 0 ? (
    <>今天有 <b>{dueCount}</b> 张复习卡到期，还有 <b>{inProgress.length}</b> 道题讲到一半啦！</>
  ) : dueCount > 0 ? (
    <>今天有 <b>{dueCount}</b> 张复习卡到期，我帮你排好啦！</>
  ) : inProgress.length > 0 ? (
    <>今天没有到期的复习卡，先把讲到一半的 <b>{inProgress.length}</b> 道题收个尾吧！</>
  ) : (
    <>今天暂时没有到期复习，去学一点新东西吧！</>
  )

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto max-w-[1060px] px-7 py-7">
        {/* ── 场景:小鸡 + 台词气泡 + ＋小组件 ── */}
        <div className={s.scene}>
          <span className={s.chick}>
            <CrayonChick className="h-[72px] w-[72px]" />
          </span>
          <div className={s.bubble}>
            <p className={s.bubbleMain}>{bubbleMain}</p>
            <div className={s.bubbleSub}>
              {dateLabel && <span>{dateLabel}</span>}
              {activePlan && (
                <>
                  <span aria-hidden>·</span>
                  <button type="button" className={s.subLink} onClick={onOpenPlan}>距期末 {planDays} 天</button>
                </>
              )}
              {streakDays != null && streakDays > 0 && (
                <>
                  <span aria-hidden>·</span>
                  <span>连续打卡 {streakDays} 天</span>
                </>
              )}
            </div>
            <svg className={s.bubbleTail} viewBox="0 0 40 24" aria-hidden>
              <path d="M30 2 C20 6 12 12 4 22 C14 18 24 12 34 6 Z" fill="rgb(var(--note-paper))" stroke="rgb(var(--note-edge))" strokeWidth="1.8" strokeLinejoin="round" />
            </svg>
          </div>
          <div className={s.addWrap} ref={pickerWrapRef}>
            <button
              type="button"
              className={s.addBtn}
              aria-haspopup="true"
              aria-expanded={pickerOpen}
              onClick={() => setPickerOpen((v) => !v)}
            >
              <PlusIcon size={12} />
              小组件
            </button>
            {pickerOpen && (
              <div className={s.pickerWrap}>
                <div className={s.picker} role="dialog" aria-label="挑选小组件">
                  <div className={s.pkTitle}>勾选即上屏 · 再点取消</div>
                  <label className={s.pkRow}>
                    <input type="checkbox" checked={wOn('streak')} onChange={() => toggleWidget('streak')} />
                    <span className={s.stkIcon}><FlameIcon /></span>
                    连续打卡
                    <span className={s.pkMeta}>{streakDays != null && streakDays > 0 ? `${streakDays} 天` : '—'}</span>
                  </label>
                  <label className={s.pkRow}>
                    <input type="checkbox" checked={wOn('due')} onChange={() => toggleWidget('due')} />
                    <span className={s.stkIcon}><CalIcon /></span>
                    期末倒计时
                    <span className={s.pkMeta}>{activePlan ? activePlan.examDate.slice(5) : '—'}</span>
                  </label>
                  <label className={s.pkRow}>
                    <input type="checkbox" checked={wOn('today')} onChange={() => toggleWidget('today')} />
                    <span className={s.stkIcon}><CheckCircleIcon /></span>
                    今日进度
                    <span className={s.pkMeta}>{activePlan && activePlan.todayTotal > 0 ? `${activePlan.todayDone}/${activePlan.todayTotal}` : '—'}</span>
                  </label>
                  <label className={s.pkRow}>
                    <input type="checkbox" checked={wOn('wrong')} onChange={() => toggleWidget('wrong')} />
                    <span className={s.stkIcon}><MarkIcon /></span>
                    错题·收藏
                    <span className={s.pkMeta}>{noteCount}/{favoriteCount}</span>
                  </label>
                  <label className={s.pkRow}>
                    <input type="checkbox" checked={wOn('trend')} onChange={() => toggleWidget('trend')} />
                    <span className={s.stkIcon}><TrendIcon /></span>
                    成绩趋势
                    <span className={s.pkMeta}>{examRecords.length > 0 ? `${examRecords.length} 次` : '—'}</span>
                  </label>
                  <label className={s.pkRow}>
                    <input type="checkbox" checked={wOn('events')} onChange={() => toggleWidget('events')} />
                    <span className={s.stkIcon}><PenIcon /></span>
                    学习记录
                    <span className={s.pkMeta}>{eventsToday != null ? `今天 ${eventsToday} 条` : '—'}</span>
                  </label>
                  <label className={s.pkRow}>
                    <input type="checkbox" checked={wOn('plan')} onChange={() => toggleWidget('plan')} />
                    <span className={s.stkIcon}><CalIcon /></span>
                    今日计划
                    <span className={s.pkMeta}>{planStats ? `${planStats.planned} 项` : '—'}</span>
                  </label>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── 问答输入框(胶带便签):虚线卡 + 和纸胶带 + 微歪,悬停摆正、聚焦重描;
             提问 → /chat?q= 自动发送,像原首页那样直接问 AI;带附件走预填管道不自动发 ── */}
        <div className={s.newqNote}>
          {(newqAtts.length > 0 || newqUploading.length > 0) && (
            <div className={s.newqAtts}>
              {newqAtts.map((att, i) => (
                <span className={s.newqAtt} key={att.url}>
                  {att.type.startsWith('image/') ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={att.url} alt="" className={s.newqAttImg} />
                  ) : (
                    <span className={s.newqAttFile}><ClipIcon size={13} /></span>
                  )}
                  <button
                    type="button"
                    className={s.newqAttX}
                    onClick={() => removeNewqAtt(i)}
                    aria-label="移除附件"
                  >
                    ×
                  </button>
                </span>
              ))}
              {newqUploading.map((u) => (
                <span className={s.newqAttUp} key={u.id}>
                  {u.status === 'error' ? `${u.name} 失败` : `${u.name} ${u.progress}%`}
                </span>
              ))}
            </div>
          )}
          <span className={s.newqLead}><ChatBubbleIcon /></span>
          <input
            type="text"
            value={newqText}
            onChange={(e) => setNewqText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submitNewq()
              }
            }}
            placeholder="有什么想问的，回车直接问 AI…"
            aria-label="向 AI 提问"
            enterKeyHint="send"
          />
          {inTauriShot && courseShellOpen && !flLocked && (
            <button
              type="button"
              className={s.newqTool}
              onClick={handleNewqShot}
              disabled={newqShooting}
              title="课堂截图提问 —— 截取课程窗口画面(含视频帧),预填新会话"
              aria-label="课堂截图提问"
            >
              <CameraIcon size={15} />
            </button>
          )}
          <button
            type="button"
            className={s.newqTool}
            onClick={() => newqAttachOpenRef.current?.()}
            title="添加附件 (图片、文本、PDF, 最大10MB)"
            aria-label="添加附件"
          >
            <ClipIcon size={15} />
          </button>
          {/* FileUpload 只出隐藏 input(hideTrigger + hideUploads),触发钮/预览由上面自绘 */}
          <FileUpload
            attachments={newqAtts}
            onAttachmentsChange={setNewqAtts}
            hideTrigger
            hideAttachmentsPreview
            hideUploads
            onUploadingFilesChange={setNewqUploading}
            openRef={newqAttachOpenRef}
          />
          <button
            type="button"
            className={cn(s.newqKey, !newqReady && s.newqKeyOff)}
            onClick={submitNewq}
            tabIndex={newqReady ? 0 : -1}
          >
            <kbd>↵</kbd>提问
          </button>
        </div>

        {/* ── 数据贴纸条(勾选增减;数据缺位不渲染,无假指标) ── */}
        <div className={s.strip}>
          {streakDays != null && wOn('streak') && (
            <button type="button" className={cn(s.sticker, s.tiltA, 'glass-blur')} onClick={onOpenStats} title="点开复习统计">
              <span className={s.stkHead}><span className={s.stkIcon}><FlameIcon /></span>连续打卡</span>
              <span className={s.stkBig}>{streakDays}<i>天</i></span>
              <StreakDots days={streakDays} />
              <span className={s.stkSub}>连续复习天数 · 复习统计 ›</span>
            </button>
          )}
          {activePlan && wOn('due') && (
            <button type="button" className={cn(s.sticker, s.tiltB, 'glass-blur')} onClick={onOpenPlan} title="点开冲刺计划">
              <span className={s.stkHead}><span className={s.stkIcon}><CalIcon /></span>期末考试</span>
              <span className={s.stkBig}>{planDays}<i>天后</i></span>
              <span className={s.stkSub}>{activePlan.title} · {activePlan.examDate.slice(5)} 开考</span>
            </button>
          )}
          {activePlan && activePlan.todayTotal > 0 && wOn('today') && (
            <button type="button" className={cn(s.sticker, s.tiltC, 'glass-blur')} onClick={onOpenTasks} title="点开今日任务">
              <span className={s.stkHead}><span className={s.stkIcon}><CheckCircleIcon /></span>今日进度</span>
              <span className={s.stkBig}>{activePlan.todayDone}<i>/ {activePlan.todayTotal} 项</i></span>
              <span className={s.stkSub}>还剩 {activePlan.todayTotal - activePlan.todayDone} 项 · 点开今日任务</span>
            </button>
          )}
          {wOn('wrong') && (
            <button type="button" className={cn(s.sticker, s.tiltD, 'glass-blur')} onClick={() => onOpenDrawer('notes')} title="打开错题本">
              <span className={s.stkHead}><span className={s.stkIcon}><MarkIcon /></span>错题·收藏</span>
              <span className={s.stkBig}>{noteCount}</span>
              <span className={s.stkSub}>收藏 {favoriteCount} · 课本 {kbUnavailable ? '—' : kbCount}</span>
            </button>
          )}
          {lastRecord && wOn('trend') && (
            <button type="button" className={cn(s.sticker, s.tiltE, 'glass-blur')} onClick={onOpenExamRecords} title="打开成绩分析">
              <span className={s.stkHead}><span className={s.stkIcon}><TrendIcon /></span>成绩趋势</span>
              <span className={s.stkBig}>{lastRecord.score}<i>/{lastRecord.fullScore}</i></span>
              <span className={s.stkSub}>最近一次 · {examRecords.length} 次记录 · 成绩分析 ›</span>
            </button>
          )}
          {wOn('events') && (
            <button type="button" className={cn(s.sticker, s.tiltA, 'glass-blur')} onClick={onOpenEvents} title="打开学习记录">
              <span className={s.stkHead}><span className={s.stkIcon}><PenIcon /></span>学习记录</span>
              <span className={s.stkBig}>{eventsToday ?? '—'}{eventsToday != null && <i>条</i>}</span>
              <span className={s.stkSub}>{latestEventText ? `最近:${latestEventText}` : '点开记一笔今天学了啥'}</span>
            </button>
          )}
          {wOn('plan') && (
            <button type="button" className={cn(s.sticker, s.tiltB, 'glass-blur')} onClick={openTodayPlan} title="点开今日计划">
              <span className={s.stkHead}><span className={s.stkIcon}><CalIcon /></span>今日计划</span>
              <span className={s.stkBig}>{planStats ? planStats.planned : '—'}{planStats && <i>项</i>}</span>
              <span className={s.stkSub}>待安排 {planStats?.inbox ?? '—'} · 点开排今天</span>
            </button>
          )}
        </div>

        {/* ── 主贴纸行:今日复习(便利贴黄)+ 侧列(背词/继续学习) ── */}
        <div className={s.mainRow}>
          <div className={cn(s.sticker, s.stickerMain, s.tiltC, 'glass-blur')}>
            <span className={s.stkHead}><span className={s.stkIcon}><RepeatIcon /></span>今日复习</span>
            <span className={cn(s.stkBig, s.stkBigXL)}>{dueCount}<i>张</i></span>
            <span className={s.stkSub}>
              {dueCount > 0
                ? dueRedoCount > 0
                  ? `${dueRedoCount} 道可重做题库原题 · 核对式自评`
                  : '按记忆曲线自动排期 · 核对式自评'
                : '学新题会自动排期'}
            </span>
            {masteryAvg != null && (
              <span className={s.stkFoot}>
                <span>均掌握 {Math.round(masteryAvg * 100)}% · {noteCount} 个考点</span>
                <button type="button" className={s.stkLink} onClick={onOpenStats}>复习统计 ›</button>
              </span>
            )}
            <button type="button" className={s.stkMainBtn} onClick={() => onOpenDrawer('review', 'redo')}>
              重做练习
              <ArrowRightIcon />
            </button>
            <button type="button" className={s.stkLink} onClick={() => onOpenDrawer('review', 'flip')}>或翻卡速览 ›</button>
          </div>
          <div className={s.sideCol}>
            <button type="button" className={cn(s.sticker, s.tiltB, 'glass-blur')} onClick={() => router.push('/study/english')}>
              <EnglishEntryCell />
            </button>
            {inProgress.length > 0 && (
              <button type="button" className={cn(s.sticker, s.tiltD, 'glass-blur')} onClick={() => onResume(inProgress[0].id)} title="继续上次">
                <span className={s.stkHead}><span className={s.stkIcon}><BookIcon /></span>继续学习</span>
                <span className={s.stkBig}>{inProgress.length}<i>题</i></span>
                <span className={s.stkSub}>
                  {inProgress.length > 1 ? '最近:' : ''}{shortTitle(inProgress[0].question)} · 讲到第 {inProgress[0].stepCount} 步
                </span>
                <span className={s.stkGo}>继续 ›</span>
              </button>
            )}
          </div>
        </div>

        {/* ── 会话历史(默认收起,v2 口径沿用) ── */}
        {showSessions && (
          <div className="mb-4 mt-4 space-y-2">
            {loading && sessions.length === 0 && (
              <div className="glass-blur rounded-[14px] border border-line/60 bg-surface-glass px-4 py-3 text-[13px] text-content-muted">加载中…</div>
            )}
            {!loading && sessions.length === 0 && (
              <div className="glass-blur rounded-[14px] border border-line/60 bg-surface-glass px-4 py-3 text-[13px] text-content-muted">
                还没有学习会话，学完第一道题会自动收进这里
              </div>
            )}
            {sessions.map((x) => (
              <button
                key={x.id}
                type="button"
                onClick={() => onResume(x.id)}
                className="glass-blur flex w-full items-center justify-between gap-3 rounded-[14px] border border-line/60 bg-surface-glass px-4 py-3 text-left transition-colors hover:border-line-strong"
              >
                <span className="min-w-0 truncate text-[13.5px] text-content-primary">{shortTitle(x.question)}</span>
                <span
                  className={cn(
                    'flex-none rounded-full px-2.5 py-0.5 text-[11px] font-medium',
                    x.status === 'explaining' ? 'bg-accent-soft text-accent' : 'bg-surface-subtle text-content-muted',
                  )}
                >
                  {x.status === 'explaining' ? `讲到第 ${x.stepCount} 步` : '已完成'}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* ── 入口贴纸行 ── */}
        <div className={s.entryRow}>
          <button type="button" className={s.miniStk} onClick={() => onNew()}>
            <PlusIcon size={13} />
            学新题
          </button>
          <button type="button" className={s.miniStk} onClick={() => router.push('/papers/composed?compose=1')}>
            <DocIcon size={13} />
            组一张卷
          </button>
          <button type="button" className={s.miniStk} onClick={() => window.dispatchEvent(new CustomEvent('surpriseQuiz:open'))}>
            <ZapIcon />
            突击一测
          </button>
          <button type="button" className={s.miniStk} onClick={onOpenEvents}>
            <PenIcon />
            记一笔
          </button>
          <button type="button" className={s.miniStk} onClick={onRecordExam}>
            <MarkIcon />
            记一次成绩
          </button>
          <button type="button" className={s.miniStk} onClick={() => onOpenDrawer('favorites')}>
            <MarkIcon />
            收藏 {favoriteCount}
          </button>
          <button type="button" className={s.miniStk} onClick={() => router.push('/kb')}>
            <BookIcon size={13} />
            课本 {kbUnavailable ? '—' : kbCount}
          </button>
          <button
            type="button"
            className={cn(s.miniStk, showSessions && s.miniStkOn)}
            onClick={() => setShowSessions((v) => !v)}
          >
            <ChatIcon />
            学习会话 {showSessions ? '↑' : '↓'}
          </button>
        </div>
        <div className="mt-3 px-0.5 text-[11px] text-content-muted tabular-nums">
          累计 <b className="text-[12.5px] font-semibold text-content-secondary">{totalSessions}</b> 场学习
        </div>
      </div>
    </div>
  )
}
