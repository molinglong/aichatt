'use client'

/**
 * 写作画布面板底部迷你输入条(B案+状态感知,2026-11-08 挑稿):快捷指令 chips + 胶囊输入岛。
 * - chips = 整篇级高频动作,点一下直接发(sendTextAsUser 直发桥进聊天全链路),
 *   与划词工具条的选区级动作互补;「补到目标」仅在设了目标字数且未达标时出现。
 * - 状态感知(治「发送后黑盒,要退出去看」):聊天流生成中(busy)整块变身状态条
 *   「脉动点 + AI 正在改这篇文档… + 停止」(停止走 stopChatStreaming 桥 → ChatPanel.handleStop);
 *   生成结束且文档字数有增时,内联「已更新,写进文档 +N 字」,由面板 2.6s 后清回。
 * - 发送后消息落在(被遮住的)聊天流里,关闭画布可见 —— 这里不做第二套发送管道;
 *   AI 命中 write_document append 直接改这篇,WriteEditor 经 write-doc-updated 事件刷新。
 */
import { useRef, useState } from 'react'
import { ArrowUp, Check, X } from 'lucide-react'
import { sendTextAsUser, stopChatStreaming, requestSelRewrite } from '@/lib/input-bridge'
import { cn } from '@/lib/utils'

/** 整篇级快捷指令(prompt 直接作为 user 消息发出)。
 *  动作语义写死在指令里(append/replace + 明确要求),不依赖模型自由发挥——
 *  曾经「写短一点/扩写细节」被模型做成新建「xx 版」副本,根因是意图不明;
 *  2026-11-08 用户要求重做五个 chip 并确保功能完整性。 */
const QUICK_ACTIONS = [
  {
    label: '续写一段',
    prompt:
      '接着这篇文档往下续写一段（150～250 字），与原文自然衔接，只新增内容、不改原文。' +
      '必须用 write_document 的 append 动作（docId 用系统注入的「当前打开文档」），content 只写新增段落',
  },
  {
    label: '写短一点',
    prompt:
      '把这篇文档压缩到原来的三分之二左右：保留全部情节节点与顺序，删掉重复铺陈与闲笔，输出压缩后的完整全文。' +
      '必须用 write_document 的 replace 动作整篇替换当前文档（docId 用系统注入的「当前打开文档」），标题保持不变，不要新建文档副本',
  },
  {
    label: '扩写细节',
    prompt:
      '扩写这篇文档：情节节点与顺序不变，补充感官细节与具体画面，篇幅约为原文的 1.5 倍，不要堆砌排比句，输出扩写后的完整全文。' +
      '必须用 write_document 的 replace 动作整篇替换当前文档（docId 用系统注入的「当前打开文档」），标题保持不变，不要新建文档副本',
  },
  {
    label: '换个结尾',
    prompt:
      '只把这篇文档的结尾段换成一个更落地的结尾（停在具体画面上，不要直接抒情），其余段落逐字保留，输出替换后的完整全文。' +
      '必须用 write_document 的 replace 动作整篇替换当前文档（docId 用系统注入的「当前打开文档」），标题保持不变，不要新建文档副本',
  },
]

interface WritePanelComposerProps {
  /** 目标字数(来自 WriteDocPanel):控制「补到目标」chip 的显隐 */
  goal?: number | null
  /** 当前字数:达标后隐藏「补到目标」 */
  chars?: number
  /** 聊天流生成中:整块变状态条 */
  busy?: boolean
  /** AI 刚写进文档的字数增量(面板 2.6s 后清回 null) */
  doneDelta?: number | null
  /** 正文当前划词选区:存在时发送的指令自动携带选区上下文,AI 只改这段 */
  sel?: { len: number; text: string } | null
  /** 取消选中(指示 chip 上的 ✕,面板 tick 驱动 WriteEditor 清选区) */
  onClearSel?: () => void
}

export function WritePanelComposer({
  goal,
  chars,
  busy = false,
  doneDelta = null,
  sel = null,
  onClearSel,
}: WritePanelComposerProps) {
  const [text, setText] = useState('')
  const [sentChip, setSentChip] = useState<string | null>(null)
  /** 输入岛是否处于多行态:单行=胶囊(rounded-full),多行=圆角矩形(rounded-card) */
  const [multiline, setMultiline] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const sentTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 自适应 1~3 行(超过内部滚动),并按行数切换岛形
  function autoGrow() {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    setMultiline(ta.scrollHeight > 40)
    ta.style.height = `${Math.min(ta.scrollHeight, 3 * 24 + 2)}px`
  }

  function send() {
    const t = text.trim()
    if (!t) return
    // 选中态:指令走 rewrite 专用通道(只改选中段落,预览卡确认后应用)——
    // 不进聊天流:flash 档模型扛不住「整篇输出+逐字保留」的复合约束(2026-11-08 实测翻车),
    // rewrite 只输出替换段落,任意模型都稳;docId/上下文由 WriteEditor 持有
    if (sel) {
      requestSelRewrite(t)
      setText('')
      setMultiline(false)
      requestAnimationFrame(() => {
        if (taRef.current) taRef.current.style.height = 'auto'
      })
      return
    }
    sendTextAsUser(t)
    setText('')
    setMultiline(false)
    requestAnimationFrame(() => {
      if (taRef.current) taRef.current.style.height = 'auto'
    })
  }

  /** chip 直发 + 短暂已发送态 */
  function sendQuick(label: string, prompt: string) {
    sendTextAsUser(prompt)
    setSentChip(label)
    if (sentTimer.current) clearTimeout(sentTimer.current)
    sentTimer.current = setTimeout(() => setSentChip(null), 1200)
  }

  const goalReached = goal != null && (chars ?? 0) >= goal

  return (
    /* 与正文版心对齐:同一套 padding-inline(md+ 收进 640px 居中列,移动端 px-4 对齐正文),
       发丝线也只画到版心宽,不再通栏 */
    <div className="shrink-0 px-4 pb-3 md:px-[max(40px,calc(50%-320px))]">
      <div className="border-t border-line pt-2">
        {busy ? (
          /* 生成中:脉动点 + 停止(停止桥 → ChatPanel.handleStop) */
          <div className="flex items-center gap-2.5 rounded-full border border-line bg-surface-muted px-3.5 py-2">
            <i className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent" />
            <span className="flex-1 text-sm text-content-primary">AI 正在改这篇文档…</span>
            <button
              type="button"
              onClick={stopChatStreaming}
              className="flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-line-strong bg-surface px-3 text-xs text-content-secondary hover:border-danger hover:text-danger transition-colors"
            >
              <i className="h-2 w-2 rounded-[2px] bg-current" />
              停止
            </button>
          </div>
        ) : doneDelta != null ? (
          /* 刚写完:内联「+N 字」反馈(面板 2.6s 后清回空闲态) */
          <div className="flex items-center gap-2.5 rounded-full border border-line bg-surface-muted px-3.5 py-2">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground">
              <Check className="h-3 w-3" />
            </span>
            <span className="flex-1 text-sm text-content-primary">已更新，写进文档</span>
            <span className="shrink-0 text-xs text-accent tabular-nums">
              {doneDelta > 0 ? '+' : ''}{doneDelta} 字
            </span>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-1.5 mb-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {QUICK_ACTIONS.map((a) => (
                <button
                  key={a.label}
                  type="button"
                  onClick={() => sendQuick(a.label, a.prompt)}
                  className={cn(
                    'shrink-0 h-[26px] px-3 rounded-full border text-xs transition-colors',
                    sentChip === a.label
                      ? 'bg-accent text-accent-foreground border-accent'
                      : 'border-line bg-surface text-content-secondary hover:text-accent hover:border-accent hover:bg-accent-soft'
                  )}
                >
                  {sentChip === a.label ? '已发送 ✓' : a.label}
                </button>
              ))}
        {goal != null && !goalReached && (
          <button
            type="button"
            onClick={() =>
              sendQuick(
                '补到目标',
                `当前文档共 ${chars ?? 0} 字，目标是 ${goal} 字：请在文末自然续写约 ${Math.max(1, goal - (chars ?? 0))} 字，让全文达到 ${goal} 字左右，与原文自然衔接、只新增不改原文。` +
                  '必须用 write_document 的 append 动作（docId 用系统注入的「当前打开文档」），content 只写新增段落'
              )
            }
                  className={cn(
                    'shrink-0 h-[26px] px-3 rounded-full border text-xs transition-colors',
                    sentChip === '补到目标'
                      ? 'bg-accent text-accent-foreground border-accent'
                      : 'border-line bg-surface text-content-secondary hover:text-accent hover:border-accent hover:bg-accent-soft'
                  )}
                >
                  {sentChip === '补到目标' ? '已发送 ✓' : '补到目标'}
                </button>
              )}
            </div>
            <div
              className={cn(
                'flex items-end gap-2 border border-line bg-surface-muted pl-4 pr-1.5 py-1.5',
                'transition-[border-radius] duration-[var(--motion-fast)] ease-[var(--ease)]',
                multiline ? 'rounded-card' : 'rounded-full'
              )}
            >
              {sel && (
                <span className="mb-0.5 shrink-0 inline-flex items-center gap-1 h-7 pl-2.5 pr-1 rounded-full bg-accent-soft text-[11px] text-accent">
                  已选 {sel.len} 字
                  <button
                    type="button"
                    onClick={onClearSel}
                    aria-label="取消选中"
                    className="flex h-5 w-5 items-center justify-center rounded-full hover:bg-accent/15 transition-colors"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              )}
              <textarea
                ref={taRef}
                rows={1}
                value={text}
                onChange={(e) => {
                  setText(e.target.value)
                  autoGrow()
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    send()
                  }
                }}
                placeholder={sel ? '针对选中的这段说…' : '或者自己说…'}
                className="flex-1 min-w-0 resize-none bg-transparent py-1 text-base leading-6 text-content-primary outline-none placeholder:text-content-muted"
              />
              <button
                type="button"
                onClick={send}
                disabled={!text.trim()}
                aria-label="发送给 AI"
                className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground transition-colors hover:bg-accent-hover disabled:opacity-40"
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
