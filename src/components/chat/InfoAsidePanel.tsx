'use client'

/**
 * 右侧「对话资料」面板 —— 聊天页常驻的一条竖排清单。
 *
 * 设计约束(用户明确要求):
 *   - 不做标签页切换、不做分区折叠,搜索 / 摘要 / 附件就是从上往下一列排完
 *   - 每行 = 一句话 + 右侧一个小计数,扫一眼就能拿到数据
 *   - 点一行 → 主区滚到对应消息(复用 OutlineSidebar 的 data-message-id 定位法)
 *
 * 数据全部来自前端已有的 messages(搜索走 extractToolCallViews,附件走 attachments),
 * 只有摘要需要问服务端拿到"覆盖多少条",走既有的 /context 接口,不新增后端。
 * 仅电脑模式渲染(useIsComputerMode:触屏为主的平板/手机一律不显示);
 * 电脑上常驻,显隐由 chat-store.infoPanelOpen 控制。
 */
import { useEffect, useMemo, useState } from 'react'
import {
  BookOpen,
  ChevronDown,
  Fish,
  Layers,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Search,
} from 'lucide-react'
import type { UIMessage } from 'ai'
import { cn } from '@/lib/utils'
import { useChatStore } from '@/store/chat-store'
import { extractToolCallViews } from './ToolCallCard'
import { MarkdownRenderer } from './MarkdownRenderer'
import {
  KNOWLEDGE_KIND_LABELS,
  KNOWLEDGE_TOOL_NAME,
  knowledgeVolumeLabel,
  type KnowledgeToolOutput,
} from '@/lib/ai/knowledge-tool'
import { YELLOW_FISH_TOOL_NAME, type YellowFishToolOutput } from '@/lib/ai/yellow-fish-tool'
import { YELLOW_FISH_LIVE_TOOL_NAME, type YellowFishLiveToolOutput } from '@/lib/ai/yellow-fish-live-tool'
import type { Attachment } from '@/lib/attachment-types'

/** 默认只露这么多条,超出的折起来(点击「展开剩余 N 条」再放出来) */
const COLLAPSE_LIMIT = 4
/** 每条搜索的来源同样先露这么多条,其余折起来——否则一次搜索就能铺满整个面板 */
const SOURCE_LIMIT = 3

/** 面板展开 / 收起时的实际占位宽度:聊天列让位、右侧阅读刻度列让位都按这个算 */
export const INFO_PANEL_WIDTH = 280
export const INFO_TAB_WIDTH = 28

interface InfoAsidePanelProps {
  conversationId: string
  messages: UIMessage[]
}

type InfoItem = {
  key: string
  icon: 'search' | 'attachment' | 'book' | 'fish'
  title: string
  /** 右侧的小计数 / 类型标签 */
  badge: string
  /** 来源清单(标题,链接/正文可选);闲鱼条目额外带 price/image,渲染成缩略图+价格强调行 */
  sources?: { title: string; url?: string; content?: string; price?: string; image?: string }[]
}

interface SummaryInfo {
  coveredMessages: number
  createdAt: string
  preview: string
}

/** 附件 → 人眼可读的短标签 */
function attachmentLabel(a: Attachment): string {
  if (typeof a.type === 'string' && a.type.startsWith('image/')) return '图片'
  const ext = a.name.includes('.') ? a.name.split('.').pop()!.toUpperCase() : ''
  return ext ? ext.slice(0, 4) : '文件'
}

/** 每条搜索的来源清单三种状态:some = 只露前几条 / all = 全露 / none = 收起 */
type SourceView = 'some' | 'all' | 'none'

export function InfoAsidePanel({ conversationId, messages }: InfoAsidePanelProps) {
  const infoPanelOpen = useChatStore((s) => s.infoPanelOpen)
  const toggleInfoPanel = useChatStore((s) => s.toggleInfoPanel)
  const [summary, setSummary] = useState<SummaryInfo | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [summaryOpen, setSummaryOpen] = useState(true)
  // 每条搜索的来源清单各自折叠,key 是那行的 item.key
  const [sourceView, setSourceView] = useState<Record<string, SourceView>>({})
  // 查课本来源行的正文展开态,key 是「行key-来源序号」;课本命中无链接,点行看原文
  const [contentOpen, setContentOpen] = useState<Record<string, boolean>>({})

  // 摘要没有存在前端,走既有 /context 接口只取 lastSummary;
  // 消息数变化时重取(与 ContextMeter 同口径),失败静默——辅助信息不打扰用户
  useEffect(() => {
    let alive = true
    fetch(`/api/conversations/${conversationId}/context`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive) setSummary(d?.lastSummary ?? null)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [conversationId, messages.length])

  // 最新在上:倒序扫消息,一次搜索/一次查课本/一个附件各占一行
  const items = useMemo<InfoItem[]>(() => {
    const out: InfoItem[] = []
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]

      for (const view of extractToolCallViews(m)) {
        // 查课本:检索词一行 + 类型与命中段数;来源清单挂书名与章节(无链接,不跳转)
        if (view.tool === KNOWLEDGE_TOOL_NAME) {
          const output = view.output as KnowledgeToolOutput | undefined
          const input = view.input as { query?: string; kind?: string } | undefined
          const results = Array.isArray(output?.results) ? output.results : []
          // 类型标注:同样的词可能一次查课本、一次查资料(答题模板),标出来才看得出不是重复行
          const kindOf = (k?: string) => (k ? (KNOWLEDGE_KIND_LABELS as Record<string, string>)[k] ?? k : undefined)
          const kinds = Array.from(new Set(results.map((r) => r.kind).filter(Boolean)))
          const kindLabel = kinds.length > 1 ? '课本/资料' : kindOf(kinds[0] ?? input?.kind)
          out.push({
            key: `${m.id}-${view.toolCallId ?? out.length}`,
            icon: 'book',
            title: output?.query || input?.query || '查课本',
            badge:
              view.state === 'input-streaming'
                ? kindLabel
                  ? `${kindLabel} · 检索中`
                  : '检索中'
                : view.state === 'output-error' || output?.error
                  ? '未生效'
                  : results.length > 0
                    ? kindLabel
                      ? `${kindLabel} · 命中 ${results.length} 段`
                      : `命中 ${results.length} 段`
                    : '无结果',
            sources: results.map((r) => {
              const place = [r.chapter, r.section].filter(Boolean).join(' / ')
              const volume = knowledgeVolumeLabel(r)
              return {
                title: [r.doc, volume, place, r.heading].filter(Boolean).join(' · '),
                content: r.content,
              }
            }),
          })
          continue
        }

        // 闲鱼实时价/行情:关键词一行,badge 带价格区间与样本量,来源=在售列表(点行开闲鱼页)
        if (view.tool === YELLOW_FISH_LIVE_TOOL_NAME) {
          const output = view.output as YellowFishLiveToolOutput | undefined
          const listings = Array.isArray(output?.listings) ? output!.listings : []
          const st = output?.stats
          const badge = !output?.available
            ? "未连通"
            : st && st.min != null && st.max != null
              ? `¥${st.min}~¥${st.max} · ${st.sampleCount}条在售`
              : `${listings.length}条在售`
          out.push({
            key: `${m.id}-${view.toolCallId ?? out.length}`,
            icon: "fish",
            title: output?.keyword || "YellowFish 实时价",
            badge,
            sources: listings.map((it) => ({
              title: it.title,
              price: it.priceDisplay || undefined,
              url: it.url || undefined,
              image: it.pic || undefined,
            })),
          })
          continue
        }
        if (view.tool === YELLOW_FISH_TOOL_NAME) {
          const output = view.output as YellowFishToolOutput | undefined
          const recents = Array.isArray(output?.recentItems) ? output!.recentItems : []
          const mk = output?.market
          const badge = !output?.available
            ? "未连通"
            : mk && mk.min != null && mk.max != null
              ? `¥${mk.min}~¥${mk.max} · ${mk.sampleCount}条样本`
              : `${recents.length}条`
          out.push({
            key: `${m.id}-${view.toolCallId ?? out.length}`,
            icon: "fish",
            title: output?.keyword || "YellowFish 行情",
            badge,
            sources: recents.map((it) => ({
              title: it.title,
              price: it.priceDisplay || undefined,
              url: it.link || undefined,
              image: it.image || undefined,
            })),
          })
          continue
        }

        if (view.tool !== 'web_search') continue
        const output = view.output as
          | {
              query?: string
              results?: Array<{ title?: string; url?: string }>
            }
          | undefined
        const input = view.input as { query?: string } | undefined
        const results = Array.isArray(output?.results) ? output.results : []
        const count = results.filter((r) => r && (r.title || r.url)).length
        out.push({
          key: `${m.id}-${view.toolCallId ?? out.length}`,
          icon: 'search',
          title: output?.query || input?.query || '联网搜索',
          badge: count > 0 ? `${count} 来源` : '无结果',
          sources: results
            .filter((r) => r && (r.title || r.url))
            .map((r) => ({ title: r.title || r.url || '', url: r.url })),
        })
      }

      const attachments = (m as { attachments?: Attachment[] }).attachments
      if (Array.isArray(attachments)) {
        for (let j = attachments.length - 1; j >= 0; j--) {
          const a = attachments[j]
          if (!a?.name) continue
          out.push({
            key: `${m.id}-att-${j}`,
            icon: 'attachment',
            title: a.name,
            badge: attachmentLabel(a),
          })
        }
      }
    }

    return out
  }, [messages])

  const visibleItems = expanded ? items : items.slice(0, COLLAPSE_LIMIT)
  const hiddenCount = items.length - visibleItems.length

  // 收起后不能只剩「无处可点」:原地留一条竖标签当展开入口
  if (!infoPanelOpen) {
    return (
      <button
        type="button"
        onClick={toggleInfoPanel}
        aria-label="展开对话资料"
        title="展开对话资料"
        className="info-aside-tab hidden md:flex h-full shrink-0 relative z-20 flex-col items-center justify-center gap-2 bg-surface text-content-muted hover:text-content-primary transition-colors"
        style={{ width: INFO_TAB_WIDTH }}
      >
        <PanelRightOpen className="w-3.5 h-3.5" />
        <span className="text-[11px] [writing-mode:vertical-rl] tracking-wide">对话资料</span>
      </button>
    )
  }

  return (
    <aside
      aria-label="对话资料"
      className="info-aside-panel hidden md:flex h-full shrink-0 relative z-20 flex-col bg-surface"
      style={{ width: INFO_PANEL_WIDTH }}
    >
      <div className="shrink-0 flex items-center justify-between h-11 px-3">
        <span className="text-[11px] font-medium text-content-muted uppercase tracking-wider">
          对话资料
        </span>
        <div className="flex items-center gap-1">
          <span className="text-[11px] text-content-muted/70 tabular-nums">{items.length}</span>
          <button
            type="button"
            onClick={toggleInfoPanel}
            aria-label="收起资料面板"
            title="收起"
            className="p-1 rounded-md text-content-muted hover:text-content-primary hover:bg-surface-subtle/70 transition-colors"
          >
            <PanelRightClose className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 摘要:一张贴在面板上的便利贴,不占折叠名额,永远在最上面。
          材质色直接走内联 rgb(var(--note-*)),不依赖 Tailwind 生成新类 —— 改配置忘重启也不会变成透明空框 */}
      <div className="shrink-0 px-3 pb-3">
        <div
          className="relative mt-2.5 rounded-lg px-3 pb-2.5 pt-3"
          style={{
            background: 'rgb(var(--note-paper))',
            border: '1px solid rgb(var(--note-edge) / 0.5)',
            boxShadow: '0 1px 3px rgb(var(--note-edge) / 0.55)',
            transform: 'rotate(-0.8deg)',
          }}
        >
          {/* 顶部胶带 */}
          <span
            aria-hidden
            className="absolute left-1/2 h-3.5 w-14 rounded-[2px]"
            style={{
              top: '-7px',
              background: 'rgb(var(--note-tape) / 0.65)',
              transform: 'translateX(-50%) rotate(-2deg)',
            }}
          />
          <button
            type="button"
            onClick={() => summary?.preview && setSummaryOpen((v) => !v)}
            className={cn(
              'w-full text-left',
              summary?.preview ? 'cursor-pointer' : 'cursor-default',
            )}
          >
            <div
              className="flex items-center gap-1.5 text-[11px]"
              style={{ color: 'rgb(var(--note-sub))' }}
            >
              <Layers className="w-3 h-3 shrink-0" />
              <span>对话摘要</span>
              {summary && <span className="tabular-nums">· 覆盖 {summary.coveredMessages} 条</span>}
              {summary?.preview && (
                <ChevronDown
                  className={cn(
                    'w-3 h-3 shrink-0 transition-transform duration-200',
                    summaryOpen && 'rotate-180',
                  )}
                />
              )}
            </div>
            <p
              className={cn('mt-1 text-[11.5px] leading-relaxed', !summaryOpen && 'line-clamp-2')}
              style={{ color: 'rgb(var(--note-ink))' }}
            >
              {summary?.preview || '对话变长后自动生成'}
            </p>
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto py-1" style={{ scrollbarWidth: 'thin' }}>
        {items.length === 0 ? (
          <p className="px-3 py-6 text-center text-[12px] text-content-muted">还没有可查看的资料</p>
        ) : (
          <>
            {/* 列表总标题:下面的搜索 / 附件混排在同一条流里 */}
            <div className="px-3 pb-1 pt-0.5 text-[11px] font-medium tracking-wider text-content-muted">
              来源
            </div>
            <ul>
              {visibleItems.map((item) => {
                const Icon =
                  item.icon === 'search'
                    ? Search
                    : item.icon === 'book'
                      ? BookOpen
                      : item.icon === 'fish'
                        ? Fish
                        : Paperclip
                const sources = item.sources ?? []
                // 默认露前几条;点行尾箭头收起来,点「展开剩余」全露
                const view: SourceView = sourceView[item.key] ?? 'some'
                const shownSources = view === 'all' ? sources : sources.slice(0, SOURCE_LIMIT)
                const restSources = sources.length - shownSources.length
                return (
                  <li key={item.key}>
                    {/* 整行只是信息展示,不做跳转;唯一的交互是行尾的折叠箭头 */}
                    <div className="flex items-center gap-1.5 mx-1.5 pl-1.5 pr-1 py-1.5 rounded-lg hover:bg-surface-subtle/70 transition-colors">
                      <Icon className="w-3.5 h-3.5 shrink-0 text-content-muted" />
                      <span
                        className="flex-1 min-w-0 truncate text-[12.5px] text-content-primary"
                        title={item.title}
                      >
                        {item.title}
                      </span>
                      <span className="shrink-0 rounded-full bg-surface-subtle px-1.5 py-0.5 text-[10px] tabular-nums text-content-muted">
                        {item.badge}
                      </span>
                      {sources.length > 0 && (
                        <button
                          type="button"
                          onClick={() =>
                            setSourceView((v) => ({
                              ...v,
                              [item.key]: (v[item.key] ?? 'some') === 'none' ? 'some' : 'none',
                            }))
                          }
                          aria-expanded={view !== 'none'}
                          aria-label={view === 'none' ? '展开来源' : '收起来源'}
                          className="shrink-0 p-0.5 rounded text-content-muted hover:text-content-primary cursor-pointer"
                        >
                          <ChevronDown
                            className={cn(
                              'w-3.5 h-3.5 shrink-0 transition-transform duration-200',
                              view !== 'none' && 'rotate-180',
                            )}
                          />
                        </button>
                      )}
                    </div>
                    {/* 来源清单:默认露前 3 条,来源标题可点直接开原网页 */}
                    {sources.length > 0 && view !== 'none' && (
                      <ul className="pb-1">
                        {shownSources.map((s, k) => {
                          const rowClass =
                            'flex items-start gap-1.5 pl-8 pr-3 py-[3px] text-[11px] leading-snug text-content-muted'
                          const dot = (
                            <span className="mt-[5px] w-1 h-1 shrink-0 rounded-full bg-content-muted/50" />
                          )
                          const ck = `${item.key}-src-${k}`
                          const bodyOpen = !!contentOpen[ck]
                          return (
                            <li key={ck}>
                              {s.price || s.image ? (
                                // 闲鱼在售条目:缩略图 + 价格强调 + 单行标题,点行开闲鱼页
                                <a
                                  href={s.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title={s.title}
                                  className="group flex items-center gap-1.5 pl-6 pr-2.5 py-1 rounded-lg hover:bg-surface-subtle/70 transition-colors"
                                >
                                  {s.image ? (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img
                                      src={s.image}
                                      alt=""
                                      loading="lazy"
                                      referrerPolicy="no-referrer"
                                      className="w-7 h-7 shrink-0 rounded-md object-cover bg-surface-subtle/70"
                                    />
                                  ) : (
                                    <span className="w-7 h-7 shrink-0 rounded-md bg-surface-subtle/70 flex items-center justify-center">
                                      <Fish className="w-3.5 h-3.5 text-content-muted/60" aria-hidden />
                                    </span>
                                  )}
                                  {s.price && (
                                    <span className="shrink-0 text-[11px] font-medium tabular-nums text-content-primary">
                                      {s.price}
                                    </span>
                                  )}
                                  <span className="min-w-0 flex-1 line-clamp-1 text-[11px] leading-snug text-content-muted group-hover:text-content-primary transition-colors">
                                    {s.title}
                                  </span>
                                </a>
                              ) : s.url ? (
                                <a
                                  href={s.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title={s.title}
                                  className={cn(rowClass, 'hover:text-content-primary')}
                                >
                                  {dot}
                                  <span className="line-clamp-2">{s.title}</span>
                                </a>
                              ) : s.content ? (
                                <>
                                  {/* 查课本命中:点行展开/收起课本原文(服务端已截到 800 字) */}
                                  <button
                                    type="button"
                                    onClick={() => setContentOpen((v) => ({ ...v, [ck]: !v[ck] }))}
                                    aria-expanded={bodyOpen}
                                    title={s.title}
                                    className={cn(
                                      rowClass,
                                      'w-full text-left hover:text-content-primary cursor-pointer',
                                    )}
                                  >
                                    {dot}
                                    <span className="line-clamp-2 flex-1">{s.title}</span>
                                    <ChevronDown
                                      className={cn(
                                        'w-3 h-3 shrink-0 transition-transform duration-200',
                                        bodyOpen && 'rotate-180',
                                      )}
                                    />
                                  </button>
                                  {bodyOpen && (
                                    <div className="mt-0.5 pb-1.5 pl-8 pr-3">
                                      <MarkdownRenderer
                                        content={s.content}
                                        rich
                                        className="text-[11px] leading-[1.7] text-content-secondary"
                                      />
                                    </div>
                                  )}
                                </>
                              ) : (
                                <span className={rowClass} title={s.title}>
                                  {dot}
                                  <span className="line-clamp-2">{s.title}</span>
                                </span>
                              )}
                            </li>
                          )
                        })}
                        {restSources > 0 && (
                          <li>
                            <button
                              type="button"
                              onClick={() =>
                                setSourceView((v) => ({
                                  ...v,
                                  [item.key]: (v[item.key] ?? 'some') === 'all' ? 'some' : 'all',
                                }))
                              }
                              aria-expanded={view === 'all'}
                              className="w-full flex items-center gap-1.5 pl-8 pr-3 py-[3px] text-left text-[11px] text-content-muted hover:text-content-primary transition-colors cursor-pointer"
                            >
                              <ChevronDown
                                className={cn(
                                  'w-3 h-3 shrink-0 transition-transform duration-200',
                                  view === 'all' && 'rotate-180',
                                )}
                              />
                              <span>{view === 'all' ? '收起' : `展开剩余 ${restSources} 条`}</span>
                            </button>
                          </li>
                        )}
                      </ul>
                    )}
                  </li>
                )
              })}
              {items.length > COLLAPSE_LIMIT && (
                <li className="mx-1.5">
                  <button
                    type="button"
                    onClick={() => setExpanded((v) => !v)}
                    aria-expanded={expanded}
                    className="w-full flex items-center gap-2 pl-1.5 pr-1 py-1.5 rounded-lg text-left text-[11px] text-content-muted hover:text-content-primary hover:bg-surface-subtle/70 transition-colors cursor-pointer"
                  >
                    <ChevronDown
                      className={cn(
                        'w-3.5 h-3.5 shrink-0 transition-transform duration-200',
                        expanded && 'rotate-180',
                      )}
                    />
                    <span>{expanded ? '收起' : `展开剩余 ${hiddenCount} 条`}</span>
                  </button>
                </li>
              )}
            </ul>
          </>
        )}
      </div>
    </aside>
  )
}
