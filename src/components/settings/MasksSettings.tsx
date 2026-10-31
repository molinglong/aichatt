'use client'

/**
 * 设置 → 面具管理：
 * - 自定义面具 CRUD（列表 / 新增 / 编辑 / 删除，删除时自动清引用会话）
 * - 面具面板：新面具 / 面具库长尾需下载后才出现在选择器，可卸载
 * - 精选内置面具只读展示 + 一键「复制为自定义」再改
 * 数据源：GET/POST /api/masks + PATCH/DELETE /api/masks/[id]
 *        + GET/POST /api/masks/installed + DELETE /api/masks/installed?maskId=
 */
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Pencil, Trash2, Copy, Loader2, VenetianMask, AlertCircle, ArrowLeft, MessageSquarePlus, User, Download, Check, Search } from 'lucide-react'
import { fetchJson, HttpError } from '@/lib/query/fetcher'
import { queryKeys, STALE } from '@/lib/query/keys'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { BUILTIN_MASKS } from '@/lib/ai/builtin-masks'
import { BUILTIN_MASK_STORE, DOWNLOADABLE_MASKS } from '@/lib/ai/builtin-masks-store'
import { STYLE_PRESETS } from '@/lib/ai/style-presets'
import { maskInputSchema, type MaskDTO, type MaskFewShotTurn } from '@/lib/ai/mask-types'
import { confirmDialog } from '@/components/ui/ConfirmDialog'

interface MaskFormState {
  rowId: string | null // null = 新建；非 null = 编辑该裸 cuid
  name: string
  avatar: string
  description: string
  systemPrompt: string
  fewShot: MaskFewShotTurn[]
  stylePreset: string // '' = 不指定
}

const EMPTY_FORM: MaskFormState = {
  rowId: null,
  name: '',
  avatar: '🎭',
  description: '',
  systemPrompt: '',
  fewShot: [],
  stylePreset: '',
}

/** 新面具（BUILTIN_MASK_STORE）在面板里打「新」标；其余可下载项来自早期面具库 */
const STORE_IDS = new Set(BUILTIN_MASK_STORE.map((m) => m.id))

const INPUT_CLS = cn(
  'w-full rounded-lg border px-2.5 py-1.5 text-xs',
  'border-line/60',
  'bg-surface',
  'text-content-primary',
  'placeholder:text-content-muted',
  'focus:outline-none focus:ring-2 focus:ring-accent/30',
  'focus:border-accent transition-all'
)

function errText(e: unknown): string {
  if (e instanceof HttpError) return e.message
  if (e instanceof Error) return e.message
  return '未知错误'
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

export default function MasksSettings() {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<MaskFormState | null>(null) // null = 列表视图
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const { data: masks, isLoading, error } = useQuery({
    queryKey: queryKeys.masks.list(),
    queryFn: () => fetchJson<MaskDTO[]>('/api/masks'),
    staleTime: STALE.masks,
  })

  // 面具面板：已下载的内置面具 id
  const { data: installedData, isLoading: installedLoading, error: installedError } = useQuery({
    queryKey: queryKeys.masks.installed(),
    queryFn: () => fetchJson<{ maskIds: string[] }>('/api/masks/installed'),
    staleTime: STALE.masks,
  })
  const installedSet = new Set(installedData?.maskIds ?? [])
  const [catalogQuery, setCatalogQuery] = useState('')
  const [installingId, setInstallingId] = useState<string | null>(null)
  const [uninstallingId, setUninstallingId] = useState<string | null>(null)

  async function invalidate() {
    await queryClient.invalidateQueries({ queryKey: queryKeys.masks.list() })
  }

  async function invalidateInstalled() {
    await queryClient.invalidateQueries({ queryKey: queryKeys.masks.installed() })
  }

  async function handleInstall(maskId: string, name: string) {
    setInstallingId(maskId)
    try {
      await fetchJson<{ ok: boolean }>('/api/masks/installed', {
        method: 'POST',
        json: { maskId },
      })
      toast.success(`已下载「${name}」，可在聊天选择器中选用`)
      await invalidateInstalled()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setInstallingId(null)
    }
  }

  async function handleUninstall(maskId: string, name: string) {
    if (
      !(await confirmDialog({
        title: '卸载面具',
        message: `确定从面具面板卸载「${name}」吗？`,
        detail: '卸载后聊天选择器里不再显示；已经使用它的对话仍可正常继续。',
        danger: true,
        okText: '卸载',
      }))
    )
      return
    setUninstallingId(maskId)
    try {
      await fetchJson<{ ok: boolean }>(`/api/masks/installed?maskId=${encodeURIComponent(maskId)}`, {
        method: 'DELETE',
      })
      toast.hint(`已卸载「${name}」`)
      await invalidateInstalled()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setUninstallingId(null)
    }
  }

  async function handleSave() {
    if (!form) return
    const payload = {
      name: form.name,
      avatar: form.avatar,
      description: form.description,
      systemPrompt: form.systemPrompt,
      fewShot: form.fewShot.length > 0 ? form.fewShot : undefined,
      stylePreset: form.stylePreset || null,
    }
    const parsed = maskInputSchema.safeParse(payload)
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? '输入不合法')
      return
    }
    setSaving(true)
    try {
      if (form.rowId) {
        await fetchJson<MaskDTO>(`/api/masks/${form.rowId}`, { method: 'PATCH', json: parsed.data })
        toast.success('面具已更新')
      } else {
        await fetchJson<MaskDTO>('/api/masks', { method: 'POST', json: parsed.data })
        toast.success('面具已创建')
      }
      await invalidate()
      setForm(null)
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(m: MaskDTO) {
    if (!(await confirmDialog({ title: '删除面具', message: `确定删除面具「${m.name}」吗？`, detail: '引用它的会话会自动恢复为无面具。', danger: true, okText: '删除' }))) return
    setDeletingId(m.rowId)
    try {
      await fetchJson<{ ok: boolean }>(`/api/masks/${m.rowId}`, { method: 'DELETE' })
      toast.hint('已删除')
      await invalidate()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setDeletingId(null)
    }
  }

  function handleCopyBuiltin(id: string) {
    const m = BUILTIN_MASKS.find((b) => b.id === id)
    if (!m) return
    setForm({
      rowId: null,
      name: `${m.name}（我的）`,
      avatar: m.avatar,
      description: m.description,
      systemPrompt: m.systemPrompt,
      fewShot: m.fewShot.map((t) => ({ role: t.role, content: t.content })),
      stylePreset: m.stylePreset ?? '',
    })
  }

  /* ---------------- 表单视图 ---------------- */
  if (form) {
    const set = <K extends keyof MaskFormState>(k: K, v: MaskFormState[K]) => setForm({ ...form, [k]: v })
    return (
      <div className="space-y-3">
        <button
          onClick={() => setForm(null)}
          className="flex items-center gap-1.5 text-[11px] text-content-muted hover:text-content-primary transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          返回列表
        </button>

        <div className="rounded-xl border border-line/60 bg-surface p-3 space-y-3">
          {/* 头像 + 名称 */}
          <div className="flex items-start gap-3">
            <div className="shrink-0 space-y-1">
              <div className="w-11 h-11 rounded-lg border border-line/60 bg-surface-subtle/60 flex items-center justify-center text-2xl">
                {form.avatar || '🎭'}
              </div>
              <input
                value={form.avatar}
                onChange={(e) => set('avatar', e.target.value.slice(0, 4))}
                className={cn(INPUT_CLS, 'text-center text-sm px-1')}
                placeholder="🎭"
                aria-label="头像 emoji"
              />
            </div>
            <div className="flex-1 space-y-2">
              <input
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                className={INPUT_CLS}
                placeholder="面具名称（必填，最多 30 字）"
                maxLength={30}
              />
              <input
                value={form.description}
                onChange={(e) => set('description', e.target.value)}
                className={INPUT_CLS}
                placeholder="一句话定位（选填，最多 50 字）"
                maxLength={50}
              />
            </div>
          </div>

          {/* 人格指令 */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-content-secondary">人格指令 systemPrompt（注入到 system 最前面）</label>
            <textarea
              value={form.systemPrompt}
              onChange={(e) => set('systemPrompt', e.target.value)}
              className={cn(INPUT_CLS, 'font-mono leading-relaxed resize-y min-h-[140px]')}
              placeholder={'## 人格：…\n你是一名…（描述人格、语气、边界）'}
              maxLength={8000}
              rows={8}
            />
            <div className="text-right text-[10px] text-content-muted">{form.systemPrompt.length} / 8000</div>
          </div>

          {/* few-shot 编辑器 */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-[11px] font-medium text-content-secondary">示例对话 few-shot（选填，最多 8 轮）</label>
              <button
                onClick={() => set('fewShot', [...form.fewShot, { role: 'user', content: '' }])}
                disabled={form.fewShot.length >= 8}
                className="flex items-center gap-1 text-[11px] text-accent hover:underline disabled:opacity-40 disabled:no-underline"
              >
                <MessageSquarePlus className="w-3 h-3" />
                添加一轮
              </button>
            </div>
            {form.fewShot.length === 0 && (
              <p className="text-[10px] text-content-muted">给 AI 2-3 轮示例，能稳定锚定回复格式与语气（比纯描述更有效）。</p>
            )}
            <div className="space-y-2">
              {form.fewShot.map((turn, i) => (
                <div key={i} className="flex items-start gap-1.5 rounded-lg border border-line/40 bg-surface-subtle/40 p-2">
                  <button
                    onClick={() => {
                      const next = [...form.fewShot]
                      next[i] = { ...turn, role: turn.role === 'user' ? 'assistant' : 'user' }
                      set('fewShot', next)
                    }}
                    className={cn(
                      'shrink-0 mt-0.5 flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-medium transition-colors',
                      turn.role === 'user'
                        ? 'bg-surface-subtle/80 text-content-secondary'
                        : 'bg-accent/10 text-accent'
                    )}
                    title="点击切换角色"
                  >
                    {turn.role === 'user' ? (
                      <>
                        <User className="w-3 h-3" />
                        用户
                      </>
                    ) : (
                      <>
                        <VenetianMask className="w-3 h-3" />
                        AI
                      </>
                    )}
                  </button>
                  <textarea
                    value={turn.content}
                    onChange={(e) => {
                      const next = [...form.fewShot]
                      next[i] = { ...turn, content: e.target.value }
                      set('fewShot', next)
                    }}
                    className={cn(INPUT_CLS, 'resize-y min-h-[52px]')}
                    placeholder={turn.role === 'user' ? '用户说…' : 'AI 应答…'}
                    maxLength={2000}
                    rows={2}
                  />
                  <button
                    onClick={() => set('fewShot', form.fewShot.filter((_, j) => j !== i))}
                    className="shrink-0 mt-0.5 p-1 rounded-md text-content-muted hover:text-red-500 hover:bg-red-500/10 transition-colors"
                    title="删除这一轮"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* 默认风格 */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-content-secondary">默认对话风格（选填）</label>
            <select value={form.stylePreset} onChange={(e) => set('stylePreset', e.target.value)} className={INPUT_CLS}>
              <option value="">不指定（跟随会话设置）</option>
              {STYLE_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}（{p.tagline}）
                </option>
              ))}
            </select>
          </div>

          {/* 保存/取消 */}
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-xs font-medium text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              {form.rowId ? '保存修改' : '创建面具'}
            </button>
            <button
              onClick={() => setForm(null)}
              disabled={saving}
              className="rounded-lg border border-line/60 px-3.5 py-1.5 text-xs text-content-secondary hover:bg-surface-subtle/60 transition-colors disabled:opacity-50"
            >
              取消
            </button>
          </div>
        </div>
      </div>
    )
  }

  /* ---------------- 列表视图 ---------------- */
  const catalogQ = catalogQuery.trim().toLowerCase()
  const catalogRows = catalogQ
    ? DOWNLOADABLE_MASKS.filter(
        (m) =>
          m.name.toLowerCase().includes(catalogQ) ||
          m.description.toLowerCase().includes(catalogQ)
      )
    : DOWNLOADABLE_MASKS
  const installedCount = DOWNLOADABLE_MASKS.filter((m) => installedSet.has(m.id)).length

  return (
    <div className="space-y-3">
      {/* 自定义面具 */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between px-0.5 py-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] font-medium text-content-secondary">我的面具</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-subtle/80 text-content-muted font-mono shrink-0">
              {masks?.length ?? 0}
            </span>
          </div>
          <button
            onClick={() => setForm({ ...EMPTY_FORM })}
            className="flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1 text-[11px] font-medium text-accent-foreground transition-opacity hover:opacity-90"
          >
            <Plus className="w-3 h-3" />
            新增面具
          </button>
        </div>

        {isLoading && (
          <div className="flex items-center gap-2 rounded-xl border border-line/60 bg-surface p-4 text-xs text-content-muted">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            加载中…
          </div>
        )}
        {error && (
          <div className="flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-600 dark:text-red-400">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            加载失败：{errText(error)}
          </div>
        )}
        {!isLoading && !error && (masks?.length ?? 0) === 0 && (
          <div className="rounded-xl border border-dashed border-line/60 bg-surface p-6 text-center">
            <VenetianMask className="w-6 h-6 mx-auto text-content-muted mb-2" />
            <p className="text-xs text-content-muted">还没有自定义面具。点击「新增面具」创建，或从下方面具面板下载、从内置面具复制一份来改。</p>
          </div>
        )}
        <div className="space-y-2">
          {(masks ?? []).map((m) => (
            <div key={m.id} className="enter-pop">
              <div className="flex items-center gap-3 rounded-xl border border-line/60 bg-surface p-3">
                <span className="text-2xl leading-none shrink-0" aria-hidden>
                  {m.avatar}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-content-primary truncate">{m.name}</span>
                    <span className="text-[10px] text-content-muted shrink-0">{fmtDate(m.updatedAt)}</span>
                  </div>
                  <p className="text-[11px] text-content-muted truncate">{m.description || '（无描述）'}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() =>
                      setForm({
                        rowId: m.rowId,
                        name: m.name,
                        avatar: m.avatar,
                        description: m.description,
                        systemPrompt: m.systemPrompt,
                        fewShot: m.fewShot,
                        stylePreset: m.stylePreset ?? '',
                      })
                    }
                    className="p-1.5 rounded-md text-content-muted hover:text-accent hover:bg-accent/10 transition-colors"
                    title="编辑"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleDelete(m)}
                    disabled={deletingId === m.rowId}
                    className="p-1.5 rounded-md text-content-muted hover:text-red-500 hover:bg-red-500/10 transition-colors disabled:opacity-40"
                    title="删除"
                  >
                    {deletingId === m.rowId ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 面具面板：新面具 / 面具库需下载后才会出现在聊天选择器 */}
      <div className="space-y-1.5 pt-1">
        <div className="flex items-center justify-between gap-2 px-0.5 py-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-[11px] font-medium text-content-secondary">面具面板</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-subtle/80 text-content-muted font-mono shrink-0">
              已下载 {installedCount}/{DOWNLOADABLE_MASKS.length}
            </span>
          </div>
        </div>
        <p className="px-0.5 text-[10px] text-content-muted leading-relaxed">
          新面具先在这里下载，之后才会出现在聊天选择器；下载的内置面具随版本更新，无需重复下载。
        </p>
        <div className="relative">
          <Search
            className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-content-muted pointer-events-none"
            aria-hidden
          />
          <input
            value={catalogQuery}
            onChange={(e) => setCatalogQuery(e.target.value)}
            placeholder="搜索面具面板..."
            className={cn(INPUT_CLS, 'pl-8')}
            aria-label="搜索面具面板"
          />
        </div>

        {installedError && (
          <div className="flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-600 dark:text-red-400">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            下载状态加载失败：{errText(installedError)}
          </div>
        )}
        {installedLoading && (
          <div className="flex items-center gap-2 rounded-xl border border-line/60 bg-surface p-4 text-xs text-content-muted">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            加载面具面板…
          </div>
        )}
        {!installedLoading && !installedError && catalogRows.length === 0 && (
          <div className="rounded-xl border border-dashed border-line/60 bg-surface p-5 text-center text-xs text-content-muted">
            没有匹配的面具
          </div>
        )}
        {!installedLoading && !installedError && catalogRows.length > 0 && (
          <div className="space-y-2">
            {catalogRows.map((m) => {
              const installed = installedSet.has(m.id)
              const busy = installingId === m.id || uninstallingId === m.id
              return (
                <div
                  key={m.id}
                  data-mask-id={m.id}
                  data-installed={installed ? '1' : '0'}
                  className="flex items-center gap-3 rounded-xl border border-line/60 bg-surface p-3"
                >
                  <span className="text-2xl leading-none shrink-0" aria-hidden>
                    {m.avatar}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium text-content-primary truncate">{m.name}</span>
                      {STORE_IDS.has(m.id) ? (
                        <span className="shrink-0 rounded-full bg-accent/10 px-1.5 py-0.5 text-[9px] font-medium text-accent">
                          新
                        </span>
                      ) : (
                        <span className="shrink-0 rounded-full bg-surface-subtle/80 px-1.5 py-0.5 text-[9px] text-content-muted">
                          面具库
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-content-muted truncate">{m.description}</p>
                  </div>
                  {installed ? (
                    <button
                      onClick={() => handleUninstall(m.id, m.name)}
                      disabled={busy}
                      className="flex items-center gap-1 shrink-0 rounded-lg border border-line/60 px-2 py-1 text-[11px] text-content-secondary transition-colors hover:border-red-500/30 hover:text-red-500 disabled:opacity-50"
                      title="点击卸载"
                    >
                      {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                      已下载
                    </button>
                  ) : (
                    <button
                      onClick={() => handleInstall(m.id, m.name)}
                      disabled={busy}
                      className="flex items-center gap-1 shrink-0 rounded-lg bg-accent px-2.5 py-1 text-[11px] font-medium text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                      {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                      下载
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* 内置面具（只读 + 复制） */}
      <div className="space-y-1.5 pt-1">
        <div className="px-0.5 py-1">
          <span className="text-[11px] font-medium text-content-secondary">内置面具（只读，可复制一份来自定义）</span>
        </div>
        <div className="space-y-2">
          {BUILTIN_MASKS.map((m) => (
            <div key={m.id} className="flex items-center gap-3 rounded-xl border border-line/40 bg-surface-subtle/30 p-3">
              <span className="text-2xl leading-none shrink-0" aria-hidden>
                {m.avatar}
              </span>
              <div className="min-w-0 flex-1">
                <span className="text-xs font-medium text-content-primary truncate block">{m.name}</span>
                <p className="text-[11px] text-content-muted truncate">{m.description}</p>
              </div>
              <button
                onClick={() => handleCopyBuiltin(m.id)}
                className="flex items-center gap-1 shrink-0 rounded-md px-2 py-1 text-[11px] text-content-secondary hover:text-accent hover:bg-accent/10 transition-colors"
                title="复制为自定义面具"
              >
                <Copy className="w-3 h-3" />
                复制为自定义
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
