'use client'

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from 'lucide-react'
import { toast } from '@/lib/toast'
import { YellowFishFavoriteItems } from '@/components/settings/YellowFishFavoriteItems'

interface GoofishAuthStatus {
  available: boolean
  valid: boolean | null
  unb?: string
  tracknick?: string
  nick?: string
  error?: string
  checkedAt: number
}

interface GoofishLoginResult {
  ok: boolean
  source?: string
  tracknick?: string
  cookiesCount?: number
  error?: string
  hint?: string
}

/**
 * 设置 → YellowFish：本机 goofish-cli 登录态（YellowFish 实时价工具的 cookie）健康检查与一键修复。
 *
 * - 有效：绿点 + 账号标识
 * - 失效：琥珀提示 + 「扫码修复登录」按钮（POST → 弹出 Playwright 登录窗口，扫码或账密，10 分钟有效）
 * - CLI 未安装（VPS 部署 / 未装）：整块降级为说明卡，不显示修复按钮（拒绝安慰剂）
 *
 * Chrome/Edge 127+ 应用绑定加密后，浏览器自动导入全灭（RequiresAdminError），修复只走弹窗。
 */
export function YellowFishSection() {
  const [status, setStatus] = useState<GoofishAuthStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [fixing, setFixing] = useState(false)
  const [fixResult, setFixResult] = useState<GoofishLoginResult | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch('/api/yellow-fish/goofish-auth', { cache: 'no-store' })
      const data = (await res.json()) as GoofishAuthStatus & { error?: string }
      if (!res.ok) throw new Error(data.error || '加载失败')
      setStatus(data)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function fix() {
    setFixing(true)
    setFixResult(null)
    try {
      const res = await fetch('/api/yellow-fish/goofish-auth', { method: 'POST' })
      const data = (await res.json()) as GoofishLoginResult & { error?: string }
      if (!res.ok && typeof data.ok !== 'boolean') throw new Error(data.error || '修复失败')
      setFixResult(data)
      if (data.ok) {
        toast.success('闲鱼登录态已修复', { title: 'YellowFish' })
        await load()
      }
    } catch (err) {
      setFixResult({ ok: false, error: err instanceof Error ? err.message : '修复失败' })
    } finally {
      setFixing(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3 space-y-2.5">
        <div className="flex items-center gap-1.5 text-xs text-content-secondary">
          <RefreshCw className="w-3.5 h-3.5" />
          登录态是干什么的
        </div>
        <p className="text-[11px] leading-5 text-content-muted">
          「YellowFish 实时价」靠本机 goofish-cli 的闲鱼登录 cookie 工作。cookie 过期后实时价查不了
          （监控行情快照不受影响，走的是 monitor 自己的登录）。失效时聊天里的实时价卡片也会提醒你回来这里修。
        </p>
      </div>

      <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3 space-y-2.5">
        <div className="flex items-center gap-1.5 text-xs text-content-secondary">
          <RefreshCw className="w-3.5 h-3.5" />
          当前状态
        </div>

        {loading ? (
          <div className="flex items-center gap-1.5 text-[11px] text-content-muted">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            正在检查登录态（失效时会先尝试浏览器免密刷新，可能要十几秒）…
          </div>
        ) : loadError ? (
          <div className="space-y-2">
            <p className="text-[11px] text-content-muted">状态查询失败：{loadError}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-surface-muted px-2.5 py-1.5 text-[11px] font-medium text-content-secondary transition hover:bg-surface-subtle"
            >
              重试
            </button>
          </div>
        ) : status && !status.available ? (
          <p className="text-[11px] leading-5 text-content-muted">
            本机没有安装 goofish-cli，实时价功能不可用（服务端部署在 VPS 上时也是这个状态）。
          </p>
        ) : status && status.valid === true ? (
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-500" />
            <div className="min-w-0">
              <div className="text-[12px] text-content-primary">
                已登录{status.tracknick ? ` · ${status.tracknick}` : ''}
              </div>
              {status.unb ? (
                <div className="text-[10px] text-content-muted">unb {status.unb}</div>
              ) : null}
            </div>
          </div>
        ) : status && status.valid === false ? (
          <div className="space-y-2.5">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-500" />
              <div className="min-w-0">
                <div className="text-[12px] text-content-primary">登录态已失效</div>
                {status.error ? (
                  <div className="mt-0.5 break-all text-[10px] leading-4 text-content-muted">
                    {status.error}
                  </div>
                ) : null}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void fix()}
              disabled={fixing}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-[11px] font-medium text-accent-foreground transition hover:opacity-90 disabled:opacity-55"
            >
              {fixing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              {fixing ? '等待扫码/登录中…（窗口 10 分钟内有效）' : '扫码修复登录（弹窗）'}
            </button>
            <p className="text-[10px] leading-4 text-content-muted">
              点按钮会弹出登录窗口：闲鱼 App 扫码或直接输账号密码均可。注意窗口可能被其他程序挡住，看看任务栏。
            </p>
          </div>
        ) : status ? (
          <div className="space-y-2">
            <p className="text-[11px] text-content-muted">状态未知：{status.error || '输出无法解析'}</p>
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-surface-muted px-2.5 py-1.5 text-[11px] font-medium text-content-secondary transition hover:bg-surface-subtle"
            >
              再查一次
            </button>
          </div>
        ) : null}
      </div>

      {fixResult && !fixResult.ok ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-3.5 py-3 space-y-1.5">
          <div className="text-[11px] font-medium text-content-primary">导入失败</div>
          {fixResult.error ? (
            <pre className="whitespace-pre-wrap break-all text-[10px] leading-4 text-content-muted">{fixResult.error}</pre>
          ) : null}
          {fixResult.hint ? (
            <p className="text-[10px] leading-4 text-content-muted">{fixResult.hint}</p>
          ) : null}
        </div>
      ) : null}

      {fixResult && fixResult.ok ? (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.06] px-3.5 py-3">
          <div className="text-[11px] text-content-primary">
            登录态已修复（来源 {fixResult.source || 'qr'}{typeof fixResult.cookiesCount === 'number' ? ` · ${fixResult.cookiesCount} 条 cookie` : ''}）。回聊天里再问一次实时价即可。
          </div>
        </div>
      ) : null}

      <YellowFishFavoriteItems />
    </div>
  )
}
