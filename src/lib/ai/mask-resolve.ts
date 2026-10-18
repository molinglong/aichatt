/**
 * 面具统一解析层（server-only，依赖 prisma）。
 *
 * 服务端所有 maskId 消费点（chat / conversations）都必须经过 getMaskById：
 * 1) user: 前缀强制校验归属(userId)，别人的面具视为不存在；
 * 2) 返回的 ref 可直接写回 Conversation.maskId（内置裸 id / user:<cuid>）；
 * 3) 找不到一律返回 undefined，调用方按"无面具"降级，不报错。
 */
import { prisma } from '@/lib/db'
import { getBuiltinMask } from './builtin-masks'
import { USER_MASK_PREFIX, type MaskFewShotTurn, type MaskDTO } from './mask-types'

/** 解析后的面具（内置与自定义同形） */
export interface ResolvedMask {
  /** 写入 Conversation.maskId 的引用：内置裸 id / user:<cuid> */
  ref: string
  name: string
  avatar: string
  description: string
  systemPrompt: string
  fewShot: MaskFewShotTurn[]
  stylePreset?: string
  /** 学科倾向(仅内置面具携带,如 math-master→math);search_knowledge 半绑定的默认过滤建议 */
  subject?: string
  /** 游戏面具标记(仅内置游戏携带,见 builtin-games.ts);chat/route.ts 据此开干净车道 */
  kind?: 'game'
}

function isFewShotTurn(t: unknown): t is MaskFewShotTurn {
  if (!t || typeof t !== 'object') return false
  const o = t as Record<string, unknown>
  return (
    (o.role === 'user' || o.role === 'assistant') &&
    typeof o.content === 'string' &&
    o.content.length > 0
  )
}

/** Prisma Json -> 校验过的 fewShot 数组（非法条目静默丢弃） */
export function parseFewShot(raw: unknown): MaskFewShotTurn[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(isFewShotTurn).slice(0, 8)
}

/** Mask 表行 -> 前端 DTO */
export function maskRowToDto(row: {
  id: string
  name: string
  avatar: string
  description: string
  systemPrompt: string
  fewShot: unknown
  stylePreset: string | null
  updatedAt: Date
}): MaskDTO {
  return {
    id: `${USER_MASK_PREFIX}${row.id}`,
    rowId: row.id,
    name: row.name,
    avatar: row.avatar,
    description: row.description,
    systemPrompt: row.systemPrompt,
    fewShot: parseFewShot(row.fewShot),
    stylePreset: row.stylePreset,
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * 解析 maskId -> 生效面具。
 * - 内置：裸 id，同步查 BUILTIN_MASKS
 * - 自定义：'user:<cuid>'，查 Mask 表（必须属于 userId）
 */
export async function getMaskById(
  maskId: string | null | undefined,
  userId?: string | null
): Promise<ResolvedMask | undefined> {
  if (!maskId) return undefined

  if (maskId.startsWith(USER_MASK_PREFIX)) {
    const rowId = maskId.slice(USER_MASK_PREFIX.length)
    if (!rowId || !userId) return undefined
    const row = await prisma.mask.findFirst({ where: { id: rowId, userId } })
    if (!row) return undefined
    return {
      ref: maskId,
      name: row.name,
      avatar: row.avatar,
      description: row.description,
      systemPrompt: row.systemPrompt,
      fewShot: parseFewShot(row.fewShot),
      stylePreset: row.stylePreset ?? undefined,
    }
  }

  const builtin = getBuiltinMask(maskId)
  if (!builtin) return undefined
  return {
    ref: builtin.id,
    name: builtin.name,
    avatar: builtin.avatar,
    description: builtin.description,
    systemPrompt: builtin.systemPrompt,
    fewShot: builtin.fewShot,
    stylePreset: builtin.stylePreset,
    subject: builtin.subject,
    kind: builtin.kind,
  }
}
