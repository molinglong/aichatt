'use client'

/**
 * /papers/composed/generating —— AI 补题组卷的独立生成页(折中方案,design/preview-paper-compose-generating.html
 * 方案 E 用户挑定:纯真题快模式留在列表页卡内,1-3 分钟的 AI 慢模式才跳本页)。
 * 流程:列表页把 payload+meta 暂存 sessionStorage('composed-pending')后跳本页 → 本页读参发起请求
 * (模块级 genPromise 单例,StrictMode 双挂载/重挂载复用同一请求;发出前写 'composed-inflight' 标记)
 * → 成功清参跳卷面;失败把错误并进 'composed-form-state' 供列表页恢复表单 + 显示错误;
 * 刷新 / 直达(有 inflight 无 pending)→ 「后台进行中」态(服务端会继续跑完落库,列表可见);
 * 两者皆无 → 空态。等待期可随时离开,组卷照常进行。
 */
import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { ChevronLeft, FileText } from 'lucide-react'
import { AuthErrorBoundary } from '@/components/AuthErrorBoundary'
import { ClientOnly } from '@/components/ClientOnly'
import { fetchJson } from '@/lib/query/fetcher'
import { chickPlay } from '@/lib/chick/reactions'
import { queryKeys } from '@/lib/query/keys'
import { toast } from '@/lib/toast'
import ComposeGenerating from '@/components/papers/ComposeGenerating'

type PendingMeta = { subjectLabel: string; total: number; score: number | null; sourceLabel: string }
type GenRes = {
  id: string
  shortages: Array<{ kind: string; score: number; requested: number; filled: number }>
  filledInline?: { textbook: number; aiVariant: number }
}
type GenState = 'run' | 'error' | 'inflight' | 'empty'

// 模块级单例:StrictMode 双挂载与重挂载复用同一请求,不重发(真刷新时 JS 重载丢引用,由 inflight 态兜底)
let genPromise: Promise<GenRes> | null = null
let genMeta: PendingMeta | null = null
let settled = false

const KIND_LABEL: Record<string, string> = { choice: '选择题', answer: '解答/填空' }

function GeneratingContent() {
  const router = useRouter()
  const qc = useQueryClient()
  const [state, setState] = useState<GenState>('run')
  const [meta, setMeta] = useState<PendingMeta | null>(genMeta)
  const [errMsg, setErrMsg] = useState<string | null>(null)
  // 「离开等待」后组件卸载:请求完成只清标记+刷列表缓存,不再 toast / 强行跳卷面
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!genPromise) {
      const raw = window.sessionStorage.getItem('composed-pending')
      if (raw) {
        window.sessionStorage.removeItem('composed-pending')
        window.sessionStorage.setItem('composed-inflight', '1')
        try {
          const { payload, meta: m } = JSON.parse(raw) as { payload: Record<string, unknown>; meta: PendingMeta }
          genMeta = m
          setMeta(m)
          genPromise = fetchJson<GenRes>('/api/papers/composed', { method: 'POST', json: payload, timeoutMs: 300_000 })
        } catch {
          window.sessionStorage.removeItem('composed-inflight')
          genPromise = null
          setState('empty')
          return
        }
      } else if (window.sessionStorage.getItem('composed-inflight') === '1') {
        setState('inflight')
        return
      } else {
        setState('empty')
        return
      }
    } else {
      setMeta(genMeta)
    }
    const p = genPromise
    p.then((res) => {
      if (settled) return
      settled = true
      window.sessionStorage.removeItem('composed-inflight')
      window.sessionStorage.removeItem('composed-form-state')
      void qc.invalidateQueries({ queryKey: queryKeys.papers.composedList() })
      // 小鸡:卷组好了(就算已离开等待页,宿主在 layout,别的页面照样弹)
      chickPlay('paperReady')
      if (!mountedRef.current) return
      const shortageNote = (res.shortages ?? [])
        .map((s) =>
          s.score === 0
            ? `${s.kind}：匹配到 ${s.filled}/${s.requested} 道`
            : `${KIND_LABEL[s.kind] ?? s.kind}${s.score}分 缺 ${s.requested - s.filled} 道`
        )
        .join('；')
      const inlineCount = (res.filledInline?.textbook ?? 0) + (res.filledInline?.aiVariant ?? 0)
      const inlineNote = inlineCount > 0 ? `${shortageNote ? '；' : ''}AI 拟题补齐 ${inlineCount} 道（卷面已标注来源）` : ''
      if (shortageNote || inlineNote) toast.success(`组好了（${shortageNote}${inlineNote}）`, { title: '拟卷' })
      router.replace(`/papers/composed/${res.id}`)
    }).catch((err: unknown) => {
      if (settled) return
      settled = true
      window.sessionStorage.removeItem('composed-inflight')
      genPromise = null
      genMeta = null
      // 错误并进表单暂存,「回去改改」回列表时表单恢复并显示错误
      const msg = err instanceof Error ? err.message : '组卷失败'
      const raw = window.sessionStorage.getItem('composed-form-state')
      try {
        const obj = raw ? (JSON.parse(raw) as { form: unknown; error?: string | null }) : { form: null, error: null }
        obj.error = msg
        window.sessionStorage.setItem('composed-form-state', JSON.stringify(obj))
      } catch {
        window.sessionStorage.setItem('composed-form-state', JSON.stringify({ form: null, error: msg }))
      }
      if (!mountedRef.current) return
      setErrMsg(msg)
      setState('error')
    })
  }, [qc, router])

  const metaText = meta
    ? `${meta.subjectLabel} · ${meta.total} 题${meta.score ? ` · ${meta.score} 分` : ''} · ${meta.sourceLabel}`
    : 'AI 出题组卷'

  const leaveBtn = (
    <button
      type="button"
      onClick={() => router.push('/papers/composed')}
      className="flex h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-4 text-[12.5px] text-content-secondary transition-colors hover:text-content-primary"
    >
      回拟卷列表
    </button>
  )

  return (
    <div className="relative h-full">
      {/* 顶栏(与列表页同款骨架):返回 = 离开等待,后台组卷照常进行 */}
      <div className="absolute inset-x-0 top-0 z-10 flex min-h-[52px] items-center gap-1 border-b border-line/60 bg-surface/95 px-1.5 backdrop-blur-md max-md:pt-[var(--sat)] md:px-4">
        <button
          type="button"
          onClick={() => router.push('/papers/composed')}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-content-secondary transition-colors hover:bg-surface-subtle hover:text-content-primary"
          aria-label="离开等待"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1 py-1 text-[13px] font-medium text-content-primary md:text-sm">拟卷</div>
      </div>

      <div className="h-full overflow-y-auto pt-[calc(52px+var(--sat))]">
        <div className="mx-auto flex w-full max-w-[720px] flex-col items-center px-2 py-8 md:px-4 md:py-12">
          {state === 'run' && (
            <>
              <div className="mb-5 text-center">
                <p className="text-[15.5px] font-bold text-content-primary">组卷进行中</p>
                <p className="mt-1 text-[12px] text-content-muted">{metaText}</p>
              </div>
              <div className="glass-blur w-full overflow-hidden rounded-[14px] border border-line/60 bg-surface-glass">
                <ComposeGenerating mode="ai" total={meta?.total ?? 0} size="page" />
              </div>
              <div className="mt-6">{leaveBtn}</div>
              <p className="mt-2.5 max-w-[420px] text-center text-[10.5px] leading-relaxed text-content-muted">
                等待期可以离开，组卷仍在后台进行，组好后会出现在拟卷列表
              </p>
            </>
          )}

          {state === 'error' && (
            <div className="glass-blur w-full rounded-[14px] border border-line/60 bg-surface-glass px-5 py-8 text-center">
              <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-red-500/10 text-red-500">
                <FileText className="h-5 w-5" />
              </span>
              <p className="mt-3 text-[14px] font-bold text-content-primary">组卷没成功</p>
              <p className="mx-auto mt-1.5 max-w-[420px] text-[12px] leading-relaxed text-content-secondary">{errMsg ?? '组卷失败'}</p>
              <div className="mt-5 flex justify-center">{leaveBtn}</div>
            </div>
          )}

          {state === 'inflight' && (
            <div className="glass-blur w-full rounded-[14px] border border-line/60 bg-surface-glass px-5 py-8 text-center">
              <p className="text-[14px] font-bold text-content-primary">组卷仍在后台进行</p>
              <p className="mx-auto mt-1.5 max-w-[420px] text-[12px] leading-relaxed text-content-secondary">
                页面刚被刷新过。这次组卷没有中断，组好后会出现在拟卷列表（AI 补题约需 1-3 分钟）。
              </p>
              <div className="mt-5 flex justify-center">{leaveBtn}</div>
            </div>
          )}

          {state === 'empty' && (
            <div className="glass-blur w-full rounded-[14px] border border-line/60 bg-surface-glass px-5 py-8 text-center">
              <p className="text-[14px] font-bold text-content-primary">没有进行中的组卷</p>
              <p className="mx-auto mt-1.5 max-w-[420px] text-[12px] leading-relaxed text-content-secondary">
                这个页面是 AI 补题组卷的等待页，从拟卷列表点「组卷」并改用 AI 出题时会自动来到这里。
              </p>
              <div className="mt-5 flex justify-center">{leaveBtn}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function ComposedGeneratingPage() {
  return (
    <AuthErrorBoundary>
      <ClientOnly>
        <GeneratingContent />
      </ClientOnly>
    </AuthErrorBoundary>
  )
}
