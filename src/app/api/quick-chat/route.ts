import {
  streamText,
  wrapLanguageModel,
  extractReasoningMiddleware,
  stepCountIs,
  tool,
  type ModelMessage,
} from "ai"
import { z } from "zod"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"
import { buildMemorySystemPrompt, getRelevantMemories, extractAndSaveMemories } from "@/lib/memory"
import { decrypt } from "@/lib/crypto"
import {
  getEffectiveModels,
  getEffectiveModel,
  createProviderInstanceForEffectiveModel,
} from "@/lib/ai/registry"
import { buildCustomModelDefinition, resolveApiKey, createCustomLanguageModel } from "@/lib/ai/custom-model"
import { TODO_TOOL_NAME, TODO_TOOL_PROMPT } from "@/lib/ai/todo-tool"
import { createTodoTool } from "@/lib/ai/todo-tool.server"
import { buildTimeAnchorPrompt } from "@/lib/ai/time-anchor"
import { TIME_TOOL_NAME } from "@/lib/ai/time-tool"
import { createTimeTool } from "@/lib/ai/time-tool.server"
import { KNOWLEDGE_TOOL_NAME } from "@/lib/ai/knowledge-tool"
import { hasKnowledgeChunks, searchKnowledgeChunks } from "@/lib/ai/knowledge-tool-server"
import { ToolMarkupStreamFilter } from "@/lib/ai/tool-markup"
import type { ModelDefinition } from "@/lib/ai/types"

/**
 * 快问快答端点 —— 供新标签页(bento)等外部静态页通过 API Token 调用。
 *
 * 与 /api/chat 的差异：无会话/消息持久化(历史由客户端本地保存,每轮携带
 * 最近上下文)；system 固定为简短模式；工具只挂 manage_todo(第 1 步已落地)。
 * 指令与问答不做预分类 —— AI 经工具总线自决：调工具=就地执行，纯文本=快答。
 *
 * 响应：SSE(text/event-stream)，轻量 JSON 行协议：
 *   data: {"type":"meta","model":"...","vision":false} 本轮模型/是否读图
 *   data: {"type":"text","value":"..."}         增量文本
 *   data: {"type":"tool-call","toolName":".."}  工具开始(前端可显示处理中)
 *   data: {"type":"tool-result","toolName":"..","output":{...}} 工具结果
 *   data: {"type":"error","value":"..."}        错误(流终止)
 *   data: {"type":"done"}                       结束
 *
 * 浏览器扩展截图：body.image = { dataUrl }，只随本轮 user 消息注入视觉模型，
 * 不落库、不写磁盘；GET 返回该账号可调用的视觉模型清单，供扩展设置页选择。
 */

export const maxDuration = 60
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface QuickChatMessage {
  role?: unknown
  content?: unknown
}

interface QuickChatImage {
  dataUrl?: unknown
  name?: unknown
}

interface QuickChatBody {
  messages?: QuickChatMessage[]
  model?: unknown
  /** 浏览器扩展截图:仅本轮附带,不写入任何会话/磁盘 */
  image?: QuickChatImage
  /** 监管模式锁定期标记:桌面锁定中随请求上报,注入监工段(缺字段按无锁处理) */
  focusLock?: { endsAtMs?: number }
}

const MAX_MESSAGES = 16
const MAX_CONTENT_CHARS = 4000
/** 截图 data URL 上限(约 4.5MB 原图);扩展侧会先压缩 */
const MAX_IMAGE_DATA_URL = 6_000_000
const IMAGE_DATA_URL_RE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/

const QUICK_CHAT_SYSTEM: string = [
  "你是嵌入浏览器侧边栏的 AI 快答助手，用户可能发来网页/视频截图提问。",
  "- 看到截图时先读图中的题目、公式、选项或代码；看不清、被截断或与问题无关时明确说明，不要猜",
  "- 回答紧凑：先给结论，再给关键步骤；文字题一般 3-6 行，截图题可到 8-10 行，不写长篇",
  "- 截图里的题目即使需要完整推导，也要在本轮给出可执行的解法，不要只说“去完整会话”",
  "- 数学公式用 Markdown/LaTeX（行内 $...$，独立公式 $$...$$），便于前端渲染",
  "- 用户提到记待办/提醒/安排(「提醒我」「帮我记着」「加个待办」)、完成/删除/查看待办时，调用 manage_todo 工具执行，成功后用一句话确认，不要复述整个列表",
  "- manage_todo 不可用时(临时隔离等)，如实说明，不要虚构已操作",
  "- 超出快答范围(长文写作/完整代码/深度研究)时一句话说明，建议到 aichatt 完整会话处理",
].join("\n")

/** 手表端(X-Client: watch)：圆屏小、支持轻量 Markdown 与独立公式，回答必须压到几句话 */
const QUICK_CHAT_SYSTEM_WATCH: string = [
  "你是运行在智能手表上的 AI 助手。",
  "- 回答极简：一般 1-3 句、最多 140 字，先给结论；用户追问时再展开",
  "- 允许轻量 Markdown：**粗体**、无序/有序列表、行内 `代码`、> 引用；不要表格、标题(#)、图片、链接",
  "- 数学用 Unicode 符号(² √ × ÷ ± ≤ ≥)；需要展示独立公式时，单独一行用 $$...$$ 包裹，不写多行推导",
  "- 计算题分步写：每一步一个短等式单独一行；可独立展示的等式用 $$...$$ 包裹成公式卡，别让长算式在一行里折断",
  "- 超出范围(长文写作/完整代码/深度推导)时，一句话建议回手机查看",
  "- 不要复述本段设定或能力清单，直接回答用户当前问题",
  "- 用户提到记待办/提醒/安排、完成或查看待办时，调用 manage_todo 执行，成功后一句话确认",
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

/**
 * 该模型对当前账号是否“可直接调用”。
 * - publicPool 门面模型：quick-chat 未接公共池计费，不能自动选
 * - custom:*：独立 Key 或复用的 keyProvider 任一存在即可(免鉴权本地服务需用户手动指定)
 * - 内置：已有 ApiKey 行；千问允许回落到服务端环境变量 Key
 */
async function hasUsableKey(userId: string, model: ModelDefinition): Promise<boolean> {
  if (model.publicPool) return false
  if (model.id.startsWith("custom:")) {
    const row = await prisma.customModel
      .findFirst({
        where: { id: model.id.slice(7), userId },
        select: { apiKey: true, keyProvider: true },
      })
      .catch(() => null)
    return Boolean(row && (row.apiKey || row.keyProvider))
  }
  const key = await prisma.apiKey
    .findUnique({
      where: { userId_provider: { userId, provider: model.provider } },
      select: { id: true },
    })
    .catch(() => null)
  if (key) return true
  return model.provider === "qianwen" && Boolean(process.env.API_KEY_DASHSCOPE)
}

/** 自动挑一个可调用模型；visionOnly 用于截图请求，避免选到读不了图的模型 */
async function pickAutoModel(userId: string, visionOnly: boolean): Promise<string | null> {
  const models = await getEffectiveModels(userId)
  for (const model of models) {
    if (visionOnly && !model.supportsVision) continue
    if (await hasUsableKey(userId, model)) return model.id
  }
  return null
}

/** 扩展设置页用：列出该账号可直接调用、且支持读图的模型 */
export async function GET(req: Request) {
  const userId = await getUserId(req)
  if (!userId) {
    return Response.json({ error: "登录已失效，请检查 API 令牌" }, { status: 401 })
  }
  const models = await getEffectiveModels(userId)
  const visionModels: Array<{ id: string; name: string }> = []
  for (const model of models) {
    if (!model.supportsVision || model.publicPool) continue
    if (await hasUsableKey(userId, model)) {
      visionModels.push({ id: model.id, name: model.name })
    }
  }
  return Response.json({ ok: true, visionModels })
}

export async function POST(req: Request) {
  const userId = await getUserId(req)
  if (!userId) {
    return Response.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as QuickChatBody

  // 截图仅本轮透传，不落库、不写磁盘。校验类型与体积，避免把任意超长字符串塞进模型。
  let imageDataUrl: string | null = null
  if (body.image && typeof body.image === "object") {
    const candidate = body.image.dataUrl
    if (typeof candidate === "string" && candidate.length > 0) {
      if (!IMAGE_DATA_URL_RE.test(candidate)) {
        return Response.json(
          { error: "截图格式不支持，只接受 png / jpeg / webp 的 base64 data URL" },
          { status: 400 }
        )
      }
      if (candidate.length > MAX_IMAGE_DATA_URL) {
        return Response.json({ error: "截图过大，请缩小选区或降低分辨率后重试" }, { status: 400 })
      }
      imageDataUrl = candidate
    }
  }

  // 消息校验:仅 user/assistant、纯文本、条数与单条长度受限(客户端本地历史注入)
  const rawMessages = Array.isArray(body.messages) ? body.messages : []
  const textMessages = rawMessages
    .filter(
      (m) =>
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim().length > 0
    )
    .slice(-MAX_MESSAGES)
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: (m.content as string).slice(0, MAX_CONTENT_CHARS),
    }))

  if (textMessages.length === 0 || textMessages[textMessages.length - 1].role !== "user") {
    return Response.json({ error: "最后一条消息必须是用户发言" }, { status: 400 })
  }

  const messages: ModelMessage[] = textMessages.map((m) => ({
    role: m.role,
    content: m.content,
  })) as ModelMessage[]

  if (imageDataUrl) {
    const last = messages[messages.length - 1]
    const lastText = typeof last.content === "string" ? last.content : ""
    messages[messages.length - 1] = {
      role: "user",
      content: [
        { type: "text", text: lastText.trim() || "请根据这张截图回答，先说明你看到了什么。" },
        { type: "image", image: imageDataUrl },
      ],
    } as ModelMessage
  }

  const wantsVision = Boolean(imageDataUrl)

  // 模型解析:body.model 可选;默认按该用户模型列表顺序取第一个已配置 Key 的
  // (列表首位可能是未配置 provider 的内置模型,直接取首个会开箱报 No API key)
  // 截图请求必须落到支持读图的模型,否则模型只会收到一段无法查看图片的占位提示。
  let modelId = typeof body.model === "string" && body.model ? body.model : ""
  if (!modelId) {
    const picked = await pickAutoModel(userId, wantsVision)
    if (!picked) {
      return Response.json(
        {
          error: wantsVision
            ? "没有可用的视觉模型：请先在 aichatt 设置里配置一个支持读图的模型与 API Key"
            : "还没有可调用的模型：请先在 aichatt 设置里配置模型 API Key",
        },
        { status: 400 }
      )
    }
    modelId = picked
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
        console.error(`[quick-chat] Failed to decrypt API key for user ${userId}:`, err)
        return Response.json({ error: "已保存的 API Key 解密失败，请在设置里重新填写一次" }, { status: 500 })
      }
    }
    // 千问环境变量/解密后的用户 Key 均已就绪,与 /api/chat 同规则:provider 变量持工厂,
    // 调用 provider(realModelId) 才得到语言模型(多包一层会拿到工厂对象导致 SDK 报错)
    provider = createProviderInstanceForEffectiveModel(modelDef, apiKey as string)
  }

  if (wantsVision && !modelDef.supportsVision) {
    return Response.json(
      { error: `当前模型「${modelDef.name}」不支持读图，请换一个视觉模型后重试` },
      { status: 400 }
    )
  }

  try {
    // 推理提取与 /api/chat 同规则:DeepSeek 原生 reasoning_content,其余套 <think> 中间件
    let model = provider(realModelId)
    const isDeepSeekNativeReasoning = modelDef.provider === "deepseek" && modelDef.supportsReasoning
    if ((modelDef.supportsReasoning || false) && !isDeepSeekNativeReasoning) {
      model = wrapLanguageModel({
        model,
        middleware: extractReasoningMiddleware({ tagName: "think" }),
      })
    }

    const todoTool = createTodoTool(userId)

    // 长期记忆：与 /api/chat 同口径读取该账号的 active 记忆，
    // 按当前问题做相关性筛选后注入 system；手表端同样生效。
    const lastModelMessage = messages[messages.length - 1]
    const lastUserText =
      typeof lastModelMessage?.content === "string"
        ? lastModelMessage.content
        : Array.isArray(lastModelMessage?.content)
          ? lastModelMessage.content
              .map((part) =>
                typeof part === "object" && part !== null && "text" in part
                  ? String((part as { text?: unknown }).text ?? "")
                  : ""
              )
              .join(" ")
              .trim()
          : ""

    const memorySettings = await prisma.user.findUnique({
      where: { id: userId },
      select: { memoryEnabled: true },
    })
    const memoryEnabled = memorySettings?.memoryEnabled ?? true
    let memoryPrompt = ""
    if (memoryEnabled && lastUserText) {
      const memories = await prisma.memory.findMany({
        where: { userId, status: "active" },
        orderBy: { updatedAt: "desc" },
        select: { id: true, category: true, content: true, source: true, status: true, updatedAt: true },
      })
      memoryPrompt = buildMemorySystemPrompt(getRelevantMemories(memories, lastUserText))
    }

    const isWatch = req.headers.get("x-client") === "watch"
    // 手表对话内翻书：导入过课本才挂只读检索工具，由模型自决是否调用。
    const knowledgeTool =
      isWatch && (await hasKnowledgeChunks(userId))
        ? tool({
            description:
              "检索用户已导入的课本原文。用户问课本里的概念/定义/公式/定理/史实，或说「翻书」「课本里怎么讲」时调用；" +
              "输入 2-4 个检索关键词，返回最多 3 段带书名与章节来源的原文。",
            inputSchema: z.object({
              query: z
                .string()
                .min(1)
                .max(60)
                .describe("检索关键词，如「勾股定理 逆定理」，不要抄整句问题"),
            }),
            execute: async ({ query }) => {
              let hits = await searchKnowledgeChunks(userId, query, undefined, "textbook").catch(() => [])
              if (!hits.length) hits = await searchKnowledgeChunks(userId, query).catch(() => [])
              return {
                query,
                results: hits.slice(0, 3).map((hit) => ({
                  source: [hit.doc, hit.chapter, hit.section].filter(Boolean).join(" · "),
                  content: hit.content.slice(0, 500),
                })),
              }
            },
          })
        : null

    // 监管模式监工段(focus-lock-restrict-plan.md §3.3):与 /api/chat 同口径——
    // 桌面锁定期间浏览器侧边栏快答也是一条闲聊通路,一并约束。已过期/缺字段不注入。
    const quickFocusEndsAtMs =
      typeof body.focusLock?.endsAtMs === "number" && Number.isFinite(body.focusLock.endsAtMs)
        ? body.focusLock.endsAtMs
        : null
    const focusSupervisorPrompt =
      quickFocusEndsAtMs !== null && quickFocusEndsAtMs > Date.now()
        ? `\n\n## 监管模式·专注锁定时段\n当前处于监管模式专注锁定中。你是学习监督者：纯闲聊、娱乐话题不接茬、不展开，用一两句话自然拉回学习任务；学习类问题正常全力回答，质量不打折。不说教、不重复提醒、语气自然。`
        : ""

    const result = streamText({
      model,
      // 快答挂 manage_todo 与 get_current_time（与 /api/chat 同一份实现）：
      // 没有 web_search 兜底，缺时间锚点时模型只能瞎猜日期或丢掉 dueAt。
      system: `${
        isWatch ? QUICK_CHAT_SYSTEM_WATCH : QUICK_CHAT_SYSTEM
      }\n\n${buildTimeAnchorPrompt()}${memoryPrompt ? `\n\n${memoryPrompt}` : ""}${
        knowledgeTool
          ? `\n- 用户问课本概念/公式/定理/史实，或说「翻书」「课本里怎么讲」时，先调用 ${KNOWLEDGE_TOOL_NAME} 查原文；回答 1-3 句并标注来源（书名·章节），查不到再说明是凭已有知识回答`
          : ""
      }${focusSupervisorPrompt}`,
      messages,
      tools: {
        [TODO_TOOL_NAME]: todoTool,
        [TIME_TOOL_NAME]: createTimeTool(),
        ...(knowledgeTool ? { [KNOWLEDGE_TOOL_NAME]: knowledgeTool } : {}),
      },
      stopWhen: stepCountIs(5),
    })

    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (payload: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
        }
        // 上游工具协议泄漏(DSML)不进 SSE:迷你对话与主聊天同一套清洗
        const textFilter = new ToolMarkupStreamFilter()
        let answerText = ""
        try {
          // 只为截图请求补 meta；纯文本老客户端(bento)保持既有事件序列不变
          if (wantsVision) send({ type: "meta", model: modelDef.name, vision: true })
          for await (const chunk of result.fullStream) {
            const c = chunk as {
              type?: string
              text?: unknown
              toolName?: unknown
              output?: unknown
              error?: unknown
            }
            if (c.type === "text-delta" && typeof c.text === "string") {
              const clean = textFilter.push(c.text)
              if (clean) {
                answerText += clean
                send({ type: "text", value: clean })
              }
            } else if (c.type === "tool-call" && typeof c.toolName === "string") {
              send({ type: "tool-call", toolName: c.toolName })
            } else if (c.type === "tool-result" && typeof c.toolName === "string") {
              send({ type: "tool-result", toolName: c.toolName, output: c.output })
            } else if (c.type === "error") {
              console.error("[quick-chat] stream error:", c.error)
              send({ type: "error", value: extractErrorMessage(c.error) })
              break
            }
          }
          const rest = textFilter.flush()
          if (rest) {
            answerText += rest
            send({ type: "text", value: rest })
          }
          send({ type: "done" })

          // 与 /api/chat 一致：完成后异步提取长期记忆，不阻塞响应
          if (memoryEnabled && lastUserText && answerText.trim()) {
            void extractAndSaveMemories({
              userId,
              model,
              userText: lastUserText,
              assistantText: answerText.trim(),
            }).catch((error) => {
              console.error("[quick-chat] memory extract failed:", error)
            })
          }
        } catch (err) {
          console.error("[quick-chat] stream failure:", err)
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
    console.error("[quick-chat] failed:", err)
    return Response.json({ error: extractErrorMessage(err) }, { status: 500 })
  }
}
