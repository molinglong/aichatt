'use client'

import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, Loader2, Trash2, Watch } from 'lucide-react'
import { toast } from '@/lib/toast'

interface TokenRow {
  id: string
  name: string
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

/**
 * 设置 → 手表：设备码授权入口 + 已连接手表列表。
 * 手表令牌与「API 令牌」共用 ApiToken 表，这里按 name="手表登录" 过滤，
 * 撤销走同一个 /api/tokens DELETE（软撤销），不影响用户手工创建的令牌。
 */
export function WatchSettings() {
  const [tokens, setTokens] = useState<TokenRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/tokens', { cache: 'no-store' })
      if (!res.ok) throw new Error('load failed')
      const data = (await res.json()) as { tokens?: TokenRow[] }
      setTokens((data.tokens ?? []).filter((t) => t.name === '手表登录' && !t.revokedAt))
    } catch {
      toast.error('手表令牌加载失败', { title: '手表' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function revoke(id: string) {
    setBusyId(id)
    try {
      const res = await fetch(`/api/tokens?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('revoke failed')
      toast.success('已断开该手表', { title: '手表' })
      await load()
    } catch {
      toast.error('断开失败，请重试', { title: '手表' })
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3 space-y-2.5">
        <div className="flex items-center gap-1.5 text-xs text-content-secondary">
          <Watch className="w-3.5 h-3.5" />
          手表端登录
        </div>
        <p className="text-[11px] leading-5 text-content-muted">
          在手表上打开 aichatt，会显示 6 位授权码。点下方按钮进入授权页，登录后输入授权码，手表会自动完成登录，不需要手动填 Token。
        </p>
        <a
          href="/watch/link"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-[11px] font-medium text-accent-foreground transition hover:opacity-90"
        >
          打开手表授权页
          <ExternalLink className="w-3.5 h-3.5" />
        </a>
        <p className="text-[10px] text-content-muted">
          授权码 5 分钟内有效；手表端每 3 秒轮询一次，授权后自动进入主屏。
        </p>
      </div>

      <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3 space-y-2.5">
        <div className="flex items-center gap-1.5 text-xs text-content-secondary">
          <Watch className="w-3.5 h-3.5" />
          已连接的手表
        </div>

        {loading ? (
          <div className="flex items-center gap-1.5 text-[11px] text-content-muted">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            加载中…
          </div>
        ) : tokens.length === 0 ? (
          <p className="text-[11px] text-content-muted">还没有通过设备码登录的手表。</p>
        ) : (
          <ul className="space-y-1.5">
            {tokens.map((token) => (
              <li
                key={token.id}
                className="flex items-center justify-between gap-2 rounded-lg bg-surface-subtle/60 px-2.5 py-1.5"
              >
                <span className="min-w-0">
                  <span className="block text-[11px] text-content-primary">手表登录</span>
                  <span className="block text-[10px] text-content-muted">
                    授权于 {new Date(token.createdAt).toLocaleString('zh-CN')}
                    {token.lastUsedAt
                      ? ` · 最近使用 ${new Date(token.lastUsedAt).toLocaleString('zh-CN')}`
                      : ''}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => revoke(token.id)}
                  disabled={busyId === token.id}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] text-red-500 transition hover:bg-red-500/10 disabled:opacity-50"
                >
                  {busyId === token.id ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="w-3.5 h-3.5" />
                  )}
                  断开
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
