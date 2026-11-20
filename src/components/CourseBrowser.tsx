'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createPortal } from 'react-dom'
import { ArrowLeft, ArrowRight, Camera, Globe, House, RotateCw, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { tauri, useIsTauri, type CourseState } from '@/lib/tauri'
import { courseScreenshotAsk, COURSE_SHELL_OPEN_EVENT, openShotCropPreview } from '@/lib/course-shot'
import { CourseStartPage } from '@/components/CourseStartPage'
import { CourseStartDaily } from '@/components/CourseStartDaily'
import {
  courseUrlKind,
  normalizeCourseUrl,
  readCourseRecents,
  recordCourseRecent,
  type CourseRecent,
} from '@/lib/course-recents'

/**
 * 课堂分栏浏览器(方案 B 玻璃条)——桌面壳专属,Web/安卓不渲染。
 * 方案: design/focus-lock-plan.md §3.2;原型: design/preview-course-panel.html(用户已挑定 B)。
 *
 * 布局模型:聊天 DOM 铺满铺底;Rust 侧 boot 预创建的 course 原生 webview 盖
 * 「工具栏下方的网页区域」(TOOLBAR_H 与 Rust course_browser::TOOLBAR_H 必须同步);
 * 本组件渲染工具栏玻璃条 + 分隔条 + 空态卡片,三者共用 --course-left CSS 变量,
 * 窗口 resize 时按比例自动跟随(course 原生层 bounds 由 Rust cb_on_resize 重算)。
 *
 * 分隔条拖动只做 DOM 视觉反馈(蓝色虚拟分界线),松手 invoke
 * course_panel_resize 一次性生效 —— child webview 逐帧 set_bounds 会卡,
 * plan §3.2 定案松手生效。
 *
 * 面板壳经 createPortal 挂 body:TopBar 祖先链有 backdrop-blur/overflow 裁剪,
 * fixed 遮罩会退化(项目实测三实例),portal 彻底避开。
 */

/** 工具栏高度(逻辑像素;与 Rust course_browser.rs TOOLBAR_H 同步,两处一起改) */
const TOOLBAR_H = 44
const SPLIT_MIN = 0.3
const SPLIT_MAX = 0.55
const SPLIT_DEFAULT = 0.4

/** ?__course=1 网页预览门用的演示最近记录(不写入 localStorage) */
const PREVIEW_RECENTS: CourseRecent[] = [
  {
    url: 'https://www.bilibili.com/video/BV1ys411472E',
    title: '线性代数的本质 · 03 矩阵与线性变换',
    ts: Date.now() - 3_600_000,
  },
  {
    url: 'https://www.bilibili.com/video/BV1GJ411x7h7',
    title: '高中物理 · 带电粒子在匀强磁场中的运动',
    ts: Date.now() - 86_400_000,
  },
  {
    url: 'https://www.bilibili.com/cheese/play/ep123456',
    title: 'Python 入门 · 第 8 章 文件与异常',
    ts: Date.now() - 2 * 86_400_000,
  },
  {
    url: 'https://www.bilibili.com/video/BV1xx411c7mD',
    title: '概率论 · 第 6 讲 连续型随机变量',
    ts: Date.now() - 3 * 86_400_000,
  },
]

/** 地址栏展示:去掉协议头,过长截中段 */
function displayUrl(url: string): string {
  const s = url.replace(/^https?:\/\//, '').replace(/^www\./, '')
  if (s.length <= 64) return s
  return s.slice(0, 40) + '…' + s.slice(-20)
}

export function CourseBrowserButton() {
  const inTauri = useIsTauri()
  const router = useRouter()

  // ── 面板状态(以 Rust 为准,mount 时拉一次)──────────────────────
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [split, setSplit] = useState(SPLIT_DEFAULT)
  const [ready, setReady] = useState(false)
  const [mounted, setMounted] = useState(false)
  /** 专注锁定态(FocusLock 维护 html[data-fl-locked],MutationObserver 同步) */
  const [locked, setLocked] = useState(false)
  /** 最近打开(localStorage;?__course=1 预览门用演示数据) */
  const [recents, setRecents] = useState<CourseRecent[]>([])
  /** 网页预览门:非 Tauri 环境也渲染面板壳,便于 3456 验收 */
  const [preview, setPreview] = useState(false)
  /** 截图提问进行中(hooks 必须挂在下方早退之前,否则 preview 翻转时 hooks 数量变化) */
  const [shooting, setShooting] = useState(false)

  // 拖动中的预览值:生效值 split 不变,DOM 用 dragSplit ?? split
  const [dragSplit, setDragSplit] = useState<number | null>(null)
  const split0 = useRef(SPLIT_DEFAULT)
  const startX = useRef(0)
  // 门卫拒绝提示节流:2 秒内多次被拒只弹一次(SPA 快速连点场景)
  const lastBlockedAt = useRef(0)

  useEffect(() => {
    setMounted(true)
    // 网页预览门:?__course=1 时非 Tauri 也把面板打开,便于 3456 验收
    const previewGate =
      !inTauri &&
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).has('__course')
    setPreview(previewGate)
    if (previewGate) {
      setReady(true)
      setOpen(true)
      const stored = readCourseRecents()
      setRecents(stored.length ? stored : PREVIEW_RECENTS)
      // 框选层交互自检门:?__course=1&__shotcrop=1 时自动开一次示例框选(仅 dev)
      if (
        process.env.NODE_ENV === 'development' &&
        new URLSearchParams(window.location.search).has('__shotcrop')
      ) {
        window.setTimeout(() => {
          void openShotCropPreview().then((msg) => toast.hint(`框选自检:${msg}`))
        }, 700)
      }
      return
    }
    if (!inTauri) return
    let alive = true
    setRecents(readCourseRecents())
    tauri.courseGetState().then((st: CourseState | null) => {
      if (!alive || !st) return
      setReady(st.ready)
      setOpen(st.open)
      setUrl(st.url === 'about:blank' ? '' : st.url)
      setSplit(st.split)
    })
    // 主框架导航推送:空态 ↔ 网页态切换 + 地址栏同步 + 最近打开记账。
    // 空串 = course_home 回主页(2026-11-19):webview 已被 Rust 侧隐藏,这里
    // 只清地址让启动页显示,面板保持开;about:blank 仍忽略(boot 噪音)。
    // 非空串 = 门卫拒绝时 Rust 回推旧地址,前端乐观 setUrl 弹回真值。
    const offNav = tauri.onCourseNavigated((u) => {
      if (u === 'about:blank') return
      if (!u) {
        setUrl('')
        return
      }
      // 面板关着直接 navigate(隐含打开,Rust 已开面板):前端同步 open 态,
      // 让 body 收缩联动跟上;正常开关面板走 togglePanel 不依赖这里
      setOpen(true)
      setUrl(u)
      setRecents((prev) => recordCourseRecent(prev, u))
    })
    // 2.2 锁定结束:面板自动收起(Rust 已隐 course webview,这里收 DOM 壳)
    const offLockEnd = tauri.onCourseLockEnded(() => setOpen(false))
    // 门卫拒绝:锁定期点白名单外链接,轻提示为什么没反应(节流防连点堆叠)
    const offBlocked = tauri.onCourseBlocked(() => {
      const now = Date.now()
      if (now - lastBlockedAt.current < 2000) return
      lastBlockedAt.current = now
      toast.hint('专注中 · 只去 B 站视频与课程页')
    })
    return () => {
      alive = false
      offNav()
      offLockEnd()
      offBlocked()
    }
  }, [inTauri])

  // 锁定态:FocusLock 维护 html[data-fl-locked],这里只读同步。
  // 启动页据此分流:C 案(小鸡书房)仅监管模式,日常态用 B 案(极简新标签页)。
  // ?__courselock=1 仅供 3456 预览门模拟锁定态(C 案验收)。
  useEffect(() => {
    const root = document.documentElement
    const forced =
      !inTauri &&
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).has('__courselock')
    const sync = () => setLocked(forced || root.hasAttribute('data-fl-locked'))
    sync()
    const mo = new MutationObserver(sync)
    mo.observe(root, { attributes: true, attributeFilter: ['data-fl-locked'] })
    return () => mo.disconnect()
  }, [inTauri])

  // 聊天区收缩联动:面板开时 body 挂 data-course-open + --course-width,
  // globals.css 据此给 .app-shell-column 让出右侧(globals.css「课堂分栏浏览器」段)。
  // 只在生效值变化时更新(拖动预览不动聊天区,与「松手生效」一致)。
  // 同一 effect 顺带广播开合态:聊天输入框/学习页的「课堂截图提问」钮据此显隐
  // (courseShellOpenNow 读 body 属性做初值,事件做后续跟变)。
  useEffect(() => {
    if (!inTauri && !preview) return
    const body = document.body
    if (open) {
      body.setAttribute('data-course-open', '1')
      body.style.setProperty('--course-width', `${split * 100}vw`)
    } else {
      body.removeAttribute('data-course-open')
    }
    window.dispatchEvent(new CustomEvent(COURSE_SHELL_OPEN_EVENT, { detail: { open } }))
    return () => {
      body.removeAttribute('data-course-open')
      window.dispatchEvent(new CustomEvent(COURSE_SHELL_OPEN_EVENT, { detail: { open: false } }))
    }
  }, [inTauri, preview, open, split])

  if (!inTauri && !preview) return null

  const activeSplit = dragSplit ?? split
  // 课程区左边缘(百分比 vw,Rust 侧 bounds 用同比例计算)
  const leftPct = (1 - activeSplit) * 100

  const togglePanel = async () => {
    if (!inTauri) {
      // 预览门:只切 DOM 壳,不碰 Rust
      setOpen((v) => !v)
      return
    }
    if (open) {
      setOpen(false)
      try {
        await tauri.coursePanelHide()
      } catch (err) {
        console.error('[course] hide failed:', err)
      }
    } else {
      setOpen(true)
      try {
        // 带上次地址重开:course webview hide 期间状态保留,直接 show 即回到原页面
        await tauri.coursePanelShow(url || null)
      } catch (err) {
        console.error('[course] show failed:', err)
      }
    }
  }

  // ── 课堂截图提问(2026-11-19 A 案 ghost 相机钮):共享管道见 lib/course-shot.ts ──
  const handleShot = async () => {
    if (shooting) return
    setShooting(true)
    try {
      await courseScreenshotAsk({ navigate: (p) => router.push(p) })
    } finally {
      setShooting(false)
    }
  }

  // ── 分隔条拖动(松手生效)──────────────────────────────────────
  const dragging = dragSplit !== null
  const onDragStart = (e: React.PointerEvent) => {
    if (!open) return
    e.preventDefault()
    split0.current = activeSplit
    startX.current = e.clientX
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    setDragSplit(activeSplit) // 进入拖动态(虚拟分界线亮起)
  }
  const onDragMove = (e: React.PointerEvent) => {
    if (dragSplit === null) return
    const vw = window.innerWidth
    const dx = e.clientX - startX.current
    setDragSplit(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, split0.current - dx / vw)))
  }
  const onDragEnd = () => {
    if (dragSplit === null) return
    const final = dragSplit
    setDragSplit(null)
    if (Math.abs(final - split) > 0.001) {
      setSplit(final)
      if (inTauri) {
        tauri.coursePanelResize(final).catch((err) =>
          console.error('[course] resize failed:', err)
        )
      }
    }
  }

  // ── 启动页打开(输入框 / 最近打开 / 快捷入口共用)──────────────
  const openUrl = async (raw: string) => {
    const u = raw.trim()
    if (!u) return
    // 裸 BV 号补全成视频页(用户常直接复制 BV 号)
    const bv = /^BV[0-9A-Za-z]{8,}$/.exec(u)
    const target = bv ? `https://www.bilibili.com/video/${bv[0]}` : u
    const norm = normalizeCourseUrl(target)
    if (!inTauri) {
      // 预览门:不出网页态(没有真实 webview),只把内容页记进最近演示打开
      const kind = courseUrlKind(norm)
      if (kind !== 'video' && kind !== 'cheese' && kind !== 'list' && kind !== 'space') return
      setRecents((prev) => {
        const hit = prev.find((r) => r.url === norm)
        const next: CourseRecent[] = [
          { url: norm, title: hit?.title, cover: hit?.cover, ts: Date.now() },
          ...prev.filter((r) => r.url !== norm),
        ]
        return next.slice(0, 8)
      })
      return
    }
    try {
      await tauri.courseNavigate(target)
      // 本地立即同步:不依赖 course://navigated 事件(reload 后监听重建有时序缝)
      setUrl(norm)
      setRecents((prev) => recordCourseRecent(prev, norm))
    } catch (err) {
      console.error('[course] navigate failed:', err)
    }
  }

  return (
    <>
      {/* 顶栏入口:开着时高亮 */}
      <button
        onClick={togglePanel}
        className={cn(
          'shrink-0 inline-flex items-center justify-center p-1.5 rounded-full transition duration-150 active:scale-95 touch-manipulation',
          open
            ? 'text-accent bg-accent-soft fl-course-accent'
            : 'text-content-secondary hover:text-content-primary hover:bg-surface-subtle'
        )}
        aria-label="课程窗口"
        title="课程窗口(内置浏览器)"
        style={{ WebkitTapHighlightColor: 'transparent' }}
      >
        <Globe className="w-3.5 h-3.5" />
      </button>

      {open &&
        mounted &&
        createPortal(
          <div
            className="fixed inset-0 z-30 pointer-events-none"
            style={{ ['--course-left' as string]: `${leftPct}vw` }}
          >
            {/* 分隔条:可拖拽,松手生效;z 高于工具栏保证全高可见 */}
            <div
              className="pointer-events-auto fixed top-0 bottom-0 w-1.5 -translate-x-1/2 cursor-col-resize z-20 group"
              style={{ left: 'var(--course-left)' }}
              onPointerDown={onDragStart}
              onPointerMove={onDragMove}
              onPointerUp={onDragEnd}
              onPointerCancel={onDragEnd}
              data-course-divider
              aria-label="调整分栏宽度"
            >
              {/* 视觉细线(hover/拖动时加深) */}
              <div
                className={cn(
                  'absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2 transition-colors duration-150',
                  dragging
                    ? 'bg-blue-500 shadow-[0_0_8px_rgba(37,99,235,0.5)] fl-course-divider-on'
                    : 'bg-line group-hover:bg-blue-400/60 fl-course-divider'
                )}
              />
            </div>

            {/* 工具栏(方案 B 玻璃条):course 原生层从 TOOLBAR_H 开始,不重叠 */}
            <div
              className="pointer-events-auto fixed top-0 h-11 flex items-center gap-1 px-2 z-10 border-b border-line/60 bg-surface-glass backdrop-blur-xl"
              style={{ left: 'var(--course-left)', right: 0 }}
              data-course-toolbar
            >
              <button
                onClick={() => tauri.courseGoBack().catch(() => {})}
                className="shrink-0 w-8 h-8 inline-flex items-center justify-center rounded-full text-content-secondary hover:text-content-primary hover:bg-surface-subtle transition duration-150"
                aria-label="后退"
                title="后退"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
              <button
                onClick={() => tauri.courseGoForward().catch(() => {})}
                className="shrink-0 w-8 h-8 inline-flex items-center justify-center rounded-full text-content-secondary hover:text-content-primary hover:bg-surface-subtle transition duration-150"
                aria-label="前进"
                title="前进"
              >
                <ArrowRight className="w-4 h-4" />
              </button>
              <button
                onClick={() => tauri.courseReload().catch(() => {})}
                className="shrink-0 w-8 h-8 inline-flex items-center justify-center rounded-full text-content-secondary hover:text-content-primary hover:bg-surface-subtle transition duration-150"
                aria-label="刷新"
                title="刷新"
              >
                <RotateCw className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => tauri.courseHome().catch(() => {})}
                className="shrink-0 w-8 h-8 inline-flex items-center justify-center rounded-full text-content-secondary hover:text-content-primary hover:bg-surface-subtle transition duration-150"
                aria-label="主页"
                title="主页 —— 回到启动页"
              >
                <House className="w-4 h-4" />
              </button>
              {/* 截图提问(A 案:左组尾部 ghost 图标钮,与四枚导航键同款):
                  空态(启动页)/预览门置灰,有页面才可截;锁定期隐藏(锁内无聊天通道) */}
              {!locked && (
                <button
                  onClick={handleShot}
                  disabled={!inTauri || !url || shooting}
                className="shrink-0 w-8 h-8 inline-flex items-center justify-center rounded-full text-content-secondary hover:text-content-primary hover:bg-surface-subtle transition duration-150 disabled:opacity-40 disabled:hover:bg-transparent"
                aria-label="截图提问"
                title="截图提问 —— 截取网页区画面(含视频帧),预填新会话"
              >
                <Camera className="w-4 h-4" />
              </button>
              )}

              {/* 地址栏(只读展示;点击全选便于复制) */}
              <div
                className="flex-1 min-w-0 h-[30px] mx-1 px-3 inline-flex items-center rounded-lg bg-black/5 dark:bg-white/10 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.05)] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.07)] text-xs text-content-secondary overflow-hidden select-text"
                data-course-address
              >
                {url ? (
                  <span className="truncate">{displayUrl(url)}</span>
                ) : (
                  <span className="truncate text-content-muted">空 —— 粘贴课程链接开始</span>
                )}
              </div>

              <button
                onClick={togglePanel}
                className="shrink-0 w-8 h-8 inline-flex items-center justify-center rounded-full text-content-secondary hover:text-danger hover:bg-danger/10 transition duration-150"
                aria-label="收起课程窗口"
                title="收起"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 启动首页(url 为空时显示;course 原生层此刻是隐藏的 about:blank)。
                日常态 B 案(极简新标签页);监管模式 C 案(小鸡书房)。 */}
            {!url && (
              <div
                className="pointer-events-auto fixed top-11 bottom-0 right-0 z-10"
                style={{ left: 'var(--course-left)' }}
                data-course-empty
                data-course-start
                data-course-variant={locked ? 'focus' : 'daily'}
              >
                {locked ? (
                  <CourseStartPage
                    ready={ready}
                    locked={locked}
                    preview={preview}
                    recents={recents}
                    setRecents={setRecents}
                    onOpen={openUrl}
                  />
                ) : (
                  <CourseStartDaily
                    ready={ready}
                    preview={preview}
                    recents={recents}
                    setRecents={setRecents}
                    onOpen={openUrl}
                  />
                )}
              </div>
            )}
          </div>,
          document.body
        )}
    </>
  )
}
