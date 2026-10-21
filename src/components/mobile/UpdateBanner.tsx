'use client'

import { useCallback, useEffect, useState } from 'react'
import { Download, RotateCw, X } from 'lucide-react'
import {
  tauri,
  isAndroidTauriShell,
  getUpdateIgnoredVersion,
  setUpdateIgnoredVersion,
  type AppUpdateInfo,
} from '@/lib/tauri'

/**
 * 应用内自更新横幅(仅安卓壳,浏览器/桌面永不渲染)。
 * 启动静默检查 VPS 清单 → 有新版才浮出玻璃胶囊 → 应用内下载(进度)
 * → 唤起系统安装器。点 × 记住该版本,新版发布后才会再弹。
 *
 * fixed 而非 absolute:与 MobileFloatButtons 同一套视口基线(var(--m-chrome-top)),
 * 锚在悬浮钮下方 8px;fixed 在本树可用(浮钮先例已真机验证)。
 * z-30:与浮钮同层,低于抽屉(z-50)与设置弹窗(z-100)。
 */
export function UpdateBanner() {
  const [phase, setPhase] = useState<'hidden' | 'found' | 'downloading' | 'ready' | 'error'>(
    'hidden'
  )
  const [info, setInfo] = useState<AppUpdateInfo | null>(null)
  const [progress, setProgress] = useState({ received: 0, total: 0 })
  const [errorMessage, setErrorMessage] = useState('')
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    if (!isAndroidTauriShell()) return
    let disposed = false
    const offProgress = tauri.onUpdateProgress((received, total) => {
      setPhase('downloading')
      setProgress({ received, total })
    })
    const offDone = tauri.onUpdateDone(() => setPhase('ready'))
    const offError = tauri.onUpdateError((message) => {
      setErrorMessage(message)
      setPhase('error')
    })
    // 状态查询兜底:WebView 切后台会冻住 JS,期间的事件可能已经错过。
    // 旧 APK 没有 updater_status 时返回 null,原有行为不变,只靠事件。
    Promise.all([tauri.updateCheck(), tauri.updateStatus()]).then(([found, status]) => {
      if (disposed || !found) return
      setInfo(found)
      if (getUpdateIgnoredVersion() === found.version) return
      if (status?.downloading) {
        setPhase('downloading')
        setProgress({ received: status.received, total: status.total })
        return
      }
      if (found.downloaded) {
        setPhase('ready')
        return
      }
      // 后台跑到一半失败时 error 事件会丢,这里补上;重试会从断点续传
      if (status?.lastError) {
        setErrorMessage(status.lastError)
        setPhase('error')
        return
      }
      setPhase('found')
      if (found.partialBytes > 0) {
        setProgress({ received: found.partialBytes, total: found.size })
      }
    })
    return () => {
      disposed = true
      offProgress()
      offDone()
      offError()
    }
  }, [])

  // 下载中每秒对一次状态:App 回前台(visibilitychange)时立即补,不靠已丢的事件。
  useEffect(() => {
    if (phase !== 'downloading') return
    let disposed = false
    const sync = async () => {
      const status = await tauri.updateStatus()
      if (disposed || !status) return
      if (status.downloading) {
        setProgress({ received: status.received, total: status.total })
        return
      }
      if (status.downloadedVersion && status.downloadedVersion === info?.version) {
        setPhase('ready')
        return
      }
      if (status.lastError) {
        setErrorMessage(status.lastError)
        setPhase('error')
      }
    }
    const timer = window.setInterval(() => void sync(), 1000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void sync()
    }
    document.addEventListener('visibilitychange', onVisible)
    void sync()
    return () => {
      disposed = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [phase, info?.version])

  const dismiss = useCallback(() => {
    if (info) setUpdateIgnoredVersion(info.version)
    setPhase('hidden')
  }, [info])

  const startDownload = useCallback(() => {
    setPhase('downloading')
    tauri.updateDownload().then((ok) => {
      if (!ok) {
        setErrorMessage('下载启动失败,稍后再试')
        setPhase('error')
      }
    })
  }, [])

  const install = useCallback(() => {
    setInstalling(true)
    tauri.updateInstall().then((message) => {
      setInstalling(false)
      if (message) {
        setErrorMessage(message)
        setPhase('error')
      }
    })
  }, [])

  if (phase === 'hidden') return null

  const pct = progress.total > 0 ? Math.min(100, Math.round((progress.received / progress.total) * 100)) : 0
  const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`

  const pill =
    'pointer-events-auto flex items-center gap-2.5 rounded-full border pl-3.5 pr-1.5 py-1.5 ' +
    'border-[rgba(29,29,31,0.08)] bg-[rgba(255,255,255,0.88)] text-content-primary ' +
    'shadow-[0_4px_20px_rgb(0_0_0_/_0.14)] ' +
    'dark:border-white/35 dark:bg-[rgb(28_28_30_/_0.88)] dark:text-white'
  const primaryBtn =
    'shrink-0 rounded-full bg-[rgb(29,29,31)] px-3.5 py-1.5 text-[13px] font-medium text-white ' +
    'dark:bg-white dark:text-black transition-transform duration-150 active:scale-95 touch-manipulation disabled:opacity-50'
  const closeBtn =
    'shrink-0 rounded-full p-1.5 text-content-muted transition-colors hover:text-content-primary'

  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-30 flex justify-center px-4"
      style={{ top: 'calc(var(--m-chrome-top) + 48px)' }}
      role="status"
    >
      <div
        className={pill}
        style={{
          WebkitBackdropFilter: 'blur(14px)',
          backdropFilter: 'blur(14px)',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        {(phase === 'found' || phase === 'ready') && info && (
          <>
            <Download className="h-4 w-4 shrink-0 text-content-muted" />
            <span className="max-w-[46vw] truncate text-[13px]">
              {phase === 'ready' ? '安装包已就绪' : `新版本 v${info.version}`}
              {phase === 'found' && info.size > 0 && (
                <span className="text-content-muted">
                  {info.partialBytes > 0 ? ` · 已下 ${mb(info.partialBytes)}` : ` · ${mb(info.size)}`}
                </span>
              )}
            </span>
            <button onClick={phase === 'ready' ? install : startDownload} className={primaryBtn}>
              {phase === 'ready'
                ? installing
                  ? '打开中…'
                  : '安装'
                : info.partialBytes > 0
                  ? '继续'
                  : '更新'}
            </button>
            <button onClick={dismiss} className={closeBtn} aria-label="忽略此版本">
              <X className="h-4 w-4" />
            </button>
          </>
        )}

        {phase === 'downloading' && (
          <>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-[13px]">
                下载更新{progress.total > 0 ? ` ${pct}%` : ''} · {mb(progress.received)}
                {progress.total > 0 ? ` / ${mb(progress.total)}` : ''}
                <span className="text-content-muted"> · 可切后台</span>
              </span>
              <div className="h-1 overflow-hidden rounded-full bg-black/10 dark:bg-white/15">
                <div
                  className="h-full rounded-full bg-[rgb(29,29,31)] transition-[width] duration-200 dark:bg-white"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
            <RotateCw className="h-4 w-4 shrink-0 animate-spin text-content-muted" />
          </>
        )}

        {phase === 'error' && (
          <>
            <span className="max-w-[46vw] truncate text-[13px] text-red-500 dark:text-red-400">{errorMessage}</span>
            <button onClick={startDownload} className={primaryBtn}>
              重试
            </button>
            <button onClick={dismiss} className={closeBtn} aria-label="关闭">
              <X className="h-4 w-4" />
            </button>
          </>
        )}
      </div>
    </div>
  )
}
