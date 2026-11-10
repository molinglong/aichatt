'use client'

/**
 * 写作文档卡片 —— 渲染 write_document 工具的文档创建结果。
 *
 * 三态（由 view.state 驱动）:
 * - 流式/待执行(input-streaming/input-available): 一行式「正在创建文档《标题》…」+ spinner
 * - 成功(output-available + ok): 📄 标题 + 字数 + 「打开」按钮(深链 /write?doc=)
 * - 失败(output-error 或 ok:false): 红色一行 + 错误信息
 *
 * 文档已在工具 execute 时落库,按钮直接深链打开;/write 端按 ?doc= 参数定位。
 */
import { memo, useEffect } from 'react'
import { useChatStore } from '@/store/chat-store'
import { FileText, Loader2, PenLine } from 'lucide-react'
import { isWriteDocOutput } from '@/lib/ai/write-doc-tool'
import type { ToolCallView } from './ToolCallCard'

/**
 * 自动打开画布的跟踪集合:只有在本会话中经历过流式 pending 态的工具调用,
 * 完成时才自动滑出写作画布;历史回放(首挂即 output-available)不在集合里,永不触发。
 */
const pendingToolCalls = new Set<string>()
const autoOpenedToolCalls = new Set<string>()

interface WriteDocCardProps {
  view: ToolCallView
}

function WriteDocCardInner({ view }: WriteDocCardProps) {
  const openWritePanel = useChatStore((s) => s.openWritePanel)
  const rawTitle =
    !!view.input &&
    typeof view.input === 'object' &&
    typeof (view.input as { title?: unknown }).title === 'string'
      ? ((view.input as { title: string }).title as string).trim()
      : ''
  const isAppend =
    !!view.input && typeof view.input === 'object' && (view.input as { action?: unknown }).action === 'append'
  const parsed = isWriteDocOutput(view.output) ? view.output : null
  // 判别收窄:parsed.ok 为 true 时才是成功形状(带 docId/title/charCount)
  const okOutput = parsed && parsed.ok ? parsed : null
  const failed = view.state === 'output-error' || (parsed !== null && !parsed.ok)
  const message =
    view.state === 'output-error'
      ? view.errorText || '文档创建失败'
      : parsed && !parsed.ok
        ? parsed.message
        : ''

  // 自动打开:刚经历流式 pending 的工具成功完成后,直接滑出写作画布(豆包式,不用点卡片)
  useEffect(() => {
    const id = view.toolCallId
    if (!id) return
    if (view.state === 'input-streaming' || view.state === 'input-available') {
      pendingToolCalls.add(id)
      return
    }
    if (view.state !== 'output-available' && view.state !== 'output-error') return
    // delete 成功 = 本会话内见过 pending 态且首次完成;历史回放/重复完成均跳过
    if (!pendingToolCalls.delete(id)) return
    if (view.state !== 'output-available' || !okOutput || autoOpenedToolCalls.has(id)) return
    autoOpenedToolCalls.add(id)
    if (okOutput.action === 'append' || okOutput.action === 'replace') {
      // 续写/整篇替换:文档就地更新,面板通常已开着,广播刷新让编辑器拉最新内容
      window.dispatchEvent(new CustomEvent('aichatt:write-doc-updated', { detail: { docId: okOutput.docId } }))
      return
    }
    // 新建:自动滑出画布
    openWritePanel(okOutput.docId)
  }, [view.state, view.toolCallId, okOutput, openWritePanel])

  if (failed) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-red-500/30 bg-red-500/5 text-xs text-red-500 dark:text-red-400">
        <FileText className="w-3.5 h-3.5 shrink-0" />
        <span className="min-w-0 truncate">写作文档创建失败:{message}</span>
      </div>
    )
  }

  if (!okOutput) {
    // 流式/待执行:参数(含长正文)还在生成
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-line bg-surface-muted/50 text-xs text-content-secondary">
        <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-accent" />
        <span className="min-w-0 truncate">
          {isAppend ? '正在续写' : '正在创建写作文档'}{rawTitle ? `《${rawTitle}》` : ''}…
        </span>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-line bg-surface-muted/50">
      <div className="shrink-0 w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center">
        <FileText className="w-4 h-4 text-accent" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-content-primary truncate">{okOutput.title}</div>
        <div className="text-[10px] text-content-muted mt-0.5">
          {okOutput.charCount} 字 · 写作画布
        </div>
      </div>
      <button
        type="button"
        title="在右侧写作画布中打开"
        onClick={() => openWritePanel(okOutput.docId)}
        className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium
          bg-accent text-accent-foreground hover:bg-accent/90 active:scale-95 transition-all"
      >
        <PenLine className="w-3.5 h-3.5" />
        打开
      </button>
    </div>
  )
}

export const WriteDocCard = memo(WriteDocCardInner)
