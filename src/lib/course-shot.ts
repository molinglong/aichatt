'use client'

import { toast } from '@/lib/toast'
import { tauri, type CourseScreenshotPayload } from '@/lib/tauri'
import { dispatchExtAsk, storePendingExtAsk, type ExtAskDetail } from '@/lib/input-bridge'
import { pickCourseShotRegion, type CssRect, type ShotImage } from '@/lib/course-shot-crop'

/**
 * 课堂截图提问共享管道(原型 design/preview-course-screenshot-ask.html A 案 +
 * design/preview-client-shot-crop.html B 案,2026-11-19/20 用户挑定)。
 * 三处入口共用:课程工具栏相机钮 / 聊天输入框胶囊 / 学习页 composer。
 *
 * 流程(先截后框):
 *   Rust course_screenshot(GDI 截整个课程区,含视频帧)
 *   → 临时隐藏课程原生层(course_set_veiled,否则 DOM 框选层被它盖住)
 *   → 冻结帧铺回原位,用户框一块(松开出「就这块/重选/用整张/取消」)
 *   → 恢复课程层 → 按选区裁切成 PNG → /api/upload(落 UploadFile 记录)
 *   → 复用扩展深链同款 EXT_ASK 管道预填新会话,不自动发送
 */

/** 课程面板 DOM 壳开合广播(输入框/学习页的截图钮据此显隐;CourseBrowser 发出) */
export const COURSE_SHELL_OPEN_EVENT = 'aichatt:course-shell-open'

/** 工具栏高度(逻辑像素,与 CourseBrowser / Rust course_browser::TOOLBAR_H 三处同值) */
const TOOLBAR_H = 44

/** 读当前课程面板开合态(挂载初值;后续变化靠 COURSE_SHELL_OPEN_EVENT 跟) */
export function courseShellOpenNow(): boolean {
  if (typeof document === 'undefined') return false
  return document.body.hasAttribute('data-course-open')
}

/** 课程区当前的视口矩形(CSS px):宽度取 CourseBrowser 写在 body 上的 --course-width */
function courseRectCss(): CssRect {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const raw = document.body.style.getPropertyValue('--course-width').trim()
  const pct = parseFloat(raw)
  const w = Number.isFinite(pct) && pct > 0 ? Math.round((pct / 100) * vw) : vw
  return { x: vw - w, y: TOOLBAR_H, w, h: Math.max(1, vh - TOOLBAR_H) }
}

/** 等原生层隐藏真正落屏(两帧足够,再多白等) */
function nextPaint(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )
}

/** 冻结帧 + 选区 → 裁切后的 PNG File(位图坐标换算按 base 的实际摆放比例) */
async function cropToFile(shot: ShotImage, base: CssRect, region: CssRect): Promise<File> {
  const img = new Image()
  img.src = shot.dataUrl
  await img.decode()

  const sx = ((region.x - base.x) / base.w) * shot.width
  const sy = ((region.y - base.y) / base.h) * shot.height
  const sw = (region.w / base.w) * shot.width
  const sh = (region.h / base.h) * shot.height

  const cw = Math.max(1, Math.round(sw))
  const ch = Math.max(1, Math.round(sh))
  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas unavailable')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cw, ch)

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('crop encode failed')
  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '-')
  return new File([blob], `课堂截图-${stamp}.png`, { type: 'image/png' })
}

let shooting = false

/**
 * dev 预览门(?__shotcrop=1,仅 Web/3456):用一张画布示例图直接打开框选层,
 * 供交互自检(课程原生层在 Web 端不存在,没法走真截图)。返回框选结果文案。
 */
export async function openShotCropPreview(): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = 960
  canvas.height = 600
  const ctx = canvas.getContext('2d')!
  const colors = ['#c0392b', '#27ae60', '#2980b9', '#8e44ad']
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = colors[i]
    ctx.fillRect((i % 2) * 480, Math.floor(i / 2) * 300, 480, 300)
  }
  ctx.fillStyle = '#fff'
  ctx.font = '700 48px sans-serif'
  ;['TL', 'TR', 'BL', 'BR'].forEach((t, i) => {
    ctx.fillText(t, (i % 2) * 480 + 180, Math.floor(i / 2) * 300 + 175)
  })
  const region = await pickCourseShotRegion(
    { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height },
    courseRectCss()
  )
  return region ? `框选 ${Math.round(region.w)}×${Math.round(region.h)}` : '已取消'
}

/**
 * 截图提问主链路。成功 = 图已预填进新会话输入框(不在 /chat 时伴随页面跳转);
 * 用户取消框选/任何失败返回 false(失败一律 toast 轻提示)。重入直接忽略。
 * navigate:宿主的页面跳转(Next router.push);不给时兜底 location.assign 整页跳。
 */
export async function courseScreenshotAsk(opts?: {
  navigate?: (path: string) => void
}): Promise<boolean> {
  if (shooting) return false
  // 监管锁定期守卫:锁内没有自由聊天通道,截图提问的全链路(上传/跳新会话/预填)
  // 都会发生在锁层之后 —— 用户视角就是「点了没反应」。显式提示并中止。
  if (typeof document !== 'undefined' && document.documentElement.hasAttribute('data-fl-locked')) {
    toast.hint('锁定期不能提问,解锁后再来截图问 AI')
    return false
  }
  shooting = true
  try {
    let shot: CourseScreenshotPayload
    try {
      shot = await tauri.courseScreenshot()
    } catch {
      toast.hint('课程窗口还没有可截的画面,先在课程窗口打开课件')
      return false
    }

    const base = courseRectCss()
    let region: CssRect | null = null
    let veiled = false
    try {
      // 先藏原生层,再挂框选层(顺序反了会先闪一下课程画面)
      await tauri.courseSetVeiled(true)
      veiled = true
      await nextPaint()
      region = await pickCourseShotRegion(
        {
          dataUrl: `data:image/png;base64,${shot.data}`,
          width: shot.width,
          height: shot.height,
        },
        base
      )
    } catch (err) {
      console.error('[course-shot] pick region failed:', err)
      toast.warning('框选界面打开失败,请重试')
      return false
    } finally {
      // 无论确认/取消/异常,课程层必须恢复
      if (veiled) {
        try {
          await tauri.courseSetVeiled(false)
        } catch (err) {
          console.error('[course-shot] unveil failed:', err)
        }
      }
    }

    // 取消(含 Esc / 取消键)= 静默退出
    if (!region || region.w < 12 || region.h < 12) return false

    let file: File
    try {
      file = await cropToFile(
        { dataUrl: `data:image/png;base64,${shot.data}`, width: shot.width, height: shot.height },
        base,
        region
      )
    } catch (err) {
      console.error('[course-shot] crop failed:', err)
      toast.warning('截图裁切失败,请重试')
      return false
    }

    const fd = new FormData()
    fd.append('file', file)
    let up: { url?: string; name?: string; type?: string; size?: number }
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: fd })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      up = await res.json()
    } catch {
      toast.warning('截图上传失败,请检查登录态后重试')
      return false
    }
    if (!up.url) {
      toast.warning('截图上传失败,请重试')
      return false
    }

    const detail: ExtAskDetail = {
      id: `shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      attachment: {
        url: up.url,
        name: up.name || file.name,
        type: up.type || 'image/png',
        size: up.size ?? file.size,
      },
    }
    // 先落 sessionStorage 兜底再分发/跳转:跨页竞态由 ChatInput 挂载补领收口
    storePendingExtAsk(detail)
    if (window.location.pathname === '/chat') {
      dispatchExtAsk(detail)
    } else if (opts?.navigate) {
      opts.navigate('/chat')
    } else {
      window.location.assign('/chat')
    }
    return true
  } finally {
    shooting = false
  }
}