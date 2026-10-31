/**
 * 上游「工具调用协议」泄漏清洗。
 *
 * 背景（2026-10-25 生产实锤）：DeepSeek 系列思考模型在**请求里没有声明 tools** 时
 * 仍会按内部协议生成工具调用，但服务端不再把它解析成 tool_calls，DSML 标记原样
 * 落进 content，前端把整段标记当 Markdown 渲染给用户。典型形态：
 *
 *   <｜｜DSML｜｜ calls>
 *   <｜｜DSML｜｜ invoke name="calculate">
 *   <｜｜DSML｜｜ parameter name="expression" string="true">...</｜｜DSML｜｜ parameter>
 *   </｜｜DSML｜｜ invoke>
 *   </｜｜DSML｜｜ calls>
 *
 * 不同中转/版本还会写成 ASCII 双竖线或单竖线（`<||DSML||`、`<|DSML|`），
 * 思考通道里也可能出现。本模块只做一件事：把这类标记从任何要展示/入库的文本里
 * 剥掉，并告诉调用方「确实剥到过」，供日志与补答决策使用。
 *
 * 用法：
 * - 一次性文本（入库 / 历史读取 / 快照）：stripToolCallMarkup
 * - 流式 delta（UI 流）：ToolMarkupStreamFilter（跨 chunk 安全）
 */

/** 竖线：半角单/双 + 全角单/双（tokenizer 会把特殊符号渲染成全角） */
const BARS = '[|｜]{1,2}'
/** 标记头：`<` + 竖线 + DSML + 竖线 */
const MARKER = `<\\s*${BARS}\\s*DSML\\s*${BARS}`
/** 块起始：`<｜｜DSML｜｜ calls>`（也兼容 tool_calls / toolcalls） */
const START = `${MARKER}\\s*(?:tool_?)?calls\\s*>`
/** 块结束：`</｜｜DSML｜｜ calls>` */
const END = `<\\s*/\\s*${BARS}\\s*DSML\\s*${BARS}\\s*(?:tool_?)?calls\\s*>`
/** 行内残留标记（单独 invoke / parameter / 结束行） */
const MARKER_ANY = `<\\s*/?\\s*${BARS}\\s*DSML\\s*${BARS}`

const MARKER_RE = new RegExp(MARKER_ANY, 'i')
const START_RE = new RegExp(START, 'i')
const END_RE = new RegExp(END, 'i')
/**
 * 文本末尾的「半个标记」(输出被截断):`<|`、`<||DSM`、`<｜｜DSML` 等。
 * 完整标记由 MARKER_RE 负责,这里只在整体不是完整标记时兜底尾部残片。
 */
const PARTIAL_TAIL_RE = /<\s*\/?\s*[|｜]{1,2}\s*(?:D\s*S\s*M\s*L\s*)?(?:[|｜]{1,2})?\s*$/i

/** 块内最多丢弃这么多字符；超过视为上游格式不认识，放弃吞掉，避免把整段回答吞没 */
const MAX_BLOCK_SWALLOW = 8000
/** 流式过滤时保留的尾巴长度，用于识别被 chunk 切开的标记 */
const HOLD = 96

export function containsToolCallMarkup(text: string | null | undefined): boolean {
  if (!text) return false
  return MARKER_RE.test(text)
}

/**
 * 一次性清洗：整段文本 → 可展示文本。
 * `stripped` 为 true 说明原文里确实有工具调用标记（调用方可据此打点/补答）。
 */
export function stripToolCallMarkup(input: string): { text: string; stripped: boolean } {
  if (!input) return { text: input, stripped: false }
  if (!containsToolCallMarkup(input)) {
    // 只有尾巴上的半个标记(输出被截断):削掉残片,剩下的正文照常展示
    const partial = PARTIAL_TAIL_RE.exec(input)
    if (partial) {
      return { text: input.slice(0, partial.index).trimEnd(), stripped: true }
    }
    return { text: input, stripped: false }
  }
  let text = input
  let stripped = false

  // 1) 完整块：起始 calls → 结束 calls（含中间 invoke / parameter 行）
  const blockRe = new RegExp(`${START}[\\s\\S]*?${END}`, 'gi')
  text = text.replace(blockRe, () => {
    stripped = true
    return ''
  })

  // 2) 只有开头没有结尾（输出被截断）：从起始标记到结尾全部丢弃
  const open = START_RE.exec(text)
  if (open) {
    stripped = true
    text = text.slice(0, open.index)
  }

  // 3) 残留的单行标记（被切开/格式不完整的 invoke、parameter、结束行）：整行剔除
  const lines = text.split('\n')
  const kept = lines.filter((line) => !MARKER_RE.test(line))
  if (kept.length !== lines.length) {
    stripped = true
    text = kept.join('\n')
  }

  if (!stripped) return { text: input, stripped: false }

  // 4) 只清理剥离留下的空行堆叠，不重排正常排版
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return { text, stripped: true }
}

/**
 * 跨 chunk 安全的流式清洗器。
 * - push(delta) 返回本次可以安全下发的文本（可能为空串）
 * - flush() 返回流结束时尚未下发的尾巴（未闭合的标记块直接丢弃）
 * - hasLeaked 记录是否命中过标记
 */
export class ToolMarkupStreamFilter {
  private inBlock = false
  private buffer = ''
  private leaked = false

  get hasLeaked(): boolean {
    return this.leaked
  }

  push(delta: string): string {
    if (!delta) return ''
    this.buffer += delta
    let out = ''

    // 循环处理：一段 delta 可能跨越「块外文本 → 块起始 → 块内丢弃 → 块结束 → 块外文本」
    while (this.buffer.length > 0) {
      if (!this.inBlock) {
        const m = START_RE.exec(this.buffer)
        if (m) {
          out += this.buffer.slice(0, m.index)
          this.buffer = this.buffer.slice(m.index + m[0].length)
          this.inBlock = true
          this.leaked = true
          continue
        }
        // 块外：留住可能是半个标记的尾巴，其余立即下发
        const hold = this.partialMarkerSuffix()
        out += this.buffer.slice(0, this.buffer.length - hold)
        this.buffer = this.buffer.slice(this.buffer.length - hold)
        break
      }

      const e = END_RE.exec(this.buffer)
      if (e) {
        this.buffer = this.buffer.slice(e.index + e[0].length)
        this.inBlock = false
        this.leaked = true
        continue
      }

      // 块内：只留能识别半个结束标记的尾巴，其余丢弃
      if (this.buffer.length > MAX_BLOCK_SWALLOW) {
        // 异常长块：放弃吞掉，退出块模式，防止把正常回答整段吃掉
        this.inBlock = false
        this.buffer = ''
        break
      }
      this.buffer = this.buffer.slice(-HOLD)
      break
    }

    return out
  }

  flush(): string {
    if (this.inBlock) {
      // 流结束时仍未闭合：整块都是泄漏标记，丢弃
      this.inBlock = false
      this.buffer = ''
      return ''
    }
    const rest = this.buffer
    this.buffer = ''
    // 尾巴如果是「半个标记」(如 `<｜｜DSML`),丢弃;普通文本(含普通 `<`)照常下发
    if (/^<\s*\/?\s*[|｜]/.test(rest)) return ''
    return rest
  }

  /** buffer 末尾可能是起始标记前缀的长度（从最后一个 `<` 起算，最多 HOLD） */
  private partialMarkerSuffix(): number {
    const tailStart = Math.max(0, this.buffer.length - HOLD)
    const idx = this.buffer.lastIndexOf('<', this.buffer.length - 1)
    if (idx < tailStart) return 0
    // 只保 `<` 及其后内容；`<` 之前已经确定不是标记的一部分
    return this.buffer.length - idx
  }
}
