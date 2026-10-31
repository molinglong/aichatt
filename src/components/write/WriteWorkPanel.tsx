'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { BookMarked, Check, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react'
import { fetchJson } from '@/lib/query/fetcher'
import { queryKeys } from '@/lib/query/keys'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  MAX_SETTING_CONTENT_CHARS,
  WORK_SETTING_CATEGORIES,
  buildFullSettingsBlock,
  categoryLabel,
} from '@/lib/write/work-settings'
import type { WorkSettingItem, WorkSummary, WriteDocSummary } from './types'

interface WriteWorkPanelProps {
  /** 当前打开的文档(归属 CTA 与「已归入」状态用;null 表示未打开任何文档) */
  activeDoc: WriteDocSummary | null
}

const INPUT_CLS =
  'w-full rounded-lg border border-line/60 bg-surface px-2 py-1.5 text-xs text-content-primary outline-none focus:ring-2 focus:ring-line-strong/30 placeholder:text-content-muted'

/** 人物卡模板:分类选「人物」且正文为空时可一键填入,引导结构化写法 */
const CHARACTER_TEMPLATE = `身份：
外貌：
性格：
说话习惯/口头禅：
人际关系：
当前状态与目标：`

interface Draft {
  category: string
  title: string
  aliases: string
  content: string
}

const EMPTY_DRAFT: Draft = { category: 'character', title: '', aliases: '', content: '' }

/**
 * 作品设定面板(/write 左栏「设定」Tab)。
 * 作品 = 长篇上下文容器:设定条目挂作品层,生成时按预算注入(见 lib/write/work-settings.ts),
 * 解跨章吃书。本面板管:选/建作品、文档归属、条目增删改与开关、注入量预估。
 */
export function WriteWorkPanel({ activeDoc }: WriteWorkPanelProps) {
  const queryClient = useQueryClient()

  const worksQuery = useQuery({
    queryKey: queryKeys.write.works(),
    queryFn: () => fetchJson<{ works: WorkSummary[] }>('/api/write/works'),
    staleTime: 30_000,
  })
  const works = worksQuery.data?.works ?? []
  const worksPending = worksQuery.isPending

  const [selectedWorkId, setSelectedWorkId] = useState<string | null>(null)
  const selected = works.find((w) => w.id === selectedWorkId) ?? null

  // 选中默认/跟随:当前文档归属的作品优先,否则第一部;所选作品被删则回退
  useEffect(() => {
    if (works.length === 0) return
    if (selectedWorkId && works.some((w) => w.id === selectedWorkId)) return
    const docWorkId = activeDoc?.workId ?? null
    setSelectedWorkId(docWorkId && works.some((w) => w.id === docWorkId) ? docWorkId : works[0].id)
  }, [works, selectedWorkId, activeDoc?.workId])

  const workIdForQuery = selectedWorkId ?? ''
  const settingsQuery = useQuery({
    queryKey: queryKeys.write.settings(workIdForQuery),
    queryFn: () =>
      fetchJson<{ settings: WorkSettingItem[] }>(`/api/write/works/${workIdForQuery}/settings`),
    enabled: !!selectedWorkId,
    staleTime: 30_000,
  })
  const settings = settingsQuery.data?.settings ?? []

  /** 注入量预估:与服务端同一份引擎,面板所见即实际拼装结果 */
  const stats = useMemo(() => {
    if (!selected) return null
    return buildFullSettingsBlock(
      { title: selected.title, description: selected.description },
      settings
    )
  }, [selected, settings])
  const enabledCount = settings.filter((s) => s.enabled && s.content.trim()).length

  // —— 新建作品 ——
  const [newWorkOpen, setNewWorkOpen] = useState(false)
  const [newWorkTitle, setNewWorkTitle] = useState('')
  const [creatingWork, setCreatingWork] = useState(false)

  async function handleCreateWork() {
    if (creatingWork) return
    setCreatingWork(true)
    try {
      const work = await fetchJson<WorkSummary>('/api/write/works', {
        method: 'POST',
        json: { title: newWorkTitle },
      })
      queryClient.invalidateQueries({ queryKey: queryKeys.write.works() })
      setSelectedWorkId(work.id)
      setNewWorkOpen(false)
      setNewWorkTitle('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '新建作品失败', { title: '作品设定' })
    } finally {
      setCreatingWork(false)
    }
  }

  async function handleToggleWorkEnabled() {
    if (!selected) return
    try {
      await fetchJson(`/api/write/works/${selected.id}`, {
        method: 'PATCH',
        json: { settingsEnabled: !selected.settingsEnabled },
      })
      queryClient.invalidateQueries({ queryKey: queryKeys.write.works() })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '开关失败', { title: '作品设定' })
    }
  }

  /** 删除作品(两段式确认):设定级联删除,文档仅解除归属不删正文 */
  const [confirmingWorkDel, setConfirmingWorkDel] = useState(false)

  async function handleDeleteWork() {
    if (!selected) return
    if (!confirmingWorkDel) {
      setConfirmingWorkDel(true)
      setTimeout(() => setConfirmingWorkDel(false), 3000)
      return
    }
    setConfirmingWorkDel(false)
    try {
      await fetchJson(`/api/write/works/${selected.id}`, { method: 'DELETE' })
      queryClient.invalidateQueries({ queryKey: queryKeys.write.works() })
      queryClient.invalidateQueries({ queryKey: queryKeys.write.list() })
      setSelectedWorkId(null)
      toast.success('作品已删除(文档保留,已解除归属)', { title: '作品设定' })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败', { title: '作品设定' })
    }
  }

  // —— 文档归属 ——
  const [assigning, setAssigning] = useState(false)

  async function handleAssignDoc(workId: string | null) {
    if (!activeDoc || assigning) return
    setAssigning(true)
    try {
      await fetchJson(`/api/write/docs/${activeDoc.id}`, { method: 'PATCH', json: { workId } })
      queryClient.invalidateQueries({ queryKey: queryKeys.write.list() })
      queryClient.invalidateQueries({ queryKey: queryKeys.write.works() })
      toast.success(workId ? '已归入作品' : '已移出作品', { title: '作品设定' })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败', { title: '作品设定' })
    } finally {
      setAssigning(false)
    }
  }

  // —— 条目编辑(editingId: null 关闭 / 'new' 新建 / 其余为条目 id) ——
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)
  /** 两段式删除确认:3s 未确认自动复位 */
  const [confirmingId, setConfirmingId] = useState<string | null>(null)

  function openNew() {
    setEditingId('new')
    setDraft(EMPTY_DRAFT)
  }

  function openEdit(s: WorkSettingItem) {
    setEditingId(s.id)
    setDraft({ category: s.category, title: s.title, aliases: s.aliases, content: s.content })
  }

  async function handleSave() {
    if (!selected || saving || editingId === null) return
    if (!draft.title.trim()) {
      toast.error('标题不能为空', { title: '作品设定' })
      return
    }
    setSaving(true)
    try {
      const url =
        editingId === 'new'
          ? `/api/write/works/${selected.id}/settings`
          : `/api/write/works/${selected.id}/settings/${editingId}`
      await fetchJson(url, { method: editingId === 'new' ? 'POST' : 'PATCH', json: draft })
      queryClient.invalidateQueries({ queryKey: queryKeys.write.settings(selected.id) })
      if (editingId === 'new') queryClient.invalidateQueries({ queryKey: queryKeys.write.works() })
      setEditingId(null)
      setDraft(EMPTY_DRAFT)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败', { title: '作品设定' })
    } finally {
      setSaving(false)
    }
  }

  async function handleToggleSetting(s: WorkSettingItem) {
    if (!selected) return
    try {
      await fetchJson(`/api/write/works/${selected.id}/settings/${s.id}`, {
        method: 'PATCH',
        json: { enabled: !s.enabled },
      })
      queryClient.invalidateQueries({ queryKey: queryKeys.write.settings(selected.id) })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '开关失败', { title: '作品设定' })
    }
  }

  async function handleDeleteSetting(id: string) {
    if (!selected) return
    if (confirmingId !== id) {
      setConfirmingId(id)
      setTimeout(() => setConfirmingId((cur) => (cur === id ? null : cur)), 3000)
      return
    }
    setConfirmingId(null)
    try {
      await fetchJson(`/api/write/works/${selected.id}/settings/${id}`, { method: 'DELETE' })
      queryClient.invalidateQueries({ queryKey: queryKeys.write.settings(selected.id) })
      queryClient.invalidateQueries({ queryKey: queryKeys.write.works() })
      if (editingId === id) setEditingId(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败', { title: '作品设定' })
    }
  }

  // 按分类优先级分组展示(仅含有条目的分组)
  const grouped = WORK_SETTING_CATEGORIES.map((c) => ({
    ...c,
    items: settings.filter((s) => s.category === c.key),
  })).filter((g) => g.items.length > 0)

  return (
    <div className="h-full flex flex-col">
      {/* 作品选择 + 新建 */}
      <div className="p-2.5 border-b border-line space-y-2">
        {works.length > 0 && (
          <div className="flex items-center gap-1.5">
            <select
              value={selectedWorkId ?? ''}
              onChange={(e) => setSelectedWorkId(e.target.value)}
              className={cn(INPUT_CLS, 'flex-1 min-w-0')}
              aria-label="选择作品"
            >
              {works.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.title}
                </option>
              ))}
            </select>
            <button
              onClick={() => setNewWorkOpen(true)}
              title="新建作品"
              aria-label="新建作品"
              className="shrink-0 p-1.5 rounded-lg border border-line/60 text-content-muted
                hover:text-content-primary hover:bg-surface-subtle transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        {newWorkOpen && (
          <div className="space-y-1.5">
            <input
              autoFocus
              value={newWorkTitle}
              onChange={(e) => setNewWorkTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreateWork()
                if (e.key === 'Escape') setNewWorkOpen(false)
              }}
              placeholder="作品名(如:星海纪元)"
              className={INPUT_CLS}
            />
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => void handleCreateWork()}
                disabled={creatingWork}
                className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg text-[11px] font-medium
                  bg-accent text-accent-foreground hover:bg-accent/90 disabled:opacity-60 transition-colors"
              >
                {creatingWork ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                创建
              </button>
              <button
                onClick={() => setNewWorkOpen(false)}
                className="flex-1 py-1.5 rounded-lg text-[11px] border border-line/60 text-content-secondary
                  hover:bg-surface-subtle transition-colors"
              >
                取消
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 主体 */}
      <div className="flex-1 overflow-y-auto overscroll-contain p-2.5 space-y-2.5">
        {worksPending ? (
          <div className="space-y-2">
            {[0, 1].map((i) => (
              <div key={i} className="h-16 rounded-xl bg-surface-muted animate-pulse" />
            ))}
          </div>
        ) : !selected ? (
          <div className="p-6 text-center">
            <div className="w-10 h-10 mx-auto rounded-xl bg-surface-subtle flex items-center justify-center">
              <BookMarked className="w-4 h-4 text-content-muted" />
            </div>
            <div className="mt-2.5 text-xs text-content-secondary font-medium">还没有作品</div>
            <p className="mt-1.5 text-[11px] text-content-muted leading-relaxed">
              作品用来收纳设定(大纲、人物卡、力量体系),
              续写与聊天时 AI 会自动遵守,防止长篇跨章吃书。
            </p>
            <button
              onClick={() => setNewWorkOpen(true)}
              className="mt-3 inline-flex items-center gap-1.5 px-3 h-8 rounded-lg text-[11px] font-medium
                bg-accent text-accent-foreground hover:bg-accent/90 transition-colors"
            >
              <Plus className="w-3 h-3" />
              新建作品
            </button>
          </div>
        ) : (
          <>
            {/* 作品卡片 */}
            <div className="rounded-xl border border-line/60 bg-surface-subtle/40 p-2.5 space-y-2">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium text-content-primary truncate">{selected.title}</div>
                  <div className="text-[10px] text-content-muted mt-0.5">
                    {selected.settingCount} 条设定 · {selected.docCount} 篇文档
                  </div>
                </div>
                <button
                  role="switch"
                  aria-checked={selected.settingsEnabled}
                  aria-label="设定注入开关"
                  onClick={() => void handleToggleWorkEnabled()}
                  className={cn(
                    'relative w-8 h-[18px] rounded-full transition-colors duration-base ease-standard shrink-0',
                    selected.settingsEnabled ? 'bg-accent' : 'bg-surface-subtle'
                  )}
                >
                  <span
                    className={cn(
                      'absolute top-[2px] left-[2px] w-[14px] h-[14px] rounded-full bg-white dark:bg-surface transition-transform duration-base ease-standard',
                      selected.settingsEnabled && 'translate-x-[14px]'
                    )}
                  />
                </button>
                <button
                  onClick={() => void handleDeleteWork()}
                  aria-label={confirmingWorkDel ? '再次点击确认删除作品' : '删除作品'}
                  title={confirmingWorkDel ? '再次点击确认删除作品(文档保留)' : '删除作品'}
                  className={cn(
                    'shrink-0 p-1 rounded transition-colors',
                    confirmingWorkDel ? 'text-red-400' : 'text-content-muted hover:text-red-400'
                  )}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="text-[10px] text-content-muted">
                {!selected.settingsEnabled
                  ? '注入已关闭,设定不会被发送给模型'
                  : enabledCount > 0
                    ? `启用 ${enabledCount} 条 · 生成时注入约 ${stats?.chars ?? 0} 字`
                    : '暂无启用中的设定内容,添加并启用条目后生效'}
              </div>

              {/* 当前文档归属 */}
              {activeDoc ? (
                activeDoc.workId === selected.id ? (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] text-content-muted truncate">
                      当前文档《{activeDoc.title}》已归入
                    </span>
                    <button
                      onClick={() => void handleAssignDoc(null)}
                      disabled={assigning}
                      className="shrink-0 text-[10px] text-content-muted hover:text-content-primary transition-colors"
                    >
                      移出
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => void handleAssignDoc(selected.id)}
                    disabled={assigning}
                    className="w-full flex items-center justify-center gap-1 py-1.5 rounded-lg text-[10px]
                      border border-line/60 text-content-secondary hover:bg-surface-subtle
                      disabled:opacity-60 transition-colors"
                  >
                    {assigning && <Loader2 className="w-3 h-3 animate-spin" />}
                    把当前文档《{activeDoc.title}》归入本作品
                  </button>
                )
              ) : (
                <div className="text-[10px] text-content-muted">打开一篇文档后可将其归入本作品</div>
              )}
            </div>

            {/* 新增条目 */}
            <button
              onClick={openNew}
              className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[11px] font-medium
                border border-dashed border-line-strong/60 text-content-secondary hover:bg-surface-subtle transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              新增设定
            </button>

            {/* 编辑表单 */}
            {editingId !== null && (
              <div className="rounded-xl border border-line bg-surface p-2.5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-content-primary">
                    {editingId === 'new' ? '新增设定' : '编辑设定'}
                  </span>
                  <button
                    onClick={() => setEditingId(null)}
                    aria-label="关闭编辑"
                    className="p-0.5 rounded text-content-muted hover:text-content-primary transition-colors"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <select
                    value={draft.category}
                    onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))}
                    className={INPUT_CLS}
                    aria-label="分类"
                  >
                    {WORK_SETTING_CATEGORIES.map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                  <input
                    value={draft.title}
                    onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                    placeholder="标题,如「林渊」"
                    className={INPUT_CLS}
                  />
                </div>
                <input
                  value={draft.aliases}
                  onChange={(e) => setDraft((d) => ({ ...d, aliases: e.target.value }))}
                  placeholder="别名,顿号分隔(聊天提及时会命中)"
                  className={INPUT_CLS}
                />
                <textarea
                  value={draft.content}
                  onChange={(e) => setDraft((d) => ({ ...d, content: e.target.value }))}
                  rows={6}
                  placeholder="设定正文…"
                  className={cn(INPUT_CLS, 'resize-y leading-relaxed')}
                />
                {draft.category === 'character' && draft.content.trim() === '' && (
                  <button
                    onClick={() => setDraft((d) => ({ ...d, content: CHARACTER_TEMPLATE }))}
                    className="text-[10px] text-accent hover:underline"
                  >
                    填入人物卡模板
                  </button>
                )}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] text-content-muted">
                    {draft.content.length}/{MAX_SETTING_CONTENT_CHARS}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setEditingId(null)}
                      className="px-2.5 py-1 rounded-lg text-[11px] border border-line/60 text-content-secondary
                        hover:bg-surface-subtle transition-colors"
                    >
                      取消
                    </button>
                    <button
                      onClick={() => void handleSave()}
                      disabled={saving}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium
                        bg-accent text-accent-foreground hover:bg-accent/90 disabled:opacity-60 transition-colors"
                    >
                      {saving && <Loader2 className="w-3 h-3 animate-spin" />}
                      保存
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* 条目列表(按分类优先级分组) */}
            {settingsQuery.isPending ? (
              <div className="space-y-2">
                {[0, 1].map((i) => (
                  <div key={i} className="h-14 rounded-xl bg-surface-muted animate-pulse" />
                ))}
              </div>
            ) : settings.length === 0 ? (
              <div className="p-4 text-center text-[11px] text-content-muted leading-relaxed">
                还没有设定条目
                <br />
                先加一条大纲或人物卡,续写时 AI 就会自动遵守
              </div>
            ) : (
              grouped.map((g) => (
                <div key={g.key} className="space-y-1.5">
                  <div className="text-[10px] font-medium text-content-muted px-0.5">
                    {g.label}
                    <span className="ml-1 opacity-60">{g.items.length}</span>
                  </div>
                  {g.items.map((s) => (
                    <div key={s.id} className="rounded-xl border border-line/60 bg-surface p-2.5 space-y-1.5">
                      <div className="flex items-center gap-1.5">
                        <span className="shrink-0 text-[9px] px-1.5 py-0.5 rounded-full bg-surface-subtle text-content-muted">
                          {categoryLabel(s.category)}
                        </span>
                        <div
                          className={cn(
                            'min-w-0 flex-1 text-xs font-medium truncate',
                            s.enabled ? 'text-content-primary' : 'text-content-muted line-through'
                          )}
                        >
                          {s.title}
                        </div>
                        <button
                          role="switch"
                          aria-checked={s.enabled}
                          aria-label={`${s.title} 启用开关`}
                          onClick={() => void handleToggleSetting(s)}
                          className={cn(
                            'relative w-7 h-4 rounded-full transition-colors duration-base ease-standard shrink-0',
                            s.enabled ? 'bg-accent' : 'bg-surface-subtle'
                          )}
                        >
                          <span
                            className={cn(
                              'absolute top-[2px] left-[2px] w-3 h-3 rounded-full bg-white dark:bg-surface transition-transform duration-base ease-standard',
                              s.enabled && 'translate-x-3'
                            )}
                          />
                        </button>
                      </div>
                      {s.aliases.trim() && (
                        <div className="text-[10px] text-content-muted truncate">别名:{s.aliases}</div>
                      )}
                      {s.content.trim() && (
                        <p
                          className={cn(
                            'text-[11px] leading-relaxed whitespace-pre-wrap break-words line-clamp-2',
                            s.enabled ? 'text-content-secondary' : 'text-content-muted'
                          )}
                        >
                          {s.content}
                        </p>
                      )}
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => openEdit(s)}
                          aria-label="编辑设定"
                          title="编辑"
                          className="p-1 rounded text-content-muted hover:text-content-primary transition-colors"
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                        <button
                          onClick={() => void handleDeleteSetting(s.id)}
                          aria-label={confirmingId === s.id ? '再次点击确认删除' : '删除设定'}
                          title={confirmingId === s.id ? '再次点击确认删除' : '删除'}
                          className={cn(
                            'p-1 rounded transition-colors',
                            confirmingId === s.id
                              ? 'text-red-400'
                              : 'text-content-muted hover:text-red-400'
                          )}
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ))
            )}
          </>
        )}
      </div>
    </div>
  )
}
