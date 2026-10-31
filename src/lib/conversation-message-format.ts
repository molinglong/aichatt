import { stripToolCallMarkup } from "@/lib/ai/tool-markup"

/**
 * 会话消息行的响应格式化:attachments/metadata 两段 JSON 在库里是字符串,
 * 统一在这里 parse 成前端可直接消费的形状(损坏 JSON 分别退化为空数组/null)。
 * GET /api/conversations/[id](首屏尾部窗口)与 GET .../messages?before=(更早翻页)
 * 共用,保证两条路径吐出的消息结构完全一致。
 *
 * 历史数据兜底:2026-10-25 之前上游泄漏的工具调用标记(DeepSeek DSML)已经入库,
 * 读取时统一清洗,老会话也不会再把原始标记渲染给用户。
 */

/** 格式化实际用到的列;两端点的 select 均覆盖这些字段,多传的行字段被忽略 */
export interface MessageRow {
  id: string
  role: string
  content: string
  reasoning: string | null
  model: string | null
  groupId: string | null
  streaming: boolean
  attachments: string | null
  metadata: string | null
  promptTokens?: number | null
  completionTokens?: number | null
  createdAt: Date
}

export function sanitizeStoredContent(content: string | null | undefined): string {
  return stripToolCallMarkup(content ?? "").text
}

/** 推理文本清洗;剥完为空时按 null 处理(前端把 null 当"无思考") */
export function sanitizeStoredReasoning(reasoning: string | null | undefined): string | null {
  if (!reasoning) return reasoning ?? null
  const cleaned = stripToolCallMarkup(reasoning).text
  return cleaned.trim() ? cleaned : null
}

export function formatMessageRow(m: MessageRow) {
  let attachments: unknown[] = []
  if (m.attachments) {
    try {
      const parsed = JSON.parse(m.attachments)
      if (Array.isArray(parsed)) attachments = parsed
    } catch {
      // 损坏 JSON 返回空数组,前端兜底处理
    }
  }
  let metadata: unknown = null
  if (m.metadata) {
    try {
      const parsed = JSON.parse(m.metadata)
      if (parsed && typeof parsed === 'object') metadata = parsed
    } catch {
      // 损坏 JSON 视为无 metadata,前端按普通 system 文本渲染
    }
  }
  return {
    id: m.id,
    role: m.role,
    // 入库前的清洗只管新数据;历史行在读取侧兜底(上游泄漏的工具协议不能回放给用户)
    content: sanitizeStoredContent(m.content),
    reasoning: sanitizeStoredReasoning(m.reasoning),
    model: m.model,
    groupId: m.groupId,
    streaming: m.streaming,
    attachments,
    // 结构化 UI 提示:{kind, sourceId, sourceTitle, ...}
    // 仅由后端写入;前端按 kind 分发渲染分支
    metadata,
    promptTokens: m.promptTokens,
    completionTokens: m.completionTokens,
    createdAt: m.createdAt,
  }
}

export function formatMessageRows(rows: MessageRow[]) {
  return rows.map(formatMessageRow)
}

/** 轮对齐/元组游标用的行最小形状 */
export interface WindowRow {
  role: string
}

/**
 * 尾部窗口的"轮对齐":从目标下标**向前**(向更早方向)走到一条 user 起头。
 * 只许前移不许后移 —— 后移会把半轮的头部行丢进无人认领的空隙(翻页游标够不到它)。
 * 走不到 user(整段无 user)时返回 0,窗口全量下发,宁可不齐也不丢行。
 */
export function alignStartToRoundHead(rows: WindowRow[], targetIdx: number): number {
  let start = Math.max(0, Math.min(targetIdx, rows.length))
  while (start > 0 && rows[start].role !== 'user') start--
  return start
}
