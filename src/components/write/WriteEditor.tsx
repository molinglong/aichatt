'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Loader2, PanelLeft, X } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchJson } from '@/lib/query/fetcher'
import { queryKeys, STALE } from '@/lib/query/keys'
import { providersModelsQuery } from '@/lib/query/providers'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { ModelSelector } from '@/components/explore/ModelSelector'
import type { ModelDefinition } from '@/lib/ai/types'
import { deAiFlavor } from '@/lib/text/deai'
import { WRITE_SEL_REWRITE_EVENT } from '@/lib/input-bridge'
import type { WriteDocFull, WriteDocSummary } from './types'

type SaveState = 'saved' | 'dirty' | 'saving' | 'error'

/** 划词状态(正文中的绝对偏移 + 镜像测得的选区起止坐标,内容坐标系) */
interface SelectionState {
  start: number
  end: number
  text: string
  /** 选区起点(首个选中字符左上角) */
  ax: number
  ay: number
  /** 选区终点(最后选中字符之后) */
  bx: number
  by: number
}

/** 改写/去AI味预览:流式产出的新文本先在这里,确认后才替换进正文 */
interface RewritePreview {
  start: number
  end: number
  original: string
  instruction: string
  output: string
  streaming: boolean
  /** 去AI味(本地规则)时的命中统计文案 */
  deaiStats?: string
}

/** 面板内嵌模式下上报给 WriteDocPanel 的元信息(状态簇渲染用) */
export interface WriteEditorMeta {
  saveState: SaveState
  chars: number
}

/** 模型列表拉取:全站共享映射(见 lib/query/providers.ts),勿再内联重写 */
function useModels(): ModelDefinition[] {
  const { data } = useQuery(providersModelsQuery)
  return data ?? []
}

const SAVE_LABEL: Record<SaveState, string> = {
  saved: '已保存',
  dirty: '编辑中',
  saving: '保存中…',
  error: '保存失败',
}

/** 划词预设动作(浮条与移动端顶条共用同一组按钮) */
const SEL_PRESETS = [
  { label: '润色', preset: '润色这段文字:提升文采与节奏,保持原意,不要扩写篇幅' },
  { label: '扩写', preset: '扩写这段文字:补充细节与感官描写,篇幅约为原文两倍' },
  { label: '改写', preset: '改写这段文字:换一种写法表达同样的情节' },
]

/** 正文排版:textarea 与镜像测距 div 必须逐字一致(字号/行高/内边距),否则测位漂移 */
const TA_TYPO = 'text-base leading-8 md:leading-9'
/** 版心:md+ 收 640px 居中列(画布全宽接管后行长可控;窄容器自动退化为 40px 边距) */
const TA_PAD = 'px-4 py-4 md:px-[max(40px,calc(50%-320px))] md:py-8'

interface WriteEditorProps {
  docId: string
  /** /write 页模式下移动端打开文档列表抽屉;面板内嵌模式不用(面板头有列表钮) */
  onOpenList?: () => void
  /**
   * 面板内嵌模式(WriteDocPanel):隐藏自带顶栏,标题受控上行,meta(保存状态/字数)
   * 通过 onMetaChange 上报给面板状态簇;模型不单独设置——model prop 为「对话当前
   * 模型」(ChatPanel 经 store 同步),划词生成跟随对话。
   * /write 页不传 embedded,保持自带顶栏 + 本地模型偏好的自足形态。
   */
  embedded?: boolean
  title?: string
  onTitleChange?: (t: string) => void
  /** embedded=对话当前模型(跟随,只读);页模式忽略(用本地偏好) */
  model?: string
  onMetaChange?: (m: WriteEditorMeta) => void
  /** 划词选中态上行:移动端面板据此隐藏悬浮目标胶囊(避免与划词顶条重叠);
   *  选区文本喂给迷你输入条 —— 选中后发送的指令自动携带选区上下文,AI 只改这段 */
  onSelChange?: (sel: { len: number; text: string } | null) => void
  /** 面板侧请求清除当前选区(迷你输入条 ✕):tick 变化即清 */
  clearSelTick?: number
}

/**
 * 写作编辑器主体:标题/字数/保存状态顶栏(页模式) + 纯文本 textarea 正文 +
 * 划词工具条与改写预览。AI 指令入口全场统一走聊天输入框(由 write_document
 * 工具驱动),画布内只保留划词快捷动作(固定语义,无需输入指令)。
 *
 * 自动保存:编辑防抖 800ms PATCH;切换文档/卸载时若有未保存改动立即补存。
 * 流式:SSE 增量 append 到正文(生成中可随时停止,保留已生成部分);
 * 改写类动作的产出走预览面板,用户确认后才替换选区。
 * 划词工具条:桌面浮条用隐藏镜像 div 测选区坐标浮在选区旁(不推挤正文),
 * 移动端(<md)沿用顶部条。
 */
export function WriteEditor({
  docId,
  onOpenList,
  embedded = false,
  title: titleProp,
  onTitleChange,
  model: modelProp,
  onMetaChange,
  onSelChange,
  clearSelTick = 0,
}: WriteEditorProps) {
  const queryClient = useQueryClient()
  const models = useModels()

  // ── 文档内容本地状态(标题/模型:面板内嵌时受控,页模式内部持有) ──
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [internalTitle, setInternalTitle] = useState('')
  const [content, setContent] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const title = embedded ? (titleProp ?? '') : internalTitle
  const setTitle = useCallback(
    (t: string) => {
      if (embedded) onTitleChange?.(t)
      else setInternalTitle(t)
    },
    [embedded, onTitleChange]
  )

  // ── 生成/预览状态 ──
  const [generating, setGenerating] = useState(false)
  const [sel, setSel] = useState<SelectionState | null>(null)
  const [preview, setPreview] = useState<RewritePreview | null>(null)

  const taRef = useRef<HTMLTextAreaElement>(null)
  /** 镜像测距 div:与 textarea 同排版,量选区坐标(桌面浮条定位) */
  const mirrorRef = useRef<HTMLDivElement>(null)
  /** 划词浮条(桌面)与其两段式定位(先渲染再量自身尺寸收敛) */
  const ftRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [ftPos, setFtPos] = useState<{ left: number; top: number } | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 最新值快照:防抖保存/补存回调里读,避免闭包拿到旧值 */
  const latestRef = useRef({ docId, title, content })
  /** 已保存基线:与最新值比较判断是否真的 dirty */
  const baselineRef = useRef({ title: '', content: '' })
  const dirtyRef = useRef(false)

  const [internalModel, setInternalModel] = useState('')
  const model = embedded ? (modelProp ?? '') : internalModel
  // 页模式:模型偏好持久化本地;面板模式:跟随对话模型,无选择器不可改
  const setModel = useCallback(
    (id: string) => {
      if (embedded) return
      setInternalModel(id)
      localStorage.setItem('aichatt-write-model', id)
    },
    [embedded]
  )
  useEffect(() => {
    if (embedded) return
    setInternalModel(localStorage.getItem('aichatt-write-model') || '')
  }, [embedded])

  useEffect(() => {
    latestRef.current = { docId, title, content }
  }, [docId, title, content])

  // 面板内嵌:meta 上报(保存状态点/字数进度条渲染用)
  useEffect(() => {
    if (embedded) onMetaChange?.({ saveState, chars: content.length })
  }, [embedded, saveState, content.length, onMetaChange])

  // 划词选中态上行(移动端隐藏悬浮胶囊 + 输入条「已选 N 字」+ 发送携带选区上下文)
  useEffect(() => {
    onSelChange?.(sel ? { len: sel.text.length, text: sel.text } : null)
  }, [sel, onSelChange])

  // 面板侧请求清除选区(迷你输入条 ✕)
  useEffect(() => {
    if (clearSelTick) setSel(null)
  }, [clearSelTick])

  // ── 保存 ──
  const doSave = useCallback(async () => {
    const { docId: id, title: t, content: c } = latestRef.current
    setSaveState('saving')
    try {
      const saved = await fetchJson<WriteDocSummary>(`/api/write/docs/${id}`, {
        method: 'PATCH',
        json: { title: t, content: c },
        timeoutMs: 15_000,
      })
      // 保存期间可能又有编辑(latestRef 超前本次快照):保持 dirty,防抖 effect 会再排下一次
      const stale = latestRef.current.title !== t || latestRef.current.content !== c
      baselineRef.current = { title: t, content: c }
      dirtyRef.current = stale
      setSaveState(stale ? 'dirty' : 'saved')
      // 列表缓存局部回写,免整个列表 refetch
      queryClient.setQueryData<{ docs: WriteDocSummary[] }>(queryKeys.write.list(), (old) =>
        old
          ? {
              docs: old.docs.map((d) =>
                d.id === id
                  ? { ...d, title: saved.title, charCount: saved.charCount, updatedAt: saved.updatedAt }
                  : d
              ),
            }
          : old
      )
    } catch (err) {
      console.error('[WriteEditor] save failed:', err)
      setSaveState('error')
    }
  }, [queryClient])

  // 自动保存:内容/标题变化 → 防抖 800ms
  useEffect(() => {
    if (loadState !== 'ready') return
    const changed = title !== baselineRef.current.title || content !== baselineRef.current.content
    if (!changed) return
    dirtyRef.current = true
    setSaveState('dirty')
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => void doSave(), 800)
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [title, content, loadState, doSave])

  // 切换文档/卸载:未保存改动立即补存(keepalive 尽量在页面关闭后也送达)
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      if (dirtyRef.current) {
        const { docId: id, title: t, content: c } = latestRef.current
        dirtyRef.current = false
        void fetchJson(`/api/write/docs/${id}`, {
          method: 'PATCH',
          json: { title: t, content: c },
          keepalive: true,
        }).catch(() => {})
      }
    }
  }, [docId])

  // AI 续写后同步:非 dirty 静默重载;dirty 提示(不覆盖用户未保存编辑)
  const [aiReloadTick, setAiReloadTick] = useState(0)
  useEffect(() => {
    function onDocUpdated(e: Event) {
      const detail = (e as CustomEvent<{ docId?: string }>).detail
      if (detail?.docId !== docId) return
      if (dirtyRef.current) {
        toast.info('AI 已续写这篇文档,为保留你的未保存编辑未自动刷新;保存后再次操作即可同步', { title: '写作画布' })
        return
      }
      setAiReloadTick((t) => t + 1)
    }
    window.addEventListener('aichatt:write-doc-updated', onDocUpdated)
    return () => window.removeEventListener('aichatt:write-doc-updated', onDocUpdated)
  }, [docId])

  // 加载文档
  useEffect(() => {
    const controller = new AbortController()
    setLoadState('loading')
    fetchJson<WriteDocFull>(`/api/write/docs/${docId}`, { signal: controller.signal })
      .then((doc) => {
        setTitle(doc.title)
        setContent(doc.content)
        baselineRef.current = { title: doc.title, content: doc.content }
        dirtyRef.current = false
        setSaveState('saved')
        setLoadState('ready')
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        console.error('[WriteEditor] load failed:', err)
        setLoadState('error')
      })
    return () => controller.abort()
  }, [docId, aiReloadTick]) // eslint-disable-line react-hooks/exhaustive-deps -- setTitle 受控时上行到面板,无需进依赖

  // 手动保存快捷键 ⌘/Ctrl+S
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (dirtyRef.current) void doSave()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [doSave])

  // ── 流式生成 ──
  const runStream = useCallback(
    async (body: Record<string, unknown>, onText: (t: string) => void) => {
      const controller = new AbortController()
      abortRef.current = controller
      setGenerating(true)
      try {
        const res = await fetch('/api/write/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, model: model || undefined }),
          signal: controller.signal,
        })
        if (!res.ok || !res.body) {
          const detail = (await res.json().catch(() => null)) as { error?: string } | null
          throw new Error(detail?.error || `HTTP ${res.status}`)
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const events = buffer.split('\n\n')
          buffer = events.pop() ?? ''
          for (const evt of events) {
            const line = evt.trim()
            if (!line.startsWith('data:')) continue
            let payload: { type?: string; value?: string }
            try {
              payload = JSON.parse(line.slice(5).trim())
            } catch {
              continue
            }
            if (payload.type === 'text' && payload.value) {
              onText(payload.value)
            } else if (payload.type === 'error') {
              throw new Error(payload.value || '生成失败')
            }
          }
        }
      } catch (err) {
        // 用户主动停止:保留已生成部分,不算错误
        if ((err as Error | null)?.name === 'AbortError') return
        toast.error(err instanceof Error ? err.message : '生成失败', { title: '写作画布' })
        throw err
      } finally {
        abortRef.current = null
        setGenerating(false)
      }
    },
    [model]
  )

  /** 划词 → AI 改写(流式进预览面板) */
  const openRewrite = useCallback(
    (selection: SelectionState, preset: string) => {
      setPreview({
        start: selection.start,
        end: selection.end,
        original: selection.text,
        instruction: preset,
        output: '',
        streaming: true,
      })
      setSel(null)
      void (async () => {
        try {
          await runStream(
            { docId, action: 'rewrite', instruction: preset, selection: selection.text },
            (t) => setPreview((p) => (p ? { ...p, output: p.output + t } : p))
          )
        } catch {
          /* 已 toast */
        } finally {
          setPreview((p) => (p ? { ...p, streaming: false } : p))
        }
      })()
    },
    [docId, runStream]
  )

  // 选区改写桥: 迷你输入条在选中态发送的指令 → openRewrite(选区+指令),
  // 走 /api/write/generate rewrite 专用通道(只输出替换段落),预览卡确认后应用。
  // 监听必须声明在 openRewrite 之后(否则 TS used-before-declaration)
  useEffect(() => {
    function onSelRewrite(e: Event) {
      const instruction = (e as CustomEvent<{ instruction?: string }>).detail?.instruction
      if (typeof instruction !== 'string' || !instruction.trim()) return
      if (!sel) return
      openRewrite(sel, instruction)
    }
    window.addEventListener(WRITE_SEL_REWRITE_EVENT, onSelRewrite)
    return () => window.removeEventListener(WRITE_SEL_REWRITE_EVENT, onSelRewrite)
  }, [sel, openRewrite])

  /** 划词 → 在选区之后插入/续写(流式追加到选区末尾,光标跟随) */
  const runInsert = useCallback(
    (selection: SelectionState, instr?: string) => {
      const end = selection.end
      setSel(null)
      let acc = ''
      void (async () => {
        try {
          await runStream(
            { docId, action: 'insert', instruction: instr, selection: selection.text },
            (t) => {
              acc += t
              setContent((prev) => prev.slice(0, end) + acc + prev.slice(end))
              // 光标跟随到插入末尾让过程可见(折叠光标不会触发划词)
              requestAnimationFrame(() => {
                const ta = taRef.current
                if (ta) ta.setSelectionRange(end + acc.length, end + acc.length)
              })
            }
          )
        } catch {
          /* 已 toast */
        }
      })()
    },
    [docId, runStream]
  )

  /** 划词 → 删除选中内容(纯前端,自动保存兜底持久化) */
  const handleDeleteSel = useCallback((selection: SelectionState) => {
    setContent((prev) =>
      selection.end <= prev.length
        ? prev.slice(0, selection.start) + prev.slice(selection.end)
        : prev
    )
    setSel(null)
  }, [])

  /** 划词 → 去AI味(本地规则,零 token,直接出预览) */
  const handleDeai = useCallback(
    (selection: SelectionState) => {
      const r = deAiFlavor(selection.text)
      if (r.hits === 0) {
        toast.success('这段没命中 AI 套话，已经很干净了', { title: '去AI味' })
        return
      }
      setPreview({
        start: selection.start,
        end: selection.end,
        original: selection.text,
        instruction: '去AI味(本地规则替换)',
        output: r.text,
        streaming: false,
        deaiStats: r.byCategory.map((c) => `${c.label}×${c.hits}`).join(' · '),
      })
      setSel(null)
    },
    []
  )

  const applyPreview = useCallback(() => {
    setPreview((p) => {
      if (!p) return null
      setContent((prev) =>
        p.end <= prev.length ? prev.slice(0, p.start) + p.output + prev.slice(p.end) : prev
      )
      return null
    })
  }, [])

  /** 镜像测距:把 value[:end] 灌进镜像 div,读两个标记点的坐标(内容坐标系) */
  const measureSel = useCallback((start: number, end: number) => {
    const ta = taRef.current
    const mirror = mirrorRef.current
    if (!ta || !mirror) return null
    // textarea 出滚动条时 clientWidth 变窄,镜像宽度必须跟着(否则换行点漂移)
    mirror.style.width = `${ta.clientWidth}px`
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    mirror.innerHTML =
      esc(ta.value.slice(0, start)) +
      '<i data-ms></i>' +
      esc(ta.value.slice(start, end)) +
      '<i data-me></i>'
    const ms = mirror.querySelector<HTMLElement>('[data-ms]')
    const me = mirror.querySelector<HTMLElement>('[data-me]')
    if (!ms || !me) return null
    return { ax: ms.offsetLeft, ay: ms.offsetTop, bx: me.offsetLeft, by: me.offsetTop }
  }, [])

  // 划词检测:textarea 原生 select 事件(桌面鼠标与移动端长按都触发)
  const handleSelect = useCallback(() => {
    if (generating || preview) return
    const ta = taRef.current
    if (!ta) return
    const { selectionStart, selectionEnd } = ta
    if (selectionEnd > selectionStart) {
      const text = ta.value.slice(selectionStart, selectionEnd)
      if (text.trim()) {
        const pos = measureSel(selectionStart, selectionEnd)
        setSel({
          start: selectionStart,
          end: selectionEnd,
          text,
          ...(pos ?? { ax: 0, ay: 0, bx: 0, by: 0 }),
        })
        return
      }
    }
    setSel(null)
  }, [generating, preview, measureSel])

  // 划词浮条定位:两段式 —— 先按选区坐标粗定位,渲染后量浮条自身尺寸收敛;
  // 默认悬在选区上方,贴顶时翻到选区下方;水平夹在正文区内
  useLayoutEffect(() => {
    if (!sel) {
      setFtPos(null)
      return
    }
    const ta = taRef.current
    const wrap = bodyRef.current
    const ft = ftRef.current
    if (!ta || !wrap || !ft || !ft.offsetWidth) return
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 36
    const fw = ft.offsetWidth
    const fh = ft.offsetHeight
    const maxLeft = Math.max(8, wrap.clientWidth - fw - 8)
    const left = Math.min(Math.max(8, sel.ax - fw / 2), maxLeft)
    let top = sel.ay - ta.scrollTop - fh - 8
    if (top < 4) top = sel.by - ta.scrollTop + lh + 8
    setFtPos({ left, top: Math.max(4, top) })
  }, [sel])

  // 选中态期间正文滚动:浮条跟随(内容坐标 - scrollTop 实时换算)
  useEffect(() => {
    const ta = taRef.current
    if (!ta || !sel) return
    function onScroll() {
      const el = taRef.current
      const wrap = bodyRef.current
      const ft = ftRef.current
      if (!el || !wrap || !ft || !ft.offsetWidth) return
      setSel((cur) => {
        if (!cur) return cur
        const lh = parseFloat(getComputedStyle(el).lineHeight) || 36
        const fw = ft.offsetWidth
        const fh = ft.offsetHeight
        const maxLeft = Math.max(8, wrap.clientWidth - fw - 8)
        const left = Math.min(Math.max(8, cur.ax - fw / 2), maxLeft)
        let top = cur.ay - el.scrollTop - fh - 8
        if (top < 4) top = cur.by - el.scrollTop + lh + 8
        setFtPos({ left, top: Math.max(4, top) })
        return cur
      })
    }
    ta.addEventListener('scroll', onScroll)
    return () => ta.removeEventListener('scroll', onScroll)
  }, [sel])

  // 生成时正文自动滚到底(用户手动上滚会被拉回,生成场景可接受)
  useEffect(() => {
    if (generating && taRef.current) {
      taRef.current.scrollTop = taRef.current.scrollHeight
    }
  }, [content, generating])

  // ── 加载/错误态 ──
  if (loadState === 'loading') {
    return (
      <div className="h-full flex items-center justify-center text-content-muted">
        <Loader2 className="w-5 h-5 animate-spin" />
      </div>
    )
  }
  if (loadState === 'error') {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-content-muted">
        <p className="text-xs">文档加载失败</p>
        <button
          onClick={() => setLoadState('loading')}
          className="text-xs text-accent hover:underline"
        >
          重试
        </button>
      </div>
    )
  }

  /** 划词动作按钮组:桌面浮条与移动端顶条共用 */
  const selActions = (
    <>
      <span className="text-[11px] text-content-secondary px-1.5 hidden sm:inline">
        已选 {sel?.text.length ?? 0} 字
      </span>
      {SEL_PRESETS.map((a) => (
        <button
          key={a.label}
          onClick={() => sel && openRewrite(sel, a.preset)}
          disabled={generating || !sel}
          className="px-2.5 py-1 rounded-md text-xs font-medium text-content-secondary
            hover:text-content-primary hover:bg-surface-subtle disabled:opacity-50 transition-colors"
        >
          {a.label}
        </button>
      ))}
      <button
        onClick={() => sel && runInsert(sel)}
        disabled={generating || !sel}
        className="px-2.5 py-1 rounded-md text-xs font-medium text-content-secondary
          hover:text-content-primary hover:bg-surface-subtle disabled:opacity-50 transition-colors"
        title="从选中文字之后继续写"
      >
        续写
      </button>
      <button
        onClick={() => sel && handleDeai(sel)}
        className="px-2.5 py-1 rounded-md text-xs font-medium text-accent
          hover:bg-accent/10 disabled:opacity-50 transition-colors"
        disabled={generating || !sel}
        title="本地规则替换 AI 套话,不消耗 token"
      >
        去AI味
      </button>
      <button
        onClick={() => sel && handleDeleteSel(sel)}
        disabled={generating || !sel}
        className="px-2.5 py-1 rounded-md text-xs font-medium text-danger
          hover:bg-danger/10 disabled:opacity-50 transition-colors"
        title="删除选中的文字"
      >
        删除
      </button>
      <button
        onClick={() => setSel(null)}
        className="p-1 rounded-md text-content-muted hover:text-content-primary hover:bg-surface-subtle transition-colors"
        aria-label="取消选择"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </>
  )

  return (
    <div className="h-full flex flex-col min-h-0 relative">
      {/* 顶栏:标题 / 字数 / 保存状态 / 模型 —— 面板内嵌模式由 WriteDocPanel
          的面板头+状态簇接管,这里不再渲染(避免双层头) */}
      {!embedded && (
        <div className="shrink-0 flex items-center gap-2 h-11 px-2.5 md:px-3 border-b border-line">
          <button
            onClick={onOpenList}
            className="md:hidden p-1.5 -ml-1 rounded-md text-content-secondary hover:text-content-primary hover:bg-surface-subtle transition-colors"
            aria-label="文档列表"
            title="文档列表"
          >
            <PanelLeft className="w-4 h-4" />
          </button>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="未命名"
            className="flex-1 min-w-0 bg-transparent text-sm font-medium text-content-primary outline-none placeholder:text-content-muted"
          />
          <span
            className={cn(
              'shrink-0 text-[11px]',
              saveState === 'error' ? 'text-danger' : 'text-content-secondary'
            )}
          >
            {SAVE_LABEL[saveState]}
          </span>
          <span className="shrink-0 text-[11px] text-content-secondary tabular-nums">
            {content.length} 字
          </span>
          <ModelSelector
            models={models}
            value={model || models[0]?.id || ''}
            onChange={setModel}
            compact
          />
        </div>
      )}

      {/* 正文 */}
      <div ref={bodyRef} className="flex-1 min-h-0 relative">
        <textarea
          ref={taRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onSelect={handleSelect}
          placeholder={'在这里直接写…\n\n小技巧:选中任意文字可续写/润色/扩写/改写/去AI味'}
          spellCheck={false}
          className={cn(
            'absolute inset-0 w-full h-full resize-none bg-transparent outline-none',
            TA_TYPO,
            TA_PAD,
            'text-content-primary placeholder:text-content-muted/70 placeholder:text-sm'
          )}
        />
        {/* 镜像测距:与 textarea 同排版同内边距,量选区坐标后清空 */}
        <div
          ref={mirrorRef}
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-0 overflow-hidden invisible whitespace-pre-wrap break-words select-none',
            TA_TYPO,
            TA_PAD
          )}
        />
        {/* 划词工具条 · 全断点悬浮:镜像测距贴选区,贴顶翻下方,水平夹在容器内。
            已选字数由 composer 的「已选 N 字」chip 承担(移动端标签隐藏) */}
        {sel && !preview && (
          <div
            ref={ftRef}
            className="flex absolute z-20 items-center gap-1 rounded-card border border-line bg-surface px-1.5 py-1
              shadow-[0_4px_16px_rgb(0_0_0/0.12),0_1px_3px_rgb(0_0_0/0.06)]"
            style={{
              left: ftPos?.left ?? -9999,
              top: ftPos?.top ?? -9999,
              visibility: ftPos ? 'visible' : 'hidden',
            }}
          >
            {selActions}
          </div>
        )}
      </div>

      {/* 改写/去AI味预览:悬浮卡(真浮层)锚在编辑区底部、与正文版心同宽,
          不再占用底部通栏;不透明 surface 保证对照文字可读 */}
      {preview && (
        <div className="absolute bottom-3 inset-x-4 md:inset-x-[max(40px,calc(50%-320px))] z-20">
          <div
            className="mx-auto w-full max-w-[640px] rounded-card border border-line bg-surface overflow-hidden flex flex-col max-h-[52vh]
              shadow-[0_8px_28px_rgb(0_0_0/0.16),0_2px_6px_rgb(0_0_0/0.08)]"
          >
            <div className="flex items-center justify-between gap-2 px-3.5 py-2 border-b border-line shrink-0">
              <div className="min-w-0">
                <div className="text-xs font-medium text-content-primary truncate">
                  {preview.instruction}
                </div>
                <div className="text-[11px] text-content-secondary mt-0.5">
                  原 {preview.original.length} 字 → 新 {preview.output.length} 字
                  {preview.deaiStats ? ` · ${preview.deaiStats}` : ''}
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={() => setPreview(null)}
                  className="px-2.5 py-1.5 rounded-md text-xs text-content-secondary hover:text-content-primary hover:bg-surface-subtle transition-colors"
                >
                  放弃
                </button>
                <button
                  onClick={applyPreview}
                  disabled={preview.streaming || !preview.output.trim()}
                  className="px-3 py-1.5 rounded-md text-xs font-medium bg-accent text-accent-foreground hover:bg-accent/90 disabled:opacity-50 transition-colors"
                >
                  应用替换
                </button>
              </div>
            </div>
            <div className="px-3.5 py-2.5 grid gap-2 md:grid-cols-2 overflow-y-auto">
              <div className="hidden md:block">
                <div className="text-[11px] text-content-secondary mb-1">原文</div>
                <div className="text-xs leading-6 text-content-secondary whitespace-pre-wrap max-h-40 overflow-y-auto p-2 rounded-lg bg-surface-muted border border-line">
                  {preview.original}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-content-secondary mb-1 flex items-center gap-1">
                  新文
                  {preview.streaming && <Loader2 className="w-3 h-3 animate-spin text-accent" />}
                </div>
                <div className="text-xs leading-6 text-content-primary whitespace-pre-wrap max-h-40 overflow-y-auto p-2 rounded-lg bg-surface-muted border border-line">
                  {preview.output || '…'}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
