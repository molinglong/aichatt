'use client'

import { useState, useRef, useEffect, useCallback, KeyboardEvent, memo } from 'react'
import Link from 'next/link'
import { useRouter, usePathname } from 'next/navigation'
import { Trash2, Pencil, Check, X, GitBranch, Copy, Download, FileJson, Upload } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { downloadConversationBundle } from '@/lib/portable-client'
import { pushBatch, readPushTarget } from '@/lib/portable-push'
import { useChatStore } from '@/store/chat-store'
import { useContextMenuStore, type ContextMenuItem } from '@/store/contextMenuStore'
import { useSingleFlight } from '@/hooks/useSingleFlight'
import { isUnread } from '@/lib/last-read'

interface ConversationItemProps {
  id: string
  title: string
  mode?: string
  /** 会话面具徽标（头像 emoji）；无面具 / 面具已删时不传，不显示 */
  maskAvatar?: string | null
  /** 面具名，用于 hover 提示 */
  maskName?: string | null
  /** 列表中的索引,用于逐个淡入的错峰延迟 */
  index?: number
  /** 该会话最后一条消息时间(ms 数字).来自会话的 updatedAt. */
  lastMessageAt?: number
  /** 批量管理模式:行不再是导航链接,整行点击切换勾选 */
  selectable?: boolean
  /** 批量管理模式下是否已勾选 */
  selected?: boolean
  onToggleSelect?: (id: string) => void
  onDelete?: (id: string) => void
  onRename?: (id: string, newTitle: string) => void
}

/** 逐个加载: 索引错峰延迟,超过 15 个后封顶 300ms 避免等待过久 */
const STAGGER_STEP_MS = 20
const STAGGER_MAX_INDEX = 15

function ConversationItemInner({ id, title, mode, maskAvatar, maskName, index = 0, lastMessageAt, selectable, selected, onToggleSelect, onDelete, onRename }: ConversationItemProps) {
  const staggerDelay = Math.min(index, STAGGER_MAX_INDEX) * STAGGER_STEP_MS
  const pathname = usePathname()
  const router = useRouter()
  const currentConversationId = useChatStore((s) => s.currentConversationId)
  const lastReadAt = useChatStore((s) => s.lastReadAt)
  // Fall back to the store because after the first message of a new chat the URL
  // is rewritten via history.replaceState, so usePathname() still returns /chat
  const isActive = pathname === `/chat/c/${id}` || currentConversationId === id
  // 未读判断:活跃会话不显示蓝点,否则按 lastMessageAt vs lastReadAt
  const showUnreadDot =
    !isActive &&
    typeof lastMessageAt === 'number' &&
    isUnread(id, lastMessageAt, lastReadAt)
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(title)
  const inputRef = useRef<HTMLInputElement>(null)
  // 右键菜单的分支/导出动作自带异步状态(不新增 props,不触碰 memo 比较函数)
  const [branching, setBranching] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [bundleExporting, setBundleExporting] = useState(false)
  // 单条直推线上:复用设置页记下的地址与 sk- 令牌,不导文件
  const [pushing, setPushing] = useState(false)

  // Focus and select all text when entering edit mode
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  // Reset edit value when title changes externally
  useEffect(() => {
    setEditValue(title)
  }, [title])

  // beginEdit 是无事件版本:右键菜单项也要进编辑态(菜单里拿不到原 MouseEvent)
  const beginEdit = useCallback(() => {
    setEditValue(title)
    setIsEditing(true)
  }, [title])

  function startEditing(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    beginEdit()
  }

  const startEditingDebounced = useSingleFlight(startEditing, [title])

  function handleDelete(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (onDelete) {
      onDelete(id)
    }
  }

  const handleDeleteDebounced = useSingleFlight(handleDelete, [id, onDelete])

  // ── 右键菜单:分支此对话(与 TopBar 同一 API,自含实现不透传回调) ──
  const handleBranch = useCallback(async () => {
    if (branching) return
    setBranching(true)
    try {
      const res = await fetch('/api/conversations/branch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: id }),
      })
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}))
        throw new Error(detail?.error ?? `HTTP ${res.status}`)
      }
      const newConv = (await res.json()) as {
        id: string
        title?: string
        mode?: 'compressed' | 'cloned'
        warning?: string
      }
      const modeLabel =
        newConv.mode === 'compressed'
          ? '已带上文,新对话已就绪'
          : newConv.mode === 'cloned'
            ? '压缩失败,已克隆原对话'
            : '新对话已就绪'
      toast.success(modeLabel, { title: '分支对话' })
      // 通知侧边栏刷新会话列表(创建了新对话),并跳转到新对话
      useChatStore.getState().bumpConversationVersion()
      router.push(`/chat/c/${newConv.id}`)
    } catch (err) {
      console.error('[ConversationItem] branch failed:', err)
      toast.error(err instanceof Error ? err.message : '创建分支对话失败,请重试', {
        title: '分支对话',
      })
    } finally {
      setBranching(false)
    }
  }, [branching, id, router])

  // ── 右键菜单:导出 Markdown(分页拉全量消息,desc+cursor 逐页追齐后反拼) ──
  const handleExport = useCallback(async () => {
    if (exporting) return
    setExporting(true)
    try {
      type ExportMessage = { role: string; content: string; createdAt?: string }
      const all: ExportMessage[] = []
      let cursor: string | null | undefined
      // 50 页 × 100 条 = 5000 条保险上限,防止异常循环
      for (let page = 0; page < 50; page++) {
        const params = new URLSearchParams({ limit: '100' })
        if (cursor) params.set('cursor', cursor)
        const res = await fetch(`/api/conversations/${id}/messages?${params}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as { messages?: ExportMessage[]; nextCursor?: string | null }
        all.push(...(data.messages ?? []))
        if (!data.nextCursor) break
        cursor = data.nextCursor
      }
      if (!all.length) {
        toast.error('该对话暂无可导出的消息', { title: '导出' })
        return
      }
      // 接口按时间倒序分页返回,反拼成时间正序
      all.reverse()
      const lines: string[] = [`# ${title}`, '']
      for (const m of all) {
        const who = m.role === 'user' ? '用户' : m.role === 'assistant' ? 'AI' : '系统'
        lines.push(`**${who}**`, '', m.content, '', '---', '')
      }
      const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${(title || '对话').replace(/[\\/:*?"<>|\n]/g, ' ').slice(0, 50) || '对话'}.md`
      a.click()
      URL.revokeObjectURL(url)
      toast.success(`已导出 ${all.length} 条消息`, { title: '导出' })
    } catch (err) {
      console.error('[ConversationItem] export failed:', err)
      toast.error('导出失败,请重试', { title: '导出' })
    } finally {
      setExporting(false)
    }
  }, [exporting, id, title])

  // ── 右键菜单:导出对话包(可回灌的 JSON,给另一套实例导入用) ──
  // 与上面的「导出 Markdown」分工不同:md 给人读,包给系统吃 —— 包保留
  // 模型/面具/思考过程/对比分组/原始时间戳,导入端靠消息 cuid 幂等去重。
  const handleExportBundle = useCallback(async () => {
    if (bundleExporting) return
    setBundleExporting(true)
    try {
      const res = await downloadConversationBundle({ ids: [id], fileName: title })
      toast.success(
        `已导出 ${res.exported} 条对话${res.skipped ? `（${res.skipped} 条本模式不可见已跳过）` : ''}`,
        { title: '导出对话包' }
      )
    } catch (err) {
      console.error('[ConversationItem] export bundle failed:', err)
      toast.error(err instanceof Error ? err.message : '导出失败,请重试', { title: '导出对话包' })
    } finally {
      setBundleExporting(false)
    }
  }, [bundleExporting, id, title])

  // ── 右键菜单:把这一条直接推到线上 ──
  // 与「导出对话包」分叉在这里:导出留文件、跨实例手动上传;推送同源取包 +
  // Bearer 令牌直写远端 import 端点(远端按消息 cuid 幂等,重推只会命中「已存在」)。
  const handlePushOne = useCallback(async () => {
    if (pushing) return
    const target = readPushTarget()
    if (!target) {
      toast.error('还没有记住的推送目标：先在 设置→对话搬运 填线上地址与 sk- 令牌，并勾上「记住令牌」', {
        title: '推送到线上',
      })
      return
    }
    setPushing(true)
    try {
      const res = await pushBatch(target, [id])
      const report = res.reports[0]
      if (res.created > 0) {
        const notes = [
          report?.strippedAttachments ? `${report.strippedAttachments} 个附件未迁移` : null,
          report?.maskDropped ? '面具不在那边，已改为无面具' : null,
        ].filter(Boolean)
        toast.success(`已推送到线上：${report?.title ?? title}${notes.length ? `（${notes.join('；')}）` : ''}`, {
          title: '推送到线上',
        })
      } else if (res.duplicate > 0) {
        toast.info('线上已有这条对话，没有重复写入', { title: '推送到线上' })
      } else {
        toast.error(`这条没有推上去：${report?.reason ?? report?.outcome ?? '远端未确认写入'}`, {
          title: '推送到线上',
        })
      }
    } catch (err) {
      console.error('[ConversationItem] push one failed:', err)
      toast.error(err instanceof Error ? err.message : '推送失败，请检查线上地址与令牌', {
        title: '推送到线上',
      })
    } finally {
      setPushing(false)
    }
  }, [pushing, id, title])

  // ── 右键菜单:会话级操作集合(hover 按钮之外补充的桌面端入口) ──
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    // 批量管理模式下不弹单条操作菜单(此处的动作对象是勾选集合)
    if (selectable) return
    e.preventDefault()
    const { openContextMenu } = useContextMenuStore.getState()
    const items: ContextMenuItem[] = []
    if (onRename) {
      items.push({
        id: 'rename',
        label: '重命名',
        icon: <Pencil className="w-3.5 h-3.5" />,
        onSelect: beginEdit,
      })
    }
    items.push({
      id: 'branch',
      label: branching ? '正在创建分支…' : '分支此对话',
      icon: <GitBranch className="w-3.5 h-3.5" />,
      disabled: branching,
      onSelect: handleBranch,
    })
    items.push({
      id: 'copy-title',
      label: '复制标题',
      icon: <Copy className="w-3.5 h-3.5" />,
      onSelect: () => {
        if (!navigator.clipboard?.writeText) {
          toast.error('当前浏览器不支持自动复制', { title: '复制失败' })
          return
        }
        navigator.clipboard.writeText(title)
          .then(() => toast.success('已复制标题', { title: '复制' }))
          .catch(() => toast.error('复制失败', { title: '复制' }))
      },
    })
    items.push({
      id: 'export',
      label: exporting ? '正在导出…' : '导出 Markdown',
      icon: <Download className="w-3.5 h-3.5" />,
      disabled: exporting,
      onSelect: handleExport,
    })
    items.push({
      id: 'export-bundle',
      label: bundleExporting ? '正在打包…' : '导出对话包（可导入）',
      icon: <FileJson className="w-3.5 h-3.5" />,
      disabled: bundleExporting,
      onSelect: handleExportBundle,
    })
    items.push({
      id: 'push-one',
      label: pushing ? '正在推送…' : '推送到线上（这一条）',
      icon: <Upload className="w-3.5 h-3.5" />,
      disabled: pushing,
      onSelect: handlePushOne,
    })
    if (onDelete) {
      items.push({
        id: 'delete',
        label: '删除对话',
        danger: true,
        dividerBefore: true,
        icon: <Trash2 className="w-3.5 h-3.5" />,
        onSelect: () => onDelete(id),
      })
    }
    openContextMenu({ x: e.clientX, y: e.clientY }, items)
  }, [
    selectable,
    onRename,
    beginEdit,
    branching,
    handleBranch,
    exporting,
    handleExport,
    bundleExporting,
    handleExportBundle,
    pushing,
    handlePushOne,
    onDelete,
    id,
    title,
  ])

  function cancelEditing() {
    setEditValue(title)
    setIsEditing(false)
  }

  function commitRename() {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== title && onRename) {
      onRename(id, trimmed)
    } else {
      setEditValue(title)
    }
    setIsEditing(false)
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitRename()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelEditing()
    }
  }

  // Edit mode: inline input
  if (isEditing) {
    return (
      <div className="flex items-center gap-1 px-1 py-0.5 rounded-lg bg-accent-soft">
        <input
          ref={inputRef}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={commitRename}
          className="flex-1 min-w-0 bg-transparent text-sm text-content-primary outline-none px-1.5 py-1"
          placeholder="对话标题"
          maxLength={200}
        />
        <button
          onMouseDown={(e) => { e.preventDefault(); commitRename() }}
          className="p-0.5 rounded-md hover:bg-surface-subtle text-green-500 transition-colors"
          aria-label="确认"
        >
          <Check className="w-3 h-3" />
        </button>
        <button
          onMouseDown={(e) => { e.preventDefault(); cancelEditing() }}
          className="p-0.5 rounded-md hover:bg-surface-subtle text-red-500 transition-colors"
          aria-label="取消"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    )
  }

  // 批量管理模式:整行即勾选开关,导航/重命名/删除按钮都让位给底部操作条
  if (selectable) {
    return (
      <button
        type="button"
        onClick={() => onToggleSelect?.(id)}
        aria-pressed={selected}
        style={{ animationDelay: `${staggerDelay}ms`, WebkitTapHighlightColor: 'transparent' }}
        className={cn(
          'sidebar-item-enter flex w-full items-center gap-2 px-2.5 py-1.5 rounded-lg text-sm transition-colors touch-manipulation',
          selected
            ? 'bg-accent-soft text-content-primary'
            : 'text-content-secondary hover:bg-surface-subtle/60 hover:text-content-primary'
        )}
      >
        <span
          aria-hidden
          className={cn(
            'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border transition-colors',
            selected ? 'border-accent bg-accent text-white' : 'border-line/70 bg-surface'
          )}
        >
          {selected && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
        </span>
        <span className="min-w-0 flex-1 truncate text-left">{title}</span>
        {maskAvatar && <span className="shrink-0 text-xs leading-none" aria-hidden>{maskAvatar}</span>}
        {mode === 'compare' && (
          <span className="shrink-0 text-[9px] px-1 py-0.5 rounded bg-accent-soft text-content-secondary font-medium">
            对比
          </span>
        )}
      </button>
    )
  }

  // Normal mode: link with title + action buttons
  return (
    <Link
      href={`/chat/c/${id}`}
      style={{ animationDelay: `${staggerDelay}ms` }}
      onContextMenu={handleContextMenu}
      className={cn(
        'sidebar-item-enter group flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-sm transition-colors',
        isActive
          ? 'bg-accent-soft text-content-primary font-medium'
          : 'text-content-secondary hover:bg-surface-subtle/60 hover:text-content-primary'
      )}
    >
      {showUnreadDot && (
        <span
          aria-label="未读"
          title="有未读消息"
          className="shrink-0 w-2 h-2 rounded-full bg-blue-500 dark:bg-blue-400
            shadow-[0_0_8px_rgba(59,130,246,0.75)] animate-pulse"
          style={{ animationDuration: '2.4s' }}
        />
      )}
      <span className="flex-1 truncate">{title}</span>
      {maskAvatar && (
        <span
          className="shrink-0 text-xs leading-none"
          title={maskName ? `面具：${maskName}` : undefined}
          aria-label={maskName ? `面具：${maskName}` : undefined}
        >
          {maskAvatar}
        </span>
      )}
      {mode === 'compare' && (
        <span className="shrink-0 text-[9px] px-1 py-0.5 rounded bg-accent-soft text-content-secondary font-medium">
          对比
        </span>
      )}
      {onRename && (
        <button
          onClick={startEditingDebounced}
          className="opacity-0 show-on-touch group-hover:opacity-100 p-0.5 rounded-md hover:bg-surface-subtle hover:text-content-primary transition-opacity active:scale-95 touch-manipulation"
          aria-label="重命名"
          style={{ WebkitTapHighlightColor: 'transparent' }}
        >
          <Pencil className="w-3 h-3" />
        </button>
      )}
      {onDelete && (
        <button
          onClick={handleDeleteDebounced}
          className="opacity-0 show-on-touch group-hover:opacity-100 p-0.5 rounded-md hover:bg-surface-subtle hover:text-red-500 dark:hover:text-red-400 transition-opacity active:scale-95 touch-manipulation"
          aria-label="删除对话"
          style={{ WebkitTapHighlightColor: 'transparent' }}
        >
          <Trash2 className="w-3 h-3" />
        </button>
      )}
    </Link>
  )
}

/**
 * 对比函数: id / title / mode / 回调引用相同则跳过重渲
 * - pathname 在父级触发 ConversationItem 列表重渲时也会变(来自 usePathname),
 *   但 active 状态是派生,只要父级 currentConversationId 不变即可
 * - currentConversationId 来自 store,但 memo 不会订阅 store —— 这里只比较自身 props
 */
function areConversationItemPropsEqual(
  prev: Readonly<ConversationItemProps>,
  next: Readonly<ConversationItemProps>
): boolean {
  if (prev.id !== next.id) return false
  if (prev.title !== next.title) return false
  if (prev.mode !== next.mode) return false
  if (prev.maskAvatar !== next.maskAvatar) return false
  if (prev.maskName !== next.maskName) return false
  if (prev.index !== next.index) return false
  if (prev.lastMessageAt !== next.lastMessageAt) return false
  if (prev.selectable !== next.selectable) return false
  if (prev.selected !== next.selected) return false
  if (prev.onToggleSelect !== next.onToggleSelect) return false
  if (prev.onDelete !== next.onDelete) return false
  if (prev.onRename !== next.onRename) return false
  return true
}

/**
 * Memoized ConversationItem —— 会话列表 100+ 项时,
 * 切换一个会话不会让其他 99 项重渲(它们只是 props 引用相同)。
 */
export const ConversationItem = memo(ConversationItemInner, areConversationItemPropsEqual)
