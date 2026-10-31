'use client'

/**
 * 设置 → MCP 工具：
 * - 用户自配远程 MCP server（HTTP/SSE）列表：启停 / 删除（两段式确认）
 * - 添加表单：名称 / URL / 可选鉴权 Header / 可选排除工具 + 「测试连接」预览工具清单
 * 数据源：GET/POST/PATCH/DELETE /api/mcp/servers + POST /api/mcp/servers/test
 * 安全：Header 值只写不读（服务端加密存储，接口永不回传）。
 */
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Plus,
  Trash2,
  Loader2,
  PlugZap,
  ArrowLeft,
  Check,
  TriangleAlert,
  Plug,
  ChevronDown,
} from 'lucide-react'
import { fetchJson, HttpError } from '@/lib/query/fetcher'
import { queryKeys } from '@/lib/query/keys'
import { MiniSwitch } from './MiniSwitch'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'

interface McpServerDTO {
  id: string
  name: string
  slug: string
  url: string
  headerName: string | null
  excludeTools: string | null
  enabled: boolean
  createdAt: string
}

interface TestResult {
  ok: boolean
  serverName?: string | null
  tools?: Array<{ name: string; description?: string }>
  error?: string
}

const INPUT_CLS = cn(
  'w-full rounded-lg border px-2.5 py-1.5 text-xs',
  'border-line/60',
  'bg-surface',
  'text-content-primary',
  'placeholder:text-content-muted',
  'focus:outline-none focus:ring-2 focus:ring-accent/30',
  'focus:border-accent transition-all'
)

const LABEL_CLS = 'text-[11px] font-medium text-content-secondary'

/**
 * 一键预置：免 Key、公开可达的 MCP 服务，点一下直接入库，不走表单。
 * 已添加（URL 命中）的预置不再展示。数学符号运算（解方程/积分）内置验算器不会，交给 Wolfram。
 */
const MCP_PRESETS: ReadonlyArray<{ name: string; url: string; blurb: string }> = [
  {
    name: 'Wolfram 数学计算',
    url: 'https://agenttools.wolfram.com/mcp',
    blurb: '解方程、积分、画函数图、知识查询；免费无需 Key，境外节点略慢',
  },
]

function errText(e: unknown): string {
  if (e instanceof HttpError) return e.message
  if (e instanceof Error) return e.message
  return '未知错误'
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url)
    return u.host + (u.pathname === '/' ? '' : u.pathname.slice(0, 24))
  } catch {
    return url.slice(0, 40)
  }
}

export default function McpSettings() {
  const queryClient = useQueryClient()

  // 列表
  const { data: servers, isLoading, error } = useQuery({
    queryKey: queryKeys.mcp.servers(),
    queryFn: () => fetchJson<{ servers: McpServerDTO[] }>('/api/mcp/servers'),
  })
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  // 新增表单（null = 列表视图）
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState({ name: '', url: '', headerName: '', headerValue: '', excludeTools: '' })
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [saving, setSaving] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [addingPreset, setAddingPreset] = useState<string | null>(null)

  async function invalidate() {
    await queryClient.invalidateQueries({ queryKey: queryKeys.mcp.servers() })
  }

  async function handleAddPreset(preset: (typeof MCP_PRESETS)[number]) {
    setAddingPreset(preset.url)
    try {
      await fetchJson('/api/mcp/servers', {
        method: 'POST',
        json: { name: preset.name, url: preset.url },
      })
      await invalidate()
      toast.success(`已添加 ${preset.name}`)
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setAddingPreset(null)
    }
  }

  async function handleToggle(server: McpServerDTO) {
    setTogglingId(server.id)
    try {
      await fetchJson('/api/mcp/servers', {
        method: 'PATCH',
        json: { id: server.id, enabled: !server.enabled },
      })
      await invalidate()
      toast.success(server.enabled ? '已停用' : '已启用')
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setTogglingId(null)
    }
  }

  async function handleDelete(server: McpServerDTO) {
    // 两段式确认：第一次点击进入确认态，3s 后自动还原
    if (confirmDeleteId !== server.id) {
      setConfirmDeleteId(server.id)
      setTimeout(() => setConfirmDeleteId((cur) => (cur === server.id ? null : cur)), 3000)
      return
    }
    setConfirmDeleteId(null)
    try {
      await fetchJson('/api/mcp/servers', { method: 'DELETE', json: { id: server.id } })
      await invalidate()
      toast.success('已删除')
    } catch (e) {
      toast.error(errText(e))
    }
  }

  async function handleTest() {
    if (!form.url.trim()) {
      toast.error('请先填写 URL')
      return
    }
    setTesting(true)
    setTestResult(null)
    try {
      const res = await fetchJson<TestResult>('/api/mcp/servers/test', {
        method: 'POST',
        json: {
          url: form.url.trim(),
          ...(form.headerName.trim() ? { headerName: form.headerName.trim() } : {}),
          ...(form.headerValue.trim() ? { headerValue: form.headerValue.trim() } : {}),
        },
      })
      setTestResult(res)
      if (res.ok) {
        toast.success(`连接成功，发现 ${res.tools?.length ?? 0} 个工具`)
      }
    } catch (e) {
      setTestResult({ ok: false, error: errText(e) })
    } finally {
      setTesting(false)
    }
  }

  async function handleSave() {
    if (!form.name.trim() || !form.url.trim()) {
      toast.error('名称与 URL 为必填项')
      return
    }
    setSaving(true)
    try {
      await fetchJson('/api/mcp/servers', {
        method: 'POST',
        json: {
          name: form.name.trim(),
          url: form.url.trim(),
          ...(form.headerName.trim() && form.headerValue.trim()
            ? { headerName: form.headerName.trim(), headerValue: form.headerValue.trim() }
            : {}),
          ...(form.excludeTools.trim()
            ? {
                excludeTools: form.excludeTools
                  .split(/[,，\s]+/)
                  .map((s) => s.trim())
                  .filter(Boolean),
              }
            : {}),
        },
      })
      await invalidate()
      toast.success('MCP 服务已添加')
      setForm({ name: '', url: '', headerName: '', headerValue: '', excludeTools: '' })
      setTestResult(null)
      setShowForm(false)
      setShowAdvanced(false)
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setSaving(false)
    }
  }

  if (showForm) {
    return (
      <div className="space-y-3">
        <button
          type="button"
          onClick={() => {
            setShowForm(false)
            setTestResult(null)
          }}
          className="flex items-center gap-1 text-xs text-content-secondary hover:text-content-primary transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> 返回列表
        </button>

        <div className="space-y-2.5 rounded-xl border border-line/60 bg-surface-muted p-3">
          <div className="space-y-1">
            <label className={LABEL_CLS}>服务名称</label>
            <input
              className={INPUT_CLS}
              placeholder="如：高德地图"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div className="space-y-1">
            <label className={LABEL_CLS}>MCP 端点 URL（HTTP/SSE）</label>
            <input
              className={INPUT_CLS}
              placeholder="https://mcp.example.com/mcp"
              value={form.url}
              onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
            />
          </div>

          {/* 高级选项：鉴权 Header 与排除工具 */}
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="flex items-center gap-1 text-[11px] text-content-muted hover:text-content-secondary transition-colors"
          >
            <ChevronDown className={cn('w-3 h-3 transition-transform', showAdvanced ? '' : '-rotate-90')} />
            高级选项（鉴权 / 工具排除）
          </button>
          {showAdvanced && (
            <div className="space-y-2.5">
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label className={LABEL_CLS}>Header 名（可选）</label>
                  <input
                    className={INPUT_CLS}
                    placeholder="Authorization"
                    value={form.headerName}
                    onChange={(e) => setForm((f) => ({ ...f, headerName: e.target.value }))}
                  />
                </div>
                <div className="space-y-1">
                  <label className={LABEL_CLS}>Header 值（可选，仅存储不回显）</label>
                  <input
                    className={INPUT_CLS}
                    type="password"
                    placeholder="Bearer sk-..."
                    value={form.headerValue}
                    onChange={(e) => setForm((f) => ({ ...f, headerValue: e.target.value }))}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <label className={LABEL_CLS}>排除工具（可选，逗号分隔）</label>
                <input
                  className={INPUT_CLS}
                  placeholder="tavily-search（屏蔽与内置联网搜索重复的能力）"
                  value={form.excludeTools}
                  onChange={(e) => setForm((f) => ({ ...f, excludeTools: e.target.value }))}
                />
              </div>
            </div>
          )}

          {/* 测试连接结果 */}
          {testResult && !testResult.ok && (
            <div className="flex items-start gap-1.5 rounded-lg border border-red-500/20 bg-red-500/5 px-2.5 py-2 text-xs text-red-500">
              <TriangleAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span className="break-words">{testResult.error || '连接失败'}</span>
            </div>
          )}
          {testResult?.ok && (
            <div className="rounded-lg border border-line/60 bg-surface px-2.5 py-2 text-xs space-y-1.5">
              <div className="flex items-center gap-1.5 text-content-secondary">
                <Check className="w-3.5 h-3.5 text-content-muted" />
                连接成功
                {testResult.serverName && (
                  <span className="text-content-muted">· {testResult.serverName}</span>
                )}
                <span className="text-content-muted">· {testResult.tools?.length ?? 0} 个工具</span>
              </div>
              {(testResult.tools ?? []).length > 0 && (
                <div className="max-h-32 overflow-y-auto space-y-0.5">
                  {(testResult.tools ?? []).map((t) => (
                    <p key={t.name} className="text-content-muted truncate" title={t.description || t.name}>
                      <span className="font-mono text-[10px] text-content-secondary">{t.name}</span>
                      {t.description ? ` — ${t.description.slice(0, 60)}` : ''}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleTest}
              disabled={testing || !form.url.trim()}
              className={cn(
                'flex items-center gap-1.5 rounded-lg border border-line/60 bg-surface px-3 py-1.5 text-xs',
                'text-content-secondary hover:bg-surface-subtle transition-colors',
                'disabled:opacity-50 disabled:cursor-not-allowed'
              )}
            >
              {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlugZap className="w-3.5 h-3.5" />}
              测试连接
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !form.name.trim() || !form.url.trim()}
              className={cn(
                'flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs text-accent-foreground',
                'hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed'
              )}
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              保存
            </button>
          </div>
          <p className="text-[10px] leading-relaxed text-content-muted">
            建议先「测试连接」确认可达再保存。仅支持远程 HTTP/SSE 服务；鉴权 Header 值加密存储、永不回显。
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* 头部说明 + 添加入口 */}
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs leading-relaxed text-content-secondary">
          接入远程 MCP 服务，为其工具赋予 AI 调用能力（配置后对所有对话生效，AI 按需调用）。
        </p>
        <button
          type="button"
          onClick={() => setShowForm(true)}
          className="flex shrink-0 items-center gap-1 rounded-lg border border-line/60 bg-surface px-2.5 py-1.5 text-xs text-content-secondary hover:bg-surface-subtle transition-colors"
        >
          <Plus className="w-3.5 h-3.5" /> 添加服务
        </button>
      </div>

      {/* 列表 */}
      {isLoading ? (
        <div className="flex items-center justify-center py-8 text-content-muted">
          <Loader2 className="w-4 h-4 animate-spin" />
        </div>
      ) : error ? (
        <div className="flex items-center gap-1.5 rounded-lg border border-red-500/20 bg-red-500/5 px-2.5 py-2 text-xs text-red-500">
          <TriangleAlert className="w-3.5 h-3.5" /> 加载失败：{errText(error)}
        </div>
      ) : !servers || servers.servers.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line/60 py-8 text-center">
          <Plug className="w-5 h-5 text-content-muted" />
          <p className="text-xs text-content-secondary">还没有添加 MCP 服务</p>
          <p className="max-w-xs text-[10px] leading-relaxed text-content-muted">
            可尝试免费公开服务（如 Wikipedia 查询、DeepWiki 仓库问答），或带 Key 的服务（高德地图、Tavily 等）。
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {servers.servers.map((server) => (
            <div
              key={server.id}
              className="flex items-center gap-2.5 rounded-xl border border-line/60 bg-surface-muted px-3 py-2.5"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                <Plug className="w-3.5 h-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-medium text-content-primary">{server.name}</span>
                  {!server.enabled && (
                    <span className="shrink-0 rounded bg-line-strong/40 px-1 py-px text-[9px] text-content-muted">已停用</span>
                  )}
                </div>
                <p className="truncate text-[10px] text-content-muted" title={server.url}>
                  {shortUrl(server.url)}
                </p>
              </div>
              {togglingId === server.id ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-content-muted" />
              ) : (
                <MiniSwitch on={server.enabled} onClick={() => handleToggle(server)} />
              )}
              <button
                type="button"
                onClick={() => handleDelete(server)}
                className={cn(
                  'flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[11px] transition-colors',
                  confirmDeleteId === server.id
                    ? 'bg-red-500/10 text-red-500'
                    : 'text-content-muted hover:text-red-500'
                )}
              >
                <Trash2 className="w-3.5 h-3.5" />
                {confirmDeleteId === server.id ? '确认删除' : ''}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 一键预置：只列尚未添加的 */}
      {!isLoading && !error && (() => {
        const existing = new Set((servers?.servers ?? []).map((s) => s.url.replace(/\/+$/, '')))
        const pending = MCP_PRESETS.filter((p) => !existing.has(p.url.replace(/\/+$/, '')))
        if (pending.length === 0) return null
        return (
          <div className="space-y-1.5">
            <p className="text-[11px] font-medium text-content-secondary">推荐服务</p>
            {pending.map((p) => (
              <div
                key={p.url}
                className="flex items-center gap-2.5 rounded-xl border border-dashed border-line/60 px-3 py-2.5"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-surface-muted text-content-secondary">
                  <Plug className="w-3.5 h-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-content-primary">{p.name}</span>
                  <p className="truncate text-[10px] text-content-muted" title={p.blurb}>
                    {p.blurb}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleAddPreset(p)}
                  disabled={addingPreset !== null}
                  className={cn(
                    'flex shrink-0 items-center gap-1 rounded-lg border border-line/60 bg-surface px-2.5 py-1 text-[11px]',
                    'text-content-secondary hover:bg-surface-subtle transition-colors',
                    'disabled:opacity-50 disabled:cursor-not-allowed'
                  )}
                >
                  {addingPreset === p.url ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Plus className="w-3 h-3" />
                  )}
                  一键添加
                </button>
              </div>
            ))}
          </div>
        )
      })()}

      <p className="text-[10px] leading-relaxed text-content-muted">
        MCP 服务为第三方能力，请只添加可信来源；临时聊天与对比模式下不会注入 MCP 工具。
      </p>
    </div>
  )
}
