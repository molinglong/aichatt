'use client'

import React, { memo, useMemo, useState, useCallback, useRef, useEffect, useContext, createContext } from 'react'
import { useRenderProbe } from '@/lib/client-diagnostics'
import { usePathname } from 'next/navigation'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import type { Components } from 'react-markdown'
import type { PluggableList } from 'unified'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { BookPlus, Check, ChevronDown, ChevronRight, ChevronUp, Copy, ImageOff, Sparkles, Wrench, StickyNote, Eye, Gauge, Zap, Star, Link2 } from 'lucide-react'
import { useYellowFishFavorites } from '@/hooks/useYellowFishFavorites'
import { parseExamSegments, parseChoice, parseEssay, parseTimeline, parseSentence, parseSourceRefLine, countEssayChars, essayToPlainText, parseGameStatus, parseGameChoice, parseYellowFish, forceRankLineBreaks, promoteRankRunsToBlocks, type ExamKind, type ExamSourceRef, type ExamChoiceOption, type ExamSentencePart, type GameStat } from '@/lib/ai/exam-markdown'
import type { YellowFishItemBrief } from '@/lib/ai/yellow-fish-tool'
import { useContextMenuStore, type ContextMenuItem } from '@/store/contextMenuStore'
import { insertTextToInput, sendTextAsUser } from '@/lib/input-bridge'
import { useChatStore } from '@/store/chat-store'
import dynamic from 'next/dynamic'
import { ChartCard } from './ChartCard'
import { TriangleFigure } from './TriangleFigure'
import { parseTriangleFigure } from '@/lib/triangle-figure'
import { parseChartMetadata } from '@/lib/chart-parser'
import type { InlineImageRef } from './ToolCallCard'
import { ChatImageLightbox } from './ChatImageLightbox'
import type { Attachment } from '@/lib/attachment-types'

// 可视化熔断开关: 一行降级——出现渲染死循环/性能退化时改 false,
// 全部消息回到纯文本渲染(两段式渲染的保险丝;历史坑: 流式重渲染 Maximum update depth)
const RICH_RENDER_ENABLED = true

// 思维导图块: 只在消息里真的出现 ```mindmap 时才去加载 markmap-view(约 27KB gz),
// 普通消息不背这个包;ssr: false —— 建图全靠 DOM 测量,服务端渲染没有意义
const MindMapBlock = dynamic(() => import('./MindMapBlock'), {
  ssr: false,
  loading: () => (
    <div className="my-4 rounded-xl overflow-hidden border border-line bg-code-bg">
      <div className="flex items-center pl-4 pr-2 py-2 border-b border-line">
        <span className="text-[11px] font-semibold text-content-secondary select-none capitalize">
          mindmap
        </span>
      </div>
      <div className="h-[220px]" />
    </div>
  ),
})

interface MarkdownRendererProps {
  content: string
  className?: string
  messageId?: string
  /**
   * 富渲染开关(两段式策略):
   * - 生成期间传 false → live=true 时轻量排版,否则纯文本。
   *   以「整条消息是否在生成」为粒度(含工具轮次间隙、远程轮询),不随单个
   *   text part 的 state 翻转 —— 否则多轮工具循环会 plain↔rich 反复横跳(闪烁)
   * - 生成结束后传 true → 普通正文白名单保留节点;其余走 react-markdown + KaTeX
   * summary 卡片与「复制为 HTML」镜像始终传 true
   */
  rich?: boolean
  /**
   * 流式轻量渲染开关: rich=false 且 live=true 时走 live 档(块级排版 + 行内加粗/行内码,
   * 不跑 KaTeX/highlight/试卷块)。生成中不再裸语法符号, 定格时块几何已就位。
   */
  live?: boolean
  /**
   * 图文混排白名单(服务端搜索结果里已过滤编号的图):
   * 正文 [图N] 占位符据此替换成内联图卡。不传/空 = 无图,占位符原样保留。
   */
  inlineImages?: InlineImageRef[]
  /** 闲鱼推荐卡 hydrate 数据源：本条消息里 get_yellow_fish_market 的 recentItems（按 no 索引）。不传 = 推荐块只显理由 */
  yellowFishItems?: YellowFishItemBrief[]
}

// ── 试卷块（材料/设问/作答）与关键词双色标注 ────────────────────────
// 材料题里材料/设问/作答混在一坨难读。约定 AI 按试卷结构分块输出：
//   :::material …（材料原文）… :::   :::question …（设问+分值）… :::   :::answer …（分点作答）… :::
// 关键词标注：==教材术语== → 红（得分点）；@@材料信息@@ → 蓝（对应材料/时政）。
// 两者都渲染为受控 mark 元素，不引入原始 HTML（无 XSS 面）；katex/代码子树不做高亮。

// ==教材术语==(红) / @@材料信息@@(蓝)：要求成对闭合、内容不含同名符号与换行，防误伤
const INLINE_MARK_RE = /==([^=\n]+?)==|@@([^@\n]+?)@@/g

/** 单个字符串内的双色高亮切分；无命中时返回原字符串（引用不变） */
function highlightInlineText(text: string): React.ReactNode {
  INLINE_MARK_RE.lastIndex = 0
  const parts: React.ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = INLINE_MARK_RE.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    parts.push(
      m[1] !== undefined ? (
        <mark key={m.index} className="exam-term">{m[1]}</mark>
      ) : (
        <mark key={m.index} className="exam-mat">{m[2]}</mark>
      ),
    )
    last = m.index + m[0].length
  }
  if (!parts.length) return text
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

// 行内 code 提为具名组件：withInlineMarks 靠引用比较跳过，代码内不做高亮
const CodeInline = ({ children }: { children?: React.ReactNode }) => (
  <code className="rounded-md bg-accent-soft px-1.5 py-0.5 font-mono text-[13.5px]">{children}</code>
)

const MAX_MARK_DEPTH = 8

/** 递归给行内 children 接上双色高亮；katex/代码子树原样保留 */
function withInlineMarks(children: React.ReactNode): React.ReactNode {
  const walk = (node: React.ReactNode, depth: number): React.ReactNode => {
    if (depth > MAX_MARK_DEPTH) return node
    if (typeof node === 'string') return highlightInlineText(node)
    if (Array.isArray(node)) {
      let changed = false
      const out = node.map((n) => {
        const next = walk(n, depth + 1)
        if (next !== n) changed = true
        return next
      })
      return changed ? out : node
    }
    if (React.isValidElement(node)) {
      if (node.type === CodeInline) return node
      const props = node.props as { className?: string; children?: React.ReactNode }
      if (props.className && (props.className.includes('katex') || props.className.includes('language-'))) return node
      if (props.children === undefined) return node
      const nextChildren = walk(props.children, depth + 1)
      return nextChildren === props.children ? node : React.cloneElement(node, undefined, nextChildren)
    }
    return node
  }
  return walk(children, 0)
}

// ── 代码块右键菜单辅助:从 <pre> 的 children(<code class="language-x">…</code>)提取语言与纯文本代码 ──
// react-markdown 块级 code 走 CodeInline 组件,className 由 ast 属性透传,仍在 props 上
function codeNodeToText(node: React.ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(codeNodeToText).join('')
  if (React.isValidElement(node)) {
    return codeNodeToText((node.props as { children?: React.ReactNode }).children)
  }
  return ''
}

function extractCodeInfo(children: React.ReactNode): { language: string; code: string } {
  const child = Array.isArray(children) ? children[0] : children
  if (React.isValidElement<{ className?: string; children?: React.ReactNode }>(child)) {
    const m = /language-([\w+#.-]+)/.exec(child.props.className ?? '')
    return {
      language: m ? m[1] : '',
      code: codeNodeToText(child.props.children),
    }
  }
  return { language: '', code: typeof child === 'string' ? child : '' }
}

/**
 * 代码块:常驻工具行(语言 badge / 复制 / 预览)+ 右键菜单(复制 / 交给 AI / 预览)。
 * 性能红线:本组件随每条消息渲染 —— memo + 轻量常驻 DOM,菜单状态全在
 * 全局 contextMenuStore,不在本组件持有;流式纯文本分支不经过这里。
 * 「交给 AI」走 input-bridge 事件注入输入框,不新增 props 链;
 * 「预览」写 chat-store 的 previewCode,由 ChatPreviewPanel 滑出渲染。
 */
const CodeBlock = memo(function CodeBlock({ children }: { children?: React.ReactNode }) {
  const { language, code } = useMemo(() => extractCodeInfo(children), [children])
  // 「交给 AI」类操作只在聊天页有意义(其他 surface 的输入桥接不存在);
  // 非聊天页仅保留复制,避免点击后无响应
  const pathname = usePathname()
  const inChat = !!pathname?.startsWith('/chat')

  const handleCopy = useCallback(() => {
    if (!navigator.clipboard?.writeText) {
      toast.error('当前浏览器不支持自动复制', { title: '复制失败' })
      return
    }
    navigator.clipboard.writeText(code)
      .then(() => toast.success('已复制代码', { title: '复制' }))
      .catch((err) => {
        console.error('[CodeBlock] copy failed:', err)
        toast.error('复制失败', { title: '复制' })
      })
  }, [code])

  // HTML/SVG 代码块 → 滑出预览面板(移动端全宽覆盖,桌面端侧栏)
  const canPreview = language === 'html' || language === 'svg'
  const handlePreview = useCallback(() => {
    useChatStore.getState().setPreviewCode(code)
  }, [code])

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (!code.trim()) return
    // 触屏(手机):交还浏览器原生文本菜单,代码可拖选复制;工具行已有复制/预览常驻按钮,
    // 右键独有的「交给 AI」三项在手机上让位给系统选择。
    if (window.matchMedia('(pointer: coarse)').matches) return
    e.preventDefault()
    const langLabel = language || '这段'
    const mdSource = '```' + language + '\n' + code + '\n```'
    const candidates: (ContextMenuItem | false | undefined)[] = [
      {
        id: 'copy',
        label: '复制代码',
        icon: <Copy className="w-3.5 h-3.5" />,
        onSelect: handleCopy,
      },
      inChat && {
        id: 'explain',
        label: '让 AI 解释这段代码',
        icon: <Sparkles className="w-3.5 h-3.5" />,
        dividerBefore: true,
        onSelect: () => insertTextToInput(`请解释以下${langLabel}代码:\n\n${mdSource}`),
      },
      inChat && {
        id: 'fix',
        label: '让 AI 修复 / 优化这段代码',
        icon: <Wrench className="w-3.5 h-3.5" />,
        onSelect: () => insertTextToInput(`请修复并优化以下${langLabel}代码,指出问题所在:\n\n${mdSource}`),
      },
      inChat && {
        id: 'comment',
        label: '让 AI 为代码添加注释',
        icon: <StickyNote className="w-3.5 h-3.5" />,
        onSelect: () => insertTextToInput(`请为以下${langLabel}代码添加逐段注释:\n\n${mdSource}`),
      },
      inChat && canPreview && {
        id: 'preview',
        label: '预览',
        icon: <Eye className="w-3.5 h-3.5" />,
        dividerBefore: true,
        onSelect: handlePreview,
      },
    ]
    const items = candidates.filter((it): it is ContextMenuItem => !!it)
    if (!items.length) return
    const { openContextMenu } = useContextMenuStore.getState()
    openContextMenu({ x: e.clientX, y: e.clientY }, items, language ? language.toUpperCase() : undefined)
  }, [code, language, handleCopy, handlePreview, canPreview, inChat])

  return (
    <div className="my-4 rounded-xl overflow-hidden border border-line bg-code-bg shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
      {language && (
        <div className="flex items-center justify-between gap-2 pl-4 pr-2 py-2 border-b border-line">
          <span className="text-[11px] font-semibold text-content-secondary truncate select-none capitalize">
            {language}
          </span>
          <div className="flex items-center gap-0.5 shrink-0">
            {canPreview && (
              <button
                type="button"
                onClick={handlePreview}
                title="预览"
                aria-label="预览"
                className="p-1.5 rounded-md text-content-muted hover:text-content-primary hover:bg-surface-subtle transition-colors"
              >
                <Eye className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              type="button"
              onClick={handleCopy}
              title="复制代码"
              aria-label="复制代码"
              className="p-1.5 rounded-md text-content-muted hover:text-content-primary hover:bg-surface-subtle transition-colors"
            >
              <Copy className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
      <pre onContextMenu={handleContextMenu} className="p-4 overflow-x-auto text-[13px] leading-[1.7]">
        {children}
      </pre>
    </div>
  )
})

// ```chart 围栏 → recharts 图表卡片(复用 chart-parser 校验,与 MessageBubble 的 chart 元数据卡同款组件)。
// JSON 解析/校验失败降级回普通代码块,原始 JSON 原样可见不吞内容;
// 流式期间走纯文本分支到不了这里,rich 后一次性渲染,半截 JSON 不会反复解析
function ChartBlock({ source, children }: { source: string; children?: React.ReactNode }) {
  const chart = useMemo(() => {
    try {
      return parseChartMetadata({ kind: 'chart', chart: JSON.parse(source) })
    } catch {
      return null
    }
  }, [source])
  if (!chart) return <CodeBlock>{children}</CodeBlock>
  return (
    <div className="my-3">
      <ChartCard chart={chart.chart} />
    </div>
  )
}

// ── 图文混排:正文 [图N] 占位符 → 内联图卡 ─────────────────────────────
// 数据链:服务端搜索工具输出白名单图(编号 n)→ MessageBubble 提取 → 本组件 context。
// 模型正文只写 [图1],渲染前把已知编号替换成 markdown 图片语法(alt 带哨兵前缀),
// mdComponents.img 识别哨兵后渲染 InlineImageCard;未知编号/无图消息原样保留,零扰动。
// 哨兵不能用 __ 或 _ 开头结尾:图片 alt 按 CommonMark 行内内容解析,下划线会被吃成
// 强调(实测 __inline:1__ → alt="inline:1"),字母+冒号+连字符才能原样穿过解析器。
const INLINE_IMG_ALT_PREFIX = 'inline-img:'
const INLINE_IMG_ALT_RE = /^inline-img:(\d+)$/
/** [图1] / [图 1](模型偶尔夹空格);全角括号不认 —— 服务端提示词已钉死半角格式 */
const INLINE_IMG_TOKEN_RE = /\[图\s*(\d+)\]/g
const EMPTY_INLINE_IMAGES: InlineImageRef[] = []

const InlineImagesContext = createContext<InlineImageRef[]>(EMPTY_INLINE_IMAGES)

// 闲鱼推荐块数据源：get_yellow_fish_market 返回的 recentItems（含 no），ExamYellowFishBody 按 no hydrate 出真实商品。
const EMPTY_YELLOW_FISH_ITEMS: YellowFishItemBrief[] = []
const YellowFishItemsContext = createContext<YellowFishItemBrief[]>(EMPTY_YELLOW_FISH_ITEMS)

function formatImgBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${Math.round(bytes / 1024)} KB`
}

/**
 * 把 md 里可解析的 [图N] 替换为 `![__inline:N__](<url>)`。
 * 与 promoteStandaloneMath 同款逐行扫描:围栏代码块内不替换(防误改代码示例);
 * 编号不在白名单(含本消息无图)时原样保留,token 继续以文字可见,不吞内容。
 * URL 走 CommonMark 尖括号目的地,带括号/逗号的图床直链不会被链接解析截断。
 */
function substituteInlineImages(md: string, images: InlineImageRef[]): string {
  if (images.length === 0 || !md.includes('[图')) return md
  const byN = new Map(images.map((i) => [i.n, i]))
  const lines = md.split('\n')
  let inFence = false
  let fenceChar = ''
  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i].trim().match(/^(`{3,}|~{3,})/)
    if (fence) {
      if (!inFence) {
        inFence = true
        fenceChar = fence[1][0]
      } else if (fence[1][0] === fenceChar) {
        inFence = false
        fenceChar = ''
      }
      continue
    }
    if (inFence) continue
    if (!lines[i].includes('[图')) continue
    lines[i] = lines[i].replace(INLINE_IMG_TOKEN_RE, (token, num) => {
      const img = byN.get(Number(num))
      if (!img) return token
      const safeUrl = img.url.replace(/</g, '%3C').replace(/>/g, '%3E')
      return `![${INLINE_IMG_ALT_PREFIX}${img.n}](<${safeUrl}>)`
    })
  }
  return lines.join('\n')
}

/** 白名单图 → 灯箱 Attachment(灯箱只读 url/name;type 走 image/* 语义) */
function toViewerAttachment(image: InlineImageRef): Attachment {
  return {
    url: image.url,
    name: image.description?.trim() || image.host || '搜索配图',
    type: 'image/*',
    size: image.bytes ?? 0,
  }
}

/**
 * 内联图卡:圆角/限高/cover 与预览稿 A-1 一致;图注取 Tavily description,
 * 来源域名走 URL host;onError 退化为承托条(绝不留碎图标)。
 * referrerpolicy="no-referrer" 与服务端白名单探测口径一致(防盗链按无 Referer 放行)。
 * 点图走应用内看图器(缩放/平移/系统返回先关灯箱),不再跳系统浏览器 ——
 * 跳出 App 既放大不了也没有返回键,还会让 WebView 切后台把流掐断(2026-10-24 实测)。
 */
const InlineImageCard = memo(function InlineImageCard({
  image,
  gallery,
}: {
  image: InlineImageRef
  /** 同一条消息的全部白名单图:灯箱内可左右切换,与附件图同一套交互 */
  gallery?: InlineImageRef[]
}) {
  const [failed, setFailed] = useState(false)
  // 骨架承托到 onLoad 才撤:图未到位时不露白底,正文也不跳动
  const [loaded, setLoaded] = useState(false)
  // 看图器下标;null = 关闭
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  const caption = image.description?.trim()
  const visible = gallery && gallery.length > 0 ? gallery : [image]
  const openViewer = () => {
    const i = visible.findIndex((g) => g.n === image.n)
    setViewerIndex(i >= 0 ? i : 0)
  }
  return (
    <span className="inline-fig" data-n={image.n}>
      {!failed ? (
        <button
          type="button"
          onClick={openViewer}
          className="inline-fig-img"
          aria-label={`查看大图:${caption || image.host}`}
          title={caption || image.host}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={image.url}
            alt={caption || image.host || '搜索配图'}
            loading="lazy"
            referrerPolicy="no-referrer"
            decoding="async"
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
          {!loaded && <span className="inline-fig-sk" aria-hidden />}
        </button>
      ) : (
        <span className="inline-fig-broken">
          <ImageOff className="w-3.5 h-3.5" aria-hidden />
          <span className="t">图片加载失败 · {image.host}</span>
          <a href={image.url} target="_blank" rel="noopener noreferrer" className="o">
            查看原图
          </a>
        </span>
      )}
      {!failed && (
        <span className="inline-fig-cap">
          {caption ? <span className="desc">{caption}</span> : null}
          <span className="src">{image.host}</span>
          {image.bytes ? <span className="meta">{formatImgBytes(image.bytes)}</span> : null}
        </span>
      )}
      {viewerIndex != null && (
        <ChatImageLightbox
          images={visible.map(toViewerAttachment)}
          index={viewerIndex}
          onClose={() => setViewerIndex(null)}
          onIndexChange={setViewerIndex}
        />
      )}
    </span>
  )
})

/** mdComponents.img 入口:alt 带哨兵 → 图卡;其余(历史消息里的裸 markdown 图等)走原样式 */
function InlineImageSlot({ src, alt }: { src?: string; alt?: string }) {
  const images = useContext(InlineImagesContext)
  const m = alt?.match(INLINE_IMG_ALT_RE)
  const img = m ? images.find((i) => i.n === Number(m[1])) : undefined
  if (img && src) return <InlineImageCard image={img} gallery={images} />
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={m ? '' : alt ?? ''} className="my-2 max-w-full rounded-xl border border-line" />
}

// markdown 元素 → 项目中性灰 token 样式。只映射视觉关键元素,
// strong/em 等走浏览器默认;不引入 @tailwindcss/typography(依赖与样式都可控)
// 行内容器(h1-h4/p/li/a/th/td/strong/em)的 children 统一过 withInlineMarks 接上双色高亮
const mdComponents: Components = {
  h1: ({ children }) => (
    <h1 className="mt-5 mb-2 text-[20px] font-semibold tracking-[-0.01em] leading-snug text-content-primary first:mt-0">{withInlineMarks(children)}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-5 mb-2 text-[19px] font-semibold tracking-[-0.01em] leading-snug text-content-primary first:mt-0">{withInlineMarks(children)}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-4 mb-1.5 text-[15.5px] font-semibold leading-[1.5] text-content-primary first:mt-0">{withInlineMarks(children)}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-4 mb-1.5 text-[15px] font-semibold text-content-secondary first:mt-0">{withInlineMarks(children)}</h4>
  ),
  p: ({ children }) => {
    // 独立成段的行内公式(模型常把 $..$ 单独成行,看起来夹在正文里很难受):
    // 段内仅一个 .katex 元素、其余为空白 → 渲染成公式卡片(样式见 globals.css .math-card);
    // 「文字+公式」混排段不命中,保持普通段落
    const nodes = React.Children.toArray(children)
    const math = nodes.find(
      (n): n is React.ReactElement<{ className?: string }> =>
        React.isValidElement(n) && n.props.className === 'katex',
    )
    if (math && nodes.every((n) => n === math || (typeof n === 'string' && !n.trim()))) {
      return <p className="math-card">{math}</p>
    }
    return <p className="mb-3.5 last:mb-0">{withInlineMarks(children)}</p>
  },
  ul: ({ children }) => <ul className="my-2.5 list-none space-y-1.5 pl-6">{children}</ul>,
  ol: ({ children }) => <ol className="my-2.5 list-decimal space-y-1.5 pl-6 marker:font-medium marker:text-content-secondary">{children}</ol>,
  li: ({ children }) => (
    // ul 圆点子弹由 before: 伪元素绘制;ol 内的隐藏不用任意变体(实测 [:is(ol)>li]:before:hidden
    // 未被 Tailwind 编译,灰点漏进有序表悬在序号旁),改由 globals.css 的 .rich-md ol > li::before 兜底
    <li className="relative leading-[1.75] before:content-[''] before:absolute before:-left-[16px] before:top-[0.8em] before:h-[5px] before:w-[5px] before:rounded-full before:bg-content-muted">
      {withInlineMarks(children)}
    </li>
  ),
  blockquote: ({ children }) => (
    // 手机端去壳:只留左侧竖线做引用标记,圆角/背景/上下边框全去掉(窄屏一张卡横竖放不下)
    <blockquote className="my-3 rounded-[10px] border border-line border-l-[3px] border-l-content-muted bg-surface px-3.5 py-2.5 text-content-secondary max-md:rounded-none max-md:border-y-0 max-md:border-r-0 max-md:bg-transparent max-md:px-3 max-md:py-0.5">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4 border-line" />,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="no-underline border-b border-line-strong transition-colors hover:border-content-secondary"
    >
      {withInlineMarks(children)}
    </a>
  ),
  table: ({ children }) => (
    // 手机端去壳:表格自身 border-collapse 的行列线足够分区,卡片外框只是吃宽度
    <div className="my-4 overflow-x-auto rounded-xl border border-line bg-surface max-md:my-3 max-md:rounded-none max-md:border-0 max-md:bg-transparent">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-surface-muted">{children}</thead>,
  th: ({ children }) => (
    <th className="border-b border-line px-3.5 py-2 text-left text-[13px] font-semibold text-content-secondary max-md:px-2">{withInlineMarks(children)}</th>
  ),
  td: ({ children }) => <td className="border-b border-line px-3.5 py-2.5 align-top max-md:px-2">{withInlineMarks(children)}</td>,
  // ```mindmap 围栏 → 导图卡片;```chart 围栏 → 图表卡片;```triangle 围栏 → 可交互三角形;
  // 其余语言照旧走 CodeBlock(解析失败时 TriangleFigure 也会退回原始代码块)
  pre: (props) => {
    const { language, code } = extractCodeInfo(props.children)
    if (language === 'mindmap') return <MindMapBlock source={code} />
    if (language === 'chart') return <ChartBlock source={code}>{props.children}</ChartBlock>
    if (language === 'triangle') return <TriangleFigure source={code} rawChildren={props.children} />
    return <CodeBlock>{props.children}</CodeBlock>
  },
  // 行内 code 样式;块级 code 在 pre 内由 globals.css 的 .rich-md pre code 覆盖为无背景无边框
  code: CodeInline,
  // 图片:alt 带 __inline:N__ 哨兵 → 内联图卡(图文混排);其余走普通样式
  img: (props) => <InlineImageSlot src={props.src} alt={props.alt} />,
  // strong/em 接入高亮管线(视觉仍走浏览器默认,如 **加粗==术语==** 也能标红)
  strong: ({ children }) => <strong>{withInlineMarks(children)}</strong>,
  em: ({ children }) => <em>{withInlineMarks(children)}</em>,
}

/* ── live 档：流式期间的轻量渲染 ──────────────────────────────────────
 * 动机(实测): 现状流式全程裸语法符号, 且定格瞬间块结构凭空出现, 长回复整体
 * 重排 264px —— 这是"看着难受"的最大单点。live 档让生成过程即所见即所得。
 * 与 rich 档的分工: 这里只做行级块切分 + 行内加粗/斜体/行内码, 不跑
 * remark/rehype 全管线(KaTeX、highlight、试卷块), 每帧成本是纯字符串扫描;
 * 元素一律调 mdComponents 里同一批渲染函数, 样式单一来源, 不与定格后漂移。 */
type LiveBlock = { start: number } & (
  | { type: 'h'; level: number; text: string }
  | { type: 'p'; text: string }
  | { type: 'quote'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'code'; lang: string; text: string }
  | { type: 'table'; rows: string[][] }
)

type MdElProps = { children?: React.ReactNode; href?: string }
type MdElName = 'h1' | 'h2' | 'h3' | 'h4' | 'p' | 'ul' | 'ol' | 'li' | 'blockquote' | 'table' | 'thead' | 'th' | 'td' | 'pre'

/** 借 mdComponents 的同一渲染函数产出元素(不复制 className) */
function mdEl(name: MdElName, props: MdElProps, key: number | string) {
  const fn = mdComponents[name] as unknown as ((p: MdElProps) => React.ReactElement) | undefined
  if (!fn) return null
  return <React.Fragment key={key}>{fn(props)}</React.Fragment>
}

const LIVE_INLINE_RE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*)/

/**
 * 打字机停在「只开了头、还没闭合」的行内定界符上时,补一个假闭合再切样式。
 * 不补的代价(实测: 一篇 900 字长回答,流式期间 9 次「上面已上屏的文字被改写」):
 * `**` / 反引号会先按字面画上屏,等真闭合那一刻再从 DOM 里吃掉 —— 那一行的结尾少掉
 * 2~7 个字、整行向左回收,肉眼就是「正文往下走,上面的行尾又闪一下」。
 * 补了之后定界符本身永不上屏,内容一出现就是最终样式,真闭合到达时该段 DOM 恰好不动。
 * 只在流式期生效;定格走 react-markdown,以原文为准。
 */
function closePendingAtoms(text: string): string {
  const bolds = text.split('**').length - 1
  if (bolds % 2 === 1) {
    const at = text.lastIndexOf('**')
    const tail = text.slice(at + 2)
    // 开头敲完、后面还没字 → 这个开头先别上屏(否则它按字面亮一帧,下一帧再被吃掉)
    if (!tail) return text.slice(0, at)
    // 闭合 ** 只到第一个 * 时也保持粗体,不能暂时退回字面标记/普通字重。
    if (tail.endsWith('*') && !tail.slice(0, -1).includes('*')) return text + '*'
    if (!tail.includes('*')) return text + '**'
  }
  const ticks = (text.match(/`/g) || []).length
  if (ticks % 2 === 1) {
    const at = text.lastIndexOf('`')
    const tail = text.slice(at + 1)
    if (!tail) return text.slice(0, at)
    if (!tail.includes('`')) return text + '`'
  }
  // 不属于 ** 的裸 * 个数为奇 → 斜体开着没关
  let lastLone = -1
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '*') continue
    if (text[i + 1] === '*' || text[i - 1] === '*') { i++; continue }
    lastLone = i
  }
  const loneStars = (text.match(/\*/g) || []).length - bolds * 2
  if (loneStars % 2 === 1 && lastLone >= 0) {
    const tail = text.slice(lastLone + 1)
    if (!tail) return text.slice(0, lastLone)
    if (!tail.includes('*')) return text + '*'
  }
  return text
}

/** 不按句切分、不挂动画 span。行内 key 跟语法片段的源偏移走,
 * 链接/标点闭合不会再改变已显示文本的父节点。仅样式定界符沿用假闭合。
 * 图片只在普通文本中切分,不侵入行内码/加粗/斜体的既有语义。 */
function liveInline(text: string, keyBase: string, images: InlineImageRef[]): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let offset = 0
  for (const part of closePendingAtoms(text).split(LIVE_INLINE_RE)) {
    const start = offset
    offset += part.length
    if (!part) continue
    const key = `${keyBase}-${start}`
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
      out.push(<strong key={key}>{part.slice(2, -2)}</strong>)
    } else if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      out.push(<CodeInline key={key}>{part.slice(1, -1)}</CodeInline>)
    } else if (part.length > 2 && part.startsWith('*') && part.endsWith('*')) {
      out.push(<em key={key}>{part.slice(1, -1)}</em>)
    } else {
      let cursor = 0
      // 独立或夹在正文中的 [图N] 都能显示;未知编号不动,不引入任意 URL 解析。
      const tokens = images.length ? Array.from(part.matchAll(/\[图\s*(\d+)\]/g)) : []
      for (const token of tokens) {
        const image = images.find((img) => img.n === Number(token[1]))
        if (!image) continue
        const at = token.index!
        if (at > cursor) out.push(<React.Fragment key={`${keyBase}-${start + cursor}`}>{part.slice(cursor, at)}</React.Fragment>)
        out.push(<InlineImageCard key={`${keyBase}-${start + at}`} image={image} gallery={images} />)
        cursor = at + token[0].length
      }
      if (cursor < part.length) out.push(<React.Fragment key={`${keyBase}-${start + cursor}`}>{part.slice(cursor)}</React.Fragment>)
    }
  }
  return out
}

const LIVE_PARA_BREAK_RE = /^(#{1,4}\s|>\s?|\||```|[-*+]\s|\d+[.)]\s|:::)/

/** 解析传入的 live 文本片段;调用方负责尾部增量与必要的边界回退。
 * start 是片段内偏移(调用方补基址);triangle 映射直接提供原始消息偏移。 */
function parseLiveBlocks(md: string, sourceLines?: number[]): LiveBlock[] {
  const lines = md.split('\n')
  let offset = 0
  const starts = sourceLines ?? lines.map((line) => { const start = offset; offset += line.length + 1; return start })
  const blocks: LiveBlock[] = []
  // 最后一个非空行 = 打字机此刻正在写的那一行(只有它处于「半截」状态)
  let lastLine = lines.length - 1
  while (lastLine >= 0 && !lines[lastLine].trim()) lastLine--
  const isPendingMarker = (index: number) =>
    index === lastLine && /^(#{1,4}|[-*+]|\d{1,3}[.)]?|`{1,2})$/.test(lines[index].trim())
  let i = 0
  while (i < lines.length) {
    const start = starts[i]
    const trimmed = lines[i].trim()
    if (!trimmed) { i++; continue }
    // 半截块标记不并入上一段,避免标记补全时改变上一段的文本。
    if (isPendingMarker(i)) break
    // 试卷块标记(:::material 等)流式期直接隐去,内部内容照常按普通块渲染。
    if (/^:::+/.test(trimmed)) { i++; continue }
    const fence = trimmed.match(/^```+([a-zA-Z0-9+#._-]*)/)
    if (fence) {
      const lang = fence[1] || ''
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```+\s*$/.test(lines[i])) { body.push(lines[i]); i++ }
      if (i < lines.length) i++
      blocks.push({ start, type: 'code', lang, text: body.join('\n') })
      continue
    }
    const head = trimmed.match(/^(#{1,4})\s+(.*)$/)
    if (head) { blocks.push({ start, type: 'h', level: head[1].length, text: head[2] }); i++; continue }
    if (/^>\s?/.test(trimmed)) { blocks.push({ start, type: 'quote', text: trimmed.replace(/^>\s?/, '') }); i++; continue }
    if (trimmed.startsWith('|')) {
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = lines[i].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells)
        i++
      }
      blocks.push({ start, type: 'table', rows })
      continue
    }
    const ulItem = /^[-*+]\s+(.*)$/
    if (ulItem.test(trimmed)) {
      const items: string[] = []
      while (i < lines.length) {
        const m = lines[i].trim().match(ulItem)
        if (!m) break
        items.push(m[1]); i++
      }
      blocks.push({ start, type: 'ul', items })
      continue
    }
    const olItem = /^\d+[.)]\s+(.*)$/
    if (olItem.test(trimmed)) {
      const items: string[] = []
      while (i < lines.length) {
        const m = lines[i].trim().match(olItem)
        if (!m) break
        items.push(m[1]); i++
      }
      blocks.push({ start, type: 'ol', items })
      continue
    }
    const para = [lines[i]]
    i++
    while (i < lines.length && lines[i].trim() && !isPendingMarker(i) && !LIVE_PARA_BREAK_RE.test(lines[i].trim())) { para.push(lines[i]); i++ }
    blocks.push({ start, type: 'p', text: para.join(' ').trim() })
  }
  return blocks
}

function renderLiveBlock(b: LiveBlock, k: number, images: InlineImageRef[]): React.ReactNode {
  if (b.type === 'h') {
    const level = Math.min(4, Math.max(1, b.level)) as 1 | 2 | 3 | 4
    return mdEl(`h${level}` as MdElName, { children: liveInline(b.text, `h${k}`, images) }, k)
  }
  if (b.type === 'p') return mdEl('p', { children: liveInline(b.text, `p${k}`, images) }, k)
  if (b.type === 'quote') return mdEl('blockquote', { children: liveInline(b.text, `q${k}`, images) }, k)
  if (b.type === 'ul' || b.type === 'ol') {
    return mdEl(
      b.type,
      { children: b.items.map((t, i) => mdEl('li', { children: liveInline(t, `l${k}-${i}`, images), }, `${k}-${i}`)) },
      k,
    )
  }
  if (b.type === 'code') {
    // 三角形块在流式期只做两档:JSON 已闭合→直接出图;还没写完→定高骨架。
    // 不把半截 JSON 画到屏幕上再换成图,那正是「上面文字被改写」的观感来源。
    if (b.lang === 'triangle') {
      if (parseTriangleFigure(b.text)) {
        return <TriangleFigure key={k} source={b.text} rawChildren={<code className="language-triangle">{b.text}</code>} />
      }
      return (
        <div key={k} className="tri-live-skeleton" aria-hidden>
          <span className="tri-figure-tag">图形</span>
          <span className="tri-skeleton-body" />
        </div>
      )
    }
    return mdEl('pre', { children: <code className={`language-${b.lang}`}>{b.text}</code> }, k)
  }
  const head = b.rows[0] ?? []
  const body = b.rows.slice(1)
  return mdEl(
    'table',
    {
      children: (
        <>
          {mdEl('thead', { children: head.map((c, i) => mdEl('th', { children: liveInline(c, `th${k}-${i}`, images) }, `h${i}`)) }, k)}
          <tbody>
            {body.map((r, ri) => (
              <tr key={ri}>{r.map((c, ci) => mdEl('td', { children: liveInline(c, `td${k}-${ri}-${ci}`, images) }, `c${ci}`))}</tr>
            ))}
          </tbody>
        </>
      ),
    },
    k,
  )
}

// 增量路径复用已完成块的引用;修订/重排路径才按数据比较,不逐帧序列化整篇。
// 图片 context 有实际变化时仍能穿过 memo,无永久缓存。
const LiveBlockView = memo(function LiveBlockView({ block }: { block: LiveBlock }) {
  const images = useContext(InlineImagesContext)
  return renderLiveBlock(block, block.start, images)
}, (previous, next) => previous.block === next.block || JSON.stringify(previous.block) === JSON.stringify(next.block))

const MD_PUNCTUATION = new RegExp('[\\p{P}\\p{S}]', 'u')

/** 收尾复用的保守白名单,不是新的 Markdown 解析器。只放行与 live 树等价的
 * 单行段落/ATX 标题/紧凑平级列表及无嵌套三件套。歧义/扩展语法一律回完整 rich,
 * 包括引用定义、链接、公式、HTML、试卷、游戏、代码围栏等,绝不为保节点禁用功能。 */
function canKeepLiveMarkdown(content: string): boolean {
  if (/[\r\t\\[\]<>_~&$@|]/.test(content) || /www\.|(?:https?|mailto):/i.test(content) || content.includes('***') || content.includes('==')) return false
  const inlineSafe = (text: string): boolean => {
    if (!text || text.trim() !== text || /^-{3,}$/.test(text) || /^(?:[-+*]\s|\d+[.)]\s|:::)/.test(text)) return false
    let offset = 0
    for (const part of text.split(LIVE_INLINE_RE)) {
      const at = offset
      offset += part.length
      if (!part) continue
      const size = part.startsWith('**') ? 2 : part.startsWith('*') || part.startsWith('`') ? 1 : 0
      if (!size) {
        if (/[*`#]/.test(part)) return false
        continue
      }
      if (!part.endsWith(part.slice(0, size))) return false
      const inner = part.slice(size, -size)
      if (!inner || inner.trim() !== inner || /[*`#]/.test(inner)) return false
      if (part[0] === '`') continue
      // CommonMark * 定界符的左右 flanking 条件;含嵌套标记的内容已在上面拒绝。
      const before = text[at - 1] ?? ''
      const after = text[offset] ?? ''
      if (MD_PUNCTUATION.test(inner[0]) && before && !/\s/.test(before) && !MD_PUNCTUATION.test(before)) return false
      if (MD_PUNCTUATION.test(inner[inner.length - 1]) && after && !/\s/.test(after) && !MD_PUNCTUATION.test(after)) return false
    }
    return true
  }
  let previousList = false
  for (const section of content.split(/\n{2,}/)) {
    if (!section) continue
    // 首尾空行允许;段内软换行/硬换行留给 rich,不猜其语义。
    const lines = section.replace(/^\n|\n$/g, '').split('\n')
    const list = lines[0].match(/^([-+*]|\d{1,9}[.)]) (.+)$/)
    if (list) {
      if (previousList) return false // 空行可能把相邻项改成 loose list。
      const ordered = /^\d/.test(list[1])
      if (ordered && !/^1[.)]$/.test(list[1])) return false // live 列表没有自定义 start。
      const delimiter = list[1].slice(-1)
      if (!lines.every((line) => {
        const item = line.match(/^([-+*]|\d{1,9}[.)]) (.+)$/)
        return !!item && /^\d/.test(item[1]) === ordered && item[1].slice(-1) === delimiter && inlineSafe(item[2])
      })) return false
      previousList = true
    } else {
      previousList = false
      if (lines.length !== 1) return false
      const heading = lines[0].match(/^#{1,4} (.+)$/)
      const text = heading ? heading[1] : lines[0]
      if (!inlineSafe(text)) return false
      // 数字/空列表标记等歧义终态交回 rich,包括四位以上编号。
      if (!heading && /^(?:#{1,4}|[-*+]|\d+[.)]?|`{1,2})$/.test(text)) return false
    }
  }
  return true
}

const LiveMarkdown = memo(function LiveMarkdown({ content, sourceLines, rich, inlineImages }: {
  content: string
  sourceLines?: number[]
  rich: boolean
  inlineImages?: InlineImageRef[]
}) {
  const keepBlocks = useMemo(() => !rich || canKeepLiveMarkdown(content), [content, rich])
  const parsedRef = useRef<{ content: string; sourceLines?: number[]; blocks: LiveBlock[] } | null>(null)
  const blocks = useMemo(() => {
    if (!keepBlocks) return []
    const previous = parsedRef.current
    // 通常只重扫最后一块;半截普通行补成列表等结构时,回退一块重判合并边界。
    // 不是按空行永久冻结 Markdown AST:修订/triangle 重排全量重算,
    // 收尾引用定义等仍交完整 rich 管线。
    if (previous && !sourceLines && !previous.sourceLines && content.startsWith(previous.content) && previous.blocks.length) {
      const last = previous.blocks[previous.blocks.length - 1]
      let tail = last.start
      let keep = previous.blocks.length - 1
      let parsed = parseLiveBlocks(content.slice(tail))
      if (last.type === 'p' && parsed[0]?.type !== 'p' && keep > 0) {
        tail = previous.blocks[--keep].start
        parsed = parseLiveBlocks(content.slice(tail))
      }
      return previous.blocks.slice(0, keep).concat(
        parsed.map(block => ({ ...block, start: block.start + tail })),
      )
    }
    return parseLiveBlocks(content, sourceLines)
  }, [content, sourceLines, keepBlocks])
  // 只提交已 commit 的缓存,中断的并发 render 不污染下一次解析。
  useEffect(() => {
    parsedRef.current = keepBlocks ? { content, sourceLines, blocks } : null
  }, [content, sourceLines, blocks, keepBlocks])
  if (!keepBlocks) return <RichMarkdown content={content} inlineImages={inlineImages} />
  return (
    <div className={cn('rich-md', !rich && 'md-live')}>
      {blocks.map((block) => <LiveBlockView key={block.start} block={block} />)}
    </div>
  )
})

/**
 * 把「独占一行」的行内公式($..$)提升为块级($$..$$):
 * 行内公式走 KaTeX textstyle,分数/求和类被渲染得非常紧凑(分子分母挤在分数线两侧);
 * displayStyle 用全尺寸参数,上下舒展。模型单行输出 $..$ 很常见,语义上就是展示公式。
 * 逐行扫描,跳过 fenced code block 内的行,避免误改代码示例;
 * 单行的 $$x$$ 也顺手展开为三行(标准 flow 语法),防 micromark 解析异常。
 */
function promoteStandaloneMath(md: string): string {
  const lines = md.split('\n')
  let inFence = false
  let fenceChar = ''
  for (let i = 0; i < lines.length; i++) {
    const fence = lines[i].trim().match(/^(`{3,}|~{3,})/)
    if (fence) {
      if (!inFence) {
        inFence = true
        fenceChar = fence[1][0]
      } else if (fence[1][0] === fenceChar) {
        inFence = false
        fenceChar = ''
      }
      continue
    }
    if (inFence) continue
    // $$x$$ 单行 → 三行块级
    const block = lines[i].match(/^\s*\$\$(.+)\$\$\s*$/)
    if (block) {
      lines[i] = `$$\n${block[1]}\n$$`
      continue
    }
    // 单 $ 包裹且独占一行(内容不含裸 $,支持 \\ 转义)
    const inline = lines[i].match(/^\s*\$(?!\$)((?:\\.|[^$\\])+?)\$\s*$/)
    if (inline) lines[i] = `$$\n${inline[1]}\n$$`
  }
  return lines.join('\n')
}

/**
 * 首个 ```triangle 围栏提升到消息最顶:解题图是「题目主图」,固定占满消息列、
 * 居中最前,题干/推导文字在图下从头排(教材版式),
 * 不跟随模型落笔位置。只提升第一张(后面的图可能对应变式或后续步骤);
 * 围栏已是第一条内容时原样返回。流式期围栏未闭合时先不提升 —— 不闭合的围栏会被
 * live 解析器吃到 EOF,提升会吞掉后文;闭合后再提升,位置一步到位。
 * 围栏头写法与 live 解析器对齐(```triangle 紧贴无空格)。
 */
function hoistTriangleFigure(md: string): { content: string; sourceLines?: number[] } {
  const unchanged = { content: md }
  if (!md.includes('triangle')) return unchanged
  const lines = md.split('\n')
  let i0 = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^`{3,}triangle\s*$/.test(lines[i].trim())) { i0 = i; break }
  }
  if (i0 < 0) return unchanged
  let j0 = -1
  for (let j = i0 + 1; j < lines.length; j++) {
    if (/^`{3,}\s*$/.test(lines[j].trim())) { j0 = j; break }
  }
  if (j0 < 0) return unchanged
  let t = 0
  while (t < lines.length && !lines[t].trim()) t++
  if (t >= i0) return unchanged
  // 文本与原始行偏移同步搬动,不让被提升的图改变其他块的 React key。
  let offset = 0
  const starts = lines.map((line) => { const start = offset; offset += line.length + 1; return start })
  const fence = lines.slice(i0, j0 + 1)
  const rest = [...lines.slice(0, i0), ...lines.slice(j0 + 1)]
  const out = [...fence]
  const sourceLines = starts.slice(i0, j0 + 1)
  if (rest.length && rest[0].trim()) { out.push(''); sourceLines.push(-1) }
  out.push(...rest)
  sourceLines.push(...starts.slice(0, i0), ...starts.slice(j0 + 1))
  return { content: out.join('\n'), sourceLines }
}

/**
 * LaTeX 原生定界符归一化: \(...\) → $...$、\[...\] → $$...$$
 * 课本 chunk 与部分模型(GLM 系)用 \( \) 风格写公式,remarkMath 只认 $ 定界符——
 * 不转换会整段漏渲染,且 \\ 换行被 markdown 转义吞成鬼画符;fenced code 内不处理
 */
function normalizeMathDelimiters(md: string): string {
  if (!md.includes('\\(') && !md.includes('\\[')) return md
  const segs = md.split(/(`{3,}[\s\S]*?`{3,}|~{3,}[\s\S]*?~{3,})/g)
  return segs
    .map((seg, i) =>
      i % 2 === 1
        ? seg
        : seg
            .replace(/\\\(([\s\S]*?)\\\)/g, (_m, inner) => `$${inner}$`)
            .replace(/\\\[([\s\S]*?)\\\]/g, (_m, inner) => `$$${inner}$$`),
    )
    .join('')
}

// memo: content/promote 均为原始值,父组件重渲染(操作按钮态、工具卡状态等)时
// 内容未变的段直接跳过整条 react-markdown 管线(解析+KaTeX+高亮)
const RichSegment = memo(function RichSegment({ content, promote = true }: { content: string; promote?: boolean }) {
  // 插件数组引用固定(memo),避免父组件重渲染导致 ReactMarkdown 反复重新解析
  const remarkPlugins = useMemo(() => [remarkGfm, remarkMath], [])
  // rehype-highlight 只认 language-* 标注(detect:false 防误染普通文本),未注册语言静默跳过
  const rehypePlugins = useMemo<PluggableList>(
    () => [
      [rehypeKatex, { throwOnError: false, strict: false }],
      [rehypeHighlight, { detect: false, ignoreMissing: true }],
    ],
    [],
  )
  // 内容稳定后才进富渲染,预处理只跑一次;先归一化定界符再决定是否块级升级
  // promote=false 用于选择题选项/诗行等短文本行——单行纯公式升级成块级卡片(math-card/katex-display)
  // 在正文里是美化,在选项里每个选项一张大卡是灾难;定界符归一化对选项同样需要,不受 promote 开关影响
  const promoted = useMemo(() => {
    const normalized = normalizeMathDelimiters(content)
    const withMath = promote ? promoteStandaloneMath(normalized) : normalized
    // 「序号｜」行兜底硬换行：模型漏写 :::yellow-fish 块时防分档条目被段落合并黏成一片
    return forceRankLineBreaks(withMath)
  }, [content, promote])
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={mdComponents}>
      {promoted}
    </ReactMarkdown>
  )
})

const EXAM_TAG: Record<ExamKind, string> = { choice: '选择题', material: '材料', question: '设问', answer: '作答', poem: '诗句', lyrics: '歌词', essay: '作文', timeline: '时间轴', translate: '译文', sentence: '成分分析', gamestatus: '状态', gamechoice: '行动', 'yellow-fish': '闲鱼推荐' }

/** 题干自带题号（1. / 1、/ 1））: 题库原题逐字转写时常见。剥离后统一走卷面题号，
 *  既避免「1. 1. 题干」双号，也避免「1. 」被 markdown 解析成有序列表；后随数字不剥（「1.5万」不是题号） */
const STEM_OWN_NO_RE = /^\s*\d{1,3}\s*[.、．)）]\s*(?!\d)/

/** 卷面题号行: 题号缀在题干首行左侧、与首行基线对齐；no 缺省时按普通题干渲染 */
function ExamStemRow({ no, stem }: { no?: number; stem: string }) {
  // 只在有卷面题号替换时才剥离原文号，保证任何情况下不吞内容
  if (no == null) return <RichSegment content={stem} />
  const cleaned = stem.replace(STEM_OWN_NO_RE, '')
  return (
    <div className="exam-stem-row">
      <span className="exam-qno" aria-hidden>{no}.</span>
      <div className="exam-stem-body">
        <RichSegment content={cleaned} />
      </div>
    </div>
  )
}

/**
 * 选择题「可作答答题卡」上下文：状态挂在每条消息（RichMarkdown）内部。
 * 纸面（isPaper）下的选择题选项渲染为可点按钮，单选；卷末汇总「题号+我的选项」
 * 发回 AI 逐题批改。按消息正文哈希持久化到 localStorage，刷新/切走再回选中项仍在。
 */
interface QuizAnswerCtxValue {
  /** 本消息为可选答的成卷，且至少含一道有选项的选择题 */
  paper: boolean
  pickedOf: (qno: number) => string | undefined
  onPick: (qno: number, letter: string) => void
}
const QuizAnswerCtx = createContext<QuizAnswerCtxValue | null>(null)

/** 正文 djb2 短哈希作持久化键（同一条消息内容不变 → 同键，无需透传 message id） */
function quizStoreKey(content: string): string {
  let h = 5381
  for (let i = 0; i < content.length; i++) h = ((h << 5) + h + content.charCodeAt(i)) | 0
  return `quiz-picks:${(h >>> 0).toString(36)}`
}

function readQuizPicks(key: string): Record<number, string> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as Record<number, string>) : {}
  } catch {
    return {}
  }
}

/** 单组题面: 题干 + 试卷式选项（长选项通栏，全部短选项时自动两列）；选项内高亮照常生效。
 *  成卷（quiz.paper）且本组有题号时，选项转为可点按钮：点中高亮、再点取消（单选） */
function ChoiceGroupView({ stem, options, no }: { stem: string; options: ExamChoiceOption[]; no?: number }) {
  const quiz = useContext(QuizAnswerCtx)
  if (!options.length) return <ExamStemRow no={no} stem={stem} />
  // 试卷排版启发: 短选项（如古文化常识/词语判断）两列更像卷面，长句选项通栏易读
  const twoCol = options.length > 2 && options.every((o) => o.text.length <= 14)
  const selectable = !!(quiz?.paper && no != null)
  const picked = selectable ? quiz!.pickedOf(no as number) : undefined
  return (
    <div className="exam-choice-group">
      {stem && <ExamStemRow no={no} stem={stem} />}
      <div className={cn('exam-options', twoCol && 'exam-options-2col')}>
        {options.map((o) => {
          const body = (
            <>
              <span className="exam-option-letter" aria-hidden>{o.letter}</span>
              <div className="flex-1 min-w-0">
                <RichSegment content={o.text} promote={false} />
              </div>
            </>
          )
          if (!selectable) return <div key={o.letter} className="exam-option">{body}</div>
          const isPicked = picked === o.letter
          return (
            <button
              key={o.letter}
              type="button"
              className={cn('exam-option exam-option-btn', isPicked && 'is-picked')}
              aria-pressed={isPicked}
              onClick={() => quiz!.onPick(no as number, isPicked ? '' : o.letter)}
            >
              {body}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** 选择题块渲染: 单题直渲；模型把多题塞进一个块时（parseChoice 拆组成功）逐组渲染，组间虚线分隔；
 *  startNo 为卷内首题题号，拆组时逐组递增 */
function ExamChoiceBody({ text, startNo }: { text: string; startNo?: number }) {
  const { stem, options, groups } = useMemo(() => parseChoice(text), [text])
  if (!options.length) return <ExamStemRow no={startNo} stem={text} />
  if (groups.length > 1) {
    return groups.map((g, i) => (
      <ChoiceGroupView key={i} stem={g.stem} options={g.options} no={startNo != null ? startNo + i : undefined} />
    ))
  }
  return <ChoiceGroupView stem={stem} options={options} no={startNo} />
}

/** 译文块分区: 英文题目的中文翻译卡(首行题干+逐选项中文)，复用 parseChoice 的选项行解析;
 * 无选项行时整块按普通文本渲染(语法填空整篇译文等场景)；配色弱化为注释层，不抢英文题面 */
function ExamTranslateBody({ text }: { text: string }) {
  const { stem, options } = useMemo(() => parseChoice(text), [text])
  if (!options.length) return <RichSegment content={text} promote={false} />
  return (
    <>
      {stem && <div className="exam-translate-stem"><RichSegment content={stem} promote={false} /></div>}
      <div className="exam-translate-options">
        {options.map((o) => (
          <div key={o.letter} className="exam-translate-option">
            <span className="exam-translate-letter" aria-hidden>{o.letter}</span>
            <div className="flex-1 min-w-0"><RichSegment content={o.text} promote={false} /></div>
          </div>
        ))}
      </div>
    </>
  )
}

/** 成分配色映射: 每种成分一色，从句按句法功能继承同色(定语从句=定语色、状语从句=状语色…)；
 * 色值见 globals.css 的 --sent-* 色板，键对应 .exam-sent-c-* 变量类 */
const SENTENCE_ROLE_COLOR: Record<string, string> = {
  主语: 'subj', 主语从句: 'subj',
  谓语: 'pred', 谓语动词: 'pred',
  宾语: 'obj', 宾语从句: 'obj',
  表语: 'preci', 表语从句: 'preci',
  定语: 'attr', 定语从句: 'attr',
  状语: 'adv', 状语从句: 'adv',
  补语: 'comp',
  同位语: 'appo', 同位语从句: 'appo',
  插入语: 'pare',
  中心语: 'head',
  从句: 'attr',
}

function sentenceRoleColor(role: string): string {
  return SENTENCE_ROLE_COLOR[role] ?? ''
}

/** 成分回标: 把明细行的成分片段在原句中定位(找不到再试大小写不敏感),
 * 重叠消解后按区间切分渲染——每成分一色底色+下划线(课本图解思路)。
 * 回标是纯展示增强: 匹配失败只是不着色,不吞内容;主干行不参与(内容为主干提炼非原句片段) */
interface SentenceMark { start: number; end: number; color: string }

function collectSentenceMarks(sentence: string, parts: ExamSentencePart[]): SentenceMark[] {
  if (!sentence) return []
  const plain = sentence.replace(/(==+|@@+)/g, '')
  const marks: SentenceMark[] = []
  for (const p of parts) {
    if (p.backbone || !p.text) continue
    const color = sentenceRoleColor(p.role)
    if (!color) continue
    const needle = p.text.trim()
    if (needle.length < 2) continue
    let idx = plain.indexOf(needle)
    if (idx < 0) {
      const li = plain.toLowerCase().indexOf(needle.toLowerCase())
      if (li >= 0) idx = li
    }
    if (idx < 0) continue
    marks.push({ start: idx, end: idx + needle.length, color })
  }
  marks.sort((a, b) => a.start - b.start || b.end - a.end)
  const out: SentenceMark[] = []
  let lastEnd = -1
  for (const m of marks) {
    if (m.start >= lastEnd) {
      out.push(m)
      lastEnd = m.end
    }
  }
  return out
}

function SentenceAnnotated({ sentence, marks }: { sentence: string; marks: SentenceMark[] }) {
  const nodes: React.ReactNode[] = []
  let cursor = 0
  marks.forEach((m, i) => {
    if (m.start > cursor) nodes.push(<span key={`t${i}`}>{sentence.slice(cursor, m.start)}</span>)
    nodes.push(
      <span key={`m${i}`} className={cn('exam-sentence-hl-c', `exam-sent-c-${m.color}`)}>
        {sentence.slice(m.start, m.end)}
      </span>,
    )
    cursor = m.end
  })
  if (cursor < sentence.length) nodes.push(<span key="tail">{sentence.slice(cursor)}</span>)
  return <>{nodes}</>
}

/** 句子成分块分区: 首行原句(成分内容自动回标着色) + 成分明细列表(徽标+内容+说明);
 * 徽标分档同源双色(主干红/修饰蓝),保持卷面两色纪律;无原句或成分行时回退普通文本 */
function ExamSentenceBody({ text }: { text: string }) {
  const { sentence, parts, note } = useMemo(() => parseSentence(text), [text])
  const marks = useMemo(() => collectSentenceMarks(sentence, parts), [sentence, parts])
  if (!sentence && !parts.length) return <RichSegment content={text} promote={false} />
  return (
    <>
      {sentence && <div className="exam-sentence-raw"><SentenceAnnotated sentence={sentence} marks={marks} /></div>}
      {parts.length > 0 && (
        <div className="exam-sentence-rows">
          {parts.map((p, i) => (
            <div key={i} className={cn('exam-sentence-row', p.backbone && 'exam-sentence-row-bb')}>
              <span
                className={
                  p.backbone
                    ? 'exam-sentence-role exam-sentence-role-bb'
                    : cn('exam-sentence-role exam-sentence-role-c', `exam-sent-c-${sentenceRoleColor(p.role)}`)
                }
              >
                {p.role}
              </span>
              <div className="exam-sentence-text">
                {p.text && <RichSegment content={p.text} promote={false} />}
                {p.note && <span className="exam-sentence-note">｜{p.note}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
      {note && <div className="exam-sentence-footnote"><RichSegment content={note} promote={false} /></div>}
    </>
  )
}

/** 时间轴块分区: 左侧年份列+竖轴+节点事件流,行首 * 为关键节点(红点);
 * 事件名/标题/尾注走行内高亮,说明行走 RichSegment(双色标注/行内公式照常生效) */
function ExamTimelineBody({ text }: { text: string }) {
  const { title, events, note } = useMemo(() => parseTimeline(text), [text])
  return (
    <>
      {title && <div className="exam-timeline-title">{withInlineMarks(title)}</div>}
      <div className="exam-timeline-body">
        <div className="exam-timeline-axis" aria-hidden />
        {events.map((ev, i) => (
          <div key={i} className={cn('exam-timeline-item', ev.key && 'exam-timeline-item-key')}>
            <span className="exam-timeline-year" aria-hidden>{ev.year}</span>
            <span className="exam-timeline-node" aria-hidden />
            <div className="exam-timeline-head">
              {ev.era && <span className="exam-timeline-era">{ev.era}</span>}
              <span className="exam-timeline-name">{withInlineMarks(ev.name)}</span>
            </div>
            {ev.desc && <div className="exam-timeline-desc"><RichSegment content={ev.desc} promote={false} /></div>}
            {ev.src && <div className="exam-timeline-src">{ev.src}</div>}
          </div>
        ))}
      </div>
      {note && <div className="exam-timeline-note">{withInlineMarks(note)}</div>}
    </>
  )
}

/** 闲鱼推荐卡分区: 模型只给「序号+理由+风险」,商品真实标题/价格/图/链接从 YellowFishItemsContext hydrate。
 *  序号对不上（模型编了不存在的 no）时退回纯理由行,不编造商品。
 *  折叠：标题行即开关,默认展开；收起后只留一行标题条（共 N 件提示数量）,商品列表和尾注一起藏起。 */
function ExamYellowFishBody({ text }: { text: string }) {
  const { title, items, note } = useMemo(() => parseYellowFish(text), [text])
  const all = useContext(YellowFishItemsContext)
  const [open, setOpen] = useState(true)
  const { isFavorited, toggle } = useYellowFishFavorites()
  // 卡片 → 收藏入参: itemId 从链接解析; region 是「位置 · 卖家」拼接串,拆回两字段喂收藏池
  // (监控快照只有位置时 seller 为空)。解析不出 id 返回 null,调用方不给入口。
  const buildListing = useCallback((it: YellowFishItemBrief) => {
    const itemId = it.link.match(/[?&]id=(\d{5,20})/)?.[1] ?? ''
    if (!itemId) return null
    const [location, seller] = (it.region ?? '').split(' · ')
    return {
      itemId,
      title: it.title,
      price: it.price,
      priceDisplay: it.priceDisplay,
      url: it.link,
      pic: it.image,
      location: location || undefined,
      seller: seller || undefined,
    }
  }, [])
  // 星标按钮: 手机端主力入口(tap 即收藏,长按对链接只有原生「打开/复制链接」),
  // 桌面同形。必须 preventDefault+stopPropagation,否则点星标会触发外层 <a> 导航。
  const handleStarClick = useCallback(
    (e: React.MouseEvent, listing: NonNullable<ReturnType<typeof buildListing>>) => {
      e.preventDefault()
      e.stopPropagation()
      void toggle(listing)
    },
    [toggle]
  )
  // 卡片右键=商品级菜单(收藏/复制链接),与消息级右键分工:命中卡片时 stopPropagation,
  // 不再弹消息菜单。触屏端(pointer:coarse)沿用消息侧口径交回原生长按,不做自定义。
  const handleItemContextMenu = useCallback(
    (e: React.MouseEvent, it: YellowFishItemBrief) => {
      if (window.matchMedia('(pointer: coarse)').matches) return
      const listing = buildListing(it)
      if (!listing) return
      e.preventDefault()
      e.stopPropagation()
      const favorited = isFavorited(listing.itemId)
      const menuItems: ContextMenuItem[] = [
        {
          id: 'favorite-item',
          label: favorited ? '取消收藏商品' : '收藏商品',
          icon: <Star className={cn('w-3.5 h-3.5', favorited && 'fill-current text-accent')} />,
          onSelect: () => void toggle(listing),
        },
        {
          id: 'copy-item-link',
          label: '复制商品链接',
          icon: <Link2 className="w-3.5 h-3.5" />,
          onSelect: () => {
            if (!navigator.clipboard?.writeText) {
              toast.error('当前浏览器不支持自动复制', { title: '复制失败' })
              return
            }
            navigator.clipboard.writeText(it.link).then(
              () => toast.hint('已复制商品链接'),
              () => toast.error('复制失败，请重试'),
            )
          },
        },
      ]
      useContextMenuStore.getState().openContextMenu({ x: e.clientX, y: e.clientY }, menuItems, 'YellowFish 商品')
    },
    [buildListing, isFavorited, toggle]
  )
  return (
    <>
      <button type="button" className="exam-yellow-fish-header" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="exam-yellow-fish-title">{title || `闲鱼推荐 · 共 ${items.length} 件`}</span>
        <ChevronRight className="exam-yellow-fish-chevron" strokeWidth={2} />
      </button>
      {open && (
        <>
          <div className="exam-yellow-fish-list">
        {items.map((r, i) => {
          const it = all.find((x) => x.no === r.no)
          if (!it) {
            return (
              <div key={i} className="exam-yellow-fish-miss">
                <span className="exam-yellow-fish-miss-no">#{r.no}</span>
                <span className="exam-yellow-fish-miss-reason">{r.reason || '（未匹配到具体商品）'}</span>
              </div>
            )
          }
          const meta = [it.region, it.publishTime ? String(it.publishTime).slice(5, 10) : ''].filter(Boolean).join(' · ')
          const listing = buildListing(it)
          const favorited = !!listing && isFavorited(listing.itemId)
          return (
            <a key={i} href={it.link} target="_blank" rel="noreferrer" className="exam-yellow-fish-item" onContextMenu={(e) => handleItemContextMenu(e, it)}>
              {it.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={it.image} alt="" loading="lazy" referrerPolicy="no-referrer" className="exam-yellow-fish-thumb" />
              ) : (
                <span className="exam-yellow-fish-thumb exam-yellow-fish-thumb-empty" aria-hidden />
              )}
              <span className="exam-yellow-fish-main">
                <span className="exam-yellow-fish-name">{it.title}</span>
                {r.reason ? <span className="exam-yellow-fish-reason">{r.reason}</span> : null}
                <span className="exam-yellow-fish-head">
                  <span className="exam-yellow-fish-price">{it.price != null ? `¥${it.price}` : (it.priceDisplay || '—')}</span>
                  {r.risk ? <span className="exam-yellow-fish-risk">⚠ {r.risk}</span> : null}
                </span>
                {meta || it.avatar ? (
                  <span className="exam-yellow-fish-foot">
                    {it.avatar ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={it.avatar} alt="" loading="lazy" referrerPolicy="no-referrer" className="exam-yellow-fish-avatar" />
                    ) : null}
                    {meta ? <span className="exam-yellow-fish-meta">{meta}</span> : null}
                  </span>
                ) : null}
              </span>
              {listing && (
                <button
                  type="button"
                  className="exam-yellow-fish-fav"
                  aria-label={favorited ? '取消收藏该商品' : '收藏该商品'}
                  title={favorited ? '取消收藏' : '收藏'}
                  onClick={(e) => handleStarClick(e, listing)}
                >
                  <Star className={cn('w-3.5 h-3.5', favorited && 'fill-current text-accent')} strokeWidth={1.8} />
                </button>
              )}
            </a>
          )
        })}
          </div>
          {note && <div className="exam-yellow-fish-note">{note}</div>}
        </>
      )}
    </>
  )
}

/** 诗块分区: 逐行居中疏排;markdown 单换行不产生换行,故按物理行切分,每行独立渲染(保留行内加粗/高亮) */
function ExamPoemBody({ text }: { text: string }) {
  const lines = useMemo(() => text.split('\n').map((l) => l.trim()).filter(Boolean), [text])
  return (
    <>
      {lines.map((line, i) => (
        <div key={i} className="exam-poem-line">
          <RichSegment content={line} promote={false} />
        </div>
      ))}
    </>
  )
}

/** 作文纸分区: 首行标题居中疏排,正文走完整 markdown(双色标注生效);字数徽标为前端实时计数(占格口径:含标题含标点,剔除行内语法符);右上角一键复制纯文本(标题+正文,已剥语法符) */
function ExamEssayBody({ text }: { text: string }) {
  const { title, body } = useMemo(() => parseEssay(text), [text])
  const charCount = useMemo(() => countEssayChars(title, body), [title, body])
  const plainText = useMemo(() => essayToPlainText(title, body), [title, body])
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    if (!navigator.clipboard?.writeText) {
      toast.error('当前浏览器不支持自动复制', { title: '复制失败' })
      return
    }
    navigator.clipboard.writeText(plainText)
      .then(() => {
        setCopied(true)
        toast.success('已复制作文全文', { title: '复制' })
        setTimeout(() => setCopied(false), 2000)
      })
      .catch((err) => {
        console.error('[ExamEssay] copy failed:', err)
        toast.error('复制失败', { title: '复制' })
      })
  }, [plainText])

  return (
    <>
      <button
        type="button"
        onClick={handleCopy}
        className="absolute right-2 top-2 p-1 rounded-md text-content-muted hover:text-content-primary hover:bg-surface-subtle transition-colors"
        title="复制作文全文"
        aria-label="复制作文"
      >
        {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
      </button>
      {title && <div className="exam-essay-title">{title}</div>}
      {body && <RichSegment content={body} />}
      {charCount > 0 && <div className="exam-essay-wc">全文 {charCount} 字</div>}
    </>
  )
}

/** 设问小问拆行: (1)/(2) 或 ①② 这类编号在一段内出现≥2个时,每个小问独立成行(试卷惯例);
 * 编号后括号必须纯数字,避免误伤 f(x)/(1+x) 这类数学式 */
const QUESTION_PART_SPLIT_RE = /(?=[(（]\s*\d{1,2}\s*[)）]|[①-⑫])/

function ExamQuestionBody({ text, no }: { text: string; no?: number }) {
  const parts = useMemo(() => text.split(QUESTION_PART_SPLIT_RE).map((s) => s.trim()).filter(Boolean), [text])
  // 拆行用行尾双空格硬换行:小问问距保持行内紧凑,不产生段落级大空隙
  return <ExamStemRow no={no} stem={parts.length >= 2 ? parts.join('  \n') : text} />
}

/** 出题场景的作答块:默认收起防剧透,点击展开(仅当同组题块带出处徽标时启用);流式期间折叠状态不重置。
 * 折叠态按钮提到块头行(与「作答」标签同一水平线,与参考徽标同位),块塌缩成薄条;展开后右上角提供收起,防剧透闭环 */
function ExamAnswerBody({ text, collapsible }: { text: string; collapsible: boolean }) {
  const [open, setOpen] = useState(false)
  if (!collapsible) return <RichSegment content={text} />
  const toggle = () => setOpen((v) => !v)
  if (open)
    return (
      <>
        <RichSegment content={text} />
        <button type="button" onClick={toggle} className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[11px] text-content-muted hover:text-content-primary hover:bg-surface-subtle transition-colors" aria-label="收起答案">
          <ChevronUp className="w-3 h-3" />
          收起
        </button>
      </>
    )
  return (
    <button type="button" onClick={toggle} className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md border border-line bg-surface-subtle px-2.5 py-1 text-[11px] text-content-muted hover:text-content-primary transition-colors" aria-label="显示答案">
      <ChevronDown className="w-3 h-3" />
      显示答案
    </button>
  )
}

/** 出处行学科中文标签 → 题库 subject 英文枚举(save route 白名单只收英文,直传中文会被 skip) */
const SUBJECT_ENUM: Record<string, string> = {
  数学: 'math',
  语文: 'chinese',
  英语: 'english',
  物理: 'physics',
  化学: 'chemistry',
  生物: 'biology',
  历史: 'history',
  政治: 'politics',
  地理: 'geography',
}

/** 题卡右上角:出处徽标 + 收进题库(题块与紧邻答案块齐备才显示按钮);入库后变绿勾禁用 */
function QuizRefBadge({
  refName,
  subject,
  quizKind,
  stem,
  answerText,
}: {
  refName: string
  subject: string | null
  quizKind: 'choice' | 'answer'
  stem: string
  answerText: string
}) {
  const [state, setState] = useState<'idle' | 'saving' | 'done'>('idle')

  const handleSave = useCallback(async () => {
    if (state !== 'idle') return
    setState('saving')
    try {
      const res = await fetch('/api/study/quiz/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          items: [
            {
              subject: (subject && SUBJECT_ENUM[subject]) || 'other',
              kind: quizKind,
              stem,
              answer: answerText,
              sourceRef: refName,
              source: 'ai_generated',
            },
          ],
        }),
      })
      const data = (await res.json().catch(() => null)) as { error?: string } | null
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
      setState('done')
      toast.success('已收进题库', { title: '题库' })
    } catch (err) {
      setState('idle')
      console.error('[QuizRefBadge] save failed:', err)
      toast.error(err instanceof Error ? err.message : '入库失败', { title: '收进题库' })
    }
  }, [state, subject, quizKind, stem, answerText, refName])

  return (
    <span className="absolute right-2 top-2 inline-flex items-center gap-1">
      <span className="text-[11px] leading-none text-content-muted whitespace-nowrap">参考 {refName}</span>
      <button
        type="button"
        onClick={handleSave}
        disabled={state !== 'idle'}
        className="p-1 rounded-md text-content-muted hover:text-content-primary hover:bg-surface-subtle transition-colors"
        title={state === 'done' ? '已在题库' : '收进题库'}
        aria-label="收进题库"
      >
        {state === 'done' ? <Check className="w-3.5 h-3.5 text-green-500" /> : <BookPlus className="w-3.5 h-3.5" />}
      </button>
    </span>
  )
}

/** 试卷分区: 材料(浅底纹)/设问(深角标)/作答;相邻块经 join-* 接成一张“试卷纸”;内部仍走完整 markdown 渲染。
 *  出题扩展: 题块(choice/question)首行「参考 §x.x·学科」剥出为右上徽标;带徽标的题块其紧邻答案块默认折叠; */
function ExamBlock({
  kind,
  text,
  joinTop,
  joinBottom,
  answerCollapsible,
  quizAnswerText,
  questionNo,
}: {
  kind: ExamKind
  text: string
  joinTop?: boolean
  joinBottom?: boolean
  /** answer 块专用:前块为带出处的题块时 true(默认收起防剧透) */
  answerCollapsible?: boolean
  /** 题块专用:紧邻 answer 块原文(齐备才显示收进题库按钮) */
  quizAnswerText?: string
  /** 题块专用:卷内题号(渲染层按消息内题块顺序编号) */
  questionNo?: number
}) {
  const isQuizStem = kind === 'choice' || kind === 'question'
  const { sourceRef, body } = isQuizStem ? parseSourceRefLine(text) : { sourceRef: null as ExamSourceRef | null, body: text }
  const displayText = isQuizStem ? body : text
  // 题库原题(practice_questions 抽题,出处行「参考 题库 …」)本来就已入库,
  // 即使模型违规带了紧邻答案块也不再显示「收进题库」按钮,只留出处标签
  const isBankRef = sourceRef?.ref.startsWith('题库') ?? false
  return (
    <div
      className={cn(
        'exam-block',
        'relative',
        `exam-${kind}`,
        joinTop && 'exam-join-top',
        joinBottom && 'exam-join-bottom',
      )}
    >
      {/* 闲鱼推荐卡不显示块标签（用户点名删掉，商品卡自身已有完整视觉） */}
      {kind !== 'yellow-fish' && <span className="exam-block-tag">{EXAM_TAG[kind]}</span>}
      {sourceRef && quizAnswerText && !isBankRef && (
        <QuizRefBadge
          refName={sourceRef.ref}
          subject={sourceRef.subject}
          quizKind={kind === 'choice' ? 'choice' : 'answer'}
          stem={body}
          answerText={quizAnswerText}
        />
      )}
      {sourceRef && (!quizAnswerText || isBankRef) && (
        <span className="absolute right-2 top-2 text-[11px] leading-none text-content-muted whitespace-nowrap">参考 {sourceRef.ref}</span>
      )}
      {kind === 'choice' ? (
        <ExamChoiceBody text={displayText} startNo={questionNo} />
      ) : kind === 'timeline' ? (
        <ExamTimelineBody text={text} />
      ) : kind === 'yellow-fish' ? (
        <ExamYellowFishBody text={text} />
      ) : kind === 'poem' || kind === 'lyrics' ? (
        <ExamPoemBody text={text} />
      ) : kind === 'essay' ? (
        <ExamEssayBody text={text} />
      ) : kind === 'question' ? (
        <ExamQuestionBody text={displayText} no={questionNo} />
      ) : kind === 'translate' ? (
        <ExamTranslateBody text={text} />
      ) : kind === 'sentence' ? (
        <ExamSentenceBody text={text} />
      ) : kind === 'answer' ? (
        <ExamAnswerBody text={text} collapsible={!!answerCollapsible} />
      ) : (
        <RichSegment content={displayText} />
      )}
    </div>
  )
}

/** 车仪表式数值表: 270° 刻度环 + 指针 + 下方数值。纯 SVG,零依赖。
 * 指针角度 = 135° + 270° × ratio(0 在左下、满值在右下、开口朝下),与预览页 B 形态同源 */
function GameGauge({ stat }: { stat: GameStat }) {
  const ratio = Math.max(0, Math.min(1, (stat.cur ?? 0) / (stat.max || 1)))
  const C = 2 * Math.PI * 44
  const ARC = C * 0.75
  const needle = (135 + 270 * ratio) * (Math.PI / 180)
  const nx = 60 + 32 * Math.cos(needle)
  const ny = 60 + 32 * Math.sin(needle)
  const ticks: React.ReactNode[] = []
  for (let i = 0; i <= 10; i++) {
    const t = (135 + 27 * i) * (Math.PI / 180)
    const r1 = i % 5 === 0 ? 50 : 52
    ticks.push(
      <line
        key={i}
        className="game-gauge-tick"
        x1={60 + r1 * Math.cos(t)}
        y1={60 + r1 * Math.sin(t)}
        x2={60 + 56 * Math.cos(t)}
        y2={60 + 56 * Math.sin(t)}
        strokeWidth={i % 5 === 0 ? 2 : 1}
      />,
    )
  }
  return (
    <svg viewBox="0 0 120 120" className="game-gauge-svg" aria-hidden>
      {ticks}
      <circle
        className="game-gauge-track"
        cx={60}
        cy={60}
        r={44}
        fill="none"
        strokeWidth={4}
        strokeDasharray={`${ARC} ${C}`}
        transform="rotate(135 60 60)"
      />
      <line className="game-gauge-needle" x1={60} y1={60} x2={nx} y2={ny} strokeWidth={3} strokeLinecap="round" />
      <circle className="game-gauge-hub" cx={60} cy={60} r={5} />
      <text className="game-gauge-value" x={60} y={92} textAnchor="middle">
        {stat.cur}
        <tspan className="game-gauge-max">/{stat.max}</tspan>
      </text>
    </svg>
  )
}

/** 游戏状态面板: 数值型(cur/max)渲染为车仪表(连续数值并排成一行),文本型渲染为标签+值 chip;
 * 与试卷块同款卡片语言但独立视觉(深色 HUD 感),点击无副作用(纯展示) */
function GameStatusCard({ text }: { text: string }) {
  const stats = useMemo<GameStat[]>(() => parseGameStatus(text), [text])
  if (!stats.length) return <RichSegment content={text} />
  // 连续的数值状态合并进同一行仪表排,保持模型输出顺序
  // (时间/地点 chip → 仪表行 → 现金/存款/职业 chip)
  const blocks: React.ReactNode[] = []
  let gaugeRun: GameStat[] = []
  const flushGauges = () => {
    if (!gaugeRun.length) return
    blocks.push(
      <div key={`gauge-${blocks.length}`} className="game-gauge-row">
        {gaugeRun.map((s, j) => (
          <div key={j} className="game-gauge-cell">
            <GameGauge stat={s} />
            <span className="game-stat-label">{s.label}</span>
          </div>
        ))}
      </div>,
    )
    gaugeRun = []
  }
  stats.forEach((s, i) => {
    if (s.cur !== undefined && s.max) {
      gaugeRun.push(s)
    } else {
      flushGauges()
      blocks.push(
        <div key={i} className="game-stat game-stat-chip">
          <span className="game-stat-label">{s.label}</span>
          {s.value && <span className="game-stat-value">{s.value}</span>}
        </div>,
      )
    }
  })
  flushGauges()
  return (
    <div className="game-panel game-status">
      <div className="game-panel-head">
        <Gauge className="w-3.5 h-3.5" aria-hidden />
        <span>状态</span>
      </div>
      <div className="game-status-grid">{blocks}</div>
    </div>
  )
}

/** 游戏行动面板: 每行一个可点行动,点击即当作 user 消息发出(sendTextAsUser → ChatPanel.handleSend)。
 * 自由行动不占选项——用户直接在输入框打字即可,故这里只渲染模型给出的具名行动 */
function GameChoiceCard({ text }: { text: string }) {
  const options = useMemo<string[]>(() => parseGameChoice(text), [text])
  if (!options.length) return <RichSegment content={text} />
  return (
    <div className="game-panel game-choice">
      <div className="game-panel-head">
        <Zap className="w-3.5 h-3.5" aria-hidden />
        <span>你的行动</span>
      </div>
      <div className="game-choice-list">
        {options.map((opt, i) => (
          <button key={i} type="button" className="game-choice-btn" onClick={() => sendTextAsUser(opt)}>
            {opt}
          </button>
        ))}
      </div>
      <div className="game-choice-hint">或直接在下方输入框自定义行动</div>
    </div>
  )
}

/** 游戏正文预处理(仅渲染层): 章节行→三级标题、对话行→引用块(先补空行孤立成段),
 * 配合 .game-narrative 阅读卡做"视觉小说"分层;大纲/检索读原文,不受影响。
 * 模型常用单个换行写对话/章节,故按行孤立而非按段匹配 */
function toGameNarrativeMd(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const t = line.trim()
      if (!t) return ''
      if (/^【[^】]+】$/.test(t)) return `\n### ${t}\n`
      if (/^「/.test(t) || /^[^：\n]{1,12}：「/.test(t)) return `\n> ${t}\n`
      return line
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function RichMarkdown({ content, inlineImages }: { content: string; inlineImages?: InlineImageRef[] }) {
  // 图文混排白名单:md 段在进 RichSegment 前做 [图N] 替换(试卷/游戏块不插图为 wave1 口径)
  const images = inlineImages ?? EMPTY_INLINE_IMAGES
  // 试卷块切分: 无 ::: 时单段,与旧版渲染结构一致
  const segments = useMemo(() => parseExamSegments(content), [content])
  // 含游戏面板块的消息=游戏对局: 正文 md 段套阅读卡(叙事区),日常对话不受影响
  const isGame = useMemo(
    () => segments.some((s) => s.type === 'exam' && (s.kind === 'gamestatus' || s.kind === 'gamechoice')),
    [segments],
  )
  // 卷面判定: 一条消息里出现选择题块(:::choice)或 ≥2 道题块即视为成卷/练习,
  // 卷内答案块一律默认收起(先做后看)。此前只认「题块首行单独一行出处」,
  // 模型把出处写成题干里的「（参考教材…）」或干脆不写时整卷答案全裸奔、边做边被剧透。
  // 单题 :::question 答疑不算卷,照旧直接展开,不把用户刚问的讲解藏进按钮
  const isPaper = useMemo(() => {
    let stems = 0
    let hasChoice = false
    for (const s of segments) {
      if (s.type !== 'exam') continue
      if (s.kind === 'choice') {
        hasChoice = true
        stems += 1
      } else if (s.kind === 'question') {
        stems += 1
      }
    }
    return hasChoice || stems >= 2
  }, [segments])
  // 卷内题号: 题块(choice/question)按出现顺序编号,一块多题按拆出的组数跳号;
  // 题号是「按题号作答」的对齐锚点(题库抽题工具的作答约定依赖它),故在渲染层统一发号
  const stemNos = useMemo(() => {
    const map = new Map<number, number>()
    let next = 1
    segments.forEach((s, i) => {
      if (s.type !== 'exam' || (s.kind !== 'choice' && s.kind !== 'question')) return
      map.set(i, next)
      const groups = s.kind === 'choice' ? parseChoice(s.text).groups.length : 0
      next += Math.max(1, groups)
    })
    return map
  }, [segments])
  // 可答题集: 本消息内「有选项的选择题」对应的题号（单题 1 个、一块多题按组递增），供交卷汇总
  const answerable = useMemo<number[]>(() => {
    if (!isPaper) return []
    const list: number[] = []
    segments.forEach((s, i) => {
      if (s.type !== 'exam' || s.kind !== 'choice') return
      const start = stemNos.get(i)
      if (start == null) return
      const { options, groups } = parseChoice(s.text)
      if (!options.length) return
      const count = Math.max(1, groups.length)
      for (let k = 0; k < count; k++) list.push(start + k)
    })
    return list
  }, [segments, stemNos, isPaper])
  // 点选草稿: 按正文哈希持久化，刷新/切走再回保留；空选清除避免脏键堆积
  const storeKey = useMemo(() => quizStoreKey(content), [content])
  const [picks, setPicks] = useState<Record<number, string>>(() => readQuizPicks(storeKey))
  useEffect(() => {
    setPicks(readQuizPicks(storeKey))
  }, [storeKey])
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const clean: Record<number, string> = {}
      for (const [k, v] of Object.entries(picks)) if (v) clean[Number(k)] = v
      if (Object.keys(clean).length) window.localStorage.setItem(storeKey, JSON.stringify(clean))
      else window.localStorage.removeItem(storeKey)
    } catch {
      /* 隐私模式/超额写入失败静默忽略，不影响本页点选 */
    }
  }, [picks, storeKey])
  const onPick = useCallback((qno: number, letter: string) => {
    setPicks((prev) => {
      const next = { ...prev }
      if (letter) next[qno] = letter
      else delete next[qno]
      return next
    })
  }, [])
  const pickedOf = useCallback((qno: number) => picks[qno], [picks])
  const quizValue = useMemo<QuizAnswerCtxValue>(
    () => ({ paper: isPaper && answerable.length > 0, pickedOf, onPick }),
    [isPaper, answerable.length, pickedOf, onPick],
  )
  const chosen = answerable.reduce((n, q) => n + (picks[q] ? 1 : 0), 0)
  const submitSheet = useCallback(() => {
    if (!answerable.length) return
    const lines = answerable.map((n) => `${n}. ${picks[n] ?? '未作答'}`)
    sendTextAsUser(`我的作答：\n${lines.join('\n')}`)
  }, [answerable, picks])
  const nodes: React.ReactNode[] = []
  let mdRun: string[] = []
  const flushMd = () => {
    if (!mdRun.length) return
    if (isGame) {
      nodes.push(
        <div key={`nar-${nodes.length}`} className="game-narrative">
          <RichSegment content={toGameNarrativeMd(mdRun.join('\n\n'))} />
        </div>,
      )
    } else {
      mdRun.forEach((t) => nodes.push(<RichSegment key={`md-${nodes.length}`} content={substituteInlineImages(t, images)} />))
    }
    mdRun = []
  }
  segments.forEach((seg, i) => {
    if (seg.type === 'md') {
      mdRun.push(seg.text)
      return
    }
    flushMd()
    // 游戏面板块独立于试卷卡片语言,提前分流(不走 ExamBlock 的 join/出处/题库逻辑)
    if (seg.kind === 'gamestatus') {
      nodes.push(<GameStatusCard key={i} text={seg.text} />)
      return
    }
    if (seg.kind === 'gamechoice') {
      nodes.push(<GameChoiceCard key={i} text={seg.text} />)
      return
    }
    // 出题组判定: answer 块向前回溯连续 exam 块(材料/设问/选择题),任一块首行带出处即整组视为出题;
    // md 段或 answer 块截断回溯(跨过 answer 就是下一道题,避免出处串组)。
    // 语文主观题是 material+question+answer 三连,出处常写在 material 首行——只看紧邻前块会漏判,答案不折叠
    const prevQuizRef = (() => {
      for (let j = i - 1; j >= 0; j--) {
        const s = segments[j]
        if (s.type !== 'exam' || s.kind === 'answer') break
        const ref = parseSourceRefLine(s.text).sourceRef
        if (ref) return ref
      }
      return null
    })()
    // 出题组联动: 题块向后找紧邻 answer(允许中间隔 translate 译文块)——齐备才显示「收进题库」;
    // 跨过其他块截断,避免出处串组
    const nextAnswerText = (() => {
      for (let j = i + 1; j < segments.length; j++) {
        const s = segments[j]
        if (s.type !== 'exam') break
        if (s.kind === 'answer') return s.text
        if (s.kind !== 'translate') break
      }
      return null
    })()
    // 卷面内收紧: answer 前方必须有题块(允许隔 ::translate 译文块),避免把正文里
    // 孤立出现的 :::answer(如整段讲解包了答案块)也收进按钮
    const hasPrevStem = (() => {
      for (let j = i - 1; j >= 0; j--) {
        const s = segments[j]
        if (s.type !== 'exam') return false
        if (s.kind === 'translate') continue
        if (s.kind === 'answer') return false
        return s.kind === 'choice' || s.kind === 'question' || s.kind === 'material'
      }
      return false
    })()
    const isQuizStem = seg.kind === 'choice' || seg.kind === 'question'
    const stemRef = isQuizStem ? parseSourceRefLine(seg.text).sourceRef : null
    nodes.push(
      <ExamBlock
        key={i}
        kind={seg.kind}
        text={seg.text}
        joinTop={i > 0 && segments[i - 1].type === 'exam'}
        joinBottom={i < segments.length - 1 && segments[i + 1].type === 'exam'}
        answerCollapsible={seg.kind === 'answer' && (!!prevQuizRef || (isPaper && hasPrevStem))}
        quizAnswerText={isQuizStem && stemRef && nextAnswerText ? nextAnswerText : undefined}
        questionNo={stemNos.get(i)}
      />,
    )
  })
  flushMd()
  return (
    <QuizAnswerCtx.Provider value={quizValue}>
      <div className="rich-md">
        {nodes}
        {quizValue.paper && (
          <div className="exam-answer-sheet">
            <span className="exam-answer-sheet-progress">已选 {chosen}/{answerable.length}</span>
            <button type="button" className="exam-answer-sheet-btn" onClick={submitSheet} disabled={chosen === 0}>
              交卷并让我批改
            </button>
          </div>
        )}
      </div>
    </QuizAnswerCtx.Provider>
  )
}

function MarkdownRendererInner({
  content,
  className,
  rich,
  live,
  inlineImages,
}: MarkdownRendererProps) {
  useRenderProbe('MarkdownRenderer')
  // 内容层两步预处理: 先把漏写块语法的「序号｜」分档段落升级合成 :::yellow-fish 块
  // (定案: 分档输出必须结构化卡片流), 再提升首个 triangle 围栏到消息最前;另保留原始源位置供 live key 使用。
  const finalContent = useMemo(() => hoistTriangleFigure(promoteRankRunsToBlocks(content)), [content])

  // 纯文本/熔断口径不变。
  if (!RICH_RENDER_ENABLED || (!rich && !live)) {
    return (
      <div className={cn('text-[15px] text-content-primary leading-[1.85] break-words whitespace-pre-wrap', className)}>
        {finalContent.content}
      </div>
    )
  }
  // live 与 rich 共用组件边界,已确认等价的普通正文收尾仅撤 md-live class。
  // 非白名单正文仍完整升级到 RichMarkdown(包括特殊卡片和安全 URL 处理)。
  return (
    <div className={cn('text-[15px] text-content-primary leading-[1.85] break-words', className)}>
      <LiveMarkdown content={finalContent.content} sourceLines={finalContent.sourceLines} rich={!!rich} inlineImages={inlineImages} />
    </div>
  )
}

/**
 * 外层壳:只负责挂 InlineImagesContext(图文混排 [图N] 数据源,rich/live 两档共用)。
 * memo 在这一层做 props 比较,inner 不再自带 memo。
 * 图片数据在此按内容稳定引用,隔离调用方随 message 快照创建的新数组。
 */
export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  className,
  rich,
  live,
  inlineImages,
  yellowFishItems,
}: MarkdownRendererProps) {
  // MessageBubble 的 message 快照每次改变都会提取新数组(包括空数组)。
  // 按实际数据稳定 context,否则它会绕过每个 LiveBlockView 的 memo。
  const imagesKey = JSON.stringify(inlineImages ?? EMPTY_INLINE_IMAGES)
  const stableImages = useMemo<InlineImageRef[]>(
    () => imagesKey === '[]' ? EMPTY_INLINE_IMAGES : JSON.parse(imagesKey),
    [imagesKey],
  )
  const yellowFishKey = JSON.stringify(yellowFishItems ?? EMPTY_YELLOW_FISH_ITEMS)
  const stableYellowFish = useMemo<YellowFishItemBrief[]>(
    () => yellowFishKey === '[]' ? EMPTY_YELLOW_FISH_ITEMS : JSON.parse(yellowFishKey),
    [yellowFishKey],
  )
  return (
    <InlineImagesContext.Provider value={stableImages}>
      <YellowFishItemsContext.Provider value={stableYellowFish}>
        <MarkdownRendererInner content={content} className={className} rich={rich} live={live} inlineImages={stableImages} />
      </YellowFishItemsContext.Provider>
    </InlineImagesContext.Provider>
  )
})
