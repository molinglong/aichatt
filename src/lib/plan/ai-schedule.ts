import { generateObject } from "ai"
import { z } from "zod"
import { prisma } from "@/lib/db"
import { decrypt } from "@/lib/crypto"
import {
  createProviderInstanceForEffectiveModel,
  getEffectiveModel,
  getEffectiveModels,
} from "@/lib/ai/registry"
import { checkQuota, getPublicPoolKey, settleQuota } from "@/lib/quota"

/**
 * AI 排程核心 —— 从 /api/plan/schedule 抽出的共用管道。
 *
 * 两个调用方:
 * - /api/plan/schedule(原 plan 服务的 Bearer 令牌端点,契约不变)
 * - /api/plan/schedule-day(今日计划弹窗的「排今天」,内部编排,见 scheduler.ts)
 *
 * 职责边界:这里只负责「用谁的模型把任务排进时间块」,不持久化任何计划数据;
 * 落库由调用方决定(plan 时代由 plan 写库,merged 后 scheduler 直接写 PlanItem)。
 *
 * AI 输出不可全信:模型可能排出重叠、越界、超时长的块,所以这里有程序校验
 * (applyGuards),只放行合法块。宁可少排,也不要把一张错表交给用户。
 */

export const scheduleItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200),
  kind: z.enum(["task", "event", "memo"]).default("task"),
  priority: z.number().int().min(0).max(2).default(1),
  estimateMin: z.number().int().min(5).max(480),
  energy: z.enum(["deep", "light", "any"]).default("any"),
  dueAt: z.string().nullable().optional(),
})

export const scheduleBodySchema = z.object({
  date: z.string().min(8).max(10),
  model: z.string().optional(),
  items: z.array(scheduleItemSchema).min(1).max(60),
  constraints: z.object({
    windows: z
      .array(z.object({ startMin: z.number().int(), endMin: z.number().int() }))
      .min(1)
      .max(6),
    fixed: z
      .array(
        z.object({
          id: z.string(),
          title: z.string(),
          startMin: z.number().int(),
          endMin: z.number().int(),
        })
      )
      .max(20)
      .default([]),
    bufferRatio: z.number().min(0).max(0.5).default(0.3),
    nowMin: z.number().int().min(0).max(1440).optional(),
  }),
})

export const scheduleOutputSchema = z.object({
  blocks: z.array(
    z.object({
      itemId: z.string(),
      startMin: z.number().int(),
      endMin: z.number().int(),
      reason: z.string().max(60),
    })
  ),
  deferred: z
    .array(z.object({ itemId: z.string(), reason: z.string().max(60) }))
    .default([]),
})

export type ScheduleBody = z.infer<typeof scheduleBodySchema>
type Block = z.infer<typeof scheduleOutputSchema>["blocks"][number]

const SYSTEM = `你是「plan」应用的今日排程器。把待办任务放进用户今天的空闲时间块，提高完成率，同时不要把一天排满。

硬性规则（违反的块会被程序丢弃）：
1. 每个块必须完整落在某个可用窗口内。可用窗口已经扣掉了固定事件和已排事项，直接在里面排即可。
2. 块之间、块与固定事件之间不能重叠，相邻块至少留 5 分钟。
3. 所有块总时长不得超过「可用时长 × (1 - bufferRatio)」，留出缓冲。
4. 固定事件不参与排程，也不要尝试移动它们。
5. 19:00 之后只排 energy 为 light 或 any 的任务。
6. energy 为 deep 的任务尽量排在 12:00 之前。
7. priority=2 优先安排；priority=0 的可以后置，甚至不排。
8. 放不下的任务放进 deferred，reason 说明原因。

reason 用一句中文，20 字以内，说明为什么排在这个位置，例如「上午精力好，先做需要思考的」。
startMin/endMin 是当天 0 点起的分钟数（09:30 = 570）。

输出必须是一个 JSON 对象（以 { 开头、以 } 结尾），不要外层包数组。优先把 priority=2 与 1 的任务排完，再考虑 priority=0。`

function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return aStart < bEnd && aEnd > bStart
}

/** 模型输出落地前的程序校验:越界、重叠、超预算、超预估的一律丢弃 */
export function applyGuards(object: z.infer<typeof scheduleOutputSchema>, body: ScheduleBody) {
  const { windows, fixed, bufferRatio } = body.constraints
  const available = windows.reduce((sum, w) => sum + (w.endMin - w.startMin), 0)
  const budget = available * (1 - bufferRatio)
  const itemMap = new Map(body.items.map((i) => [i.id, i]))

  const accepted: Block[] = []
  let total = 0

  for (const block of [...object.blocks].sort((a, b) => a.startMin - b.startMin)) {
    const item = itemMap.get(block.itemId)
    if (!item) continue
    if (block.endMin <= block.startMin) continue

    const dur = block.endMin - block.startMin
    // 明显超出用户预估的块不收(模型偶尔会把 15 分钟排成 2 小时)
    if (dur > item.estimateMin * 2) continue

    const inWindow = windows.some(
      (w) => block.startMin >= w.startMin && block.endMin <= w.endMin
    )
    if (!inWindow) continue

    if (fixed.some((f) => overlap(block.startMin, block.endMin, f.startMin, f.endMin))) {
      continue
    }

    const clash = accepted.some((a) =>
      overlap(block.startMin, block.endMin + 5, a.startMin - 5, a.endMin)
    )
    if (clash) continue

    if (total + dur > budget) continue

    accepted.push(block)
    total += dur
  }

  const scheduled = new Set(accepted.map((b) => b.itemId))
  const deferredIds = new Set(object.deferred.map((d) => d.itemId))

  const deferred = [
    ...object.deferred.filter((d) => itemMap.has(d.itemId) && !scheduled.has(d.itemId)),
    ...body.items
      .filter((i) => !scheduled.has(i.id) && !deferredIds.has(i.id))
      .map((i) => ({ itemId: i.id, reason: "今天没有合适的空档" })),
  ]

  return { blocks: accepted, deferred }
}

/** 排程失败的可识别错误:调用方按 code 决定兜底文案 */
export class ScheduleError extends Error {
  code: string
  status: number
  detail?: string
  constructor(code: string, message: string, status = 400, detail?: string) {
    super(message)
    this.code = code
    this.status = status
    this.detail = detail
  }
}

/**
 * 选模型 → 取 key → 配额 → generateObject → applyGuards 的完整管道。
 * 抛 ScheduleError;调用方决定是回给 4xx/5xx 还是降级本地顺排。
 */
export async function aiScheduleCore(body: ScheduleBody, userId: string) {
  // ── 选模型:显式指定优先,否则挑公共池里的便宜档 ───────────────
  const modelDef = body.model
    ? await getEffectiveModel(userId, body.model)
    : (await getEffectiveModels(userId)).find((m) => m.publicPool)

  if (!modelDef) {
    throw new ScheduleError("no_model", "没有可用模型，请先在 aichatt 配置模型或公共池")
  }

  let apiKey: string | undefined
  let usesServerBilledKey = false

  if (modelDef.publicPool) {
    apiKey = (await getPublicPoolKey(modelDef.provider)) ?? undefined
    usesServerBilledKey = true
  } else {
    const record = await prisma.apiKey.findUnique({
      where: { userId_provider: { userId, provider: modelDef.provider } },
    })
    if (!record) {
      throw new ScheduleError("no_key", `未配置 ${modelDef.provider} 的 API Key`)
    }
    apiKey = decrypt(record.encryptedKey)
  }

  if (!apiKey) {
    throw new ScheduleError("no_key", "模型凭证不可用")
  }

  let quotaBaseLimit: number | null = null
  if (usesServerBilledKey) {
    const check = await checkQuota(userId, false, { modelId: modelDef.id })
    if (check.baseLimit) quotaBaseLimit = check.baseLimit
    if (!check.ok) {
      throw new ScheduleError("quota_exhausted", "公共额度已用完", 429)
    }
  }

  const prompt = [
    `日期：${body.date}`,
    `当前时间（分钟）：${body.constraints.nowMin ?? "未知"}`,
    `可用窗口（已扣除固定安排，可直接使用）：${JSON.stringify(body.constraints.windows)}`,
    `缓冲比例：${body.constraints.bufferRatio}`,
    `固定事件：${JSON.stringify(body.constraints.fixed)}`,
    "",
    "待排任务（id | 标题 | 预估分钟 | 精力 | 优先级 | 截止）：",
    ...body.items.map(
      (i) =>
        `${i.id} | ${i.title} | ${i.estimateMin} | ${i.energy} | ${i.priority} | ${
          i.dueAt ?? "无"
        }`
    ),
  ].join("\n")

  try {
    const provider = createProviderInstanceForEffectiveModel(modelDef, apiKey)
    const model = provider(modelDef.upstreamId ?? modelDef.id)

    const { object, usage } = await generateObject({
      model,
      schema: scheduleOutputSchema,
      system: SYSTEM,
      prompt,
      temperature: 0.2,
      // DeepSeek 等上游的 json 模式会把顶层对象多包一层数组([{...}]),
      // 这里只做这一种确定性解包;其他偏差不猜,交给原始报错。
      experimental_repairText: async ({ text }) => {
        try {
          const value = JSON.parse(text)
          if (Array.isArray(value) && value.length === 1 && typeof value[0] === "object") {
            return JSON.stringify(value[0])
          }
        } catch {
          // 交给上层报错
        }
        return null
      },
    })

    if (usesServerBilledKey) {
      await settleQuota({
        userId,
        modelId: modelDef.id,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        fallbackText: JSON.stringify(object),
        baseLimit: quotaBaseLimit,
      })
    }

    const result = applyGuards(object, body)

    return {
      ...result,
      model: modelDef.id,
      usage: { input: usage?.inputTokens ?? 0, output: usage?.outputTokens ?? 0 },
    }
  } catch (err) {
    if (err instanceof ScheduleError) throw err
    console.error("[plan.schedule] failed:", err)
    // 开发期把真实原因带出去,生产环境只给一句话
    const e = err as Error & { text?: string; cause?: unknown }
    const detail =
      process.env.NODE_ENV === "production"
        ? undefined
        : [
            `${e?.name ?? "Error"}: ${e?.message ?? ""}`,
            e?.cause ? `cause: ${String((e.cause as Error)?.message ?? e.cause)}` : "",
            e?.text ? `text: ${e.text.slice(0, 500)}` : "",
          ]
            .filter(Boolean)
            .join(" | ")
            .slice(0, 1200)
    throw new ScheduleError("ai_error", "排程失败", 500, detail)
  }
}
