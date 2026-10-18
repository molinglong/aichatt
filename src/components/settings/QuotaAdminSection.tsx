'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, RefreshCw, ShieldAlert, Plus, Trash2, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { copyText } from '@/lib/clipboard'
import { fmtTokens, parseKmTokens } from './quota-format'

type AdminQuotaUser = {
  userId: string
  name: string | null
  nickname: string | null
  email: string
  role: string | null
  todayTokens: number
  totalTokens: number
  requests: number
}

type PublicModelRow = {
  id: string
  name: string
  provider: string
  upstreamId: string
  weight: number
  capTokens: number
  usedTokens: number
  enabled: boolean
}

type PoolKeyRow = { provider: string; masked: string }

type RedeemCodeRow = {
  code: string
  tokens: number
  note: string
  enabled: boolean
  redeemedBy: string | null
  redeemedByName: string | null
  redeemedAt: string | null
  createdAt: string
}

type RegCodeRow = {
  code: string
  note: string
  enabled: boolean
  usedBy: string | null
  usedByName: string | null
  usedAt: string | null
  createdAt: string
}

type Catalog = {
  providers: Array<{ id: string; name: string }>
  builtinModels: Array<{ id: string; name: string; provider: string }>
}

type AdminQuotaData = {
  pool: {
    totalTokens: number
    usedTokens: number
    dailyRefillTokens: number
    dayKey: string
    perUserDailyTokens: number
    ephemeralPerUserDailyTokens: number
  } | null
  dayKey: string
  users: AdminQuotaUser[]
  publicModels: PublicModelRow[]
  codes: RedeemCodeRow[]
  regcodes: RegCodeRow[]
  poolKeys: PoolKeyRow[]
  catalog: Catalog
}

const inputCls =
  'w-full min-w-0 rounded-lg border border-line/60 bg-surface px-2.5 py-1.5 text-[12px] text-content-primary placeholder:text-content-muted focus:outline-none focus:ring-1 focus:ring-accent/50'
const btnGhost =
  'inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors bg-surface-muted text-content-secondary hover:bg-surface-subtle disabled:cursor-not-allowed disabled:opacity-60'
const btnDanger =
  'inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium transition-colors bg-red-500/10 text-red-600 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-60'

/** 一次连通性检测的结果，只存组件状态：刷新页面即清空，不进库 */
type TestResult = { ok: boolean; error?: string; raw?: string; reply?: string; ms: number; at: number }

/** 检测结论行：成功给耗时，失败直接给归类后的中文原因，附检测时刻以判断新旧 */
function TestResultLine({ r }: { r: TestResult | undefined }) {
  if (!r) return null
  return (
    <p
      className={cn(
        'text-[10.5px] truncate max-md:whitespace-normal max-md:overflow-visible max-md:text-clip',
        r.ok ? 'text-accent' : 'text-red-600'
      )}
      title={r.ok ? `${r.ms}ms 内返回，上游正文「${r.reply ?? ''}」` : `${r.error}\n${r.raw ?? ''}`}
    >
      {r.ok ? `✓ 可用 · ${r.ms}ms${r.reply ? '' : ' · 空回复'}` : `✗ ${r.error}`}
      <span className="text-content-muted">
        {' '}
        · {new Date(r.at).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })}
      </span>
    </p>
  )
}

/** 管理分三档：额度号池 / 激活码 / 注册码，同一份聚合数据按视图切片 */
export default function QuotaAdminSection({ view = 'pool' }: { view?: 'pool' | 'redeem' | 'register' }) {
  const [data, setData] = useState<AdminQuotaData | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [opError, setOpError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // 两步确认状态:再次点击才真正执行
  const [confirmModelId, setConfirmModelId] = useState<string | null>(null)
  const [confirmKeyProvider, setConfirmKeyProvider] = useState<string | null>(null)
  const [confirmCode, setConfirmCode] = useState<string | null>(null)
  const [confirmRegCode, setConfirmRegCode] = useState<string | null>(null)

  // 激活码生成表单
  const [genTokens, setGenTokens] = useState('100K')
  const [genCount, setGenCount] = useState('1')
  const [genNote, setGenNote] = useState('')
  // 注册码生成表单
  const [genRegCount, setGenRegCount] = useState('1')
  const [genRegNote, setGenRegNote] = useState('')
  // 复制反馈:null=未在展示 / ok=true 已复制 / false 复制失败(剪贴板被 webview 权限拦时走兜底仍失败)
  const [copied, setCopied] = useState<{ code: string; ok: boolean } | null>(null)

  // 新增模型表单
  const [addName, setAddName] = useState('')
  const [addProvider, setAddProvider] = useState('deepseek')
  const [addUpstream, setAddUpstream] = useState('deepseek-flash')
  const [addWeight, setAddWeight] = useState('1')
  // 倍率行内编辑:点击 ×N 徽标进入,Enter 提交,ESC 取消
  const [weightEditId, setWeightEditId] = useState<string | null>(null)
  const [weightDraft, setWeightDraft] = useState('')
  // 全站累计限额行内编辑:点击「限 N/不限量」徽标进入,0=不限
  const [capEditId, setCapEditId] = useState<string | null>(null)
  const [capDraft, setCapDraft] = useState('')
  // ESC 用 document 捕获阶段拦截:设置弹窗在 document 冒泡阶段也监听 Escape 关窗,
  // 合成事件的 stopPropagation 拦不住它,不抢先把编辑收口会把整个弹窗带走
  useEffect(() => {
    if (weightEditId === null && capEditId === null) return
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setWeightEditId(null)
      setCapEditId(null)
    }
    document.addEventListener('keydown', onEsc, true)
    return () => document.removeEventListener('keydown', onEsc, true)
  }, [weightEditId, capEditId])
  // Key 表单
  const [keyProvider, setKeyProvider] = useState('deepseek')
  const [keyValue, setKeyValue] = useState('')
  // 连通性检测:结果按门面模型 id 存;testingId 为当前正在打上游的那一行
  const [testResults, setTestResults] = useState<Record<string, TestResult>>({})
  const [testingId, setTestingId] = useState<string | null>(null)
  const [batchTesting, setBatchTesting] = useState(false)

  const load = useCallback(async (soft = false) => {
    if (soft) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/quota/admin', { cache: 'no-store' })
      if (!res.ok) {
        setData(null)
        setError(res.status === 403 ? '当前账号不是管理员，无法查看管理项' : '加载失败，请稍后重试')
        return
      }
      setData(await res.json())
    } catch {
      setError('网络异常，请稍后重试')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const mutate = useCallback(
    async (url: string, init: RequestInit) => {
      setBusy(true)
      setOpError(null)
      try {
        const res = await fetch(url, {
          ...init,
          headers: { 'content-type': 'application/json', ...(init.headers || {}) },
        })
        if (!res.ok) {
          const j = (await res.json().catch(() => null)) as { error?: string } | null
          setOpError(j?.error || `操作失败（${res.status}）`)
          return false
        }
        await load(true)
        return true
      } catch {
        setOpError('网络异常，操作未完成')
        return false
      } finally {
        setBusy(false)
      }
    },
    [load]
  )

  const commitWeight = (m: PublicModelRow, draft: string) => {
    const n = parseFloat(draft)
    setWeightEditId(null)
    if (!Number.isFinite(n) || n < 0.01 || n > 100) {
      setOpError('倍率需在 0.01~100 之间')
      return
    }
    if (Math.abs(n - m.weight) < 1e-9) return
    void mutate('/api/quota/admin/models', {
      method: 'PATCH',
      body: JSON.stringify({ id: m.id, weight: n }),
    })
  }

  const commitCap = (m: PublicModelRow, draft: string) => {
    const n = parseInt(draft, 10)
    setCapEditId(null)
    if (!Number.isFinite(n) || n < 0 || n > 1_000_000_000) {
      setOpError('限额需为 0~10亿 的整数（0=不限）')
      return
    }
    if (n === m.capTokens) return
    void mutate('/api/quota/admin/models', {
      method: 'PATCH',
      body: JSON.stringify({ id: m.id, capTokens: n }),
    })
  }

  const runTest = useCallback(async (model: PublicModelRow) => {
    setTestingId(model.id)
    try {
      const res = await fetch('/api/quota/admin/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: model.id }),
      })
      const j = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; raw?: string; reply?: string; ms?: number } | null
      const ok = !!j?.ok
      setTestResults((prev) => ({
        ...prev,
        [model.id]: {
          ok,
          error: ok ? undefined : (j?.error ?? `检测请求失败（${res.status}）`),
          raw: ok ? undefined : j?.raw,
          reply: ok ? j?.reply : undefined,
          ms: j?.ms ?? 0,
          at: Date.now(),
        },
      }))
    } catch {
      setTestResults((prev) => ({
        ...prev,
        [model.id]: { ok: false, error: '网络异常，检测未完成', ms: 0, at: Date.now() },
      }))
    } finally {
      setTestingId(null)
    }
  }, [])

  // 一键全检串行跑:并行会同时压同一个上游域名,容易自己把自己限流
  const testAll = useCallback(async () => {
    setBatchTesting(true)
    for (const m of data?.publicModels ?? []) await runTest(m)
    setBatchTesting(false)
  }, [data, runTest])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10 text-content-muted">
        <Loader2 className="w-4 h-4 animate-spin" />
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-content-muted">
        <ShieldAlert className="w-5 h-5" />
        <p className="text-[12px]">{error ?? '加载失败'}</p>
      </div>
    )
  }

  const { pool, catalog } = data
  const providerName = (id: string) => catalog.providers.find((p) => p.id === id)?.name ?? id
  const upstreamOptions = catalog.builtinModels.filter((m) => m.provider === addProvider)
  // 上游选择跟随服务商:切服务商时重置为该厂第一个内置模型
  const effectiveUpstream = upstreamOptions.some((o) => o.id === addUpstream)
    ? addUpstream
    : upstreamOptions[0]?.id ?? ''
  const usedPct = pool && pool.totalTokens > 0 ? Math.min(100, Math.round((pool.usedTokens / pool.totalTokens) * 100)) : 0
  // 池子四档数字:桌面横排 4 格(10.5px 标签),手机端 2x2 格(12px 标签 + 14px 值)。
  // 同一份数据喂两套断点分支,别在此处再加第三种口径
  const poolStats = pool
    ? [
        { label: '已用', value: fmtTokens(pool.usedTokens) },
        { label: '每日补给', value: fmtTokens(pool.dailyRefillTokens) },
        { label: '正式日限', value: fmtTokens(pool.perUserDailyTokens) },
        { label: '访客日限', value: fmtTokens(pool.ephemeralPerUserDailyTokens) },
      ]
    : []

  return (
    <div className="space-y-3">
      {/* 刷新行 + 操作报错 —— 统计日口径只属于号池视图，注册/激活码不按日重置 */}
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-content-muted text-left">
          {view === 'pool' ? '统计日 ' + data.dayKey + ' · 个人日限按北京时间自然日重置' : ''}
        </p>
        <div className="flex items-center gap-1.5 shrink-0">
          {view === 'pool' && (
            <button
              onClick={() => void testAll()}
              disabled={busy || testingId !== null || data.publicModels.length === 0}
              className={cn(btnGhost, testingId !== null && 'opacity-60')}
              title="用服务端 Key 逐个真打一次上游，验证 Key 有效、上游模型名存在（串行执行，不计入额度账）"
            >
              {testingId !== null ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
              {batchTesting
                ? `全检中 ${data.publicModels.findIndex((m) => m.id === testingId) + 1}/${data.publicModels.length}`
                : '一键全检'}
            </button>
          )}
          <button
            onClick={() => void load(true)}
            disabled={refreshing}
            className={cn(btnGhost, refreshing && 'opacity-60')}
          >
            {refreshing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            刷新
          </button>
        </div>
      </div>
      {opError && <p className="text-[11px] text-red-600 text-left">{opError}</p>}

      {view === 'pool' && (<>
      {/* 公共池卡片 */}
      {pool ? (
        <div
          data-testid="pool-quota-card"
          className="rounded-xl border border-line/60 bg-surface/60 px-4 py-4 space-y-3"
        >
          {/* 桌面:标题与 text-lg 数字同一行,原样保留。手机端:标题独占一行,余量做 26px 大字主视觉 */}
          <div className="flex items-baseline justify-between gap-2 max-md:hidden">
            <span className="text-[12px] font-medium text-content-secondary">公共池余量</span>
            <span className="text-lg font-semibold text-content-primary tabular-nums">
              {fmtTokens(pool.totalTokens - pool.usedTokens)}
              <span className="text-[12px] font-normal text-content-muted"> / {fmtTokens(pool.totalTokens)}</span>
            </span>
          </div>
          <div className="hidden max-md:block max-md:space-y-1.5">
            <p className="text-[12.5px] font-medium text-content-secondary">公共池余量</p>
            <p className="text-[26px] font-semibold leading-none tabular-nums text-content-primary">
              {fmtTokens(pool.totalTokens - pool.usedTokens)}
              <span className="ml-1.5 text-[12.5px] font-normal text-content-secondary">
                / {fmtTokens(pool.totalTokens)} tokens
              </span>
            </p>
          </div>
          <div className="h-1.5 rounded-full bg-surface-muted overflow-hidden max-md:h-2.5">
            <div
              className={cn('h-full rounded-full transition-all', usedPct >= 90 ? 'bg-red-400' : 'bg-accent')}
              style={{ width: `${Math.max(usedPct, 1)}%` }}
            />
          </div>
          <div className="grid grid-cols-4 gap-2 text-center max-md:hidden">
            {poolStats.map((s) => (
              <div key={s.label} className="min-w-0">
                <p className="text-[10.5px] text-content-muted truncate">{s.label}</p>
                <p className="text-[12px] font-medium text-content-primary tabular-nums truncate">{s.value}</p>
              </div>
            ))}
          </div>
          {/* 手机端 2x2:一档一格,标签走 secondary(桌面那套 10.5px muted 压在卡面上实测 2.64:1) */}
          <div className="hidden max-md:grid max-md:grid-cols-2 max-md:gap-2">
            {poolStats.map((s) => (
              <div key={s.label} className="rounded-lg bg-surface-muted/60 px-2.5 py-1.5">
                <p className="text-[12px] text-content-secondary">{s.label}</p>
                <p className="text-[14px] font-medium tabular-nums text-content-primary">{s.value}</p>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-[12px] text-content-muted">公共池尚未初始化（没有额度记录）。</p>
      )}

      {/* 公共模型管理 */}
      <div className="rounded-xl border border-line/60 bg-surface/60 overflow-hidden">
        <div className="px-3.5 pt-3 pb-2">
          <p className="text-[12px] font-medium text-content-secondary">公共模型</p>
          <p className="text-[10.5px] text-content-muted mt-0.5 max-md:hidden">
            全员可见的「注册即用」档位：一律服务端出钱 + 公共额度计费。×倍率 = 该模型烧池子的速度相对「标准」的倍数（落账 tokens×倍率），按各上游真实成本填。限 N = 全站累计预算：用完自动停运并从用户端隐藏，改大即恢复。「检测」= 用服务端 Key 真打一次上游，确认 Key 与模型名可用；几条 token 的消耗记在上游侧，不进本页任何额度数字。
          </p>
        </div>
        {data.publicModels.length === 0 ? (
          <p className="px-3.5 py-4 text-[12px] text-content-muted">还没有公共模型，用下方表单添加。</p>
        ) : (
          <div className="divide-y divide-line/50">
            {data.publicModels.map((m) => {
              // 触顶判定集中一处:红标、限额芯片配色、已用配色三处同源,别各写各的
              const isCapped = m.capTokens > 0 && m.usedTokens >= m.capTokens
              const weightCtl =
                weightEditId === m.id ? (
                  <input
                    autoFocus
                    type="number"
                    step="0.1"
                    min="0.01"
                    max="100"
                    value={weightDraft}
                    onChange={(e) => setWeightDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitWeight(m, weightDraft)
                    }}
                    onBlur={() => commitWeight(m, weightDraft)}
                    className="w-14 shrink-0 rounded border border-line/60 bg-surface px-1 py-0 text-[10.5px] text-content-primary text-right focus:outline-none focus:ring-1 focus:ring-accent/50 max-md:w-20 max-md:px-2 max-md:py-1 max-md:text-[16px]"
                    aria-label={`修改 ${m.name} 的计费倍率`}
                  />
                ) : (
                  <button
                    onClick={() => {
                      setWeightDraft(String(m.weight))
                      setWeightEditId(m.id)
                    }}
                    className="shrink-0 rounded bg-surface-muted px-1 py-px font-medium text-content-secondary hover:bg-surface-subtle transition-colors max-md:px-2.5 max-md:py-1.5 max-md:text-[12.5px]"
                    title="点击修改计费倍率（落账 tokens×倍率）"
                  >
                    ×{m.weight}
                  </button>
                )
              const capCtl =
                capEditId === m.id ? (
                  <input
                    autoFocus
                    type="number"
                    step="1000"
                    min="0"
                    max="1000000000"
                    value={capDraft}
                    onChange={(e) => setCapDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitCap(m, capDraft)
                    }}
                    onBlur={() => commitCap(m, capDraft)}
                    className="w-20 shrink-0 rounded border border-line/60 bg-surface px-1 py-0 text-[10.5px] text-content-primary text-right focus:outline-none focus:ring-1 focus:ring-accent/50 max-md:w-28 max-md:px-2 max-md:py-1 max-md:text-[16px]"
                    aria-label={`修改 ${m.name} 的全站累计限额`}
                  />
                ) : (
                  <button
                    onClick={() => {
                      setCapDraft(String(m.capTokens))
                      setCapEditId(m.id)
                    }}
                    className={cn(
                      'shrink-0 rounded px-1 py-px font-medium transition-colors max-md:px-2.5 max-md:py-1.5 max-md:text-[12.5px]',
                      isCapped
                        ? 'bg-red-500/10 text-red-600 hover:bg-red-500/20'
                        : 'bg-surface-muted text-content-secondary hover:bg-surface-subtle'
                    )}
                    title="点击修改全站累计限额（0=不限；达到后停运并从用户端隐藏，改大即恢复）"
                  >
                    {m.capTokens > 0 ? `限 ${fmtTokens(m.capTokens)}` : '不限量'}
                  </button>
                )
              return (
              <div
                key={m.id}
                data-testid={`pool-row-${m.name}`}
                className="px-3.5 py-2.5 flex items-center gap-2 max-md:flex-col max-md:items-stretch max-md:gap-2.5 max-md:px-3 max-md:py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] font-medium text-content-primary truncate max-md:text-[15px] max-md:whitespace-normal max-md:overflow-visible max-md:text-clip">
                    {m.name}
                    {!m.enabled && (
                      <span className="ml-1.5 inline-flex items-center h-[14px] px-1 rounded bg-surface-muted text-content-muted text-[9px] leading-none align-middle max-md:h-[18px] max-md:px-1.5">
                        已停用
                      </span>
                    )}
                    {m.enabled && m.capTokens > 0 && m.usedTokens >= m.capTokens && (
                      <span className="ml-1.5 inline-flex items-center h-[14px] px-1 rounded bg-red-500/10 text-red-600 text-[9px] leading-none align-middle max-md:h-[18px] max-md:px-1.5">
                        预算用完 · 用户端已隐藏
                      </span>
                    )}
                  </p>
                  {/* 桌面:一行塞满(服务商+倍率+限额+已用),手机端拆成「信息行 + 芯片行」两块 */}
                  <p className="text-[10.5px] text-content-muted truncate flex items-center gap-1 max-md:hidden">
                    <span className="truncate">{providerName(m.provider)} · 上游 {m.upstreamId}</span>
                    {weightCtl}
                    {capCtl}
                    {m.capTokens > 0 && (
                      <span
                        className={cn('shrink-0 tabular-nums', m.usedTokens >= m.capTokens && 'text-red-600')}
                      >
                        已用 {fmtTokens(m.usedTokens)}
                      </span>
                    )}
                  </p>
                  <div className="hidden max-md:flex max-md:flex-wrap max-md:items-center max-md:gap-x-2 max-md:gap-y-2">
                    <p className="w-full text-[12.5px] text-content-secondary">
                      {providerName(m.provider)} · 上游 {m.upstreamId}
                    </p>
                    {weightCtl}
                    {capCtl}
                    <span className={cn('text-[12.5px] tabular-nums text-content-secondary', isCapped && 'text-red-600')}>
                      已用 {fmtTokens(m.usedTokens)}
                      {m.capTokens > 0 ? ` / ${fmtTokens(m.capTokens)}` : ''}
                    </span>
                  </div>
                  <TestResultLine r={testResults[m.id]} />
                </div>
                {/* 操作钮包一层:桌面是同一行 gap-2 序列(视觉不变),手机端整行铺开等分 */}
                <div className="flex shrink-0 items-center gap-2 max-md:w-full">
                <button
                  onClick={() => void runTest(m)}
                  disabled={busy || testingId !== null}
                  className={cn(btnGhost, testingId === m.id && 'opacity-60', 'max-md:flex-1 max-md:justify-center')}
                  title="用该服务商的服务端 Key 真打一次上游，确认 Key 有效且上游模型名存在"
                >
                  {testingId === m.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
                  检测
                </button>
                <button
                  onClick={() => void mutate('/api/quota/admin/models', { method: 'PATCH', body: JSON.stringify({ id: m.id, enabled: !m.enabled }) })}
                  disabled={busy}
                  className={cn(btnGhost, 'max-md:flex-1 max-md:justify-center')}
                >
                  {m.enabled ? '停用' : '启用'}
                </button>
                {confirmModelId === m.id ? (
                  <>
                    <button
                      onClick={() => {
                        setConfirmModelId(null)
                        void mutate(`/api/quota/admin/models?id=${encodeURIComponent(m.id)}`, { method: 'DELETE' })
                      }}
                      disabled={busy}
                      className={cn(btnDanger, 'max-md:flex-1 max-md:justify-center')}
                    >
                      确认删除
                    </button>
                    <button onClick={() => setConfirmModelId(null)} className={cn(btnGhost, 'max-md:flex-1 max-md:justify-center')}>
                      取消
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setConfirmModelId(m.id)}
                    disabled={busy}
                    className={cn(btnGhost, 'max-md:px-3')}
                    aria-label={`删除 ${m.name}`}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
                </div>
              </div>
              )
            })}
          </div>
        )}
        {/* 新增表单 */}
        <div className="border-t border-line/50 px-3.5 py-3 space-y-2 bg-surface-muted/30">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
            <input
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              placeholder="显示名，如：标准 Pro"
              maxLength={24}
              className={inputCls}
            />
            <button
              onClick={() => {
                if (!addName.trim() || !effectiveUpstream) {
                  setOpError('请填显示名并确认该服务商有可选上游模型')
                  return
                }
                void mutate('/api/quota/admin/models', {
                  method: 'POST',
                  body: JSON.stringify({
                    name: addName.trim(),
                    provider: addProvider,
                    upstreamId: effectiveUpstream,
                    weight: addWeight.trim() === '' ? 1 : parseFloat(addWeight) || 0,
                  }),
                }).then((ok) => {
                  if (ok) {
                    setAddName('')
                    setAddWeight('1')
                  }
                })
              }}
              disabled={busy || !addName.trim() || !effectiveUpstream}
              className={cn(
                'inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors shrink-0',
                !busy && addName.trim() && effectiveUpstream
                  ? 'bg-accent text-accent-foreground hover:bg-accent-hover'
                  : 'bg-surface-muted text-content-muted cursor-not-allowed'
              )}
            >
              <Plus className="w-3.5 h-3.5" />
              添加
            </button>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_72px] gap-2 max-md:grid-cols-2">
            <select
              value={addProvider}
              onChange={(e) => {
                setAddProvider(e.target.value)
                const first = catalog.builtinModels.find((m) => m.provider === e.target.value)
                setAddUpstream(first?.id ?? '')
              }}
              className={inputCls}
              aria-label="服务商"
            >
              {catalog.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select
              value={effectiveUpstream}
              onChange={(e) => setAddUpstream(e.target.value)}
              className={inputCls}
              aria-label="上游模型"
            >
              {upstreamOptions.length === 0 && <option value="">该服务商无内置模型</option>}
              {upstreamOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
            <input
              type="number"
              step="0.1"
              min="0.01"
              max="100"
              value={addWeight}
              onChange={(e) => setAddWeight(e.target.value)}
              className={inputCls}
              aria-label="计费倍率"
              title="计费倍率：落账 tokens×倍率，1=与「标准」同口径"
            />
          </div>
        </div>
      </div>

      {/* 服务端 Key 管理 */}
      <div className="rounded-xl border border-line/60 bg-surface/60 overflow-hidden">
        <div className="px-3.5 pt-3 pb-2">
          <p className="text-[12px] font-medium text-content-secondary">服务端 Key（公共池出钱用）</p>
          <p className="text-[10.5px] text-content-muted mt-0.5 max-md:hidden">
            门面模型发上游从这里取 Key。DeepSeek 未设置时回退服务器环境变量兜底；Key 只存服务器，界面只显掩码。
          </p>
        </div>
        {data.poolKeys.length > 0 && (
          <div className="divide-y divide-line/50">
            {data.poolKeys.map((k) => (
              <div key={k.provider} className="px-3.5 py-2.5 flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] font-medium text-content-primary truncate">{providerName(k.provider)}</p>
                  <p className="text-[10.5px] text-content-muted truncate tabular-nums">{k.masked}</p>
                </div>
                {confirmKeyProvider === k.provider ? (
                  <>
                    <button
                      onClick={() => {
                        setConfirmKeyProvider(null)
                        void mutate(`/api/quota/admin/key?provider=${encodeURIComponent(k.provider)}`, { method: 'DELETE' })
                      }}
                      disabled={busy}
                      className={btnDanger}
                    >
                      确认清除
                    </button>
                    <button onClick={() => setConfirmKeyProvider(null)} className={btnGhost}>
                      取消
                    </button>
                  </>
                ) : (
                  <button onClick={() => setConfirmKeyProvider(k.provider)} disabled={busy} className={btnGhost}>
                    清除
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="border-t border-line/50 px-3.5 py-3 space-y-2 bg-surface-muted/30">
          <div className="grid grid-cols-[minmax(0,38%)_minmax(0,1fr)_auto] gap-2 max-md:grid-cols-1">
            <select value={keyProvider} onChange={(e) => setKeyProvider(e.target.value)} className={inputCls} aria-label="Key 服务商">
              {catalog.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <input
              type="password"
              value={keyValue}
              onChange={(e) => setKeyValue(e.target.value)}
              placeholder="粘贴该服务商的 API Key"
              autoComplete="off"
              className={inputCls}
            />
            <button
              onClick={() => {
                if (!keyValue.trim()) {
                  setOpError('请粘贴 Key 内容')
                  return
                }
                void mutate('/api/quota/admin/key', {
                  method: 'PUT',
                  body: JSON.stringify({ provider: keyProvider, apiKey: keyValue.trim() }),
                }).then((ok) => {
                  if (ok) setKeyValue('')
                })
              }}
              disabled={busy || !keyValue.trim()}
              className={cn(
                'inline-flex items-center px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors shrink-0',
                !busy && keyValue.trim()
                  ? 'bg-accent text-accent-foreground hover:bg-accent-hover'
                  : 'bg-surface-muted text-content-muted cursor-not-allowed'
              )}
            >
              保存
            </button>
          </div>
        </div>
      </div>
      </>)}

      {view === 'redeem' && (<>
      {/* 激活码管理 */}
      <div className="rounded-xl border border-line/60 bg-surface/60 overflow-hidden">
        <div className="px-3.5 pt-3 pb-2">
          <p className="text-[12px] font-medium text-content-secondary">激活码</p>
          <p className="text-[10.5px] text-content-muted mt-0.5">
            用户在「用量统计」的额度卡里兑换：到账附加余额，跨天存续，日限触顶后自动续烧，用完为止。删除已兑换的码不影响到账额度。
          </p>
        </div>
        {data.codes.length === 0 ? (
          <p className="px-3.5 py-4 text-[12px] text-content-muted">还没有激活码，用下方表单生成。</p>
        ) : (
          <div className="divide-y divide-line/50">
            {data.codes.map((c) => (
              <div key={c.code} className="px-3.5 py-2.5 flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <button
                    onClick={async () => {
                      const ok = await copyText(c.code)
                      setCopied({ code: c.code, ok })
                      setTimeout(() => setCopied((cur) => (cur?.code === c.code ? null : cur)), ok ? 1500 : 2500)
                    }}
                    className={cn(
                      'font-mono text-[12px] transition-colors truncate block max-w-full text-left',
                      copied?.code === c.code && !copied.ok
                        ? 'text-red-600'
                        : copied?.code === c.code
                          ? 'text-accent'
                          : 'text-content-primary hover:text-accent'
                    )}
                    title="点击复制"
                  >
                    {copied?.code === c.code ? (copied.ok ? '已复制 ✓' : '复制失败') : c.code}
                  </button>
                  <p className="text-[10.5px] text-content-muted truncate">
                    {fmtTokens(c.tokens)}
                    {c.redeemedBy ? ` · 已兑换${c.redeemedByName ? ` · ${c.redeemedByName}` : ''}` : ' · 未兑换'}
                    {!c.enabled && ' · 已停用'}
                    {c.note ? ` · ${c.note}` : ''}
                  </p>
                </div>
                <button
                  onClick={() => void mutate('/api/quota/admin/codes', { method: 'PATCH', body: JSON.stringify({ code: c.code, enabled: !c.enabled }) })}
                  disabled={busy}
                  className={btnGhost}
                >
                  {c.enabled ? '停用' : '启用'}
                </button>
                {confirmCode === c.code ? (
                  <>
                    <button
                      onClick={() => {
                        setConfirmCode(null)
                        void mutate(`/api/quota/admin/codes?code=${encodeURIComponent(c.code)}`, { method: 'DELETE' })
                      }}
                      disabled={busy}
                      className={btnDanger}
                    >
                      确认删除
                    </button>
                    <button onClick={() => setConfirmCode(null)} className={btnGhost}>
                      取消
                    </button>
                  </>
                ) : (
                  <button onClick={() => setConfirmCode(c.code)} disabled={busy} className={btnGhost} aria-label={`删除激活码 ${c.code}`}>
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {/* 生成表单 */}
        <div className="border-t border-line/50 px-3.5 py-3 space-y-2 bg-surface-muted/30">
          <div className="grid grid-cols-[96px_56px_minmax(0,1fr)_auto] gap-2">
            <input
              type="text"
              inputMode="text"
              autoComplete="off"
              value={genTokens}
              onChange={(e) => setGenTokens(e.target.value)}
              className={inputCls}
              aria-label="面值，支持 K/M 缩写"
              title="面值：兑换到账的附加余额 tokens，支持 K/M 缩写，如 100K、2M"
              placeholder="如 100K / 2M"
            />
            <input
              type="number"
              min="1"
              max="50"
              value={genCount}
              onChange={(e) => setGenCount(e.target.value)}
              className={inputCls}
              aria-label="生成张数"
              title="一次生成几张（1~50）"
            />
            <input
              value={genNote}
              onChange={(e) => setGenNote(e.target.value)}
              placeholder="备注（可选，如：开学活动）"
              maxLength={60}
              className={inputCls}
            />
            <button
              onClick={() => {
                const tokens = parseKmTokens(genTokens)
                const count = parseInt(genCount, 10)
                if (!Number.isFinite(tokens) || tokens < 1000 || tokens > 10000000) {
                  setOpError('面值需在 1K~10M tokens 之间')
                  return
                }
                void mutate('/api/quota/admin/codes', {
                  method: 'POST',
                  body: JSON.stringify({ tokens, count: Number.isFinite(count) ? count : 1, note: genNote.trim() }),
                }).then((ok) => {
                  if (ok) {
                    setGenNote('')
                    setOpError(null)
                  }
                })
              }}
              disabled={busy}
              className={cn(
                'inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors shrink-0',
                !busy
                  ? 'bg-accent text-accent-foreground hover:bg-accent-hover'
                  : 'bg-surface-muted text-content-muted cursor-not-allowed'
              )}
            >
              <Plus className="w-3.5 h-3.5" />
              生成
            </button>
          </div>
        </div>
      </div>
      </>)}

      {view === 'register' && (<>
      {/* 注册码管理 */}
      <div className="rounded-xl border border-line/60 bg-surface/60 overflow-hidden">
        <div className="px-3.5 pt-3 pb-2">
          <p className="text-[12px] font-medium text-content-secondary">注册码</p>
          <p className="text-[10.5px] text-content-muted mt-0.5">
            注册需持注册码（一码一用）：发给一个是一个号，防止脚本批量注册烧公共池。泄露的码可停用。
          </p>
        </div>
        {data.regcodes.length === 0 ? (
          <p className="px-3.5 py-4 text-[12px] text-content-muted">还没有注册码，用下方表单生成。</p>
        ) : (
          <div className="divide-y divide-line/50">
            {data.regcodes.map((c) => (
              <div key={c.code} className="px-3.5 py-2.5 flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <button
                    onClick={async () => {
                      const ok = await copyText(c.code)
                      setCopied({ code: c.code, ok })
                      setTimeout(() => setCopied((cur) => (cur?.code === c.code ? null : cur)), ok ? 1500 : 2500)
                    }}
                    className={cn(
                      'font-mono text-[12px] transition-colors truncate block max-w-full text-left',
                      copied?.code === c.code && !copied.ok
                        ? 'text-red-600'
                        : copied?.code === c.code
                          ? 'text-accent'
                          : 'text-content-primary hover:text-accent'
                    )}
                    title="点击复制"
                  >
                    {copied?.code === c.code ? (copied.ok ? '已复制 ✓' : '复制失败') : c.code}
                  </button>
                  <p className="text-[10.5px] text-content-muted truncate">
                    {c.usedBy ? `已使用${c.usedByName ? ` · ${c.usedByName}` : ''}` : '未使用'}
                    {!c.enabled && ' · 已停用'}
                    {c.note ? ` · ${c.note}` : ''}
                  </p>
                </div>
                <button
                  onClick={() => void mutate('/api/quota/admin/regcodes', { method: 'PATCH', body: JSON.stringify({ code: c.code, enabled: !c.enabled }) })}
                  disabled={busy}
                  className={btnGhost}
                >
                  {c.enabled ? '停用' : '启用'}
                </button>
                {confirmRegCode === c.code ? (
                  <>
                    <button
                      onClick={() => {
                        setConfirmRegCode(null)
                        void mutate(`/api/quota/admin/regcodes?code=${encodeURIComponent(c.code)}`, { method: 'DELETE' })
                      }}
                      disabled={busy}
                      className={btnDanger}
                    >
                      确认删除
                    </button>
                    <button onClick={() => setConfirmRegCode(null)} className={btnGhost}>
                      取消
                    </button>
                  </>
                ) : (
                  <button onClick={() => setConfirmRegCode(c.code)} disabled={busy} className={btnGhost} aria-label={`删除注册码 ${c.code}`}>
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {/* 生成表单 */}
        <div className="border-t border-line/50 px-3.5 py-3 space-y-2 bg-surface-muted/30">
          <div className="grid grid-cols-[56px_minmax(0,1fr)_auto] gap-2">
            <input
              type="number"
              min="1"
              max="50"
              value={genRegCount}
              onChange={(e) => setGenRegCount(e.target.value)}
              className={inputCls}
              aria-label="生成张数（注册码）"
              title="一次生成几张（1~50）"
            />
            <input
              value={genRegNote}
              onChange={(e) => setGenRegNote(e.target.value)}
              placeholder="备注（可选，如：三班同学）"
              maxLength={60}
              className={inputCls}
            />
            <button
              onClick={() => {
                const count = parseInt(genRegCount, 10)
                void mutate('/api/quota/admin/regcodes', {
                  method: 'POST',
                  body: JSON.stringify({ count: Number.isFinite(count) ? count : 1, note: genRegNote.trim() }),
                }).then((ok) => {
                  if (ok) {
                    setGenRegNote('')
                    setOpError(null)
                  }
                })
              }}
              disabled={busy}
              className={cn(
                'inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors shrink-0',
                !busy
                  ? 'bg-accent text-accent-foreground hover:bg-accent-hover'
                  : 'bg-surface-muted text-content-muted cursor-not-allowed'
              )}
            >
              <Plus className="w-3.5 h-3.5" />
              生成
            </button>
          </div>
        </div>
      </div>
      </>)}

      {view === 'pool' && (<>
      {/* 用户用量列表:按累计降序(API 已排) */}
      <div className="rounded-xl border border-line/60 bg-surface/60 overflow-hidden">
        <div className="grid grid-cols-[minmax(0,1fr)_58px_66px_40px] gap-2 items-center px-3.5 py-2 bg-surface-muted/50 text-[10.5px] text-content-muted">
          <span>用户</span>
          <span className="text-right">今日</span>
          <span className="text-right">累计</span>
          <span className="text-right">请求</span>
        </div>
        {data.users.length === 0 ? (
          <p className="px-3.5 py-6 text-center text-[12px] text-content-muted">
            还没有任何消耗记录。走公共池的对话会计入这里。
          </p>
        ) : (
          <div className="divide-y divide-line/50">
            {data.users.map((u) => (
              <div
                key={u.userId}
                className="grid grid-cols-[minmax(0,1fr)_58px_66px_40px] gap-2 items-center px-3.5 py-2.5"
              >
                <div className="min-w-0">
                  <p className="text-[12.5px] font-medium text-content-primary truncate">
                    {u.nickname || u.name || u.email.split('@')[0]}
                    {u.role === 'admin' && (
                      <span className="ml-1.5 inline-flex items-center h-[14px] px-1 rounded bg-accent-soft text-accent text-[9px] leading-none align-middle">
                        管理员
                      </span>
                    )}
                  </p>
                  <p className="text-[10.5px] text-content-muted truncate">{u.email}</p>
                </div>
                <span className="text-right text-[12px] text-content-secondary tabular-nums">
                  {fmtTokens(u.todayTokens)}
                </span>
                <span className="text-right text-[12px] font-medium text-content-primary tabular-nums">
                  {fmtTokens(u.totalTokens)}
                </span>
                <span className="text-right text-[12px] text-content-muted tabular-nums">{u.requests}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="text-[11px] text-content-muted">
        只统计走公共池计费的请求（公共模型与内置兜底模型）；各用户自带 Key 的调用不经过公共池，不在此列。
      </p>
      </>)}
    </div>
  )
}
