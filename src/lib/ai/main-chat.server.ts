/**
 * 主对话 server 层:主会话的 find-or-create 与 Ping 卡写入。
 * Ping = 一条 model:'system' 的 assistant 消息,content 为纯文本摘要(模型可见,
 * 管家接话时能"记得"说过什么),metadata.kind='ping' + 模板字段供前端渲染卡片。
 * 去重:同类型 ping 在窗口内只发一条(metadata 是 TEXT 列,取回后 JS 过滤)。
 */
import { prisma } from "@/lib/db"
import { KEEPER_MASK_ID } from "@/lib/ai/keeper-mask"

export const PING_TYPES = ["review_due", "lesson_archived", "monitor_done"] as const
export type PingType = (typeof PING_TYPES)[number]

const DEDUP_WINDOW_MS: Record<PingType, number> = {
  review_due: 24 * 60 * 60 * 1000,
  lesson_archived: 60 * 1000,
  monitor_done: 60 * 1000,
}

export interface PingActionResult {
  label: string
  href: string
}

/** 确保主对话存在并返回 */
export async function ensureMainConversation(userId: string, modelId?: string) {
  const existing = await prisma.conversation.findFirst({
    where: { userId, isMain: true },
  })
  if (existing) return existing
  return prisma.conversation.create({
    data: {
      userId,
      title: "主对话",
      model: modelId || "deepseek-flash",
      maskId: KEEPER_MASK_ID,
      isMain: true,
    },
  })
}

interface PingTemplate {
  source: string
  icon: string
  text: string
  actions: PingActionResult[]
}

function pingTemplate(type: PingType, p: Record<string, unknown>): PingTemplate {
  switch (type) {
    case "review_due":
      return {
        source: "管家 · 复习到期",
        icon: "🔁",
        text: `${p.count} 张卡片今天到期:${String(p.items ?? "").slice(0, 80)}。`,
        actions: [{ label: "开始复习", href: "/study?panel=review" }],
      }
    case "lesson_archived":
      return {
        source: "管家 · 结课归档",
        icon: "✅",
        text: `「${String(p.question ?? "").slice(0, 40)}」讲完了,共 ${p.steps ?? "?"} 步,已存入错题本。${p.weak ? "过程中有没懂的点,复习时会重点再考。" : ""}`,
        actions: [{ label: "回看讲解", href: "/study" }],
      }
    case "monitor_done":
      return {
        source: `管家 · 监控:${String(p.keyword ?? "")}`,
        icon: "🐟",
        text: `你挂的闲鱼监控「${String(p.keyword ?? "")}」有新数据了。`,
        actions: [{ label: "看行情", href: `/chat/c/${String(p.conversationId ?? "")}` }],
      }
  }
}

/** 写入一条 Ping;幂等(去重窗口内同类型/同会话不重复) */
export async function createPing(
  userId: string,
  type: PingType,
  payload: Record<string, unknown> = {},
  modelId?: string
): Promise<{ ok: true; deduped?: boolean } | { ok: false; error: string }> {
  const session = await ensureMainConversation(userId, modelId)

  const dedupCutoff = new Date(Date.now() - DEDUP_WINDOW_MS[type])
  const recentPings = await prisma.message.findMany({
    where: { conversationId: session.id, model: "system", createdAt: { gte: dedupCutoff } },
    orderBy: { createdAt: "desc" },
    select: { id: true, metadata: true },
  })
  const dup = recentPings.some((m) => {
    try {
      const md = JSON.parse(m.metadata ?? "{}") as { kind?: string; pingType?: string; payload?: { sessionId?: string } }
      if (md.kind !== "ping" || md.pingType !== type) return false
      if (type === "lesson_archived") return md.payload?.sessionId === payload.sessionId
      return true
    } catch {
      return false
    }
  })
  if (dup) return { ok: true, deduped: true }

  const tpl = pingTemplate(type, payload)
  await prisma.message.create({
    data: {
      conversationId: session.id,
      role: "assistant",
      content: `[${tpl.source}] ${tpl.text}`,
      model: "system",
      // metadata 是 TEXT 列:存 JSON 字符串,前端解析渲染 Ping 卡
      metadata: JSON.stringify({ kind: "ping", pingType: type, payload, ...tpl }),
      streaming: false,
    },
  })
  return { ok: true }
}
