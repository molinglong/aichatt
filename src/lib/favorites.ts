import { prisma } from "@/lib/db"

/**
 * 收藏模块服务端辅助函数。
 *
 * 收藏与错题本(StudyNote)分开:这里只产出"消息快照",不含掌握度/复习字段。
 * 来源消息用软关联(sourceMessageId 无外键),消息删除后收藏仍完整可读。
 */

/** 把 Message.attachments 的 JSON 字符串解析为数组;损坏 JSON 退化为空数组 */
export function parseFavoriteAttachments(raw: string | null | undefined): unknown[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** 取第一张图片附件的 url,作为列表缩略图 */
export function firstImageUrl(attachments: unknown[]): string | null {
  for (const item of attachments) {
    if (!item || typeof item !== "object") continue
    const a = item as { type?: unknown; url?: unknown }
    if (typeof a.type === "string" && a.type.startsWith("image/") && typeof a.url === "string" && a.url) {
      return a.url
    }
  }
  return null
}

/** 列表摘要:剥掉 Markdown/公式标记后压缩空白取前 40 字;空正文给兜底文案 */
export function favoriteTitle(content: string): string {
  const plain = content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`#>]+/g, " ")
    .replace(/\$+/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return plain.slice(0, 40) || "消息收藏"
}

/**
 * 批量取"消息 → 收藏 id"映射,供会话消息接口回填 favoriteId。
 * 两个消息端点(首屏尾部窗口 / 更早翻页 / 前台补拉)必须同口径,
 * 否则翻页后老消息的星标状态会错。
 */
export async function getFavoriteIdMap(
  userId: string,
  messageIds: string[]
): Promise<Map<string, string>> {
  if (messageIds.length === 0) return new Map()
  const rows = await prisma.favorite.findMany({
    where: { userId, sourceMessageId: { in: messageIds } },
    select: { id: true, sourceMessageId: true },
  })
  const map = new Map<string, string>()
  for (const row of rows) {
    if (row.sourceMessageId) map.set(row.sourceMessageId, row.id)
  }
  return map
}
