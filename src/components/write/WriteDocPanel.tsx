'use client'

/**
 * 聊天内嵌写作画布面板 —— 案3形态(2026-11-08 挑稿定案):
 * - 桌面端展开后接管整个主区(w-full):聊天列淡出退场(ChatPanel 配合),
 *   移动端本就全屏覆盖。不再有「46vw 浮层盖在聊天上裁字」的中间态。
 * - 头部 = 文档标题(方案B:标题上提为面板头/拖窗区)+ 铅笔重命名 + 图标化动作;
 *   第二行状态簇 = 保存状态点 / 字数与目标字数进度(模型不单独设置,划词生成跟随对话)。
 * - 底部 WritePanelComposer 复用 sendTextAsUser 直发桥:画布打开期间照样对 AI
 *   说话,回复命中 write_document append 直接续写当前文档(write-doc-updated 刷新)。
 * - 标题/模型受控下发 WriteEditor(embedded 模式),meta(saveState/chars)上行。
 * 入口:write_document 文档卡片「打开」(WriteDocCard);打开状态在 chat-store(writePanelDocId)。
 * 关闭时延迟卸载编辑器:既保住滑出动画,也让 WriteEditor 卸载补存正常执行。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  ExternalLink,
  FolderDown,
  Loader2,
  Minus,
  PanelLeft,
  PenLine,
  Pencil,
  Plus,
  X,
} from 'lucide-react'
import { useChatStore } from '@/store/chat-store'
import { WriteEditor, type WriteEditorMeta } from './WriteEditor'
import { WritePanelComposer } from './WritePanelComposer'
import { exportToWorkspaceFile } from '@/lib/workspace/export-to-workspace'
import { cn } from '@/lib/utils'

/** 与 transition-duration 保持一致;关闭后延迟此时长再卸载编辑器 */
const CLOSE_ANIM_MS = 300

type SaveState = WriteEditorMeta['saveState']

const SAVE_LABEL: Record<SaveState, string> = {
  saved: '已保存',
  dirty: '编辑中',
  saving: '保存中…',
  error: '保存失败',
}

/** 保存状态点:空心=已保存 / accent 实心=编辑中 / 旋转=保存中 / danger=失败(不引新色相) */
function SaveStateChip({ state }: { state: SaveState }) {
  return (
    <span
      className={cn(
        'shrink-0 inline-flex items-center gap-1.5 text-[11px] tabular-nums',
        state === 'error' ? 'text-danger' : 'text-content-secondary'
      )}
    >
      {state === 'saving' ? (
        <Loader2 className="w-3 h-3 animate-spin" />
      ) : (
        <i
          className={cn(
            'w-1.5 h-1.5 rounded-full',
            state === 'saved' && 'border border-content-muted',
            state === 'dirty' && 'bg-accent animate-pulse',
            state === 'error' && 'bg-danger'
          )}
        />
      )}
      {SAVE_LABEL[state]}
    </span>
  )
}

export function WriteDocPanel() {
  const router = useRouter()
  const writePanelDocId = useChatStore((s) => s.writePanelDocId)
  const closeWritePanel = useChatStore((s) => s.closeWritePanel)
  const open = writePanelDocId !== null

  // 关闭动画播完再真正卸载编辑器(卸载时会补存未保存改动)
  const [renderDocId, setRenderDocId] = useState<string | null>(null)
  useEffect(() => {
    if (writePanelDocId) {
      setRenderDocId(writePanelDocId)
      return
    }
    const t = setTimeout(() => setRenderDocId(null), CLOSE_ANIM_MS)
    return () => clearTimeout(t)
  }, [writePanelDocId])

  // ── 受控下行(WriteEditor embedded)/ 上行 meta ──
  const [title, setTitle] = useState('')
  const [meta, setMeta] = useState<WriteEditorMeta>({ saveState: 'saved', chars: 0 })
  const onMetaChange = useCallback((m: WriteEditorMeta) => setMeta(m), [])
  // 模型不再单独设置:划词生成跟随对话当前模型(ChatPanel 同步进 store)
  const chatModelId = useChatStore((s) => s.chatModelId)
  // ── AI 写入反馈(治「点 chip 发送后黑盒,要退出去看」): 聊天流忙时 composer
  //    变状态条;忙结束若文档字数有增,内联「+N 字」2.6s 后淡回 ──
  const chatBusy = useChatStore((s) => s.chatBusy)
  // 划词选中态(移动端选中时隐藏悬浮目标胶囊;选区文本喂给 composer 发送携带上下文)
  const [selInfo, setSelInfo] = useState<{ len: number; text: string } | null>(null)
  const onSelChange = useCallback((sel: { len: number; text: string } | null) => setSelInfo(sel), [])
  const [clearSelTick, setClearSelTick] = useState(0)
  const lastCharsRef = useRef(0)
  useEffect(() => {
    lastCharsRef.current = meta.chars
  }, [meta.chars])
  const charsAtSendRef = useRef(0)
  const prevBusyRef = useRef(false)
  const [doneDelta, setDoneDelta] = useState<number | null>(null)
  const doneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const was = prevBusyRef.current
    prevBusyRef.current = chatBusy
    if (chatBusy && !was) charsAtSendRef.current = lastCharsRef.current
    if (!chatBusy && was) {
      // write_document 落库 + 编辑器刷新有延迟,缓一拍再算差值(增减都提示)
      const t = setTimeout(() => {
        const delta = lastCharsRef.current - charsAtSendRef.current
        if (delta !== 0) {
          setDoneDelta(delta)
          if (doneTimerRef.current) clearTimeout(doneTimerRef.current)
          doneTimerRef.current = setTimeout(() => setDoneDelta(null), 2600)
        }
      }, 900)
      return () => clearTimeout(t)
    }
  }, [chatBusy])

  // ── 标题编辑(铅笔进入;编辑态摘掉 Tauri 拖窗区,避免输入框拖窗冲突) ──
  const [editingTitle, setEditingTitle] = useState(false)
  const editingTitleRef = useRef(false)
  useEffect(() => {
    editingTitleRef.current = editingTitle
  }, [editingTitle])

  // ── 目标字数(localStorage 按文档存;点字数簇弹出设置,D 案大数字 ±50 步进) ──
  const [goal, setGoal] = useState<number | null>(null)
  const [goalOpen, setGoalOpen] = useState(false)
  const goalBoxRef = useRef<HTMLDivElement>(null)
  // 点弹层外任意处关闭(否则浮层会一直挂着)
  useEffect(() => {
    if (!goalOpen) return
    function onDoc(e: MouseEvent) {
      if (goalBoxRef.current && !goalBoxRef.current.contains(e.target as Node)) setGoalOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [goalOpen])
  useEffect(() => {
    setTitle('')
    setEditingTitle(false)
    setGoalOpen(false)
    try {
      const v = renderDocId ? localStorage.getItem(`aichatt-write-goal:${renderDocId}`) : null
      const n = v ? Number(v) : NaN
      setGoal(Number.isFinite(n) && n > 0 ? n : null)
    } catch {
      setGoal(null)
    }
  }, [renderDocId])
  // 步进/预设/清除都即时生效且不关浮层(连续调整是主路径),点浮层外关闭
  const saveGoal = useCallback(
    (g: number | null) => {
      setGoal(g)
      try {
        const key = `aichatt-write-goal:${renderDocId}`
        if (g) localStorage.setItem(key, String(g))
        else localStorage.removeItem(key)
      } catch {
        /* 私有模式下静默 */
      }
    },
    [renderDocId]
  )
  /** ±50 步进;未设置时 + 从 600 起;范围 300–3000 */
  const stepGoal = useCallback(
    (delta: 1 | -1) => {
      if (!goal) {
        if (delta === 1) saveGoal(600)
        return
      }
      saveGoal(Math.min(3000, Math.max(300, goal + delta * 50)))
    },
    [goal, saveGoal]
  )

  // ESC 关闭(编辑标题时只退编辑态,不关面板)
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !editingTitleRef.current) closeWritePanel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, closeWritePanel])

  // 逃生舱:跳 /write 完整工作区(带文档列表/深链定位),跳转前收起面板防回来时残留
  function openFullCanvas() {
    const id = renderDocId
    closeWritePanel()
    router.push(id ? `/write?doc=${id}` : '/write')
  }

  // 一键导出到本地工作区(桌面端):走共享导出流(exportToWorkspaceFile:桌面检查 →
  // 授权工作区 → 写入 <标题>.md → 成功/失败提示)。编辑器内容自动保存有秒级 debounce,
  // 此处取 DB 真源,滞后可忽略
  const [exporting, setExporting] = useState(false)
  async function exportToWorkspace() {
    const docId = renderDocId
    if (!docId || exporting) return
    setExporting(true)
    try {
      await exportToWorkspaceFile({
        load: async () => {
          const res = await fetch(`/api/write/docs/${docId}`)
          if (!res.ok) throw new Error('读取文档失败，请重试')
          const doc = (await res.json()) as { title?: string; content?: string }
          return { fileNameBase: doc.title || '', content: doc.content ?? '', ext: 'md' }
        },
      })
    } finally {
      setExporting(false)
    }
  }

  const goalPct = goal ? Math.min(100, Math.round((meta.chars / goal) * 100)) : null
  /** chip 小圆环进度(r=5.5 周长) */
  const goalRingLen = 2 * Math.PI * 5.5

  return (
    <aside
      aria-hidden={!open}
      className={`fixed inset-y-0 right-0 z-[80] w-full flex flex-col
        bg-surface border-l border-line shadow-2xl
        transition-transform duration-[var(--motion-base)] ease-[var(--ease-enter)]
        ${open ? 'translate-x-0' : 'translate-x-full pointer-events-none'}`}
    >
      {/* 面板头 = 文档标题(方案B 上提;data-tauri-drag-region="deep":客户端下即面板
          「标题栏」,整块按下都能拖窗、双击转最大化;编辑标题时临时摘掉拖窗区,
          右侧按钮由 Tauri 脚本自动排除) */}
      <div
        {...(editingTitle ? {} : { 'data-tauri-drag-region': 'deep' as const })}
        className="shrink-0 flex items-center gap-1.5 h-12 px-4 md:px-[max(40px,calc(50%-320px))]"
      >
        <div className="w-7 h-7 rounded-control bg-accent/10 flex items-center justify-center shrink-0">
          <PenLine className="w-3.5 h-3.5 text-accent" />
        </div>
        {editingTitle ? (
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setEditingTitle(false)
              if (e.key === 'Escape') {
                e.stopPropagation()
                setEditingTitle(false)
              }
            }}
            placeholder="未命名"
            className="flex-1 min-w-0 mx-1 bg-transparent text-sm font-medium text-content-primary outline-none placeholder:text-content-muted"
          />
        ) : (
          <span className="flex-1 min-w-0 truncate text-sm font-medium text-content-primary">
            {title || '未命名'}
          </span>
        )}
        <button
          type="button"
          onClick={() => setEditingTitle((v) => !v)}
          title="重命名"
          aria-label="重命名文档"
          className="p-1.5 rounded-md text-content-secondary hover:text-content-primary
            hover:bg-surface-subtle transition-colors shrink-0"
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
        <span className="w-px h-4 bg-line shrink-0" />
        {/* 移动端:文档列表 = 去完整画布 */}
        <button
          type="button"
          onClick={openFullCanvas}
          className="md:hidden p-1.5 rounded-md text-content-secondary hover:text-content-primary
            hover:bg-surface-subtle transition-colors shrink-0"
          aria-label="文档列表"
          title="文档列表"
        >
          <PanelLeft className="w-4 h-4" />
        </button>
        {open && (
          <button
            type="button"
            onClick={() => void exportToWorkspace()}
            disabled={exporting}
            title="把当前文档导出到本地工作区文件夹(.md)"
            className="p-1.5 rounded-md text-content-secondary hover:text-content-primary
              hover:bg-surface-subtle transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
          >
            {exporting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <FolderDown className="w-4 h-4" />
            )}
          </button>
        )}
        <button
          type="button"
          onClick={openFullCanvas}
          title="打开完整写作工作区"
          className="p-1.5 rounded-md text-content-secondary hover:text-content-primary
            hover:bg-surface-subtle transition-colors shrink-0"
        >
          <ExternalLink className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={closeWritePanel}
          aria-label="关闭写作画布"
          className="p-1.5 rounded-md text-content-secondary hover:text-content-primary
            hover:bg-surface-subtle transition-colors shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 悬浮状态簇:浮在编辑区右上角(不占布局行,给正文让出 40px),点字数设目标。
          毛玻璃用「纸色白玻璃」rgb(var(--surface)/0.72)+glass-blur —— 不走 bg-surface-glass
          (bigsur ⑥b 会把它压成不透明 muted,blur 失效);白玻璃叠白纸不偏浅,滚动文字透出霜感。
          移动端划词选中时隐藏(顶条已占该区域)。 */}
      <div
        className={cn(
          'absolute top-[54px] right-4 md:right-[max(40px,calc(50%-320px))] z-10',
          selInfo && 'max-md:hidden'
        )}
      >
        <div className="relative" ref={goalBoxRef}>
          <button
            type="button"
            onClick={() => setGoalOpen((v) => !v)}
            title={goal ? '目标字数:点击修改' : '点击设置目标字数'}
            className="inline-flex items-center gap-2.5 h-8 rounded-full border border-line bg-[rgb(var(--surface)/0.72)] glass-blur pl-3 pr-2.5
              shadow-[0_2px_10px_rgb(0_0_0/0.10)] hover:border-line-strong transition-colors"
          >
            <SaveStateChip state={meta.saveState} />
            <span className="text-[11px] text-content-secondary tabular-nums">
              {meta.chars.toLocaleString()}
              {goal ? ` / ${goal} 字` : ' 字'}
            </span>
            {goal && (
              <svg
                aria-hidden="true"
                className="shrink-0 -rotate-90"
                width="14"
                height="14"
                viewBox="0 0 14 14"
              >
                <circle
                  cx="7"
                  cy="7"
                  r="5.5"
                  fill="none"
                  strokeWidth="2.5"
                  style={{ stroke: 'rgb(var(--surface-subtle))' }}
                />
                <circle
                  cx="7"
                  cy="7"
                  r="5.5"
                  fill="none"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  style={{
                    stroke: 'rgb(var(--accent) / 0.55)',
                    strokeDasharray: goalRingLen,
                    strokeDashoffset: goalRingLen * (1 - (goalPct ?? 0) / 100),
                    transition: 'stroke-dashoffset var(--motion-fast) ease',
                  }}
                />
              </svg>
            )}
          </button>
          {/* 目标字数设置:真浮层(环影合规)。D 案(2026-11-08 挑稿):大数字 ±50 步进
              + 预设直选,操作即时生效且不关浮层;±50 让 750/850 这类中间值可达。
              已达标用 accent(禁新色相,不用绿)。 */}
          {goalOpen && (
            <div
              className="absolute right-0 top-full mt-1.5 z-30 w-[264px] rounded-card border border-line bg-surface p-4
                shadow-[0_4px_16px_rgb(0_0_0/0.12),0_1px_3px_rgb(0_0_0/0.06)]"
            >
              <div className="text-[11px] text-content-secondary text-center">目标字数</div>
              <div className="flex items-center justify-center gap-4 mt-1.5">
                <button
                  type="button"
                  onClick={() => stepGoal(-1)}
                  disabled={!goal || goal <= 300}
                  aria-label="目标字数 −50"
                  className="h-8 w-8 rounded-full border border-line flex items-center justify-center text-content-secondary
                    hover:text-accent hover:border-accent/60 hover:bg-accent-soft transition-colors
                    disabled:opacity-40 disabled:pointer-events-none shrink-0"
                >
                  <Minus className="w-3.5 h-3.5" />
                </button>
                {goal ? (
                  <span className="min-w-[110px] text-center text-2xl font-semibold text-content-primary tabular-nums leading-none">
                    {goal.toLocaleString()}
                    <span className="text-[11px] font-normal text-content-secondary ml-0.5">字</span>
                  </span>
                ) : (
                  <span className="min-w-[110px] text-center text-sm text-content-muted">未设置</span>
                )}
                <button
                  type="button"
                  onClick={() => stepGoal(1)}
                  aria-label={goal ? '目标字数 +50' : '设为 600 字'}
                  className="h-8 w-8 rounded-full border border-line flex items-center justify-center text-content-secondary
                    hover:text-accent hover:border-accent/60 hover:bg-accent-soft transition-colors shrink-0"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="flex items-center justify-center gap-1 mt-2.5">
                {[600, 700, 800, 1000].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => saveGoal(n)}
                    className={cn(
                      'h-7 px-2 rounded-control text-xs tabular-nums transition-colors',
                      goal === n
                        ? 'text-accent font-semibold'
                        : 'text-content-secondary hover:text-content-primary hover:bg-surface-subtle'
                    )}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2 mt-3 pt-2.5 border-t border-line">
                <span
                  className={cn(
                    'flex-1 min-w-0 truncate text-[11px] tabular-nums',
                    goal && meta.chars >= goal ? 'text-accent' : 'text-content-secondary'
                  )}
                >
                  {goal
                    ? meta.chars >= goal
                      ? `${meta.chars.toLocaleString()} / ${goal.toLocaleString()} · 已达标`
                      : `${meta.chars.toLocaleString()} / ${goal.toLocaleString()} · 还差 ${(goal - meta.chars).toLocaleString()} 字`
                    : `当前 ${meta.chars.toLocaleString()} 字 · 未设目标`}
                </span>
                {goal && (
                  <button
                    type="button"
                    onClick={() => saveGoal(null)}
                    className="shrink-0 text-[11px] text-content-secondary hover:text-danger transition-colors"
                  >
                    清除
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 编辑器(embedded:无自带顶栏,标题受控,meta 上行)+ 底部迷你输入条 */}
      {renderDocId && (
        <>
          <div className="flex-1 min-h-0">
            <WriteEditor
              key={renderDocId}
              docId={renderDocId}
              embedded
              title={title}
              onTitleChange={setTitle}
              model={chatModelId ?? ''}
              onMetaChange={onMetaChange}
              onSelChange={onSelChange}
              clearSelTick={clearSelTick}
            />
          </div>
          <WritePanelComposer
            goal={goal}
            chars={meta.chars}
            busy={chatBusy}
            doneDelta={doneDelta}
            sel={selInfo}
            onClearSel={() => setClearSelTick((t) => t + 1)}
          />
        </>
      )}
    </aside>
  )
}
