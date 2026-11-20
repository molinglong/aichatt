/**
 * 错题入库自动打标:题干(+可选讲解) → { subject, topic, title }。
 * 模型解析照抄 branch/route.ts 的 resolveModel 范式(取用户最近一次对话的模型);
 * 任何失败返回 null,调用方降级存原文,绝不阻塞入库主流程。
 */
import { generateText, type LanguageModel } from 'ai'
import { prisma } from '@/lib/db'
import { decrypt } from '@/lib/crypto'
import {
  getEffectiveModel,
  createProviderInstanceForEffectiveModel,
} from '@/lib/ai/registry'
import { getPublicPoolKey } from '@/lib/quota'
import {
  buildCustomModelDefinition,
  resolveApiKey,
  createCustomLanguageModel,
} from '@/lib/ai/custom-model'

export const NOTE_SUBJECTS = [
  'math',
  'english',
  'chinese',
  'physics',
  'chemistry',
  'biology',
  'history',
  'geography',
  'politics',
  'other',
] as const
export type NoteSubject = (typeof NOTE_SUBJECTS)[number]

export interface NoteTags {
  subject: NoteSubject
  topic: string | null
  title: string
}

const TAG_SYSTEM =
  '你是错题本打标助手。根据题目(和可选的 AI 讲解)输出严格的 JSON,格式:' +
  '{"subject":"math|english|chinese|physics|chemistry|biology|history|geography|politics|other",' +
  '"topic":"一个具体考点短语(不超过12字,如:十字相乘/定语从句/受力分析),无法判断则 null",' +
  '"title":"题干摘要(不超过30字)"}。只输出 JSON,不要任何其他文字或代码围栏。'

/** 取用户可用的 LanguageModel:沿用其最近一次对话的模型;失败返回 null(调用方降级) */
export async function resolveStudyModel(userId: string): Promise<LanguageModel | null> {
  try {
    const conv = await prisma.conversation.findFirst({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      select: { model: true },
    })
    if (!conv?.model) return null
    return await buildModel(userId, conv.model)
  } catch {
    return null
  }
}

/** 模型 id → LanguageModel(范式与 branch/route.ts 一致,任何环节失败返回 null) */
async function buildModel(userId: string, modelId: string): Promise<LanguageModel | null> {
  if (modelId.startsWith('custom:')) {
    const cmRecord = await prisma.customModel.findFirst({
      where: { id: modelId.slice(7), userId },
    })
    if (!cmRecord) return null
    const apiKey = await resolveApiKey(userId, cmRecord)
    return createCustomLanguageModel(cmRecord, apiKey)
  }

  const modelDef = await getEffectiveModel(userId, modelId)
  if (!modelDef) return null

  const apiKeyRecord = await prisma.apiKey.findUnique({
    where: { userId_provider: { userId, provider: modelDef.provider } },
  })

  let apiKey: string | undefined
  if (apiKeyRecord) {
    apiKey = decrypt(apiKeyRecord.encryptedKey)
  } else if (modelDef.publicPool) {
    // 公共池门面模型走服务端出钱 Key,与 chat 管线同口径——
    // 用户默认模型是池模型时,打标/重标不该 503(A11 回归中实测)
    apiKey = (await getPublicPoolKey(modelDef.provider)) ?? undefined
  } else if (modelDef.provider === 'qianwen') {
    // 沿用 chat/route.ts 的回退逻辑:Qwen 可走环境变量 key
    apiKey = process.env.API_KEY_DASHSCOPE
  }
  if (!apiKey) return null

  try {
    // 门面模型必须发上游真实 id(如 deepseek-standard → deepseek-flash);
    // 直接用 modelDef.id 会被上游 400 拒绝,打标静默降级。
    return createProviderInstanceForEffectiveModel(modelDef, apiKey)(modelDef.upstreamId ?? modelDef.id)
  } catch {
    return null
  }
}

/** LLM 打标;解析失败/字段不合法返回 null(降级),title 永远有兜底截断 */
export async function tagNote(
  model: LanguageModel,
  question: string,
  analysis?: string | null
): Promise<NoteTags | null> {
  const fallbackTitle = () => {
    const t = question.replace(/\s+/g, ' ').trim().slice(0, 30)
    return t || '错题'
  }
  try {
    const { text } = await generateText({
      model,
      system: TAG_SYSTEM,
      prompt: `题目:${question.slice(0, 1500)}${analysis ? `\n\nAI 讲解(供参考):${analysis.slice(0, 800)}` : ''}\n\nJSON:`,
      temperature: 0.2,
    })
    // 剥掉可能的 ```json 围栏
    const raw = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
    const parsed = JSON.parse(raw) as { subject?: string; topic?: string | null; title?: string }
    const subject = (NOTE_SUBJECTS as readonly string[]).includes(parsed.subject ?? '')
      ? (parsed.subject as NoteSubject)
      : 'other'
    const topic =
      typeof parsed.topic === 'string' && parsed.topic.trim()
        ? parsed.topic.trim().slice(0, 12)
        : null
    return {
      subject,
      topic,
      title:
        typeof parsed.title === 'string' && parsed.title.trim()
          ? parsed.title.trim().slice(0, 40)
          : fallbackTitle(),
    }
  } catch {
    return null
  }
}
