import { streamText } from "ai"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"
import { decrypt } from "@/lib/crypto"
import {
  getEffectiveModels,
  getEffectiveModel,
  createProviderInstanceForEffectiveModel,
  getCappedPublicPoolModel,
} from "@/lib/ai/registry"
import { getPublicPoolKey } from "@/lib/quota"
import { buildCustomModelDefinition, resolveApiKey, createCustomLanguageModel } from "@/lib/ai/custom-model"
import type { ModelDefinition } from "@/lib/ai/types"
import { monitor } from "@/lib/monitor"
import { DEAI_WRITING_DISCIPLINE } from "@/lib/text/deai"
import { buildFullSettingsBlock } from "@/lib/write/work-settings"

/**
 * 写作画布流式生成端点 —— /api/write/generate。
 *
 * 与 /api/chat 的差异:不建会话、不落消息记录,产出的正文由前端通过
 * /api/write/docs PATCH 持久化;无工具总线,纯文本流。
 * 模型解析与 /api/quick-chat 同构:body.model 可选,缺省按该用户模型列表
 * 取第一个已配置 Key 的;SSE 事件协议也与 quick-chat 一致:
 *   data: {"type":"text","value":"..."}  增量正文
 *   data: {"type":"error","value":"..."} 错误(流终止)
 *   data: {"type":"done"}                结束
 *
 * 四种动作(落笔纪律移植自 NovelWriter 的落笔层 write.js):
 *   create   按指令从零生成整篇/开头
 *   continue 以正文尾部约 600 字为锚点无缝续写(可带要求)
 *   insert   在选区之后插入/续写新内容(可带要求,选区本身保留)
 *   rewrite  改写选区(润色/扩写/改写/自定义),只输出替换文字
 */

export const maxDuration = 300

type WriteAction = "create" | "continue" | "insert" | "rewrite"

/** 续写锚点长度:太短失去连贯性,太长挤占输出预算 */
const ANCHOR_CHARS = 600
/** 选区动作(insert/rewrite)时选区前后的参考上下文 */
const CONTEXT_BEFORE = 400
const CONTEXT_AFTER = 200
const MAX_SELECTION_CHARS = 8000
const MAX_INSTRUCTION_CHARS = 2000

const CRAFT_DISCIPLINE: string = [
  "你是一位专业的小说写手。你的唯一任务是产出可直接使用的小说正文。",
  "铁律:",
  "1. 直接输出正文本身,不要解释、不要开场白、不要任何 markdown 标题或列表符号",
  "2. 不要反问、不要给建议、不要总结你的写作思路",
  "3. 使用中文,叙事连贯,段落之间用空行分隔",
  "4. 保持人称、时态与文风一致",
  "",
  DEAI_WRITING_DISCIPLINE,
].join("\n")

/** 提取错误对象的可读信息(兼容 Error / APICallError / 未知形状) */
function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === "object" && err !== null) {
    const anyErr = err as { message?: unknown; stringValue?: unknown }
    if (typeof anyErr.message === "string") return anyErr.message
  }
  return typeof err === "string" ? err : "模型调用失败"
}

/** 组装各动作的 system 提示词 */
function buildSystem(
  action: WriteAction,
  opts: { instruction: string; anchor: string; before: string; after: string; selection: string }
): string {
  if (action === "create") {
    return [
      CRAFT_DISCIPLINE,
      "",
      "【写作指令】",
      opts.instruction,
    ].join("\n")
  }

  if (action === "continue") {
    const parts = [
      CRAFT_DISCIPLINE,
      "",
      "【正文结尾(续写锚点)】",
      opts.anchor,
      "",
      "从锚点末尾无缝续写:",
      "- 不要重复锚点中已有的内容",
      "- 新内容直接承接最后一句的情节、节奏与语气",
    ]
    if (opts.instruction) {
      parts.push(`- 本次续写要求:${opts.instruction}`)
    }
    return parts.join("\n")
  }

  // insert:在选区之后无缝续写(指令可空;选区与前后文都只是衔接参考)
  if (action === "insert") {
    return [
      CRAFT_DISCIPLINE,
      "",
      "【上下文(仅供理解情节,不要输出)】",
      `${opts.before}……${opts.after}`,
      "",
      "【已有的一句/一段(正文里已存在,不要重复输出)】",
      opts.selection,
      "",
      opts.instruction ? `【添加要求】${opts.instruction}` : "【任务】从这段文字之后无缝续写:",
      "要求:",
      "- 直接从该段文字的结尾处接着写,衔接其语气、人称、时态与情节走向",
      "- 不要重复选区与上下文中已有的内容",
      "- 只输出新增的正文本身",
    ].join("\n")
  }

  // rewrite
  return [
    "你是一位专业的小说编辑,负责按任务要求改写指定选区。",
    "",
    "【上下文(仅供理解情节,不要输出)】",
    `${opts.before}……${opts.after}`,
    "",
    "【待改写选区】",
    opts.selection,
    "",
    `【任务】${opts.instruction}`,
    "要求:",
    "- 只输出改写后的选区文字本身,不要输出上下文、引号或任何解释",
    "- 保持与上下文一致的人称、时态和文风",
    "- 除任务要求外,不改变情节事实与人物设定",
    "",
    DEAI_WRITING_DISCIPLINE,
  ].join("\n")
}

export async function POST(req: Request) {
  const userId = await getUserId(req)
  if (!userId) {
    return Response.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const action = body.action
  if (action !== "create" && action !== "continue" && action !== "insert" && action !== "rewrite") {
    return Response.json({ error: "无效的生成动作" }, { status: 400 })
  }

  const instruction =
    typeof body.instruction === "string" ? body.instruction.trim().slice(0, MAX_INSTRUCTION_CHARS) : ""
  const selection =
    typeof body.selection === "string" ? body.selection.slice(0, MAX_SELECTION_CHARS) : ""

  monitor("write_generate_start", { action, selectionLen: selection.length, instructionLen: instruction.length })

  if (action === "create" && !instruction) {
    return Response.json({ error: "请先描述要写什么" }, { status: 400 })
  }
  if (action === "rewrite" && (!selection.trim() || !instruction)) {
    return Response.json({ error: "改写需要选区与任务说明" }, { status: 400 })
  }
  if (action === "insert" && !selection.trim()) {
    return Response.json({ error: "添加内容需要先选中一段文字" }, { status: 400 })
  }

  // continue/insert/rewrite 必须有文档(锚点与上下文的权威来源是库里的正文,不信客户端)
  let anchor = ""
  let before = ""
  let after = ""
  let docWorkId: string | null = null
  if (action === "continue" || action === "insert" || action === "rewrite") {
    const docId = typeof body.docId === "string" ? body.docId : ""
    if (!docId) {
      return Response.json({ error: "缺少文档 id" }, { status: 400 })
    }
    const doc = await prisma.writeDoc.findFirst({
      where: { id: docId, userId },
      select: { content: true, workId: true },
    })
    if (!doc) {
      return Response.json({ error: "文档不存在" }, { status: 404 })
    }
    docWorkId = doc.workId
    if (action === "continue") {
      if (!doc.content.trim()) {
        return Response.json({ error: "正文为空,请先用「生成」写个开头" }, { status: 400 })
      }
      anchor = doc.content.slice(-ANCHOR_CHARS)
    } else if (selection) {
      // 选区在正文中的真实位置:取前后文帮模型理解情节;找不到就用选区自身
      const idx = doc.content.indexOf(selection)
      before = idx > 0 ? doc.content.slice(Math.max(0, idx - CONTEXT_BEFORE), idx) : ""
      const afterStart = idx < 0 ? -1 : idx + selection.length
      after = afterStart >= 0 ? doc.content.slice(afterStart, afterStart + CONTEXT_AFTER) : ""
    }
  }

  // 作品设定注入(全量档):continue/insert 取文档归属作品,create 用 body.workId(画布接入时);
  // rewrite 只改表达不吃设定,跳过省 token —— 策略细节见 lib/write/work-settings.ts。
  // 注入在模型解析之前完成,便于无 token 冒烟(坏 model 请求也能从日志核验注入结果)
  let workBlock = ""
  if (action !== "rewrite") {
    const workId = docWorkId ?? (typeof body.workId === "string" ? body.workId : null)
    if (workId) {
      const work = await prisma.work.findFirst({
        where: { id: workId, userId },
        select: { id: true, title: true, description: true, settingsEnabled: true },
      })
      if (work?.settingsEnabled) {
        const entries = await prisma.workSetting.findMany({
          where: { workId: work.id, enabled: true },
          select: { id: true, category: true, title: true, aliases: true, content: true, enabled: true },
          orderBy: { sort: "asc" },
        })
        const block = buildFullSettingsBlock(work, entries)
        if (block.text) {
          workBlock = block.text
          console.log(
            `[write-generate] work settings injected: work=${work.id} entries=${block.included}/${block.total} chars=${block.chars}`
          )
        }
      }
    }
  }

  // 模型解析:与 /api/quick-chat 同构(body.model 可选,缺省取第一个已配置 Key 的)
  let modelId = typeof body.model === "string" && body.model ? body.model : ""
  if (!modelId) {
    const models = await getEffectiveModels(userId)
    for (const m of models) {
      const hasKey =
        (await prisma.apiKey.findUnique({
          where: { userId_provider: { userId, provider: m.provider } },
          select: { id: true },
        })) != null ||
        (m.provider === "qianwen" && !!process.env.API_KEY_DASHSCOPE)
      if (hasKey) {
        modelId = m.id
        break
      }
    }
    if (!modelId) modelId = models[0]?.id || "gpt-5.4-mini"
  }

  let modelDef: ModelDefinition
  let apiKey: string | undefined
  let provider: (modelId: string) => ReturnType<typeof createProviderInstanceForEffectiveModel>
  let realModelId = modelId

  if (modelId.startsWith("custom:")) {
    const cmId = modelId.slice(7)
    const cmRecord = await prisma.customModel.findFirst({ where: { id: cmId, userId } })
    if (!cmRecord) {
      return Response.json({ error: `自定义模型不存在：${modelId}` }, { status: 400 })
    }
    modelDef = buildCustomModelDefinition(cmRecord)
    realModelId = cmRecord.modelId
    apiKey = await resolveApiKey(userId, cmRecord)
    provider = () => createCustomLanguageModel(cmRecord, apiKey)
  } else {
    const builtinModelDef = await getEffectiveModel(userId, modelId)
    if (!builtinModelDef) {
      return Response.json({ error: `模型不存在或已下架：${modelId}` }, { status: 400 })
    }
    modelDef = builtinModelDef
    // 公共池门面模型(如 bailian-qwen3.8-27b):必须映射到 upstreamId 再发上游,
    // 并用公共池服务端 Key + 额度闸 —— 与 /api/chat 的 resolver 同规则。
    // 缺这条会把门面 id 原样发给 DashScope,报「model does not exist」(2026-11-08 踩坑)
    if (modelDef.upstreamId) realModelId = modelDef.upstreamId
    if (modelDef.publicPool) {
      const capped = await getCappedPublicPoolModel(modelId).catch(() => null)
      if (capped) {
        return Response.json(
          { error: `「${capped.name}」的公共额度已用完，请换个模型` },
          { status: 429 }
        )
      }
      apiKey = (await getPublicPoolKey(modelDef.provider)) ?? undefined
      if (!apiKey) {
        return Response.json(
          { error: `公共池未配置 ${modelDef.provider} 的服务端 Key` },
          { status: 400 }
        )
      }
      provider = createProviderInstanceForEffectiveModel(modelDef, apiKey)
    } else {
      const apiKeyRecord = await prisma.apiKey.findUnique({
        where: { userId_provider: { userId, provider: modelDef.provider } },
      })
      if (!apiKeyRecord && modelDef.provider === "qianwen") {
        // 与 /api/chat 同规则:千问回落到环境变量 Key(免配置免费额度)
        apiKey = process.env.API_KEY_DASHSCOPE
        if (!apiKey) {
          return Response.json(
            { error: "服务端未配置通义千问的 API Key（环境变量 API_KEY_DASHSCOPE）" },
            { status: 400 }
          )
        }
      } else if (!apiKeyRecord) {
        return Response.json(
          { error: `还没有配置 ${modelDef.provider} 的 API Key，请先到设置里填写` },
          { status: 400 }
        )
      } else {
        try {
          apiKey = decrypt(apiKeyRecord.encryptedKey)
        } catch (err) {
          console.error(`[write-generate] Failed to decrypt API key for user ${userId}:`, err)
          return Response.json({ error: "已保存的 API Key 解密失败，请在设置里重新填写一次" }, { status: 500 })
        }
      }
      // 与 /api/chat 同规则:provider 变量持工厂,调用 provider(realModelId) 才得到语言模型
      provider = createProviderInstanceForEffectiveModel(modelDef, apiKey as string)
    }
  }

  try {
    // 作品设定块拼在任务 prompt 之后:任务在前、设定在后,模型先看到"要写什么"再对照一致性约束
    const systemPrompt = buildSystem(action, { instruction, anchor, before, after, selection })
    const result = streamText({
      model: provider(realModelId),
      system: workBlock ? `${systemPrompt}\n\n${workBlock}` : systemPrompt,
      messages: [
        {
          role: "user" as const,
          // 具体任务已全部在 system 里;user 位放一句最小触发语,防止部分模型空响应
          content:
            action === "rewrite"
              ? "请输出改写后的选区文字。"
              : action === "continue" || action === "insert"
                ? "请开始续写。"
                : "请开始写作。",
        },
      ],
    })

    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (payload: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
        }
        try {
          for await (const chunk of result.fullStream) {
            const c = chunk as { type?: string; text?: unknown; error?: unknown }
            if (c.type === "text-delta" && typeof c.text === "string") {
              send({ type: "text", value: c.text })
            } else if (c.type === "error") {
              console.error("[write-generate] stream error:", c.error)
              send({ type: "error", value: extractErrorMessage(c.error) })
              break
            }
          }
          send({ type: "done" })
        } catch (err) {
          console.error("[write-generate] stream failure:", err)
          monitor("write_generate_stream_error", { error: String(err).slice(0, 160) })
          send({ type: "error", value: extractErrorMessage(err) })
        } finally {
          controller.close()
        }
      },
    })

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    })
  } catch (err) {
    console.error("[write-generate] failed:", err)
    return Response.json({ error: extractErrorMessage(err) }, { status: 500 })
  }
}
