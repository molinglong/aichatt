'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRenderProbe } from '@/lib/client-diagnostics'
import { Gauge, Layers, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'

interface ContextInfo {
  estimatedTokens: number
  /** 已被摘要覆盖、不再计入占用的估算 token */
  compressedTokens: number
  realTokens: number
  messageCount: number
  /** 已被摘要覆盖的消息条数 */
  coveredMessages: number
  lastSummary: {
    coveredMessages: number
    createdAt: string
    preview: string
  } | null
  /** 本会话 prompt caching 统计(与设置·用量页同口径):
      只统计上游报了缓存明细的轮次;rounds=0 表示无可统计数据 */
  cache: {
    /** 命中量(promptTokens 的子集,逐轮 clamp) */
    hitTokens: number
    /** 有缓存明细轮次的输入 token 合计 */
    promptTokens: number
    /** 有缓存明细的轮次数 */
    rounds: number
    /** 其中命中(>0)的轮次数 */
    hitRounds: number
  }
}

interface ContextMeterProps {
  conversationId: string
  /** 当前模型 context window(tokens),0/未知时不渲染 */
  contextWindow: number
  /** 变化时重新拉取(如消息数变化) */
  refreshSignal: number
}

/**
 * 上下文用量仪表:输入区上方的小 pill,点击展开明细与"立即压缩"。
 * 占用比例与自动压缩阈值(60%)同口径估算,>60% 琥珀、>80% 红色警示。
 * 手机端(≤md)整颗不渲染(max-md:hidden):按用户要求从手机端撤下,桌面端行为不变。
 */
export function ContextMeter({ conversationId, contextWindow, refreshSignal }: ContextMeterProps) {
  useRenderProbe('ContextMeter')
  const [info, setInfo] = useState<ContextInfo | null>(null)
  const [open, setOpen] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/conversations/${conversationId}/context`)
      if (!res.ok) return
      setInfo(await res.json())
    } catch {
      // 静默:仪表属于辅助信息,加载失败不打扰用户
    }
  }, [conversationId])

  useEffect(() => {
    void load()
  }, [load, refreshSignal])

  // 点击面板外部关闭
  useEffect(() => {
    if (!open) return
    const onDocMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [open])

  if (!contextWindow || contextWindow <= 0 || !info) return null

  const ratio = Math.min(1, info.estimatedTokens / contextWindow)
  const pct = Math.round(ratio * 100)
  const tone =
    ratio >= 0.8
      ? 'text-red-500 border-red-500/40'
      : ratio >= 0.6
        ? 'text-amber-500 border-amber-500/40'
        : 'text-content-muted border-line'
  const barTone =
    ratio >= 0.8 ? 'bg-red-500' : ratio >= 0.6 ? 'bg-amber-500' : 'bg-accent'

  const handleCompact = async () => {
    if (compacting) return
    setCompacting(true)
    try {
      const res = await fetch(`/api/conversations/${conversationId}/compact`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`)
      }
      if (data.compressed === false) {
        toast.info(data.message || '消息数量还不足以压缩', { title: '上下文压缩' })
      } else {
        toast.success('已把较早的对话压缩为摘要', { title: '上下文压缩' })
      }
      await load()
    } catch (err) {
      console.error('[ContextMeter] compact failed:', err)
      toast.error(err instanceof Error ? err.message : '压缩失败,请稍后重试', { title: '上下文压缩' })
    } finally {
      setCompacting(false)
    }
  }

  return (
    <div ref={rootRef} className="relative max-md:hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex items-center gap-1 rounded-full border bg-surface/80 px-2 py-0.5 text-[11px] font-medium transition-colors hover:bg-surface-subtle',
          tone
        )}
        title="上下文用量"
      >
        <Gauge className="h-3 w-3" />
        <span>{pct}%</span>
      </button>

      {open && (
        <div data-panel-state="open" className="panel-motion absolute bottom-full right-0 z-20 mb-2 w-72 rounded-xl border border-line bg-surface p-3 shadow-lg">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-content-primary">上下文用量</span>
            <span className={cn('text-xs font-semibold', tone.split(' ')[0])}>{pct}%</span>
          </div>

          {/* 占用进度条 */}
          <div className="mb-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-subtle">
            <div className={cn('h-full rounded-full transition-all', barTone)} style={{ width: `${Math.max(pct, 2)}%` }} />
          </div>
          <div className="mb-3 text-[10px] text-content-muted">
            ≈ {info.estimatedTokens.toLocaleString()} / {contextWindow.toLocaleString()} tokens
          </div>

          {/* 明细 */}
          <div className="space-y-1 text-[11px] text-content-secondary">
            <div className="flex justify-between">
              <span>消息数</span>
              <span>{info.messageCount}</span>
            </div>
            {info.coveredMessages > 0 && (
              <div className="flex justify-between">
                <span>已压缩</span>
                <span>
                  {info.coveredMessages} 条 · 节省 {info.compressedTokens.toLocaleString()} tokens
                </span>
              </div>
            )}
            <div className="flex justify-between">
              <span>真实用量(已统计轮次)</span>
              <span>{info.realTokens > 0 ? info.realTokens.toLocaleString() : '—'}</span>
            </div>
            {/* 输入命中率迷你圆环:输入拆成 未命中(蓝)+命中(琥珀),配色与设置·用量页同款 */}
            {(() => {
              const c = info.cache
              const miss = Math.max(c.promptTokens - c.hitTokens, 0)
              const denom = c.promptTokens > 0 ? c.promptTokens : 0
              const missRatio = denom > 0 ? miss / denom : 0
              const hitRatio = denom > 0 ? Math.min(c.hitTokens, denom) / denom : 0
              const rate = denom > 0 ? Math.round(hitRatio * 100) : null
              return (
                <div
                  className="my-1 flex items-center gap-2.5"
                  title={
                    c.rounds > 0
                      ? `已报缓存明细的 ${c.rounds} 轮中 ${c.hitRounds} 轮命中 · 命中 ${c.hitTokens.toLocaleString()} / 输入 ${c.promptTokens.toLocaleString()} tokens`
                      : undefined
                  }
                >
                  <div className="relative h-11 w-11 shrink-0">
                    {c.rounds > 0 ? (
                      <>
                        <svg viewBox="0 0 42 42" className="h-full w-full -rotate-90">
                          {/* 背景环 */}
                          <circle cx="21" cy="21" r="15.9155" fill="none" stroke="currentColor" strokeWidth="6" className="text-line/40" />
                          {/* 未命中输入段(蓝) */}
                          <circle cx="21" cy="21" r="15.9155" fill="none" stroke="#3b82f6" strokeWidth="6" strokeDasharray={`${missRatio * 100} 100`} strokeDashoffset="0" strokeLinecap="butt" />
                          {/* 缓存命中段(琥珀) */}
                          {c.hitTokens > 0 && (
                            <circle cx="21" cy="21" r="15.9155" fill="none" stroke="#f59e0b" strokeWidth="6" strokeDasharray={`${hitRatio * 100} 100`} strokeDashoffset={`${-missRatio * 100}`} strokeLinecap="butt" />
                          )}
                        </svg>
                        <div className="absolute inset-0 flex items-center justify-center">
                          <span className="font-mono text-[10px] font-semibold text-content-primary tabular-nums">{rate}%</span>
                        </div>
                      </>
                    ) : (
                      <div className="flex h-full w-full items-center justify-center rounded-full border-2 border-dashed border-line/60">
                        <span className="text-[9px] text-content-muted">无数据</span>
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1 space-y-0.5 text-[11px]">
                    <div className="flex justify-between text-content-secondary">
                      <span>输入命中率</span>
                      <span className="tabular-nums">{c.rounds > 0 ? `${c.hitRounds}/${c.rounds} 轮` : '未统计'}</span>
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-content-muted">
                      <span className="flex items-center gap-1">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
                        命中 {c.hitTokens.toLocaleString()}
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-500" />
                        未命中 {miss.toLocaleString()}
                      </span>
                    </div>
                  </div>
                </div>
              )
            })()}
            <div className="flex justify-between">
              <span>最近压缩</span>
              <span>
                {info.lastSummary
                  ? `${info.lastSummary.coveredMessages} 条 · ${new Date(info.lastSummary.createdAt).toLocaleDateString()}`
                  : '未压缩过'}
              </span>
            </div>
          </div>

          {info.lastSummary && (
            <div className="mt-2 max-h-16 overflow-y-auto rounded-md bg-surface-subtle/60 p-2 text-[10px] leading-relaxed text-content-muted">
              {info.lastSummary.preview}
              {info.lastSummary.preview.length >= 200 && '…'}
            </div>
          )}

          <button
            type="button"
            onClick={handleCompact}
            disabled={compacting}
            className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-line bg-surface-subtle px-2 py-1.5 text-xs font-medium text-content-primary transition-colors hover:bg-line/40 disabled:opacity-60"
          >
            {compacting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                压缩中…
              </>
            ) : (
              <>
                <Layers className="h-3.5 w-3.5" />
                立即压缩为摘要
              </>
            )}
          </button>
        </div>
      )}
    </div>
  )
}
