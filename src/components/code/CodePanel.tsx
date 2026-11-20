'use client'

/**
 * 聊天内嵌代码编辑器面板 —— 右侧滑出,左列表 + 右 Monaco,与写作画布(WriteDocPanel)
 * 同款交互但独立一套。专门写代码,不与写小说的 textarea 画布混淆。
 *
 * 数据流:TopBar「代码」按钮 → openCodePanel(id) → 面板滑出;
 *   左 CodeDocList(react-query code.list)新建/删除/切换;
 *   右 CodeEditor(Monaco,自包含加载/自动保存/AI Diff 审查)。
 * 关闭时延迟卸载编辑器:既保住滑出动画,也让 CodeEditor 卸载补存正常执行。
 * 导出:桌面端把当前文档写到授权工作区(<标题>.<ext>),复用 tauri-files 写盘通道。
 */
import { useEffect, useState } from 'react'
import { FileCode2, FolderDown, Loader2, X } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useChatStore } from '@/store/chat-store'
import { CodeEditor } from './CodeEditor'
import { CodeDocList } from './CodeDocList'
import { fetchJson } from '@/lib/query/fetcher'
import { queryKeys } from '@/lib/query/keys'
import { exportToWorkspaceFile } from '@/lib/workspace/export-to-workspace'
import type { CodeDocSummary } from './types'

/** 与 transition-duration 保持一致;关闭后延迟此时长再卸载编辑器 */
const CLOSE_ANIM_MS = 300

/** 语言 → 文件扩展名(导出本地文件用;未收录的落 .txt) */
const LANG_EXT: Record<string, string> = {
  typescript: 'ts', javascript: 'js', python: 'py', rust: 'rs', go: 'go',
  java: 'java', c: 'c', cpp: 'cpp', csharp: 'cs', html: 'html', css: 'css',
  json: 'json', markdown: 'md', bash: 'sh', shell: 'sh', sql: 'sql',
  yaml: 'yml', php: 'php', ruby: 'rb', swift: 'swift', kotlin: 'kt', plaintext: 'txt',
}

export function CodePanel({ embedded = false }: { embedded?: boolean }) {
  const codePanelOpen = useChatStore((s) => s.codePanelOpen)
  const codePanelDocId = useChatStore((s) => s.codePanelDocId)
  const openCodePanel = useChatStore((s) => s.openCodePanel)
  const closeCodePanel = useChatStore((s) => s.closeCodePanel)
  const open = codePanelOpen
  // 会话聚合:列表只拉当前对话的 AI 代码产物。
  // currentConversationId=null(空白新对话)时不发请求,左栏显示引导文案。
  const conversationId = useChatStore((s) => s.currentConversationId)

  // 代码文档列表(与左栏共享缓存;保存后由 CodeEditor 局部回写)
  const { data, isPending } = useQuery({
    queryKey: queryKeys.code.list(conversationId),
    queryFn: async () => {
      const r = await fetchJson<{ docs: CodeDocSummary[] }>(
        `/api/code/docs?conversationId=${encodeURIComponent(conversationId!)}`
      )
      return r.docs
    },
    enabled: open && conversationId !== null,
    staleTime: 30_000,
  })

  // 关闭动画播完再真正卸载编辑器(卸载时会补存未保存改动);
  // 面板开着但无文档(空态)也保持卸载状态,只渲染引导
  const [renderDocId, setRenderDocId] = useState<string | null>(null)
  useEffect(() => {
    if (codePanelDocId) {
      setRenderDocId(codePanelDocId)
      return
    }
    const t = setTimeout(() => setRenderDocId(null), open ? 0 : CLOSE_ANIM_MS)
    return () => clearTimeout(t)
  }, [codePanelDocId, open])

  // ESC 关闭(与编辑器内 ⌘/Ctrl+S 不冲突)
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') closeCodePanel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, closeCodePanel])

  // 删除当前文档后:有兄弟就切到第一个,否则收起面板
  function handleDeleted(id: string) {
    if (id !== codePanelDocId) return
    const sibling = (data ?? []).find((d) => d.id !== id)
    if (sibling) openCodePanel(sibling.id)
    else closeCodePanel()
  }

  // 导出到本地工作区(桌面端):取 DB 全文后走共享导出流(exportToWorkspaceFile:
  // 桌面检查 → 授权工作区 → 写入 <标题>.<ext> → 成功/失败提示)
  const [exporting, setExporting] = useState(false)
  async function exportToWorkspace() {
    const docId = renderDocId
    if (!docId || exporting) return
    setExporting(true)
    try {
      await exportToWorkspaceFile({
        load: async () => {
          const doc = await fetchJson<{ title?: string; content?: string; language?: string }>(
            `/api/code/docs/${docId}`
          )
          return {
            fileNameBase: doc.title || '未命名',
            content: doc.content ?? '',
            ext: LANG_EXT[doc.language ?? ''] ?? 'txt',
          }
        },
      })
    } finally {
      setExporting(false)
    }
  }

  // [P1 改版]embedded = 挂进 WorkSidePane 的 tab 内容(无定位/滑出动画);独立覆盖面板兜底保留
  const rootCls = embedded
    ? 'h-full flex flex-col bg-surface'
    : `fixed inset-y-0 right-0 z-[80] w-full md:w-[min(60vw,960px)] flex flex-col
        bg-surface border-l border-line shadow-2xl
        transition-transform duration-300 ease-out
        ${open ? 'translate-x-0' : 'translate-x-full pointer-events-none'}`

  return (
    <div aria-hidden={!open} className={rootCls}>
      {/* 面板头(data-tauri-drag-region="deep":客户端下即面板「标题栏」,
          整块按下都能拖窗、双击转最大化;右侧按钮由 Tauri 脚本自动排除) */}
      <div
        data-tauri-drag-region="deep"
        className="shrink-0 flex items-center gap-2 h-12 px-3 border-b border-line"
      >
        <div className="w-7 h-7 rounded-lg bg-accent/10 flex items-center justify-center shrink-0">
          <FileCode2 className="w-3.5 h-3.5 text-accent" />
        </div>
        <span className="text-xs font-medium text-content-primary">代码编辑器</span>
        <div className="flex-1" />
        {open && (
          <button
            type="button"
            onClick={() => void exportToWorkspace()}
            disabled={exporting}
            title="把当前代码导出到本地工作区文件夹"
            className="inline-flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs text-content-secondary
              hover:text-content-primary hover:bg-surface-subtle transition-colors
              disabled:opacity-40"
          >
            {exporting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <FolderDown className="w-3.5 h-3.5" />
            )}
            <span className="hidden sm:inline">存到工作区</span>
          </button>
        )}
        <button
          type="button"
          onClick={closeCodePanel}
          aria-label="关闭代码编辑器"
          className="p-1.5 rounded-md text-content-secondary hover:text-content-primary
            hover:bg-surface-subtle transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 主体:左列表 + 右编辑器 */}
      {open && (
        <div className="flex-1 min-h-0 flex">
          {/* 左栏:本对话的 AI 代码产物列表(无手动新建,由 write_code 工具在聊天中产生) */}
          <div className="w-[200px] shrink-0 border-r border-line hidden md:block">
            <CodeDocList
              docs={data}
              isPending={isPending && conversationId !== null}
              activeId={renderDocId}
              onSelect={openCodePanel}
              onDeleted={handleDeleted}
              conversationId={conversationId}
            />
          </div>
          {/* 右栏:编辑器(open 后挂载,关闭延迟卸载);无文档时显示引导 */}
          <div className="flex-1 min-h-0">
            {renderDocId ? (
              <CodeEditor key={renderDocId} docId={renderDocId} />
            ) : (
              <div className="h-full grid place-items-center px-8">
                <div className="text-center max-w-[280px]">
                  <FileCode2 className="w-8 h-8 mx-auto text-content-muted/50" />
                  <div className="text-sm text-content-secondary mt-3">还没有代码文档</div>
                  <div className="text-xs text-content-muted mt-1.5 leading-relaxed">
                    在聊天里说「写个网页/脚本」，AI 会把代码放到这里；
                    本对话的产物都收在左侧列表中。
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
