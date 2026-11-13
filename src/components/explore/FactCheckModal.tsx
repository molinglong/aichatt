'use client'

import { useState, useEffect } from 'react'
import { X, AlertTriangle, CheckCircle, HelpCircle, XCircle, Loader2, Globe, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'

interface FactCheckModalProps {
  content: string
  role: 'user' | 'opponent'
  topic?: string
  onClose: () => void
}

interface FactCheckResult {
  status: 'verified' | 'disputed' | 'unverifiable' | 'false'
  claims: {
    text: string
    type?: 'fact' | 'value'
    status: 'verified' | 'disputed' | 'unverifiable' | 'false'
    verification?: string
    source?: string
  }[]
  suggestions?: string[]
}

export function FactCheckModal({ content, role, topic, onClose }: FactCheckModalProps) {
  const [loading, setLoading] = useState(true)
  const [result, setResult] = useState<FactCheckResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    performFactCheck()
  }, [])

  const performFactCheck = async () => {
    setLoading(true)
    setError(null)

    try {
      const res = await fetch('/api/explore/fact-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, topic }),
      })

      if (!res.ok) throw new Error('核查请求失败')

      const data = await res.json()
      setResult(data.result)
    } catch (err) {
      console.error('Fact check failed:', err)
      setError(err instanceof Error ? err.message : '核查失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop — 主题感知磨砂遮罩 */}
      <div
        className="absolute inset-0 bg-black/20 backdrop-blur-[12px] saturate-150 dark:bg-white/15 dark:saturate-150"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="confirm-card-in relative w-full max-w-lg bg-surface rounded-2xl shadow-2xl border border-line/60 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-line/60">
          <div className="flex items-center gap-2">
            <div className={cn(
              'w-8 h-8 rounded-lg flex items-center justify-center',
              role === 'user' ? 'bg-accent/10' : 'bg-red-500/10'
            )}>
              <AlertTriangle className={cn(
                'w-4 h-4',
                role === 'user' ? 'text-accent' : 'text-red-500'
              )} />
            </div>
            <div>
              <h3 className="text-sm font-semibold">事实核查</h3>
              <p className="text-[10px] text-content-muted">
                {role === 'user' ? '你的发言' : '对手发言'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-surface-muted transition-colors"
          >
            <X className="w-4 h-4 text-content-secondary" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 max-h-[60vh] overflow-y-auto">
          {/* Original content */}
          <div className="mb-4">
            <div className="text-[10px] text-content-muted mb-1 font-medium">原文</div>
            <div className="text-sm text-content-secondary p-2 rounded-lg bg-surface-muted border border-line/40">
              {content}
            </div>
          </div>

          {/* Loading state */}
          {loading && (
            <div className="flex flex-col items-center justify-center py-8 text-content-muted">
              <Loader2 className="w-6 h-6 animate-spin mb-2" />
              <p className="text-xs">正在联网核查...</p>
              <p className="text-[10px] mt-1">使用百度 + Tavily 双引擎验证</p>
            </div>
          )}

          {/* Error state */}
          {error && !loading && (
            <div className="flex flex-col items-center justify-center py-8 text-content-muted">
              <XCircle className="w-6 h-6 text-red-500 mb-2" />
              <p className="text-xs text-red-500">{error}</p>
              <button
                onClick={performFactCheck}
                className="mt-3 flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs bg-surface-muted hover:bg-surface-subtle border border-line/60 transition-colors"
              >
                <RefreshCw className="w-3 h-3" />
                重试
              </button>
            </div>
          )}

          {/* Result */}
          {result && !loading && (
            <div className="space-y-3">
              {/* Status overview */}
              <div className="flex items-center gap-2 p-2 rounded-lg bg-surface-muted">
                <StatusIcon status={result.status} />
                <div className="flex-1">
                  <div className="text-xs font-medium">{getStatusLabel(result.status)}</div>
                  <div className="text-[10px] text-content-muted">{getStatusDescription(result.status)}</div>
                </div>
              </div>

              {/* Claims breakdown */}
              {result.claims.length > 0 && (
                <div className="space-y-2">
                  <div className="text-[10px] text-content-muted font-medium">逐条核查</div>
                  {result.claims.map((claim, idx) => (
                    <div
                      key={idx}
                      className={cn(
                        'p-2.5 rounded-lg border',
                        claim.status === 'verified' && 'bg-emerald-500/5 border-emerald-500/20',
                        claim.status === 'disputed' && 'bg-amber-500/5 border-amber-500/20',
                        claim.status === 'unverifiable' && 'bg-gray-500/5 border-gray-500/20',
                        claim.status === 'false' && 'bg-red-500/5 border-red-500/20',
                      )}
                    >
                      <div className="flex items-start gap-2">
                        <StatusIcon status={claim.status} size="sm" />
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <div className="text-xs text-content-primary">"{claim.text}"</div>
                            {claim.type === 'value' && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-accent/10 text-accent">
                                价值主张
                              </span>
                            )}
                          </div>
                          {claim.verification && (
                            <div className="text-[11px] text-content-secondary whitespace-pre-wrap">
                              {claim.verification}
                            </div>
                          )}
                          {claim.source && (
                            <div className="flex items-center gap-1 mt-1 text-[10px] text-content-muted">
                              <Globe className="w-3 h-3" />
                              <span className="break-all">{claim.source}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Suggestions */}
              {result.suggestions && result.suggestions.length > 0 && (
                <div className="p-2.5 rounded-lg bg-accent/5 border border-accent/20">
                  <div className="flex items-center gap-1.5 mb-2">
                    <AlertTriangle className="w-3 h-3 text-accent" />
                    <span className="text-xs font-medium text-accent">助手建议</span>
                  </div>
                  <ul className="space-y-1">
                    {result.suggestions.map((s, idx) => (
                      <li key={idx} className="text-[11px] text-content-secondary flex items-start gap-1.5">
                        <span className="text-accent mt-0.5">·</span>
                        <span>{s}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-line/60 bg-surface-muted/50">
          <button
            onClick={performFactCheck}
            disabled={loading}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs text-content-secondary hover:text-content-primary hover:bg-surface-muted transition-colors disabled:opacity-50"
          >
            <RefreshCw className="w-3 h-3" />
            重新核查
          </button>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg text-xs font-medium bg-accent text-accent-foreground hover:bg-accent-hover transition-colors"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}

function StatusIcon({ status, size = 'md' }: { status: FactCheckResult['status']; size?: 'sm' | 'md' }) {
  const cls = size === 'sm' ? 'w-3.5 h-3.5' : 'w-5 h-5'
  switch (status) {
    case 'verified':
      return <CheckCircle className={cn(cls, 'text-emerald-500')} />
    case 'disputed':
      return <HelpCircle className={cn(cls, 'text-amber-500')} />
    case 'unverifiable':
      return <HelpCircle className={cn(cls, 'text-gray-400')} />
    case 'false':
      return <XCircle className={cn(cls, 'text-red-500')} />
  }
}

function getStatusLabel(status: FactCheckResult['status']) {
  switch (status) {
    case 'verified': return '已验证'
    case 'disputed': return '存在争议'
    case 'unverifiable': return '无法核实'
    case 'false': return '可能错误'
  }
}

function getStatusDescription(status: FactCheckResult['status']) {
  switch (status) {
    case 'verified': return '该内容有可靠来源支持'
    case 'disputed': return '不同来源存在相互矛盾的信息'
    case 'unverifiable': return '无法找到足够证据验证'
    case 'false': return '该内容与已知事实不符'
  }
}
