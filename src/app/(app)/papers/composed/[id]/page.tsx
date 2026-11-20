'use client'

/**
 * /papers/composed/[id] —— 拟卷卷面页(双态:屏显编辑 / 打印纯净)。
 *
 * 数据与操作口径(2026-11-11 与用户定案):
 * - 全部题目与答案出自试卷库有官方答案的真题,零 AI 拟题;本页不做任何内容改写。
 * - 修改 = 整题级槽位操作(换一题/移除/加一题/整卷重摇),每次 PATCH 返回最新全量直接换缓存;
 * - 「这题有误」= PaperQuestion.flagged 全局拉黑(原卷永不动),本卷同步移除该题;
 * - 卷面版式 = 霞鹜文楷全卷(design/preview-paper-fonts.html 方案三,替换原方案A 三体仿真),材料块左细线锚定,材料题组共享材料只排一次;
 * - 打印 = 浏览器原生分页,@media print 隐藏全部编辑层并解除 shell 裁剪链。
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ChevronLeft, GripVertical, Loader2, Printer, RefreshCw, Search, Sparkles, Trash2, X } from 'lucide-react'
import katex from 'katex'
import { AuthErrorBoundary } from '@/components/AuthErrorBoundary'
import { ClientOnly } from '@/components/ClientOnly'
import { ComposedAssistant } from '@/components/papers/ComposedAssistant'
import { PaperBrandSeal } from '@/components/papers/PaperBrandSeal'
import { confirmDialog } from '@/components/ui/ConfirmDialog'
import { fetchJson } from '@/lib/query/fetcher'
import { queryKeys } from '@/lib/query/keys'
import { PRINT_BASE_CSS, PRINT_SHELL_UNCHAIN_CSS, printPageCss } from '@/lib/print/print-css'
import { usePrintEvent } from '@/hooks/usePrintEvent'
import { providersModelsQuery, isModelAvailable, providerKeysStatusQuery } from '@/lib/query/providers'
import { toast } from '@/lib/toast'
import styles from './ComposedPaper.module.css'
// 卷面专用字体(霞鹜文楷屏幕版),仅本页引入;文件在 public/fonts/lxgw-wenkai-screen/
import './wenkai-screen.css'

const TOPBAR_H = 52

interface ComposedSlotView {
  slotId: string
  section: string | null
  kind: string
  score: number
  number: number
  stem: string | null
  options: string[]
  images: string[]
  answer: string | null
  multiple: boolean
  /** official=官方答案，ai=AI 参考答案（答案页逐题挂标注） */
  answerSource?: string
  sourceTitle: string | null
  sourceSlug: string | null
  sourceYear: string | null
  sourceNumber: number | null
  /** 非真题槽来源:textbook/ai-variant(真题槽 null) */
  inlineSource: string | null
  sourceRef: string | null
  /** 真题槽的 PaperQuestion id(今晚测验对答错题出变式用);内联槽/旧缓存为 undefined */
  paperQuestionId?: string | null
}

interface ComposedPaperView {
  id: string
  title: string
  subject: string
  baseSlug: string
  onlyChoice: boolean
  totalScore: number
  durationMin: number
  createdAt: string
  slots: ComposedSlotView[]
  sources: string[]
}

interface CandidateItem {
  id: string
  stem: string
  kind: string
  score: number
  section: string | null
  paperTitle: string
  number: number
  /** official=官方 ai=AI 参考答案 */
  answerSource?: string
  /** 全量题干与选项(查看完整题目用) */
  fullStem: string
  options: string[]
}

const SUBJECT_LABELS: Record<string, string> = {
  math: '数学', chinese: '语文', english: '英语', physics: '物理', chemistry: '化学',
  biology: '生物', history: '历史', geography: '地理', politics: '政治', other: '综合',
}

/** 遍历文本节点,把 $...$ / $$...$$ 渲染成 KaTeX(与原卷预览页同一套实现) */
function renderTexIn(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const targets: Text[] = []
  let node: Node | null
  while ((node = walker.nextNode())) {
    const t = node as Text
    if (t.nodeValue && t.nodeValue.includes('$')) targets.push(t)
  }
  for (const t of targets) {
    const value = t.nodeValue ?? ''
    const re = /\$\$([^$\n]+?)\$\$|\$([^$\n]+?)\$/g
    const frag = document.createDocumentFragment()
    let last = 0
    let m: RegExpExecArray | null
    let changed = false
    while ((m = re.exec(value))) {
      if (m.index > last) frag.appendChild(document.createTextNode(value.slice(last, m.index)))
      const display = !!m[1]
      const span = document.createElement('span')
      span.className = display ? 'pv-tex-block' : 'pv-tex'
      span.innerHTML = katex.renderToString((m[1] ?? m[2]) ?? '', { throwOnError: false, displayMode: display })
      frag.appendChild(span)
      last = m.index + m[0].length
      changed = true
    }
    if (changed) {
      if (last < value.length) frag.appendChild(document.createTextNode(value.slice(last)))
      t.parentNode?.replaceChild(frag, t)
    }
  }
}

/**
 * 题干拆材料:录入契约为「<题干>\n【材料】\n<材料全文>」(标记独占一行)。
 * 库内现实(实测):多数材料题一题一材料,少数组共享同段;因此一律拆分——
 * 相邻同材料的组共享一块,孤例也独立成文楷材料块(全卷文楷,材料块靠左细线锚定)。
 * 保守边界:标记必须独占一行(前后是行首/行尾),题干里引用性出现「【材料】」不会误切。
 */
const MATERIAL_SPLIT_RE = /(?:^|\n)【材料】(?:\n|$)/
function splitMaterial(stem: string): { questionText: string; material: string | null } {
  const m = MATERIAL_SPLIT_RE.exec(stem)
  if (!m) return { questionText: stem, material: null }
  return {
    questionText: stem.slice(0, m.index).replace(/\n+$/, ''),
    material: stem.slice(m.index + m[0].length).replace(/\n+$/, ''),
  }
}

/** 选择题官方答案抽字母(口径与引擎自检一致):「16.B. 是认识的来源」→ B + 解析残段 */
function parseChoiceAnswer(answer: string): { letters: string | null; rest: string } {
  const numMatch = /^(\d+)\s*[.、．]/.exec(answer)
  const body = numMatch ? answer.slice(numMatch[0].length) : answer
  const letterMatch = /^\s*[.、．:：]?\s*([A-Z]{1,8})\b/.exec(body)
  if (!letterMatch) return { letters: null, rest: answer }
  return { letters: letterMatch[1], rest: body.slice(letterMatch[0].length).trim() }
}

/** 去掉与本卷题号相同的编号前缀(纯格式去重,内容一字不动) */
function stripOwnNumber(answer: string, number: number): string {
  const m = new RegExp(`^\\s*${number}\\s*[.、．]\\s*`).exec(answer)
  return m ? answer.slice(m[0].length) : answer
}

/**
 * 打印全局规则(随本页挂载生效,离开页面即失效):解除壳裁剪链、隐藏装饰层,
 * 让浏览器原生分页只输出卷面。公共骨架(@page/html,body 解锁/壳豁免链)收敛在
 * @/lib/print/print-css,纪律与坑清单见其文件头;名单必须与根布局/壳结构同步维护
 * (2026-11-11 修「只能打印一张」:根布局两层壳不在旧名单里,内容被钉在一屏高度)。
 * 这些选择器是全局类,不能进 CSS 模块(purity 检查要求选择器带本地类),用 <style> 注入。
 */
const PRINT_GLOBAL_CSS = `
@media print {
  ${printPageCss()}
  ${PRINT_BASE_CSS}
  ${PRINT_SHELL_UNCHAIN_CSS}
  /* AI 助手(悬浮球/停靠列/浮卡)整层不进打印 */
  .paper-assistant-print-hide { display: none !important; }
}
`

type RenderItem =
  | { type: 'section'; section: string | null; note: string; bucket: { section: string | null; kind: string; score: number } | null; key: string }
  | { type: 'material'; body: string; marks?: MarkSpan[]; key: string }
  | { type: 'question'; slot: ComposedSlotView; questionText: string; showScoreTag: boolean; key: string }

// ===================== 材料标记重建(渲染层) =====================
/**
 * 题面常引用「加点字/画波浪线的词语/划线」等原卷排版标记,录入层只有纯文本,
 * 标记丢失会让这类题没法作答。这里从选项反推标记位置,纯渲染层恢复、内容一字不动:
 * - 加点 → 着重号(dotted 下划点)
 * - 波浪线 → 波浪下划线
 * - 划线/横线 → 直下划线
 * 反推不出的(纯拼音选项/句子对选项/无选项的句子语病题)静默跳过。
 */
type MarkStyle = 'dot' | 'wavy' | 'line'
interface MarkSpan { start: number; end: number; style: MarkStyle }

function detectMarkStyle(stem: string): MarkStyle | null {
  if (/波浪线/.test(stem)) return 'wavy'
  if (/加点/.test(stem)) return 'dot'
  if (/画横线|划线|下划线/.test(stem)) return 'line'
  return null
}

/** 从单个选项反推被标记的字符串;sentence 用于「句子　　字：释义」型在句内定位 */
function optionMarkTargets(option: string, style: MarkStyle): Array<{ target: string; sentence?: string }> {
  const text = option.replace(/^[A-D][.、．]\s*/, '').trim()
  if (!text) return []
  if (style === 'dot') {
    // 解释型:「句子　　字：释义」→ 在句内给「字」着重号
    const expl = text.match(/^([\s\S]{4,}?)[\s　]{2,}([^：]{1,2})：/)
    if (expl) return [{ target: expl[2], sentence: expl[1] }]
    // 注音型:X（pīn）→ 点 X(取拼音括号前的汉字)
    const py = text.match(/([一-龥])（[a-zA-Z]/)
    if (py) return [{ target: py[1] }]
  }
  // 词语/短语型:整词(去内部空白对齐原文)
  return [{ target: text.replace(/\s+/g, '') }]
}

function computeMaterialMarks(body: string, refs: Array<{ stem: string; options: string[] }>): MarkSpan[] {
  const spans: MarkSpan[] = []
  for (const ref of refs) {
    const style = detectMarkStyle(ref.stem)
    if (!style) continue
    for (const option of ref.options) {
      for (const t of optionMarkTargets(option, style)) {
        if (!t.target) continue
        if (t.sentence) {
          const sAt = body.indexOf(t.sentence)
          if (sAt < 0) continue
          const cAt = body.indexOf(t.target, sAt)
          if (cAt >= 0 && cAt < sAt + t.sentence.length) spans.push({ start: cAt, end: cAt + t.target.length, style })
        } else {
          const at = body.indexOf(t.target)
          if (at >= 0) spans.push({ start: at, end: at + t.target.length, style })
        }
      }
    }
  }
  // 重叠合并:按起点排序,丢弃与已选区间相交的
  spans.sort((a, b) => a.start - b.start)
  const out: MarkSpan[] = []
  for (const s of spans) {
    const prev = out[out.length - 1]
    if (prev && s.start < prev.end) continue
    out.push(s)
  }
  return out
}

function renderMarkedBody(body: string, marks: MarkSpan[]) {
  const nodes: React.ReactNode[] = []
  let cursor = 0
  marks.forEach((m, i) => {
    if (m.start > cursor) nodes.push(body.slice(cursor, m.start))
    const cls = m.style === 'wavy' ? styles.markWavy : m.style === 'dot' ? styles.markDot : styles.markLine
    nodes.push(
      <span key={i} className={cls}>
        {body.slice(m.start, m.end)}
      </span>
    )
    cursor = m.end
  })
  if (cursor < body.length) nodes.push(body.slice(cursor))
  return nodes
}

/** 大题组内分值是否统一(统一时题面不再重复标分) */
function uniformScore(slots: ComposedSlotView[]): boolean {
  return slots.length > 1 && slots.every((s) => s.score === slots[0].score)
}

function buildRenderItems(paper: ComposedPaperView): RenderItem[] {
  const slots = paper.slots
  // 连续同 section 为一组(大题),组头给事实性说明+加题锚点;组内材料块:相邻同材料共享,孤例单排
  const items: RenderItem[] = []
  let i = 0
  while (i < slots.length) {
    const section = slots[i].section
    let j = i
    while (j < slots.length && slots[j].section === section) j++
    const group = slots.slice(i, j)
    const total = group.reduce((acc, s) => acc + s.score, 0)
    const uniform = uniformScore(group)
    items.push({
      type: 'section',
      section,
      note: uniform
        ? `（本大题共 ${group.length} 小题，每小题 ${group[0].score} 分，共 ${total} 分。）`
        : `（本大题共 ${group.length} 小题，共 ${total} 分。）`,
      bucket: { section: group[0].section, kind: group[0].kind, score: group[0].score },
      key: `sec:${group[0].slotId}`,
    })
    let prevMat: string | null = null
    for (const slot of group) {
      const split = splitMaterial(slot.stem ?? '')
      if (split.material && split.material !== prevMat) {
        items.push({ type: 'material', body: split.material, key: `mat:${slot.slotId}` })
      }
      prevMat = split.material
      items.push({
        type: 'question',
        slot,
        questionText: split.questionText,
        showScoreTag: group.length > 1 && !uniform,
        key: slot.slotId,
      })
    }
      i = j
    }
    // 材料标记重建:材料块向后扫到下一块材料为止的题,从其选项反推「加点/划线」标记位置
    for (let k = 0; k < items.length; k++) {
      const it = items[k]
      if (it.type !== 'material') continue
      const refs: Array<{ stem: string; options: string[] }> = []
      for (let j = k + 1; j < items.length; j++) {
        const nx = items[j]
        if (nx.type !== 'question') break
        refs.push({ stem: nx.questionText, options: nx.slot.options })
      }
      const marks = computeMaterialMarks(it.body, refs)
      if (marks.length) it.marks = marks
    }
    return items
  }

// ===================== 拖拽排序单题块(@dnd-kit sortable) =====================

/**
 * 单题块 = 题干/选项 + 编辑行(把手在最左)。方案A(design/preview-paper-drag.html):
 * 只许从「⠿」把手拖,正文选择不受影响;拖动中半透明+accent 描边,松手 PATCH reorder。
 * 落败语义:PATCH 失败时 items 不变,视觉顺序自动回弹(dnd-kit transform 重置)。
 */
function SortableQuestionBlock({
  item,
  busyKey,
  dropPos,
  movedLabel,
  onPanel,
  onReplace,
  onRemove,
  onFlag,
}: {
  item: Extract<RenderItem, { type: 'question' }>
  busyKey: string | null
  /** 拖拽落点指示:该块上/下缘显示虚线 */
  dropPos?: 'before' | 'after'
  /** 拖拽成功的轻浮窗文案(挂本块右上) */
  movedLabel?: string
  onPanel: (t: { section: string | null; kind: string; score: number; afterSlotId?: string; label?: string }) => void
  onReplace: (body: Record<string, unknown>, key: string) => void
  onRemove: (body: Record<string, unknown>, key: string) => void
  onFlag: (slot: ComposedSlotView) => void
}) {
  const slot = item.slot
  const busy = !!busyKey
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: slot.slotId,
    disabled: busy,
  })
  return (
    <div
      ref={setNodeRef}
      className={styles.qWrap}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : undefined,
        position: 'relative',
        zIndex: isDragging ? 20 : undefined,
        outline: isDragging ? '2px solid var(--accent)' : undefined,
        outlineOffset: 4,
        borderRadius: 10,
      }}
    >
      {movedLabel && <span className={`${styles.movedTag} ${styles.printHide}`}>✓ {movedLabel}</span>}
      {dropPos === 'before' && <div className={styles.dropLine} />}
      <div className={styles.q}>
        <div className={styles.qText}>
          <span className={styles.qNo}>{slot.number}.</span>
          {slot.inlineSource && (
            <span className={styles.srcBadge}>
              〔{slot.inlineSource === 'textbook' ? slot.sourceRef?.replace(/^课本·/, '课本 · ') ?? '课本' : 'AI 拟题'}〕
            </span>
          )}
          {item.questionText}
          {item.showScoreTag && <span className={styles.scoreTag}>（{slot.score}分）</span>}
        </div>
        {slot.options.length > 0 && (
          <div className={styles.opts}>
            {slot.options.map((o, i) => (
              <div key={i}>{o}</div>
            ))}
          </div>
        )}
      </div>
      <div className={`${styles.editBar} ${styles.printHide}`}>
        <button
          type="button"
          ref={setActivatorNodeRef}
          className={`${styles.editBtn} touch-none ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
          {...attributes}
          {...listeners}
          disabled={busy}
          aria-label="拖动排序"
          title="拖动排序"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className={styles.editBtn}
          disabled={busy}
          onClick={() =>
            onPanel({
              section: slot.section,
              kind: slot.kind,
              score: slot.score,
              afterSlotId: slot.slotId,
              label: `第 ${slot.number} 题后`,
            })
          }
        >
          后面加一题
        </button>
        {!slot.inlineSource && (
          <button
            type="button"
            className={styles.editBtn}
            disabled={busy}
            onClick={() => onReplace({ op: 'replace', slotId: slot.slotId }, `replace:${slot.slotId}`)}
          >
            {busyKey === `replace:${slot.slotId}` ? '换题中…' : '换一题'}
          </button>
        )}
        <button
          type="button"
          className={styles.editBtn}
          disabled={busy}
          onClick={() => onRemove({ op: 'remove', slotId: slot.slotId }, `remove:${slot.slotId}`)}
        >
          {busyKey === `remove:${slot.slotId}` ? '移除中…' : '移除'}
        </button>
        <button type="button" className={`${styles.editBtn} ${styles.editBtnDanger}`} disabled={busy} onClick={() => onFlag(slot)}>
          这题有误
        </button>
      </div>
      {dropPos === 'after' && <div className={styles.dropLine} />}
    </div>
  )
}

// ===================== 加题候选面板 =====================

/** 举一反三变式预览(生成接口返回 + 前端动作状态) */
interface VariantPreview {
  stem: string
  options: string[]
  answer: string
  kind: 'choice' | 'answer'
  score: number
  /** basic/medium/hard */
  difficulty: string
  sourceRef: string
  /** 已收进题库(Question 练习题库) */
  saved: boolean
  /** 已加入本卷(内联 AI 拟题槽) */
  added: boolean
}

function CandidatePanel({
  id,
  subject,
  target,
  busyKey,
  onAdd,
  onPatch,
  onClose,
}: {
  id: string
  /** 本卷学科(收进题库落 Question.subject 用) */
  subject: string
  target: { section: string | null; kind: string; score: number; afterSlotId?: string; label?: string }
  busyKey: string | null
  /** 加入成功返回 true(失败 doPatch 已 toast,候选行原地保留) */
  onAdd: (paperQuestionId: string) => boolean | Promise<boolean>
  /** 卷面 PATCH 通道(= doPatch,举一反三「加入本卷」复用同一执行链) */
  onPatch: (body: Record<string, unknown>, key: string) => Promise<boolean>
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [dq, setDq] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // 加入成功的过渡:灰显(held)→淡出(fading)→摘除。快照在手独立渲染,不受 refetch 摘题影响
  const [ghosts, setGhosts] = useState<Array<{ item: CandidateItem; index: number; fading: boolean }>>([])
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 250)
    return () => clearTimeout(t)
  }, [q])
  const searchMode = dq.length > 0

  const handleAdd = async (c: CandidateItem, index: number) => {
    const ok = await onAdd(c.id)
    if (!ok) return
    setGhosts((g) => [...g, { item: c, index, fading: false }])
    setTimeout(() => {
      setGhosts((g) => g.map((x) => (x.item.id === c.id ? { ...x, fading: true } : x)))
      setTimeout(() => {
        setGhosts((g) => g.filter((x) => x.item.id !== c.id))
        setDismissed((s) => new Set(s).add(c.id))
        // 灰卡退场后才失效候选缓存,让列表与卷面真实状态对齐(refetch 摘走该题)
        qc.invalidateQueries({ queryKey: [...queryKeys.all, 'papers', 'composed', id, 'candidates'] })
      }, 260)
    }, 1400)
  }

  // ── 举一反三:按候选原题出 AI 变式(预览 → 收进题库 / 加入本卷) ──
  // 模型口径与卷面助手一致:公共池优先,有 Key 的优先
  const { data: allModels } = useQuery({ ...providersModelsQuery })
  const { data: keyProviders } = useQuery<Set<string>>({ ...providerKeysStatusQuery })
  const modelId = useMemo(() => {
    if (!allModels) return null
    const avail = keyProviders ? allModels.filter((m) => isModelAvailable(m, keyProviders)) : allModels
    return avail.find((m) => m.publicPool)?.id || avail[0]?.id || null
  }, [allModels, keyProviders])
  // 生成状态按候选 id 存(面板重开即重置);同一时刻只允许一路生成,防连点烧额度
  const [variantMap, setVariantMap] = useState<Record<string, { status: 'loading' | 'done' | 'error'; items: VariantPreview[] }>>({})
  const genBusy = Object.values(variantMap).some((v) => v.status === 'loading')
  const [savingVariant, setSavingVariant] = useState<string | null>(null)

  const onVariants = async (c: CandidateItem) => {
    if (genBusy || !modelId) return
    setExpandedId(c.id)
    setVariantMap((m) => ({ ...m, [c.id]: { status: 'loading', items: [] } }))
    try {
      const r = await fetchJson<{ variants: Array<Omit<VariantPreview, 'saved' | 'added'>> }>(
        `/api/papers/composed/${id}/variants`,
        { method: 'POST', json: { paperQuestionId: c.id, modelId }, timeoutMs: 120_000 }
      )
      setVariantMap((m) => ({
        ...m,
        [c.id]: { status: 'done', items: (r.variants ?? []).map((v) => ({ ...v, saved: false, added: false })) },
      }))
    } catch (err) {
      console.error('[variants] generate failed:', err)
      setVariantMap((m) => ({ ...m, [c.id]: { status: 'error', items: [] } }))
    }
  }

  /** 收进题库:进 Question 练习题库(选择题题干按库规约合并选项行);部分成功语义由 save 端点兜底 */
  const onSaveVariant = async (candId: string, vi: number) => {
    const v = variantMap[candId]?.items[vi]
    if (!v || v.saved || savingVariant) return
    setSavingVariant(`${candId}:${vi}`)
    try {
      await fetchJson('/api/study/quiz/save', {
        method: 'POST',
        json: {
          items: [
            {
              subject,
              kind: v.kind,
              stem: v.kind === 'choice' ? [v.stem, ...v.options].join('\n') : v.stem,
              answer: v.answer,
              difficulty: v.difficulty,
              source: 'ai_generated',
              sourceRef: v.sourceRef,
            },
          ],
        },
        timeoutMs: 30_000,
      })
      setVariantMap((m) => {
        const st = m[candId]
        if (!st) return m
        return { ...m, [candId]: { ...st, items: st.items.map((x, i) => (i === vi ? { ...x, saved: true } : x)) } }
      })
      toast.success('已收进题库，练习抽题可以抽到它', { title: '举一反三' })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '入库失败，请重试', { title: '举一反三' })
    } finally {
      setSavingVariant(null)
    }
  }

  /** 加入本卷:内联 AI 拟题槽(insert_inline),卷面带〔AI 拟题〕标注、答案页进 AI 参考答案标注体系 */
  const onAddVariant = async (candId: string, vi: number) => {
    const v = variantMap[candId]?.items[vi]
    if (!v || v.added) return
    const ok = await onPatch(
      {
        op: 'insert_inline',
        stem: v.stem,
        options: v.options,
        answer: v.answer,
        kind: v.kind,
        score: v.score,
        sourceRef: v.sourceRef,
        section: target.section,
        afterSlotId: target.afterSlotId,
      },
      `insert_inline:${candId}:${vi}`
    )
    if (!ok) return
    setVariantMap((m) => {
      const st = m[candId]
      if (!st) return m
      return { ...m, [candId]: { ...st, items: st.items.map((x, i) => (i === vi ? { ...x, added: true } : x)) } }
    })
  }

  // Esc 关闭(与 ConfirmDialog 同通道;遮罩点击/右上的 ✕ 也可关)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const { data: cands, isFetching } = useQuery({
    queryKey: [...queryKeys.all, 'papers', 'composed', id, 'candidates', { mode: searchMode ? 'q' : 'bucket', section: target.section, kind: target.kind, score: target.score, q: dq }],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams()
      if (searchMode) {
        params.set('q', dq)
      } else {
        params.set('kind', target.kind)
        if (target.score > 0) params.set('score', String(target.score))
        if (target.section) params.set('section', target.section)
      }
      return fetchJson<{ candidates: CandidateItem[] }>(
        `/api/papers/composed/${id}/candidates?${params.toString()}`,
        { signal }
      ).then((r) => r.candidates ?? [])
    },
  })

  /** 来源卷名缩短显示:去公共考试前缀(「广西普通高中学业水平合格性考试」→ 尾段),无「考试」保持原样 */
  const shortSrc = (t: string) => {
    const i = t.lastIndexOf('考试')
    return i >= 0 ? t.slice(i + 2) : t
  }

  // 渲染序列:正常候选行 + 灰显过渡行(ghost),ghost 按加入时的位置钉回序列
  const ghostIds = new Set(ghosts.map((g) => g.item.id))
  const rows: Array<{ key: string; cand?: CandidateItem; ghost?: (typeof ghosts)[number]; index: number }> = [
    ...(cands ?? [])
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => !ghostIds.has(c.id) && !dismissed.has(c.id))
      .map(({ c, i }) => ({ key: c.id, cand: c, index: i })),
    ...ghosts.map((g) => ({ key: `ghost:${g.item.id}`, ghost: g, index: g.index })),
  ].sort((a, b) => a.index - b.index)

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/35 p-0 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label="加一题"
      onClick={onClose}
    >
      <div
        className="flex max-h-[74vh] w-full flex-col rounded-t-2xl border border-line bg-surface shadow-2xl sm:max-w-xl sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 px-5 pt-4">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-content-primary">
              加一题{target.label ? ` · ${target.label}` : target.section ? ` · ${target.section}` : ''}
            </h3>
            <p className="mt-0.5 text-[11.5px] text-content-muted">
              从试卷库有官方答案的真题里选 · {searchMode ? '关键词搜索全库' : `同题型（${target.kind === 'choice' ? '选择题' : '解答题'} · ${target.score} 分）优先`}
              <span className="ml-2 hidden sm:inline">点候选行可展开完整题目</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-content-muted transition-colors hover:bg-surface-subtle hover:text-content-primary"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 pt-3">
          <div className="flex h-9 items-center gap-2 rounded-lg bg-surface-subtle px-3">
            <Search className="h-3.5 w-3.5 shrink-0 text-content-muted" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索题干 / 选项关键词"
              className="h-full w-full bg-transparent text-[13px] text-content-primary outline-none placeholder:text-content-muted"
              aria-label="搜索候选题"
            />
            {isFetching && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-content-muted" />}
          </div>
        </div>
        <div className="mt-2 flex-1 overflow-y-auto px-2 pb-4">
          {rows.length === 0 && !isFetching ? (
            <p className="px-3 py-8 text-center text-xs text-content-muted">
              题库里没有可加的题{searchMode ? '，换个关键词试试' : '，试试输入关键词搜索全库'}
            </p>
          ) : (
            rows.map((r, ri) => {
              if (r.ghost) {
                const g = r.ghost
                return (
                  <div
                    key={r.key}
                    className={`pointer-events-none flex items-center gap-2.5 rounded-xl px-3 py-2.5 transition-opacity duration-base ${ri > 0 ? 'border-t border-line/60' : ''} ${g.fading ? 'opacity-0' : 'opacity-45'}`}
                  >
                    <span
                      className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-accent-soft text-[10.5px] font-bold tabular-nums text-accent"
                      aria-hidden
                    >
                      {ri + 1}
                    </span>
                    <p className="min-w-0 flex-1 truncate text-[13px] text-content-muted">{g.item.stem}</p>
                    <span className="mt-0.5 shrink-0 text-[11px] font-medium text-content-muted">✓ 已加入</span>
                  </div>
                )
              }
              const c = r.cand!
              const expanded = expandedId === c.id
              const vs = variantMap[c.id]
              return (
                <div
                  key={r.key}
                  className={`group rounded-xl transition-colors hover:bg-surface-subtle/70 ${ri > 0 ? 'border-t border-line/60' : ''}`}
                >
                  <div className="flex items-start gap-2.5 px-3 py-2.5">
                    <span
                      className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[10.5px] font-bold tabular-nums ${expanded ? 'bg-accent text-accent-foreground' : 'bg-accent-soft text-accent'}`}
                      aria-hidden
                    >
                      {ri + 1}
                    </span>
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => setExpandedId((v) => (v === c.id ? null : c.id))}
                      title={expanded ? '收起' : '查看完整题目'}
                    >
                      {expanded ? (
                        <>
                          <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-content-primary">{c.fullStem}</p>
                          {c.options.length > 0 && (
                            <div className="mt-1.5 space-y-0.5 rounded-lg bg-surface-subtle/70 px-3 py-2">
                              {c.options.map((o, oi) => (
                                <div key={oi} className="text-[12.5px] leading-relaxed text-content-secondary">{o}</div>
                              ))}
                            </div>
                          )}
                          <span className="mt-1 inline-block text-[11px] font-medium text-accent">▲ 收起</span>
                        </>
                      ) : (
                        <>
                          <p className="truncate text-[13px] leading-relaxed text-content-primary">{c.stem}</p>
                          <p className="mt-0.5 truncate text-[11px] text-content-muted">
                            {shortSrc(c.paperTitle)} · 原卷第 {c.number} 题 · {c.score} 分
                            {c.answerSource === 'ai' && <span className="ml-1.5 text-[10px] text-amber-600">AI 答案</span>}
                          </p>
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      disabled={genBusy || !modelId}
                      onClick={() => void onVariants(c)}
                      title={!modelId ? '没有可用的 AI 模型' : '举一反三 · 按这道题出 2 道变式'}
                      aria-label="举一反三"
                      className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-accent/70 bg-surface text-accent opacity-0 show-on-touch transition-all hover:bg-accent hover:text-white focus:opacity-100 disabled:opacity-50 group-hover:opacity-100"
                    >
                      {vs?.status === 'loading' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                    </button>
                    <button
                      type="button"
                      disabled={!!busyKey}
                      onClick={() => handleAdd(c, r.index)}
                      className="mt-0.5 h-7 shrink-0 rounded-lg border border-accent bg-surface px-3 text-xs font-medium text-accent opacity-0 show-on-touch transition-all hover:bg-accent hover:text-white focus:opacity-100 disabled:opacity-50 group-hover:opacity-100"
                    >
                      {busyKey === `insert:${c.id}` ? '加入中…' : '加入'}
                    </button>
                  </div>
                  {vs && (
                    <div className="pb-3 pl-[42px] pr-3">
                      {vs.status === 'loading' && (
                        <div className="flex items-center gap-2 rounded-lg bg-surface-subtle/70 px-3 py-2.5 text-xs text-content-muted">
                          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                          正在按这道题的考点出 2 道变式，约十几秒…
                        </div>
                      )}
                      {vs.status === 'error' && (
                        <div className="flex items-center gap-2 rounded-lg bg-surface-subtle/70 px-3 py-2.5 text-xs text-content-muted">
                          变式生成失败
                          <button
                            type="button"
                            disabled={genBusy || !modelId}
                            onClick={() => void onVariants(c)}
                            className="font-medium text-accent hover:underline disabled:opacity-50"
                          >
                            重试
                          </button>
                        </div>
                      )}
                      {vs.status === 'done' && vs.items.length === 0 && (
                        <div className="rounded-lg bg-surface-subtle/70 px-3 py-2.5 text-xs text-content-muted">
                          这次没生成出合格的变式，点「举一反三」再试一次
                        </div>
                      )}
                      {vs.status === 'done' && vs.items.length > 0 && (
                        <div className="space-y-2">
                          <p className="text-[10.5px] text-content-muted">
                            AI 变式 · 收进题库进练习抽题池；加入本卷会带〔AI 拟题〕标注
                          </p>
                          {vs.items.map((v, vi) => (
                            <div key={vi} className="rounded-xl border border-line/70 bg-surface px-3 py-2.5">
                              <div className="flex items-center gap-2 text-[10.5px]">
                                <span className="rounded-md bg-accent-soft px-1.5 py-0.5 font-semibold text-accent">变式 {vi + 1}</span>
                                <span className="text-content-muted">
                                  {v.difficulty === 'basic' ? '基础' : v.difficulty === 'hard' ? '提高' : '中等'} · {v.score} 分
                                </span>
                                <span className="ml-auto text-content-muted">AI 拟题</span>
                              </div>
                              <p className="mt-1.5 whitespace-pre-wrap text-[12.5px] leading-relaxed text-content-primary">{v.stem}</p>
                              {v.options.length > 0 && (
                                <div className="mt-1 space-y-0.5 text-[12.5px] leading-relaxed text-content-secondary">
                                  {v.options.map((o, oi) => (
                                    <div key={oi}>{o}</div>
                                  ))}
                                </div>
                              )}
                              <div className="mt-1.5 rounded-lg bg-surface-subtle/70 px-2.5 py-1.5 text-[12px] leading-relaxed text-content-secondary">
                                <span className="font-medium text-content-muted">AI 参考答案：</span>
                                {v.answer}
                              </div>
                              <div className="mt-2 flex items-center gap-2">
                                <button
                                  type="button"
                                  disabled={v.saved || !!savingVariant}
                                  onClick={() => void onSaveVariant(c.id, vi)}
                                  className={`h-7 rounded-lg border px-2.5 text-xs font-medium transition-colors disabled:opacity-60 ${
                                    v.saved
                                      ? 'border-line/60 text-content-muted'
                                      : 'border-accent bg-surface text-accent hover:bg-accent hover:text-white'
                                  }`}
                                >
                                  {v.saved ? '✓ 已入题库' : savingVariant === `${c.id}:${vi}` ? '入库中…' : '收进题库'}
                                </button>
                                <button
                                  type="button"
                                  disabled={v.added || !!busyKey}
                                  onClick={() => void onAddVariant(c.id, vi)}
                                  className={`h-7 rounded-lg border px-2.5 text-xs transition-colors disabled:opacity-60 ${
                                    v.added
                                      ? 'border-line/60 text-content-muted'
                                      : 'border-line bg-surface text-content-secondary hover:bg-surface-subtle'
                                  }`}
                                >
                                  {v.added ? '✓ 已加入本卷' : busyKey === `insert_inline:${c.id}:${vi}` ? '加入中…' : '加入本卷'}
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

// ===================== 卷面页 =====================

function ComposedContent() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const qc = useQueryClient()

  const { data: paper, isLoading, isError } = useQuery({
    queryKey: queryKeys.papers.composed(id),
    queryFn: ({ signal }) => fetchJson<ComposedPaperView>(`/api/papers/composed/${id}`, { signal }),
  })

  const containerRef = useRef<HTMLDivElement>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [panelTarget, setPanelTarget] = useState<{
    section: string | null
    kind: string
    score: number
    /** 中途加题:插到该槽正后方;不传 = 大题组末尾 */
    afterSlotId?: string
    label?: string
  } | null>(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  /** 组卷时的真题缺口(组卷页写入 sessionStorage;卷面页一次性提示,关掉即清) */
  const [gapNote, setGapNote] = useState<{ missing: number; score: number } | null>(null)

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(`composed-gap:${id}`)
      if (!raw) return
      const parsed = JSON.parse(raw) as { missing?: number; score?: number }
      if (parsed?.missing) setGapNote({ missing: parsed.missing, score: parsed.score ?? 0 })
    } catch {
      // 忽略损坏的暂存
    }
  }, [id])

  const dismissGapNote = useCallback(() => {
    setGapNote(null)
    try {
      sessionStorage.removeItem(`composed-gap:${id}`)
    } catch {
      // ignore
    }
  }, [id])

  useEffect(() => {
    if (containerRef.current) renderTexIn(containerRef.current)
  }, [paper])

  // 打印监察:打印对话框真实弹出(beforeprint,打印按钮/Ctrl+P 皆覆盖)即上报一次,
  // 「今晚测验」队列据此判定今天打印过哪张卷。hook 内失败静默,绝不影响打印本身。
  usePrintEvent('composed', id)

  const doPatch = useCallback(
    async (body: Record<string, unknown>, key: string): Promise<boolean> => {
      if (busyKey) return false
      setBusyKey(key)
      try {
        const res = await fetchJson<{ ok: boolean; paper: ComposedPaperView | null }>(
          `/api/papers/composed/${id}`,
          { method: 'PATCH', json: body, timeoutMs: 30_000 }
        )
        if (res.paper) {
          qc.setQueryData(queryKeys.papers.composed(id), res.paper)
          // 候选列表随在卷题目变化,整族失效让面板下次打开/已开面板即时刷新
          qc.invalidateQueries({ queryKey: [...queryKeys.all, 'papers', 'composed', id, 'candidates'] })
          // 槽位增删/改名会变列表页与学习台区块的元数据(题数/卷名),列表缓存一并失效
          void qc.invalidateQueries({ queryKey: queryKeys.papers.composedList() })
        }
        return res.ok !== false && !!res.paper
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '操作失败，请重试', { title: '拟卷' })
        return false
      } finally {
        setBusyKey(null)
      }
    },
    [busyKey, id, qc]
  )

  const onReshuffle = useCallback(async () => {
    const yes = await confirmDialog({
      title: '整卷重摇？',
      message: '按当前组卷参数重新抽题，所有题目都会被替换。',
      detail: '卷子结构不变，可反复重摇。',
      okText: '重摇',
    })
    if (yes) doPatch({ op: 'reshuffle' }, 'reshuffle')
  }, [doPatch])

  const onFlag = useCallback(
    async (slot: ComposedSlotView) => {
      const yes = await confirmDialog({
        title: '标记「这题有误」？',
        message: `第 ${slot.number} 题将退出全部拟卷题池，本卷同步移除。`,
        detail: '原卷数据不受影响；可对照原件修复后在试卷库解除标记。',
        okText: '标记并移出',
      })
      if (yes) doPatch({ op: 'flag', slotId: slot.slotId }, `flag:${slot.slotId}`)
    },
    [doPatch]
  )

  const commitTitle = useCallback(() => {
    setEditingTitle(false)
    const clean = titleDraft.trim()
    if (paper && clean && clean !== paper.title) doPatch({ op: 'retitle', title: clean }, 'retitle')
  }, [titleDraft, paper, doPatch])

  const handleBack = useCallback(() => {
    if (window.history.length > 1) router.back()
    else router.push('/study')
  }, [router])

  const onDelete = useCallback(async () => {
    if (!paper) return
    const yes = await confirmDialog({
      title: '删除这张拟卷？',
      message: `「${paper.title}」将被删除，不可恢复。`,
      detail: '原试卷库不受影响；想再要同款可回聊天重新组一张。',
      okText: '删除',
      danger: true,
    })
    if (!yes) return
    setBusyKey('delete')
    try {
      await fetchJson<{ ok: boolean }>(`/api/papers/composed/${id}`, { method: 'DELETE', timeoutMs: 30_000 })
      // 详情与候选族缓存一并清掉,避免返回/重进读到已删卷;列表(学习台区块/列表页)同步失效
      qc.removeQueries({ queryKey: queryKeys.papers.composed(id) })
      void qc.invalidateQueries({ queryKey: queryKeys.papers.composedList() })
      toast.success('拟卷已删除', { title: '拟卷' })
      router.push('/study')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败，请重试', { title: '拟卷' })
      setBusyKey(null)
    }
  }, [paper, id, qc, router])

  const items = useMemo(() => (paper ? buildRenderItems(paper) : []), [paper])
  // 拖拽排序(方案A 把手):问题块渲染序上的槽位 id 序列;松手 PATCH reorder,失败自动回弹
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const questionIds = useMemo(() => items.filter((i) => i.type === 'question').map((i) => i.slot.slotId), [items])
  const onDragEnd = useCallback(
    async (e: DragEndEvent) => {
      const { active, over } = e
      setDropTarget(null)
      if (!over || active.id === over.id) return
      const from = questionIds.indexOf(String(active.id))
      const to = questionIds.indexOf(String(over.id))
      if (from < 0 || to < 0) return
      const slotId = String(active.id)
      const ok = await doPatch({ op: 'reorder', orderedSlotIds: arrayMove(questionIds, from, to) }, 'reorder')
      if (!ok) return
      // 轻浮窗:从刷新后的数据取新题号,挂被移动的块右上 2.2s
      const fresh = qc.getQueryData<{ slots: Array<{ slotId: string; number: number }> }>(queryKeys.papers.composed(id))
      const n = fresh?.slots.find((s) => s.slotId === slotId)?.number
      if (n == null) return
      setMovedTag({ slotId, label: `已移至第 ${n} 题` })
      if (movedTimerRef.current) clearTimeout(movedTimerRef.current)
      movedTimerRef.current = setTimeout(() => setMovedTag(null), 2200)
    },
    [questionIds, doPatch, qc, id]
  )
  // 落点指示:拖动中实时计算插入边界(从下往上拖 → 插到目标块上缘;反之下缘)
  const [dropTarget, setDropTarget] = useState<{ id: string; pos: 'before' | 'after' } | null>(null)
  // 拖拽成功的轻浮窗(挂被移动的块右上,2.2s 自愈)
  const [movedTag, setMovedTag] = useState<{ slotId: string; label: string } | null>(null)
  const movedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onDragOver = useCallback(
    (e: { active: { id: unknown }; over: { id: unknown } | null }) => {
      const { active, over } = e
      if (!over || active.id === over.id) {
        setDropTarget((prev) => (prev ? null : prev))
        return
      }
      const ai = questionIds.indexOf(String(active.id))
      const oi = questionIds.indexOf(String(over.id))
      if (ai < 0 || oi < 0) return
      const pos = ai < oi ? 'after' : 'before'
      setDropTarget((prev) => (prev?.id === String(over.id) && prev.pos === pos ? prev : { id: String(over.id), pos }))
    },
    [questionIds]
  )
  const answerRows = useMemo(
    () =>
      (paper?.slots ?? [])
        .filter((s) => s.kind === 'choice')
        .map((s) => ({
          number: s.number,
          letters: s.answer ? parseChoiceAnswer(s.answer).letters : null,
          ai: s.answerSource === 'ai',
        })),
    [paper]
  )
  const answerDetails = useMemo(
    () =>
      (paper?.slots ?? [])
        .filter((s) => s.answer)
        .map((s) => {
          const a = s.answer as string
          const ai = s.answerSource === 'ai'
          if (s.kind === 'choice') {
            const { letters, rest } = parseChoiceAnswer(a)
            return letters && !rest ? null : { number: s.number, text: letters ? rest : stripOwnNumber(a, s.number), ai }
          }
          return { number: s.number, text: stripOwnNumber(a, s.number), ai }
        })
        .filter((x): x is { number: number; text: string; ai: boolean } => x !== null),
    [paper]
  )
  // 答案页来源声明三态:全官方=原文案;混合=官方 N 题+AI M 题;全 AI=卷级声明不逐题挂标
  const aiSlotCount = useMemo(() => (paper?.slots ?? []).filter((s) => s.answerSource === 'ai').length, [paper])
  const tbSlotCount = (paper?.slots ?? []).filter((s) => s.answerSource === 'textbook').length
  const slotCount = paper?.slots.length ?? 0
  const nonOfficial = aiSlotCount + tbSlotCount
  const ansSrcText = (() => {
    if (slotCount === 0 || nonOfficial === 0) return '答案均出自官方答案卷原文，非 AI 拟答'
    if (nonOfficial === slotCount) return '本卷答案为课本依据/AI 参考答案（非官方原文，见各题标注）'
    return `${slotCount - nonOfficial} 题出自官方答案卷 · 其余 ${nonOfficial} 题为课本依据/AI 参考答案（见标注）`
  })()
  /** 纯 AI 卷不逐题重复挂标,声明行已交代 */
  const showPerItemAiMark = aiSlotCount > 0 && aiSlotCount < slotCount

  if (isError) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-sm text-content-muted">
        卷子不存在或无权访问
      </div>
    )
  }

  const hasSlots = (paper?.slots.length ?? 0) > 0
  const hasInline = (paper?.slots ?? []).some((sl) => sl.inlineSource)

  return (
    <div className="relative flex h-full bg-surface-subtle/40">
      <style dangerouslySetInnerHTML={{ __html: PRINT_GLOBAL_CSS }} />
      {/* 卷面列:AI 助手停靠列(≥md)推挤本列;助手组件挂在本 flex 根上 */}
      <div className="relative min-w-0 flex-1">
      {/* 顶栏(仅屏幕):悬浮玻璃条 —— 脱离边缘+四周圆角+毛玻璃;
          移动端要让出全局浮钮行(☰/↻/⚙,--m-chrome-top 起、高 40):+48 = 浮钮行下留 8;桌面 md:top-3 不变 */}
      <div className={`absolute inset-x-2 top-[calc(var(--m-chrome-top)+48px)] z-10 flex min-h-[52px] items-center gap-1 rounded-2xl border border-line/60 bg-surface/60 px-2 shadow-[0_8px_24px_rgb(0_0_0/0.1)] backdrop-blur-xl md:inset-x-3 md:top-3 md:gap-2 md:px-4 ${styles.printHide}`}>
        <button
          type="button"
          onClick={handleBack}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-content-secondary transition-colors hover:bg-surface-subtle hover:text-content-primary"
          aria-label="返回"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        {editingTitle ? (
          <input
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitTitle()
              if (e.key === 'Escape') setEditingTitle(false)
            }}
            className="min-w-0 flex-1 rounded-lg border border-line bg-surface-subtle px-2 py-1.5 text-sm text-content-primary outline-none focus:border-accent"
            aria-label="卷名"
            maxLength={60}
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              if (paper) {
                setTitleDraft(paper.title)
                setEditingTitle(true)
              }
            }}
            className="line-clamp-2 min-w-0 flex-1 py-1 text-left text-[13px] font-medium leading-tight text-content-primary md:text-sm md:leading-snug"
            title="点击修改卷名"
          >
            {paper?.title ?? '拟卷'}
          </button>
        )}
        {paper?.baseSlug && (
          <button
            type="button"
            onClick={onReshuffle}
            disabled={!paper || !!busyKey}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs text-content-secondary transition-colors hover:bg-surface-subtle hover:text-content-primary disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${busyKey === 'reshuffle' ? 'animate-spin' : ''}`} />
            重摇
          </button>
        )}
        <button
          type="button"
          onClick={() => window.print()}
          disabled={!paper}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-content-primary transition-colors hover:bg-surface-subtle disabled:opacity-50"
        >
          <Printer className="h-3.5 w-3.5" />
          打印
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={!paper || !!busyKey}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-content-secondary transition-colors hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50"
          aria-label="删除卷子"
          title="删除卷子"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* max-md 顶距让出两行 chrome:浮钮行(m-chrome-top+40)+玻璃顶栏(52)+间距 20;桌面 68px 不变 */}
      <div
        ref={containerRef}
        className={`h-full overflow-y-auto pt-[calc(68px+var(--sat))] max-md:pt-[calc(var(--m-chrome-top)+112px)] ${styles.scroller} ${styles.flow}`}
      >
        <div className={`mx-auto flex w-full max-w-[880px] flex-col gap-5 px-2 pt-3 pb-[max(64px,var(--sab))] md:px-4 md:pb-16 ${styles.sheetColumn}`}>
          {isLoading || !paper ? (
            <div className="h-64 animate-pulse rounded-xl bg-surface-subtle" />
          ) : (
            <>
              {/* 摘要行(仅屏幕) */}
              <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11.5px] text-content-muted ${styles.printHide}`}>
                <span>
                  满分 {paper.totalScore} 分 · {paper.slots.length} 题
                  {paper.durationMin > 0 ? ` · 建议 ${paper.durationMin} 分钟` : ''}
                  {paper.sources.length ? ` · 来源 ${paper.sources.length} 套真题卷` : ''}
                </span>
                <span>全部题目与答案出自原卷 · 改动实时保存</span>
              </div>

              {/* 真题缺口提示(组卷页写入、卷面页一次性展示):别让缺题静默消失 */}
              {gapNote && (
                <div
                  role="status"
                  className={`flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-[12px] border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11.5px] text-content-secondary ${styles.printHide}`}
                >
                  <span>
                    按大纲还缺 {gapNote.missing} 道
                    {gapNote.score > 0 ? ` · ${gapNote.score} 分` : ''}（该档真题不足，有多少放多少）
                  </span>
                  <a
                    href="/papers/composed?compose=1"
                    className="font-semibold text-accent underline-offset-2 hover:underline"
                  >
                    回表单补题 / 改用 AI 补题
                  </a>
                  <button
                    type="button"
                    onClick={dismissGapNote}
                    aria-label="关闭缺口提示"
                    className="ml-auto rounded-md px-1.5 py-0.5 text-content-muted transition-colors hover:bg-surface-subtle hover:text-content-primary"
                  >
                    ✕
                  </button>
                </div>
              )}

              {/* 卷面条 */}
              <div className={styles.sheet}>
                <PaperBrandSeal />
                <div className={styles.paperHead}>
                  <div className={styles.examTag}>{SUBJECT_LABELS[paper.subject] ?? paper.subject} · 真题重组 · {hasInline ? "部分题目为课本/AI 补充（已标注）" : "全部题目与答案出自原卷"}</div>
                  <div className={styles.paperTitle}>{paper.title}</div>
                  <div className={styles.paperMeta}>
                    <span>满分 {paper.totalScore} 分</span>
                    {paper.durationMin > 0 && <span>考试时间 {paper.durationMin} 分钟</span>}
                  </div>
                </div>

                {!hasSlots ? (
                  <p className="py-16 text-center text-[11pt]">这张卷子还没有题目，可整卷重摇，或回聊天重新组一张。</p>
                ) : (
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={onDragEnd}
                    onDragOver={onDragOver}
                    onDragCancel={() => setDropTarget(null)}
                  >
                    <SortableContext items={questionIds} strategy={verticalListSortingStrategy}>
                      {items.map((item) => {
                        if (item.type === 'section') {
                          if (!item.section) return null
                          return (
                            <div key={item.key} className={styles.sectionHead}>
                              {item.section}
                              <span className={styles.sectionNote}>{item.note}</span>
                              {item.bucket && (
                                <button
                                  type="button"
                                  onClick={() => setPanelTarget(item.bucket)}
                                  className={`${styles.editBtn} ml-2 align-middle ${styles.printHide}`}
                                  disabled={!!busyKey}
                                >
                                  ＋加一题
                                </button>
                              )}
                            </div>
                          )
                        }
                        if (item.type === 'material') {
                          return (
                            <div key={item.key} className={styles.material}>
                              <span className={styles.materialTag}>【材料】</span>
                              {item.marks && item.marks.length > 0 ? renderMarkedBody(item.body, item.marks) : item.body}
                            </div>
                          )
                        }
                        return (
                          <SortableQuestionBlock
                            key={item.key}
                            item={item}
                            busyKey={busyKey}
                            dropPos={dropTarget?.id === item.slot.slotId ? dropTarget.pos : undefined}
                            movedLabel={movedTag?.slotId === item.slot.slotId ? movedTag.label : undefined}
                            onPanel={setPanelTarget}
                            onReplace={doPatch}
                            onRemove={doPatch}
                            onFlag={onFlag}
                          />
                        )
                      })}
                  </SortableContext>
                  </DndContext>
                )}
                {/* 无大题头的卷(大纲模式槽位 section 为空):卷尾加一题是唯一加题入口 */}
                {paper.slots.every((s) => !s.section) && paper.slots.length > 0 && (
                  <div className={`mt-3 flex justify-center ${styles.printHide}`}>
                    <button
                      type="button"
                      className={styles.editBtn}
                      disabled={!!busyKey}
                      onClick={() => {
                        const last = paper.slots[paper.slots.length - 1]
                        setPanelTarget({ section: null, kind: last.kind, score: last.score, afterSlotId: last.slotId, label: '卷尾' })
                      }}
                    >
                      ＋ 卷尾加一题
                    </button>
                  </div>
                )}
              </div>

              {/* 答案页(随卷打印在最后) */}
              {hasSlots && (
                <div className={styles.sheet}>
                  <div className={styles.ansHead}>参考答案</div>
                  <div className={styles.ansSrc}>
                    {ansSrcText}
                    {paper.sources.length ? ` · 出处：${paper.sources.join('、')}` : ''}
                  </div>
                  {answerRows.length > 0 && (
                    <div className={styles.ansGrid}>
                      {answerRows.map((r) => (
                        <div key={r.number} style={{ display: 'contents' }}>
                          <div className={`${styles.ansCell} ${styles.ansCellK}`}>{r.number}</div>
                          <div className={styles.ansCell}>
                            {r.letters ?? '见下'}
                            {r.ai && showPerItemAiMark && <span className={styles.aiChip}>AI</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {answerDetails.length > 0 && (
                    <div className={styles.ansDetail}>
                      {answerDetails.map((d) => (
                        <div key={d.number} className={styles.ansItem}>
                          <div className={styles.ansDt}>
                            {d.number}.
                            {d.ai && showPerItemAiMark && <span className={styles.aiChipLong}>AI 参考</span>}
                          </div>
                          <div className={styles.ansDd}>{d.text}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      </div>

      <ComposedAssistant composedId={id} slots={paper?.slots ?? []} paperTitle={paper?.title ?? '拟卷'} durationMin={paper?.durationMin ?? 0} />

      {panelTarget && paper && (
        <div className={styles.printHide}>
          <CandidatePanel
            id={id}
            subject={paper.subject}
            target={panelTarget}
            busyKey={busyKey}
            onAdd={(qid) =>
              doPatch(
                { op: 'insert', paperQuestionId: qid, afterSlotId: panelTarget.afterSlotId },
                `insert:${qid}`
              )
            }
            onPatch={doPatch}
            onClose={() => setPanelTarget(null)}
          />
        </div>
      )}
    </div>
  )
}

export default function ComposedPaperPage() {
  return (
    <AuthErrorBoundary>
      <ClientOnly>
        <Suspense fallback={<div className="h-full" />}>
          <ComposedContent />
        </Suspense>
      </ClientOnly>
    </AuthErrorBoundary>
  )
}
