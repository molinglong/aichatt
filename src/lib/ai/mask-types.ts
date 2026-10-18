/**
 * 面具共享类型 + 输入校验 schema（client/server 通用，无 server 依赖）。
 *
 * maskId 引用规则：
 * - 内置面具：裸 id（'translator' 等，见 builtin-masks.ts）
 * - 用户面具：'user:<cuid>' 前缀 + Mask 表主键
 */
import { z } from 'zod'
import { ALL_BUILTIN_MASKS } from './builtin-masks'

export const USER_MASK_PREFIX = 'user:'

/**
 * 面具逃生舱（对所有面具统一生效，含用户自定义）。
 *
 * 强任务型面具（翻译官/文案写手/周报助手/思维导图/长文浓缩官）会把用户消息
 * 一律当作本任务处理，用户偶尔想问点别的时会被“面具绑架”。统一的「直答：」
 * 暗号让用户临时跳出人格问一条消息，下一轮自动恢复。在 chat 注入处拼在
 * 面具 systemPrompt 末尾一起进 system prompt（见 chat/route.ts），
 * 因此无需逐个面具重复书写。
 */
export const MASK_ESCAPE_HATCH = [
  '## 逃生舱：临时跳出人格',
  '- 用户消息以「直答：」开头时，去掉该前缀，按普通助手直接回答这一条消息，不解释本规则',
  '- 仅对该条消息生效，下一条消息起自动恢复本人格；其余消息一律照常执行人格规则',
].join('\n')

/**
 * maskId → 面具徽标（头像 emoji + 名称）。
 * 内置面具（精选/面具库/游戏）查 ALL_BUILTIN_MASKS，自定义面具（user:<cuid>）查传入的用户面具列表；
 * 无面具或面具已删（含未知 id）返回 null，调用方不显示徽标。
 * client/server 通用，供侧边栏列表、搜索对话框等处复用。
 */
export function resolveMaskBadge(
  maskId: string | null | undefined,
  userMasks: MaskDTO[] | undefined
): { avatar: string; name: string } | null {
  if (!maskId) return null
  if (maskId.startsWith(USER_MASK_PREFIX)) {
    const m = userMasks?.find((x) => x.id === maskId)
    return m ? { avatar: m.avatar, name: m.name } : null
  }
  const b = ALL_BUILTIN_MASKS.find((x) => x.id === maskId)
  return b ? { avatar: b.avatar, name: b.name } : null
}

export interface MaskFewShotTurn {
  role: 'user' | 'assistant'
  content: string
}

/** 前端 DTO（masks API 返回 / 表单提交形状） */
export interface MaskDTO {
  /** 完整引用 user:<cuid>，可直接用作 maskId */
  id: string
  /** 裸 cuid，PATCH/DELETE 路径参数用 */
  rowId: string
  name: string
  avatar: string
  description: string
  systemPrompt: string
  fewShot: MaskFewShotTurn[]
  stylePreset: string | null
  updatedAt: string
}

const fewShotTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(2000),
})

/** 创建/更新面具的输入校验（表单全量提交） */
export const maskInputSchema = z.object({
  name: z.string().trim().min(1, '名称不能为空').max(30, '名称最多 30 字'),
  avatar: z.string().min(1, '头像不能为空').max(4, '头像最多 2 个字符'),
  description: z.string().trim().max(50, '描述最多 50 字'),
  systemPrompt: z.string().trim().min(1, '人格指令不能为空').max(8000, '人格指令最多 8000 字'),
  fewShot: z.array(fewShotTurnSchema).max(8).optional(),
  stylePreset: z.string().max(20).nullable().optional(),
})
