import { NextRequest } from "next/server"
import {
  streamText,
  wrapLanguageModel,
  extractReasoningMiddleware,
  toUIMessageStream,
  createUIMessageStreamResponse,
  APICallError,
  type ModelMessage,
  type UIMessageChunk,
} from "ai"
import type { SharedV4ProviderOptions } from "@ai-sdk/provider"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { decrypt } from "@/lib/crypto"
import { classifyUpstreamError, encodeUpstreamError } from "@/lib/error-catalog"
import { getEffectiveModel, getCappedPublicPoolModel, createProviderInstanceForEffectiveModel } from "@/lib/ai/registry"
import { buildCustomModelDefinition, resolveApiKey, createCustomLanguageModel } from "@/lib/ai/custom-model"
import { buildMemorySystemPrompt, getRelevantMemories, extractAndSaveMemories } from "@/lib/memory"
import { buildGeneralProfileSection } from "@/lib/profile/injection"
import { loadGeneralProfile } from "@/lib/profile/load"
import { generateImage, extractImagePrompts, IMG_MARKER_REGEX } from "@/lib/ai/image"
import { generateConversationTitle } from "@/lib/ai/title-generator"
import { getStylePromptFromPreset, STYLE_PRESETS, presetFromOffset } from "@/lib/ai/style"
import { getReplyLengthPrompt, REPLY_LENGTH_LEVELS, DEFAULT_REPLY_LENGTH } from "@/lib/ai/reply-length"
import { getMaskById } from '@/lib/ai/mask-resolve'
import { MASK_ESCAPE_HATCH } from '@/lib/ai/mask-types'
import { buildMatchedSettingsBlock } from "@/lib/write/work-settings"
import { splitReasoningTail } from "@/lib/utils"
import { createWebSearchTool } from "@/lib/ai/search"
import { KNOWLEDGE_TOOL_NAME, KNOWLEDGE_SUBJECT_LABELS } from "@/lib/ai/knowledge-tool"
import { createKnowledgeTool, hasKnowledgeChunks } from "@/lib/ai/knowledge-tool-server"
import { PRACTICE_TOOL_NAME, RECORD_TOOL_NAME } from "@/lib/ai/practice-tool"
import { createPracticeTool, createRecordPracticeTool } from "@/lib/ai/practice-tool-server"
import { hasQuestions } from "@/lib/study/question-bank"
import { CLARIFY_TOOL_NAME, CLARIFY_TOOL_PROMPT, createClarifyTool } from "@/lib/ai/clarify"
import {
  LOCAL_FILE_TOOL_NAME,
  LOCAL_FILE_TOOL_PROMPT,
  createLocalFileTool,
} from "@/lib/ai/local-file-tool"
import {
  CODE_EDIT_TOOL_NAME,
  CODE_EDIT_TOOL_PROMPT,
  createCodeEditTool,
} from "@/lib/ai/code-edit-tool"
import {
  PREVIEW_CHECK_TOOL_NAME,
  PREVIEW_CHECK_TOOL_PROMPT,
  createPreviewCheckTool,
} from "@/lib/ai/preview-check-tool"
import {
  PROJECT_CHECK_TOOL_NAME,
  PROJECT_CHECK_TOOL_PROMPT,
  createProjectCheckTool,
} from "@/lib/ai/project-check-tool"
import {
  SETTINGS_TOOL_NAME,
  SETTINGS_TOOL_PROMPT,
  SETTINGS_DISABLED_PROMPT,
  buildSettingsSnapshotSection,
  createSettingsTool,
} from "@/lib/ai/settings-tool"
import {
  PROVIDER_MODEL_TOOL_NAME,
  createProviderModelTool,
} from "@/lib/ai/provider-model-tool"
import { buildProviderModelSection } from "@/lib/ai/provider-model-tool.server"
import {
  ADD_CUSTOM_MODEL_TOOL_NAME,
  createCustomModelTool,
} from "@/lib/ai/custom-model-tool"
import { buildCustomModelSection } from "@/lib/ai/custom-model-tool.server"
import {
  DELETE_CUSTOM_MODEL_TOOL_NAME,
  createDeleteCustomModelTool,
} from "@/lib/ai/delete-custom-model-tool"
import {
  MEMORY_TOOL_NAME,
  MEMORY_TOOL_PROMPT,
  MEMORY_DISABLED_PROMPT,
} from "@/lib/ai/memory-tool"
import { createMemoryTool } from "@/lib/ai/memory-tool.server"
import {
  TODO_TOOL_NAME,
  TODO_TOOL_PROMPT,
  TODO_DISABLED_PROMPT,
} from "@/lib/ai/todo-tool"
import { createTodoTool } from "@/lib/ai/todo-tool.server"
import {
  MASK_TOOL_NAME,
  MASK_TOOL_PROMPT,
  createMaskGeneratorTool,
} from "@/lib/ai/mask-tool"
import {
  WRITE_DOC_TOOL_NAME,
  WRITE_DOC_TOOL_PROMPT,
} from "@/lib/ai/write-doc-tool"
import { createWriteDocTool } from "@/lib/ai/write-doc-tool.server"
import {
  WRITE_CODE_TOOL_NAME,
  WRITE_CODE_TOOL_PROMPT,
} from "@/lib/ai/write-code-tool"
import { createWriteCodeTool } from "@/lib/ai/write-code-tool.server"
import {
  TRIP_TOOL_NAME,
  TRIP_TOOL_PROMPT,
} from "@/lib/ai/trip-tool"
import { createTripTool } from "@/lib/ai/trip-tool.server"
import {
  URL_READER_TOOL_NAME,
  URL_READER_TOOL_PROMPT,
  URL_READER_DISABLED_PROMPT,
} from "@/lib/ai/url-reader"
import { createUrlReaderTool } from "@/lib/ai/url-reader.server"
import { buildMcpPromptSection } from "@/lib/ai/mcp/mcp-constants"
import {
  loadMcpToolsForUser,
  closeMcpClients,
  type McpLoadResult,
} from "@/lib/ai/mcp/mcp-client.server"
import { loadCompressionState, maybeCompressContext, shouldCompress } from "@/lib/context-compression"
import type { SearchEngineId } from "@/lib/ai/search-engines"
import {
  getSearchPlatform,
  toSearchPlatformId,
  type SearchPlatformId,
} from "@/lib/ai/search-platforms"
import type { Attachment } from "@/lib/attachment-types"
import { sanitizeUploadName, readUploadAsDataUrl, sweepOrphanUploadsThrottled } from "@/lib/uploads"
import { SCANNED_PDF_MIN_CHARS } from "@/lib/file-parser"
import type { ModelDefinition } from "@/lib/ai/types"
import { isEphemeralSession } from "@/lib/ephemeral"
import { checkQuota, settleQuota, isQuotaBilledModel, getPublicPoolKey } from "@/lib/quota"
import { monitor } from "@/lib/monitor"

export const maxDuration = 120 // seconds。深度思考耗时较长,Vercel Pro 允许到 300

interface ChatRequestBody {
  model: string
  messages: IncomingMessage[]
  conversationId?: string
  deepThink?: boolean
  groupId?: string
  attachments?: Attachment[]
  styleOffset?: number // 旧版 0-100, default 50 if not provided(向后兼容)
  stylePreset?: string // 新版 preset id(见 src/lib/ai/style-presets.ts 的 STYLE_PRESETS)
  replyLength?: string // 回复长度档 id(见 src/lib/ai/reply-length.ts);不传时走 standard(不注入)
  maskId?: string // 面具 id(内置面具见 @/lib/ai/builtin-masks);不传时从会话读取
  webSearch?: boolean // 客户端本次请求是否开启联网搜索
  searchEngine?: SearchEngineId // 联网搜索引擎，默认 qianfan
  searchPlatform?: SearchPlatformId // 平台定向口径: 'auto'(默认,模型自判) | 'all'(强制全网) | 具体平台 id(强制站内白名单)
  mcpEnabled?: boolean // 客户端是否注入 MCP 外部工具(默认 true,仅显式 false 时跳过加载)
  settingsSnapshot?: Partial<Record<string, string>> // 客户端设置快照（AI 设置控制，executor.buildSettingsSnapshot 上报）
  currentWriteDocId?: string // 写作画布面板当前打开的文档 id（注入提示词与 append 续写）
  localFilesEnabled?: boolean // 客户端(Tauri)本地文件能力:仅桌面端且用户开关开启时上报 true,服务端据此注入 local_file 工具
  workspaceContext?: string // 工作区快照(客户端组装:目录树+AGENT.md 约定,≤8KB):仅 local_file 注入时采纳,注入 system
  codePanelOpen?: boolean // 客户端上报:代码编辑器面板是否打开,服务端据此注入 code_edit 工具
  studyMode?: boolean // /study 导师对话流:强制挂载课本检索/题库练题工具并注入教学能力段(临时模式页面已被 middleware 封锁)
  /** 「只重答这条」:就地改写该 user 消息并把新回答插回原时间位置,后续消息不归档 */
  reanswerEdit?: { editedId?: string; oldContent: string }
}

/** 客户端传入的消息（UIMessage 格式的结构化子集）*/
interface IncomingPart {
  type: string
  text?: string
  /** tool-* part 专有字段（state=input-available/output-available/output-error）*/
  toolCallId?: string
  state?: string
  input?: unknown
  output?: unknown
  errorText?: string
}

interface IncomingMessage {
  role: string
  content?: string | IncomingPart[]
  parts?: IncomingPart[]
  text?: string
  /** UIMessage 序列化自带的消息 id(历史消息=数据库 id,本轮新消息=本地临时 id) */
  id?: string
  /** 后端写入的结构化 UI 提示: { kind: 'branch_summary', ... } */
  metadata?: unknown
}

/**
 * Convert incoming UIMessage format (from @ai-sdk/react useChat) to ModelMessage format
 * that streamText expects. UIMessages use `parts` array; ModelMessages use `content`.
 *
 * 客户端工具(local_file)多步续跑: tool-* part 与 assistant 消息走结构化转换——
 * 保留 reasoning(DeepSeek thinking 模式强制要求回传 reasoning_content,缺失直接 400)
 * 发出 tool-call,工具结果以独立 tool 消息紧随其后。普通纯文本历史维持原拼接行为,零回归。
 */
function convertToModelMessages(messages: IncomingMessage[]): ModelMessage[] {
  const out: ModelMessage[] = []
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant" && m.role !== "system") continue
    let modelMessage: ModelMessage | null = null
    let toolMessage: ModelMessage | null = null
    if (typeof m.content === "string" && m.content) {
      // If message already has string content, use it directly
      modelMessage = { role: m.role, content: m.content } as ModelMessage
    } else if (Array.isArray(m.content) && m.content.length > 0) {
      // content is already structured parts → pass through
      modelMessage = { role: m.role, content: m.content } as unknown as ModelMessage
    } else if (Array.isArray(m.parts)) {
      const hasToolPart = m.parts.some(
        (p: IncomingPart) => typeof p.type === "string" && p.type.startsWith("tool-")
      )
      if (m.role === "assistant" && hasToolPart) {
        const content: Array<Record<string, unknown>> = []
        const toolResults: Array<Record<string, unknown>> = []
        for (const p of m.parts) {
          if (p.type === "text" && p.text) {
            content.push({ type: "text", text: p.text })
          } else if (p.type === "reasoning" && p.text) {
            content.push({ type: "reasoning", text: p.text })
          } else if (p.type.startsWith("tool-")) {
            const toolName = p.type.slice(5)
            // 只转换已完结的调用(input-streaming 等中间态跳过,避免悬空 tool-call)
            if (p.toolCallId && (p.state === "output-available" || p.state === "output-error")) {
              content.push({
                type: "tool-call",
                toolCallId: p.toolCallId,
                toolName,
                input: p.input ?? {},
              })
              toolResults.push({
                type: "tool-result",
                toolCallId: p.toolCallId,
                toolName,
                // v5 协议:output 必须是带 type 标签的包裹(json/error-text/text/...),
                // 裸对象会被 streamText 的 zod 校验拒绝(AI_InvalidPromptError)
                output:
                  p.state === "output-error"
                    ? { type: "error-text", value: p.errorText ?? "工具执行失败" }
                    : { type: "json", value: p.output ?? { ok: true } },
              })
            }
          }
          // step-start 等其他 part 不进入模型消息
        }
        if (content.length > 0) {
          modelMessage = { role: "assistant", content } as unknown as ModelMessage
        }
        if (toolResults.length > 0) {
          toolMessage = { role: "tool", content: toolResults } as unknown as ModelMessage
        }
      } else {
        const textContent = m.parts
          .filter((p: IncomingPart) => p.type === "text")
          .map((p: IncomingPart) => p.text ?? "")
          .join("")
        if (textContent) modelMessage = { role: m.role, content: textContent } as ModelMessage
      }
    } else {
      const fallback = String(m.content ?? m.text ?? "")
      if (fallback) modelMessage = { role: m.role, content: fallback } as ModelMessage
    }
    // Preserve metadata so downstream code can identify special message kinds
    // (e.g. branch_summary system messages that must be moved into the `system` param).
    if (modelMessage && m.metadata) (modelMessage as { metadata?: unknown }).metadata = m.metadata
    if (modelMessage) out.push(modelMessage)
    if (toolMessage) out.push(toolMessage)
  }
  return out
}

const IMG_PREFIX = "[IMG:"
const IMG_PLACEHOLDER = "\n\n> 🎨 正在生成图片…\n\n"

/**
 * 过滤流式输出中的 [IMG:...] 标记(跨 chunk 安全),替换为占位提示。
 * 最终正文在 onFinish 中统一替换为真实图片后入库,
 * 客户端收到 finish 事件时会拉取库中最终内容覆盖显示。
 */
function createImgMarkerFilterStream(): TransformStream<UIMessageChunk, UIMessageChunk> {
  let pending = ""

  // 计算 buf 末尾与 IMG_PREFIX 前缀的最长重叠长度(标记可能被 chunk 截断)
  const longestPrefixAtEnd = (s: string): number => {
    for (let len = IMG_PREFIX.length; len > 0; len--) {
      if (s.endsWith(IMG_PREFIX.slice(0, len))) return len
    }
    return 0
  }

  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      if (chunk.type !== "text-delta") {
        controller.enqueue(chunk)
        return
      }
      let buf = pending + chunk.delta
      pending = ""

      // 逐个替换完整的 [IMG:...] 标记;未闭合的标记挂起等待后续 chunk
      while (true) {
        const startIdx = buf.indexOf(IMG_PREFIX)
        if (startIdx === -1) {
          const hold = longestPrefixAtEnd(buf)
          if (hold > 0) {
            pending = buf.slice(buf.length - hold)
            buf = buf.slice(0, buf.length - hold)
          }
          break
        }
        const endIdx = buf.indexOf("]", startIdx)
        if (endIdx === -1) {
          pending = buf.slice(startIdx)
          buf = buf.slice(0, startIdx)
          break
        }
        buf = buf.slice(0, startIdx) + IMG_PLACEHOLDER + buf.slice(endIdx + 1)
      }

      if (buf) {
        controller.enqueue({ type: "text-delta", id: chunk.id, delta: buf })
      }
    },
    flush() {
      // 流结束时仍有未闭合标记(模型输出被截断),直接丢弃;
      // 最终入库内容在 onFinish 中会同样清理残留标记。
    },
  })
}

/** Extract plain text from a message (UIMessage or CoreMessage) */
function extractTextContent(msg: IncomingMessage): string {
  if (typeof msg.content === "string" && msg.content) return msg.content
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((p: IncomingPart) => p.type === "text")
      .map((p: IncomingPart) => p.text ?? "")
      .join("\n")
  }
  if (Array.isArray(msg.parts)) {
    return msg.parts
      .filter((p: IncomingPart) => p.type === "text")
      .map((p: IncomingPart) => p.text ?? "")
      .join("\n")
  }
  return String(msg.content ?? msg.text ?? "")
}

export async function POST(req: NextRequest) {
  try {
    const session = await auth()
    if (!session?.user?.id) {
      return new Response(
        JSON.stringify({
          error: encodeUpstreamError(
            classifyUpstreamError(new Error("未登录或登录已过期"), { code: "session_expired", status: 401 })
          ),
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }
      )
    }

    const userId = session.user.id
    // 临时聊天模式(访客密码登录):对话打隔离标记进隔离区。
    // 记忆写入/设置类工具全部物理级关闭,长期记忆注入由用户开关控制。
    const isEphemeral = isEphemeralSession(session)

    // 提前声明:长上下文摘要注入分支及多个 system 提示都需要读取 systemParts,
    // 在函数顶部集中声明一次,避免下游块式作用域里的 TDZ / use-before-define。
    const systemParts: string[] = []

    const body: ChatRequestBody = await req.json()
    const { model: modelId, messages: rawMessages, conversationId, deepThink, groupId, webSearch, searchEngine, mcpEnabled } = body
    const attachments = Array.isArray(body.attachments) ? body.attachments : []
    const hasImageAttachments = attachments.some((a) => a.type.startsWith("image/"))
    // 学习模式(导师对话流):仅正式单聊生效。页面级封锁在 middleware,
    // 这里再挡一层防伪造请求把工具强行挂进临时/对比泳道。
    const studyModeOn = body.studyMode === true && !isEphemeral && !groupId

    console.log(`[chat] Processing request for user ${userId}, model: ${modelId}, messages: ${rawMessages?.length || 0}, deepThink: ${deepThink}, webSearch: ${webSearch}, mcpEnabled: ${mcpEnabled}`)

    // 边界护栏:body.model 缺失(客户端模型水合竞态等)会让下游 modelId.startsWith
    // 直接 TypeError 500,错误细节只有服务端控制台可见。这里 400 早退并给出可读文案。
    if (typeof modelId !== "string" || !modelId.trim()) {
      console.error(`[chat] Missing/invalid model in request body for user ${userId}: ${String(modelId)}`)
      return new Response(JSON.stringify({ error: "请求缺少模型参数,请刷新页面后重试;若反复出现请清浏览器缓存" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }

    // 新版 preset 优先:body 显式传 stylePreset 时用之,否则查 DB 的 preset;
    // preset 缺失/null 时回退到旧的 styleOffset(老会话);offset 也无则默认 balanced。
    const requestedStylePreset = STYLE_PRESETS.find((p) => p.id === body.stylePreset)?.id
    const requestedStyleOffset =
      typeof body.styleOffset === 'number' && Number.isFinite(body.styleOffset)
        ? Math.max(0, Math.min(100, Math.round(body.styleOffset)))
        : undefined

    // 解析面具:body 显式传 maskId 时用之,否则查 DB;未知 id 视为无面具。
    // user: 前缀为自定义面具(getMaskById 内部校验归属)
    // 写作画布面板当前打开的文档,前端随请求附带:注入上下文让 AI 可用 append 续写这篇
const currentWriteDocId = typeof body.currentWriteDocId === "string" ? body.currentWriteDocId : null
const requestedMask = await getMaskById(body.maskId ?? null, userId)
    const requestedMaskRef = requestedMask?.ref

    let conversationStylePreset: string | null = null
    let conversationStyleOffset = 50
    let conversationMaskId: string | null = null
    let conversationReplyLength: string | null = null
    // 归属标记:conversationId 确实属于当前用户且区隔匹配(临时↔正式)才允许复用,读取其数据。
    // 否则一律按"无会话"处理并新建,杜绝向他人会话写入(跨用户越权与跨区写入)。
    let conversationOwned = false
    if (conversationId) {
      try {
        const conv = await prisma.conversation.findFirst({
          where: { id: conversationId, userId, isEphemeral },
          select: { styleOffset: true, stylePreset: true, maskId: true, replyLength: true },
        })
        conversationOwned = !!conv
        conversationStylePreset = conv?.stylePreset ?? null
        conversationStyleOffset = conv?.styleOffset ?? 50
        conversationMaskId = conv?.maskId ?? null
        conversationReplyLength = conv?.replyLength ?? null
      } catch (err) {
        console.error("[chat] Failed to fetch conversation:", err)
      }
    }

    // 「只重答这条」标记:仅单聊(无 groupId)、非临时区且会话归属成立时生效
    const reanswerEdit = !groupId && !isEphemeral && conversationOwned ? body.reanswerEdit ?? null : null

    // 解析最终生效的面具:body > DB conv;未知 id 视为无面具。
    const effectiveMask = await getMaskById(requestedMaskRef ?? conversationMaskId, userId)
    const effectiveMaskId = effectiveMask?.ref ?? null
    if (effectiveMask) {
      console.log(`[chat] Mask: ${effectiveMask.ref} (body: ${requestedMaskRef ?? '-'}, conv: ${conversationMaskId ?? '-'})`)
    }
    // 游戏面具(世界引擎型人格)走「干净车道」:关掉记忆/档案/回复长度/课本检索/练题/澄清等
    // 学习脚手架,以及设置控制/面具工坊/写作/代码/行程/待办/生图/本地文件/代码编辑/预览/项目
    // 检查/MCP/联网读页等全部助理工具面——沉浸叙事只留世界观与游戏面板。逃生舱(MASK_ESCAPE_HATCH)仍保留。
    const isGameMask = effectiveMask?.kind === 'game'

    // 解析最终生效的 preset:body > DB preset > 面具默认风格 > 旧 offset 推导 > balanced
    const effectiveStylePreset: string =
      requestedStylePreset ??
      conversationStylePreset ??
      effectiveMask?.stylePreset ??
      presetFromOffset(requestedStyleOffset ?? conversationStyleOffset)
    console.log(`[chat] Style preset: ${effectiveStylePreset} (body: ${requestedStylePreset ?? '-'}, conv: ${conversationStylePreset ?? '-'})`)

  // Validate model (builtin or custom)
  let modelDef: ModelDefinition
  let apiKey: string | undefined
  // 公共额度计费标记:本次请求是否走「服务端兜底 Key」的计费模型
  // (见 lib/quota.ts 的 QUOTA_BILLED_MODEL_IDS)。决定请求前过额度闸、onFinish 结算
  let usesServerBilledKey = false
  let provider: (modelId: string) => ReturnType<typeof createProviderInstanceForEffectiveModel>
  let realModelId = modelId // for builtin models same as input; for custom use modelId from DB
  // 自定义模型推理信息:是否勾选推理 + Base URL(决定 deepThink 时是否注入 reasoning_effort 档位)
  let cmSupportsReasoning = false
  let cmBaseURL = ""

  if (modelId.startsWith("custom:")) {
    const cmId = modelId.slice(7) // strip "custom:" prefix
    const cmRecord = await prisma.customModel.findFirst({ where: { id: cmId, userId } })
    if (!cmRecord) {
      console.error(`[chat] Unknown custom model: ${modelId} for user ${userId}`)
      monitor("chat_upstream_error", { code: "model_not_found", stage: "precheck" })
      return new Response(
        JSON.stringify({
          error: encodeUpstreamError(
            classifyUpstreamError(new Error(`自定义模型记录不存在: ${modelId}`), {
              code: "model_not_found",
              status: 404,
            })
          ),
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      )
    }
    modelDef = buildCustomModelDefinition(cmRecord)
    realModelId = cmRecord.modelId
    cmSupportsReasoning = cmRecord.supportsReasoning
    cmBaseURL = cmRecord.baseURL || ""
    // Resolve API key (own key > provider key > none/local)
    apiKey = await resolveApiKey(userId, cmRecord)
    // Build provider instance (native for provider-key reuse without baseURL; OpenAI-compatible otherwise)
    provider = () => createCustomLanguageModel(cmRecord, apiKey)
  } else {
    // 用户级有效模型：内置预置（未被该用户隐藏）+ 用户添加的自定义模型（复用 provider Key）
    const builtinModelDef = await getEffectiveModel(userId, modelId)
    if (!builtinModelDef) {
      // 甄别:公共门面模型预算触顶被隐藏时,给「额度用完」而非「不在可用列表」
      // (选择器已隐藏,走到这的多是旧会话残留选中或并发窗口)
      const capped = await getCappedPublicPoolModel(modelId).catch(() => null)
      if (capped) {
        console.warn(`[chat] MODEL_CAPPED: model=${modelId}, user=${userId}`)
        monitor("chat_quota_denied", { reason: "model_capped", provider: modelId })
        return new Response(
          JSON.stringify({
            error: encodeUpstreamError(
              classifyUpstreamError(new Error(`「${capped.name}」的公共额度已用完`), {
                code: "quota_exhausted",
                status: 429,
                fallbackDetail: "该模型的公共额度预算已用完，请换个模型",
              })
            ),
          }),
          { status: 429, headers: { "Content-Type": "application/json" } }
        )
      }
      console.error(`[chat] Unknown model: ${modelId}`)
      monitor("chat_upstream_error", { code: "model_not_found", stage: "precheck" })
      return new Response(
        JSON.stringify({
          error: encodeUpstreamError(
            classifyUpstreamError(new Error(`模型 ${modelId} 不在可用列表中`), {
              code: "model_not_found",
              status: 404,
            })
          ),
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      )
    }
    modelDef = builtinModelDef
    // 门面模型上游映射:「标准」引擎与 deepseek-flash 同款,发上游用真实模型 id
    if (modelDef.upstreamId) realModelId = modelDef.upstreamId

    // Fetch and decrypt the user's API key for this provider
    const apiKeyRecord = await prisma.apiKey.findUnique({
      where: {
        userId_provider: {
          userId,
          provider: modelDef.provider,
        },
      },
    })

    // For Qwen/DashScope: fall back to environment variable API key if user hasn't configured one
    // This enables free-tier access without requiring users to manually configure API keys
    if (modelDef.publicPool) {
      // 公共池门面模型(DB 动态注册):一律服务端出钱 + 公共额度计费,即便用户自带
      // 同厂 Key——门面档语义唯一,自带 Key 想省池子请选原厂模型
      apiKey = (await getPublicPoolKey(modelDef.provider)) ?? undefined
      if (!apiKey) {
        console.error(`[chat] No public pool key configured for provider ${modelDef.provider} (user ${userId})`)
        monitor("chat_upstream_error", { code: "config_missing", stage: "precheck", provider: modelDef.provider })
        return new Response(
          JSON.stringify({
            error: encodeUpstreamError(
              classifyUpstreamError(new Error(`公共池未配置 ${modelDef.provider} 的服务端 Key`), {
                code: "config_missing",
              })
            ),
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        )
      }
      usesServerBilledKey = true
      console.log(`[chat] Using public pool server key (provider=${modelDef.provider})`)
    } else if (!apiKeyRecord && modelDef.provider === "qianwen") {
      apiKey = process.env.API_KEY_DASHSCOPE
      if (!apiKey) {
        console.error(`[chat] No DashScope API key configured for user ${userId}`)
        monitor("chat_upstream_error", { code: "config_missing", stage: "precheck", provider: "qianwen" })
        return new Response(
          JSON.stringify({
            error: encodeUpstreamError(
              classifyUpstreamError(new Error("服务端环境变量 API_KEY_DASHSCOPE 未配置"), {
                code: "config_missing",
              })
            ),
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        )
      }
      console.log("[chat] Using DashScope env var API key for Qwen models")
    } else if (
      !apiKeyRecord &&
      modelDef.provider === "deepseek" &&
      isQuotaBilledModel(modelDef.id)
    ) {
      // DeepSeek 公共额度接入:服务端兜底 Key 只对计费名单内模型开放(当前仅
      // deepseek-flash)。名单外的重型模型(如 deepseek-v4-pro,输出价约 3.4 倍)
      // 落到下方 config_missing 引导用户自带 Key——堵「免费重型模型」漏洞
      apiKey = process.env.API_KEY_DEEPSEEK
      if (!apiKey) {
        console.error(`[chat] No DeepSeek API key configured for user ${userId}`)
        monitor("chat_upstream_error", { code: "config_missing", stage: "precheck", provider: "deepseek" })
        return new Response(
          JSON.stringify({
            error: encodeUpstreamError(
              classifyUpstreamError(new Error("服务端环境变量 API_KEY_DEEPSEEK 未配置"), {
                code: "config_missing",
              })
            ),
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        )
      }
      usesServerBilledKey = true
      console.log("[chat] Using DeepSeek env var API key (public quota billed)")
    } else if (!apiKeyRecord) {
      console.error(`[chat] No API key configured for ${modelDef.provider} for user ${userId}`)
      monitor("chat_upstream_error", { code: "config_missing", stage: "precheck", provider: modelDef.provider })
      return new Response(
        JSON.stringify({
          error: encodeUpstreamError(
            classifyUpstreamError(new Error(`未配置 ${modelDef.provider} 的 API Key`), {
              code: "config_missing",
            })
          ),
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    } else {
      try {
        apiKey = decrypt(apiKeyRecord.encryptedKey)
      } catch (err) {
        console.error(`[chat] Failed to decrypt API key for user ${userId}:`, err)
        monitor("chat_upstream_error", { code: "config_missing", stage: "decrypt" })
        return new Response(
          JSON.stringify({
            error: encodeUpstreamError(
              classifyUpstreamError(err, {
                code: "config_missing",
                fallbackDetail: "已保存的 Key 解密失败，请在设置里重新填写一次",
              })
            ),
          }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        )
      }
    }

    try {
      // 用户添加的模型（带 custom: 前缀）使用 modelDef.provider 查找 provider
      provider = createProviderInstanceForEffectiveModel(modelDef, apiKey)
    } catch (err) {
      console.error(`[chat] Failed to create provider instance for ${modelId}:`, err)
      monitor("chat_upstream_error", { code: "server_error", stage: "provider_init" })
      return new Response(
        JSON.stringify({
          error: encodeUpstreamError(
            classifyUpstreamError(err, {
              code: "server_error",
              fallbackDetail: `无法初始化 ${modelDef.provider} 的调用客户端`,
            })
          ),
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      )
    }
  }

  // 公共额度闸:仅服务端兜底 Key 的计费模型请求过闸(自带 Key / 非计费模型直通)。
  // 池空与个人超限都回 429,错误体走 error-catalog envelope,客户端按码出中文提示
  let quotaBaseLimit: number | null = null // 结算处判定附加余额扣减用
  if (usesServerBilledKey) {
    const check = await checkQuota(userId, isEphemeral)
    if (check.baseLimit) quotaBaseLimit = check.baseLimit
    if (!check.ok) {
      console.warn(`[chat] QUOTA_DENIED: reason=${check.reason}, user=${userId}, model=${modelId}`)
      monitor("chat_quota_denied", { reason: check.reason, provider: "deepseek" })
      return new Response(
        JSON.stringify({
          error: encodeUpstreamError(
            classifyUpstreamError(new Error("公共额度已用完"), {
              code: "quota_exhausted",
              status: 429,
              fallbackDetail:
                check.reason === "pool_exhausted"
                  ? "全站公共池已耗尽，等待每日自动补货"
                  : "你今日的个人额度已用完，北京时间 0 点自动恢复",
            })
          ),
        }),
        { status: 429, headers: { "Content-Type": "application/json" } }
      )
    }
  }

  // 长上下文压缩(剔除): 该会话已有远期摘要时,把被摘要覆盖的早期原文从本次请求中
  // 摘除——只发"摘要 + 未覆盖的近期原文",压缩才真正省 token。
  // 消息 id:若 id 不在覆盖集合(本地临时消息),一律保留,宁可多发不可漏发。
  const compressionState =
    conversationId && conversationOwned
      ? await loadCompressionState(conversationId)
      : null
  const effectiveRawMessages = compressionState
    ? rawMessages.filter(
        (m) => typeof m.id !== "string" || !compressionState.coveredIds.has(m.id)
      )
    : rawMessages

  // Convert incoming messages to ModelMessage format for streamText
  const messages = convertToModelMessages(effectiveRawMessages)

  // 附件内容注入:图片转多模态 image part(仅视觉模型),文本文件读入正文
  if (attachments.length > 0) {
    const userMsgIdx = messages.map((m) => m.role).lastIndexOf("user")
    if (userMsgIdx !== -1) {
      type ContentPart = { type: string; text?: string; image?: unknown }
      const contentParts: ContentPart[] = []
      for (const att of attachments) {
        const fileName = sanitizeUploadName(att.url)
        if (!fileName) continue
        if (att.type.startsWith("image/")) {
          if (modelDef.supportsVision) {
            const dataUrl = await readUploadAsDataUrl(fileName, att.type)
            if (dataUrl) {
              contentParts.push({ type: "image", image: dataUrl })
            }
          } else {
            contentParts.push({
              type: "text",
              text: `（用户上传了一张图片「${att.name}」，但你无法查看图片内容。请直接告诉用户：你无法查看图片，需要切换到支持视觉的模型后重新发送；不要尝试描述、猜测或生成图片。）`,
            })
          }
        } else {
          // 文本/PDF:从中转站(UploadFile)取上传时解析好的文本,不再读盘重复解析
          const rec = await prisma.uploadFile
            .findUnique({ where: { fileName } })
            .catch(() => null)
          if (
            rec?.parseStatus === "done" &&
            rec.parseText &&
            rec.parseText.trim().length >= SCANNED_PDF_MIN_CHARS
          ) {
            // 截断超长文本,避免撑爆上下文
            const truncated = rec.parseText.length > 20000
            const text = rec.parseText.slice(0, 20000)
            contentParts.push({
              type: "text",
              text: `【附件·${att.name}】\n${text}${
                truncated ? "\n（内容过长，已截断前 20000 字符）" : ""
              }`
            })
          } else if (rec?.parseStatus === "done") {
            // done 但提取不到有效文本(扫描件/图片型 PDF)。视觉模型也读不了(服务端不渲染 PDF 页为图),
            // 故不误导用户切模型,直接给出可行动建议
            contentParts.push({
              type: "text",
              text: `（用户上传的 PDF「${att.name}」是扫描件/图片型，未能提取到文本。请告诉用户：可以将 PDF 中的文字内容复制后直接发送给你；图片型扫描件暂无法自动识别。）`,
            })
          } else if (rec) {
            // failed 等异常状态
            contentParts.push({
              type: "text",
              text: `（用户上传的文件「${att.name}」解析失败，无法读取内容。请直接告知用户该附件无法处理。）`,
            })
          } else {
            contentParts.push({
              type: "text",
              text: `（用户上传了文件 ${att.name}，当前版本暂不支持解析该类型）`,
            })
          }
        }
      }
      if (contentParts.length > 0) {
        const orig = messages[userMsgIdx].content
        if (typeof orig === "string" && orig) {
          contentParts.push({ type: "text", text: orig })
        }
        messages[userMsgIdx] = {
          role: "user",
          content: contentParts,
        } as ModelMessage
      }
    }
  }

  // 可视化意图钉子:小模型(qwen-turbo 级)在长 system prompt 下会忽略「数据可视化规范」,
  // 被检索纪律带跑成"查课本→纯文字分析",整个 chart 管线拿不到块。在末条 user 消息尾部
  // 补一行定向提醒(注意力贴着用户消息,小模型也能命中);只改模型上下文,不入库、客户端不显示。
  // 触发词用图表专名而非泛「画X」,避免误伤 [IMG:] 生图请求。
  const CHART_INTENT_RE =
    /折线图|柱状图|条形图|饼图|面积图|散点图|图表|数据可视化|可视化|思维导图|知识导图|脑图/
  {
    const userMsgIdxForChart = messages.map((m) => m.role).lastIndexOf("user")
    if (userMsgIdxForChart !== -1) {
      const c = messages[userMsgIdxForChart].content
      const lastUserText =
        typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c
                .filter((p) => (p as { type?: string }).type === "text")
                .map((p) => (p as { text?: string }).text || "")
                .join("\n")
            : ""
      if (CHART_INTENT_RE.test(lastUserText)) {
        console.log(`[chat] chart nudge fired (userMsgIdx=${userMsgIdxForChart})`)
        const NUDGE =
          "\n\n[system:本次请求要求图表/可视化——必须输出 ```chart 或 ```mindmap 代码块(格式见数据可视化规范),禁止只给文字分析,禁止用[IMG:]生图;数据用你掌握的知识,不要以课本检索无果为由不画图]"
        const msg = messages[userMsgIdxForChart]
        if (typeof msg.content === "string") {
          msg.content += NUDGE
        } else if (Array.isArray(msg.content)) {
          const parts = msg.content as { type: string; text?: string }[]
          const lastText = [...parts].reverse().find((p) => p.type === "text")
          if (lastText) lastText.text = (lastText.text || "") + NUDGE
          else parts.push({ type: "text", text: NUDGE })
        }
      }
    }
  }

  // 游戏面板钉子:快模型(qwen-flash 级)在超长世界引擎 system prompt 下,常漏掉
  // 每回合的 :::gamestatus / :::gamechoice 面板块(实测第 3 回合只写叙事、两块全丢,
  // 玩家没有可点行动)。同「可视化钉子」思路:在末条 user 消息尾部补一行贴身提醒,
  // 注意力贴着用户消息,小模型也能命中;只改模型上下文,不入库、客户端不显示。
  // 仅游戏干净车道生效(学习/助理车道无面板协议)。
  if (isGameMask) {
    const gameUserIdx = messages.map((m) => m.role).lastIndexOf("user")
    if (gameUserIdx !== -1) {
      const GAME_NUDGE =
        "\n\n[system:输出骨架铁律——若角色尚未创建,只输出开场问卷;若角色已创建,本回合必须依次输出三段、缺一不可:(1) :::gamestatus 状态面板块(每行「名称 值」,只写当前值,不写 +10/-20 这类增减);(2) 第二人称叙事正文;(3) :::gamechoice 行动面板块(2~4 个行动,每行一个,不编号、不加 A/B/C 字母、不加括号数值说明)。每个块的 ::: 开标记与闭标记都必须各自独占一行,行动绝不能挤在 :::gamechoice 同一行,也绝不能漏写结尾的 :::。行动面板输出后立即停下等待玩家,绝不替玩家选择、绝不继续推进剧情。]"
      const gmsg = messages[gameUserIdx]
      if (typeof gmsg.content === "string") {
        gmsg.content += GAME_NUDGE
      } else if (Array.isArray(gmsg.content)) {
        const parts = gmsg.content as { type: string; text?: string }[]
        const lastText = [...parts].reverse().find((p) => p.type === "text")
        if (lastText) lastText.text = (lastText.text || "") + GAME_NUDGE
        else parts.push({ type: "text", text: GAME_NUDGE })
      }
      console.log(`[chat] game panel nudge fired (userMsgIdx=${gameUserIdx})`)
    }
  }

  // 长上下文压缩(注入): 上方已摘除被覆盖的早期原文,这里把摘要注入 system 段,
  // 模型无需原文也能接续早期上下文。仅本人会话才读取(信息泄露防护)。
  if (compressionState?.content) {
    const SUMMARY_HEADER =
      "## 早期对话摘要（系统自动压缩，可能不完整，不要引用其中未确认的具体数字/代码细节）"
    systemParts.unshift(`${SUMMARY_HEADER}\n${compressionState.content}`)
    console.log(
      `[chat] injected summary (${compressionState.content.length} chars, ` +
        `dropped ${rawMessages.length - effectiveRawMessages.length} covered msgs) for conv ${conversationId}`
    )
  }

  // Extract text from the last user message for persistence & memory relevance
  const lastRawUserMsg = [...rawMessages].reverse().find((m) => m.role === "user")
  const userContent = lastRawUserMsg ? extractTextContent(lastRawUserMsg) : ""

  // Load the user's long-term memories (if the feature is enabled)
  const memorySettings = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      memoryEnabled: true,
      clarifyEnabled: true,
      aiSettingsControl: true,
      localFilesEnabled: true,
      imageModel: true,
      imageSize: true,
      ephemeralMemoryInjection: true,
    },
  })
  const memoryEnabled = memorySettings?.memoryEnabled ?? true
  const clarifyEnabled = memorySettings?.clarifyEnabled ?? true
  // 本地文件能力:DB 总开关(默认关)。与客户端上报的 body.localFilesEnabled 双重校验:
  // 二者皆真且非临时非对比才注入 local_file 工具(见下方工具定义区)。
  const localFilesEnabledDb = memorySettings?.localFilesEnabled ?? false

  // 临时模式默认不注入长期记忆(防借号场景:"你还记得我什么"套出隐私),
  // 用户可在正常模式 设置→用户中心 中打开"临时模式允许读取我的记忆"
  const injectMemory =
    memoryEnabled &&
    !isGameMask &&
    (!isEphemeral || (memorySettings?.ephemeralMemoryInjection ?? false))

  let memorySystemPrompt = ""
  if (injectMemory) {
    const memories = await prisma.memory.findMany({
      where: { userId, status: "active" },
      orderBy: { updatedAt: "desc" },
    })
    if (memories.length > 0) {
      const relevant = getRelevantMemories(memories, userContent || "")
      memorySystemPrompt = buildMemorySystemPrompt(relevant)
    }
  }

  // 澄清提问:告诉模型何时调用 ask_clarification 工具(工具本体随下方 tools 注入)。
  // 升级自旧版自助反问"纯文本反问",现在以结构化卡片呈现,用户点选回答。
  const clarifySystemPrompt = CLARIFY_TOOL_PROMPT

  // 通用档案(身份/学段/选科/目标/讲解深度 + 称呼):用户中心显式开启才注入。
  // 四道闸门与记忆同构——临时模式(借号)不读写、对比模式不重复注入、
  // 记忆总开关关掉则整套关、档案行 enabled 默认 false。
  const generalProfile =
    !isEphemeral && !groupId && memoryEnabled && !isGameMask
      ? await loadGeneralProfile(userId)
      : null
  const generalProfilePrompt =
    generalProfile?.enabled
      ? buildGeneralProfileSection({
          fields: generalProfile.fields,
          displayName: generalProfile.displayName,
        })
      : ""

  // Deep thinking: for non-reasoning models, add a system prompt and extract thinking via middleware
  let model = provider(realModelId)
  const baseModel = model // 保留原始模型引用，用于标题生成等后台任务
  if (memorySystemPrompt) systemParts.push(memorySystemPrompt)
  if (generalProfilePrompt) {
    systemParts.push(generalProfilePrompt)
    console.log(`[chat] profile injected (${generalProfilePrompt.length} chars, user ${userId})`)
  }
  if (clarifyEnabled && !isGameMask) systemParts.push(clarifySystemPrompt)

  // AI 设置控制:总开关开启且非对比模式时,注入快照、规则与 update_settings 工具;
  // 关闭时物理级不注入工具(总开关判定在服务端,模型无法影响),改注入降级提示。
  // 对比模式(groupId)两条泳道各自请求,不注入避免重复消耗与多泳道重复执行。
  // 游戏干净车道:整套不注入,连降级提示也省——沉浸叙事不谈配置。
  const aiControlEnabled = memorySettings?.aiSettingsControl ?? true
  if (aiControlEnabled && !isEphemeral && !groupId && !isGameMask) {
    systemParts.push(
      buildSettingsSnapshotSection(body.settingsSnapshot, {
        memoryEnabled,
        clarifyEnabled,
        imageModel: memorySettings?.imageModel,
        imageSize: memorySettings?.imageSize,
      })
    )
    systemParts.push(SETTINGS_TOOL_PROMPT)
    // 服务商模型管理(添加/移除/隐藏模型):与设置控制同开关同三道闸门。
    // 只注入规则+快照,真实写入由前端确认卡片完成(见 ProviderModelCard)。
    systemParts.push(await buildProviderModelSection(userId))
    // 中转站/自定义模型(add_custom_model):同开关同闸门;AI 只起草端点与模型名,
    // API Key 由用户在确认卡片里粘贴——Key 不经过模型请求也不进聊天记录。
    systemParts.push(await buildCustomModelSection(userId))
  } else if (!groupId && !isEphemeral && !isGameMask) {
    systemParts.push(SETTINGS_DISABLED_PROMPT)
  }

  // 显式记忆添加:记忆功能开启且非对比模式时注入 add_memory 工具+规则。
  // 关闭时物理级不注入,改注入降级提示,避免模型虚构"已保存"。
  // 与 onFinish 的自动记忆提取互补:自动靠模型判断"值得记",本工具响应显式指令。
  // 游戏干净车道:两者都不注入(记忆工具与降级提示都属学习/助理脚手架噪音)。
  if (!isGameMask) {
    if (memoryEnabled && !isEphemeral && !groupId) {
      systemParts.push(MEMORY_TOOL_PROMPT)
    } else if (!groupId) {
      systemParts.push(MEMORY_DISABLED_PROMPT)
    }
  }

  // 面具工坊:非对比模式全量注入,无用户开关;草稿需用户在卡片上确认才入库。
  // 模型仅在用户明确要求生成面具时调用(与 update_settings 的 mask 项互斥分发)。
  // 临时模式不注入(生成的面具会写入用户面具库,写入不受隔离);游戏回合同样不注入。
  if (!isEphemeral && !groupId && !isGameMask) {
    systemParts.push(MASK_TOOL_PROMPT)
  }

  // 写作文档:非临时非对比模式注入(正文写库,写入受临时隔离);mask 无用户开关,
  // 模型仅在用户要求成篇幅正文时调用,产出进 WriteDoc 表与 /write 互通;游戏回合不注入。
  if (!isEphemeral && !groupId && !isGameMask) {
    // 面板打开时附带当前文档(校验属主),AI 可用 append 动作续写这篇;
    // 文档归属作品时追加设定注入(命中式,见下)
    let currentDocHint = ""
    if (currentWriteDocId) {
      const openDocId: string = currentWriteDocId
      const curDoc = await prisma.writeDoc.findFirst({
        where: { id: openDocId, userId },
        select: { title: true, workId: true },
      })
      if (curDoc) {
        currentDocHint = `\n- 用户当前在写作画布打开的文档「${curDoc.title}」(id=${openDocId})。用户说续写/接着写,往这篇补充/修改这篇时，这是对该文档的编辑请求，必须调用 write_document 的 action=append 传该 id，content 只写新增正文(与原文自然衔接，不要重复原文)，不要把正文直接回复在聊天里；创作全新内容仍用 create`
      }

      // 作品设定注入(聊天为「命中式」档):大纲恒注入 + 标题/别名命中最近消息或正文尾部的条目;
      // 零命中只给一行条目索引,避免每轮无脑灌满预算 —— 策略细节见 lib/write/work-settings.ts
      if (curDoc?.workId) {
        const work = await prisma.work.findFirst({
          where: { id: curDoc.workId, userId },
          select: { id: true, title: true, description: true, settingsEnabled: true },
        })
        if (work?.settingsEnabled) {
          const entries = await prisma.workSetting.findMany({
            where: { workId: work.id, enabled: true },
            select: { id: true, category: true, title: true, aliases: true, content: true, enabled: true },
            orderBy: { sort: "asc" },
          })
          if (entries.length > 0) {
            // 命中文本 = 最近 6 条消息 + 当前文档尾部(用户只说"继续写"时,人名多半只在正文里)
            const docTail = await prisma.writeDoc.findFirst({
              where: { id: openDocId, userId },
              select: { content: true },
            })
            const recentText = Array.isArray(rawMessages)
              ? (rawMessages as IncomingMessage[]).slice(-6).map(extractTextContent).join("\n")
              : ""
            const matchText = `${recentText}\n${(docTail?.content ?? "").slice(-1500)}`
            const block = buildMatchedSettingsBlock(work, entries, matchText)
            if (block.text) {
              systemParts.push(block.text)
              console.log(
                `[chat] work settings injected: work=${work.id} entries=${block.included}/${block.total} chars=${block.chars}`
              )
            }
          }
        }
      }
    }
    systemParts.push(WRITE_DOC_TOOL_PROMPT + currentDocHint)
  }

  // 代码文档:与 write_document 对称(非临时非对比),模型产出代码/网页类产物时创建
  // CodeDoc 并在前端自动滑出代码编辑器面板——「写个主页 html」类请求的默认通道,
  // 不再误入写作画布;两条 prompt 紧邻注入,边界对照更清晰;游戏回合不注入。
  if (!isEphemeral && !groupId && !isGameMask) {
    systemParts.push(WRITE_CODE_TOOL_PROMPT)
  }

  // 行程规划:非对比模式注入(纯只读不落库,临时模式安全);模型仅在用户提出
  // 旅游/出行规划意图时调用(坐标经服务端高德 POI 校准后由前端渲染地图卡片);游戏回合不注入。
  if (!groupId && !isGameMask) {
    systemParts.push(TRIP_TOOL_PROMPT)
  }

  // 待办管理:非临时非对比模式注入 manage_todo 工具+规则。
  // 临时模式不注入(待办属长期数据,防污染),注入降级提示防虚构。
  // 与 REST API(/api/todos,新标签页插件)共用 Todo 表,变更互通;游戏回合整链不注入。
  if (!isEphemeral && !groupId && !isGameMask) {
    systemParts.push(TODO_TOOL_PROMPT)
  } else if (!groupId && !isGameMask) {
    systemParts.push(TODO_DISABLED_PROMPT)
  }

  // Style prompt - 按 preset 渲染(新版)
  systemParts.push(getStylePromptFromPreset(effectiveStylePreset))

  // 回复长度档:插在风格段之后,让「篇幅」独立于「语气」可调(风格段管详略的旧语义
  // 由 LENGTH_LAYER_PREAMBLE 显式覆盖)。优先级 body > 会话 DB > standard。
  // standard 档 prompt 为空串 → 不注入,存量会话行为不变。
  const effectiveReplyLength: string =
    REPLY_LENGTH_LEVELS.find((l) => l.id === body.replyLength)?.id ??
    REPLY_LENGTH_LEVELS.find((l) => l.id === conversationReplyLength)?.id ??
    DEFAULT_REPLY_LENGTH
  const replyLengthPrompt = getReplyLengthPrompt(effectiveReplyLength)
  if (replyLengthPrompt && !isGameMask) systemParts.push(replyLengthPrompt)

  // 公式书写规范: 全局生效——模型(尤其中文系)常用 Unicode 拼凑数学式(a^m·a^n、√2、≠),
  // KaTeX 只认 LaTeX 定界符,这些写法被原样当字符显示,用户侧表现就是"公式全是乱码"。
  // 约束源头优于前端兜底: 启发式转换会误伤 2^10 / C++ / 版本号等正文片段,且本渲染管线
  // 已有定界符归一化 + 块级提升两层预处理,不宜再叠高误伤层。
  systemParts.push([
    '## 数学公式书写规范',
    '界面会把 LaTeX 渲染成数学排版。所有数学表达式一律用 LaTeX 书写：',
    '- 行内公式用 $...$；独立成行的公式用 $$...$$ 单独占行，如 $x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$',
    '- 幂与下标用花括号包裹多字符内容：$a^{m+n}$、$a^{-n}$、$x_1$',
    '- 乘号写 \\cdot 或 \\times，根号写 \\sqrt{}，分数写 \\frac{}{}，不等号写 \\neq、\\leq、\\geq、\\approx',
    '- 多个公式并列时逐行呈现（每式单独一行或用列表），不要用空格挤在同一行',
    '- 以下写法会被原样显示成乱码，禁止使用：a^m·a^n = a^(m+n)、√2、x≠0、1/a^n',
    '- 代码块与代码示例保持原样，不套公式规范',
  ].join('\n'))

  // Image generation — tell the model how to request images
  // 非视觉模型收到图片附件时移除生图能力提示,避免模型被"图片"字眼诱导误触发生成。
  // 游戏干净车道不注入(生图属暂缓能力,沉浸叙事不该被诱导出画)。
  if (!isGameMask && !(hasImageAttachments && !modelDef.supportsVision)) {
    systemParts.push([
      '## 生图能力',
      '用户想要生成图片（绘画、照片、插画等美术需求）时，在图片应出现的位置输出[IMG:详细描述]（用用户语言描述主体、风格、构图、光线），每条回复最多 2 张。数据图表类可视化不要用生图，按「数据可视化规范」输出。',
    ].join('\n'))
  }

  // 数据可视化规范:界面能直接渲染 ```chart 图表卡(recharts)、```mindmap 导图卡(markmap)
  // 与 ```html 预览面板,没有"图表走生图"的通路——不写这条,模型会把"画个折线图"理解成
  // 生图产出一 JPG 位图,或把任何可视化都写成 html 代码让用户自己点预览。
  // data 键名钉死 name/value 与前端 ChartCard 默认 xKey/yKey 对齐,格式越松解析失败率越高。
  systemParts.push([
    '## 数据可视化规范',
    '用户需要图表或数据可视化（趋势、对比、占比、分布等）时，禁止用[IMG:]生图，禁止只给文字分析，必须按以下方式输出图表（本规范优先于知识库检索：数据用你掌握的知识，不因检索无果而不画图）：',
    '- 常规图表输出一个 ```chart 代码块，块内为纯 JSON：{"type":"line","title":"标题(含单位)","data":[{"name":"2000年","value":17.71},{"name":"2001年","value":17.03}]}。type 取 bar|line|pie|area|scatter；data 每行第一个键固定是类目名 name，其余键都是数值。',
    '- 多序列对比（两国人口、城乡收入、多指标并列）同样用 ```chart 块，不要退到 html：data 每行写 {"name":"1990年","中国":11.35,"印度":8.73}（每个序列一个键，键名即图例名）。饼图只有单序列。图表块之后附一句文字解读。',
    '- 思维导图/知识结构/概念关系梳理输出一个 ```mindmap 代码块，块内为 Markdown 大纲（用 #/##/### 标题或 - 缩进列表表达层级），界面会渲染成可交互导图。不要用 html 画思维导图。',
    '- 复杂交互可视化（地图、大屏、多图联动、动画）才输出一个 ```html 代码块（可用 CDN 引入 ECharts），用户可在代码块上点「预览」查看效果。',
    '- 图表数据要完整（逐年/逐项都给出），不要省略中间数据。',
  ].join('\n'))

  // 联网搜索能力(仅在用户配置了联网搜索 Key 且本次请求主动开启了 webSearch 时才挂上工具)
  // - webSearchEnabled: 客户端本次是否主动开启,默认 false,避免模型无脑触发搜索消耗额度。
  // - 引擎: 客户端通过 searchEngine 指定(qianfan | tavily)，由 Settings 滑块控制
  const webSearchEnabled = webSearch === true
  const engine: SearchEngineId = searchEngine ?? "qianfan"
  // 平台定向口径:客户端没传/传了非法值 → 'auto'(模型自判),行为与改造前完全一致。
  const searchPlatform: SearchPlatformId = toSearchPlatformId(body.searchPlatform)
  let searchApiKey: string | null = null
  // 工具调用明细收集:onStepFinish 逐步累积,流结束后随 metadata 入库,
  // 供前端历史消息回显工具调用卡片(kind='tool_calls')。
  const collectedToolCalls: Array<{ tool: string; input: unknown; output: unknown }> = []
  let searchTool: ReturnType<typeof createWebSearchTool> | null = null
  if (webSearchEnabled) {
    try {
      const searchKeyRecord = await prisma.searchApiKey.findUnique({
        where: { userId_engine: { userId, engine } },
      })
      if (searchKeyRecord) {
        searchApiKey = decrypt(searchKeyRecord.encryptedKey)
        searchTool = createWebSearchTool(engine, searchApiKey, searchPlatform)
        console.log(
          `[chat] Using search engine: ${engine}, platform: ${searchPlatform}${
            searchPlatform !== "auto" ? `(${getSearchPlatform(searchPlatform).label})` : ""
          }`
        )
      }
    } catch (err) {
      console.error(`[chat] Failed to load search key for engine ${engine}:`, err)
    }
    if (!searchApiKey) {
      console.warn(`[chat] User ${userId} requested webSearch but no SearchApiKey configured for engine '${engine}'`)
    }
  }

  // 全文阅读工具(read_url):与联网搜索共用开关(同一“联网”意图),无需 Key。
  // 只读工具,临时模式安全(课本 knowledge 同理)。与 web_search 分工:
  // 搜索回摘要,本工具读链接全文(HTML 正文/PDF 文字层,unpdf 已有依赖)。
  // 关闭时物理不注入,改注入降级提示防虚构;游戏回合整链不注入。
  const urlReaderTool = webSearchEnabled && !isGameMask ? createUrlReaderTool() : null
  if (urlReaderTool) {
    systemParts.push(URL_READER_TOOL_PROMPT)
  } else if (!groupId && !isGameMask) {
    systemParts.push(URL_READER_DISABLED_PROMPT)
  }

  // MCP 外部工具:非临时非对比模式加载用户启用的 server(配置即全局生效)。
  // 连接失败只记入 failures,随能力段注入降级提示,不阻塞主流程;
  // 连接在 onFinish 统一 close(临时模式/对比模式根本不加载);游戏回合同样不加载。
  let mcp: McpLoadResult | null = null
  if (!isEphemeral && !groupId && mcpEnabled !== false && !isGameMask) {
    try {
      mcp = await loadMcpToolsForUser(userId)
      if (mcp.promptInfos.length > 0 || mcp.failures.length > 0) {
        systemParts.push(buildMcpPromptSection(mcp.promptInfos, mcp.failures))
      }
      if (Object.keys(mcp.tools).length > 0) {
        console.log(`[chat] MCP tools attached: ${Object.keys(mcp.tools).length} from ${mcp.clients.length} server(s)`)
      }
    } catch (err) {
      console.error('[chat] Failed to load MCP tools:', err)
    }
  }
  const mcpToolCount = mcp ? Object.keys(mcp.tools).length : 0

  // 澄清提问工具(无 execute:输出 tool call 后本轮即结束,等用户在前端卡片上回答)。
  // 对比模式不注入(多泳道各自触发澄清卡片会互相踩踏),v1 仅单聊启用。
  const clarifyTool = clarifyEnabled && !groupId && !isGameMask ? createClarifyTool() : null
  const settingsTool =
    aiControlEnabled && !isEphemeral && !groupId && !isGameMask ? createSettingsTool() : null
  const providerModelTool =
    aiControlEnabled && !isEphemeral && !groupId && !isGameMask ? createProviderModelTool() : null
  // 中转站/自定义模型:AI 只起草配置,Key 由用户在卡片粘贴(同设置控制开关)
  const customModelTool =
    aiControlEnabled && !isEphemeral && !groupId && !isGameMask ? createCustomModelTool() : null
  // 删除自定义模型(聊天/生图):删除走确认卡片+计算题双层防护(同设置控制开关)
  const deleteCustomModelTool =
    aiControlEnabled && !isEphemeral && !groupId && !isGameMask ? createDeleteCustomModelTool() : null
  const memoryTool = memoryEnabled && !isEphemeral && !groupId && !isGameMask ? createMemoryTool(userId) : null
  const maskGeneratorTool =
    !isEphemeral && !groupId && !isGameMask ? createMaskGeneratorTool() : null
  const todoTool =
    !isEphemeral && !groupId && !isGameMask ? createTodoTool(userId) : null
  const writeDocTool =
    !isEphemeral && !groupId && !isGameMask ? createWriteDocTool(userId) : null
  // 代码文档落库需要 conversationId,但新对话的 convId 在下方才解析:
  // 改为工厂惰性单例 —— 首次 execute 时 convId 已确定,拿当届值建工具。
  // 用 const 局部变量中转,不依赖 TS 对闭包内可变捕获变量的收窄
  let writeCodeToolInstance: ReturnType<typeof createWriteCodeTool> | null = null
  const writeCodeTool = !isEphemeral && !groupId && !isGameMask
    ? () => {
        const existing = writeCodeToolInstance
        if (existing) return existing
        const created = createWriteCodeTool(userId, convId)
        writeCodeToolInstance = created
        return created
      }
    : null
  const tripTool = !groupId && !isGameMask ? createTripTool(userId) : null

  // 本地文件工具(无 execute:文件操作在用户本地机器执行,远程服务器碰不到磁盘)。
  // 注入三重闸门:①客户端上报 localFilesEnabled(仅 Tauri+用户开关会为 true)
  // ②DB 开关 localFilesEnabledDb ③非临时非对比模式 ④游戏干净车道。tool call 输出后本轮即结束,
  // 前端 onToolCall 经 Tauri 在工作区沙箱内执行(删除需卡片确认),经 addToolOutput 回填续跑。
  const localFileTool =
    body.localFilesEnabled === true && localFilesEnabledDb && !isEphemeral && !groupId && !isGameMask
      ? createLocalFileTool()
      : null
  if (localFileTool) {
    systemParts.push(LOCAL_FILE_TOOL_PROMPT)
    console.log(`[chat] local_file tool attached (desktop client, user ${userId})`)
    // 工作区快照(仿 settingsSnapshot 的客户端上报→服务端 buildSection 模式):
    // 目录树 + AGENT.md 约定,模型省去每会话重复 overview。与 local_file 同源注入——
    // 未授权工作区/网页端不传,快照可能滞后,注入段显式声明「改文件前先核实」。
    const snapshot = body.workspaceContext
    if (typeof snapshot === "string" && snapshot.trim()) {
      const clamped = snapshot.length > 8192 ? snapshot.slice(0, 8192) + "\n…(已截断)" : snapshot
      systemParts.push(
        "## 工作区快照（客户端上报,可能滞后）\n" +
          "以下是用户当前工作区的目录树与 AGENT.md 项目约定,供快速了解项目结构。注意:\n" +
          "- 快照是最近一次上报,可能滞后于磁盘现状——引用具体文件内容前,先用 local_file 的 read/search 核实;\n" +
          "- 用户尚未建立项目约定时,可建议把稳定的项目规范写入工作区根 AGENT.md(下次会话自动注入)。\n\n" +
          clamped
      )
    }
  }

  // 代码编辑器工具(无 execute:操作的是 DB 里的 CodeDoc + 前端 Diff 审查,不碰磁盘)。
  // 注入条件:客户端上报 codePanelOpen(用户打开了代码面板)且非临时非对比模式;游戏回合不注入。
  const codeEditTool =
    body.codePanelOpen === true && !isEphemeral && !groupId && !isGameMask
      ? createCodeEditTool()
      : null
  if (codeEditTool) {
    systemParts.push(CODE_EDIT_TOOL_PROMPT)
    console.log(`[chat] code_edit tool attached (user ${userId})`)
  }

  // 预览验证工具(无 execute:前端渲染 iframe 预览收集 console/脚本错误回填)。
  // 与 write_code 同闸门(普通聊天恒挂载)——它是 write_code 的验证闭环下半场:
  // 模型写完 HTML 主动自查,报错回来自修。执行在前端(不依赖 Tauri,Web 端可用);游戏回合不注入。
  const previewCheckTool =
    !isEphemeral && !groupId && !isGameMask ? createPreviewCheckTool() : null
  if (previewCheckTool) {
    systemParts.push(PREVIEW_CHECK_TOOL_PROMPT)
  }

  // 项目检查工具(无 execute:前端经 Tauri lf_exec 在工作区根跑 tsc/eslint/测试并回填)。
  // 闸门与 local_file 完全同源(依赖桌面端 lf_exec,Web 端无从执行)——直接复用其判据:
  // 它是 local_file 写操作的"验收闭环下半场",模型改完工程文件必须跑绿才算完成;
  // 配套收工验收门在 ChatPanel(verify-gate.ts),服务端只负责把工具和规则注入。
  const projectCheckTool = localFileTool ? createProjectCheckTool() : null
  if (projectCheckTool) {
    systemParts.push(PROJECT_CHECK_TOOL_PROMPT)
    console.log(`[chat] project_check tool attached (desktop client, user ${userId})`)
  }

  // 课本知识库检索:半绑定(用户名下有知识切块才注入,物理级闸门,无课本则工具不存在);
  // 面具学科倾向(如数学大师→math)仅作为能力段默认过滤建议,不锁死。
  // 只读工具,临时模式/对比模式均可安全使用。学习模式强制挂载(没课本时检索返回空,不阻塞)。
  let knowledgeTool: ReturnType<typeof createKnowledgeTool> | null = null
  let knowledgeSubjectHint = ""
  try {
    if (!isGameMask && (studyModeOn || (await hasKnowledgeChunks(userId)))) {
      knowledgeTool = createKnowledgeTool(userId, effectiveMask?.subject)
      const prefSubject = effectiveMask?.subject
      const prefLabel = prefSubject ? (KNOWLEDGE_SUBJECT_LABELS[prefSubject] ?? prefSubject) : ""
      knowledgeSubjectHint = prefSubject
        ? `当前面具偏好${prefLabel}学科：检索时默认传 subject="${prefSubject}"；用户明确问的是其他学科时，不传 subject（改查全部）。`
        : "不确定学科时不传 subject，查全部。"
      console.log(`[chat] knowledge tool attached (mask subject: ${effectiveMask?.subject ?? "-"})`)
    }
  } catch (err) {
    console.error("[chat] Failed to check knowledge chunks:", err)
  }

  // 题库练题:双工具(practice_questions 抽题 / record_practice 判分回传)。
  // 用户名下有题目才注入(物理级闸门);抽题只读但判分回传要写错题本(StudyNote),
  // 故临时模式/对比模式整体不挂载(与其它写入类工具同闸门)。学习模式强制挂载。
  let practiceTool: ReturnType<typeof createPracticeTool> | null = null
  let recordPracticeTool: ReturnType<typeof createRecordPracticeTool> | null = null
  if (!isEphemeral && !groupId && !isGameMask) {
    try {
      if (studyModeOn || (await hasQuestions(userId))) {
        practiceTool = createPracticeTool(userId)
        recordPracticeTool = createRecordPracticeTool(userId)
        console.log(`[chat] practice tools attached (user ${userId})`)
      }
    } catch (err) {
      console.error("[chat] Failed to check question bank:", err)
    }
  }

  if (searchTool) {
    const engineDisplayName = engine === "tavily" ? "Tavily" : "百度千帆"
    // 平台定向口径:用户已选定时工具 schema 里根本没有 platform 参数(见 lib/ai/search.ts),
    // 这里只需交代"结果来自哪个口径 + 回退后必须如实说明";'auto' 才需要教模型何时传参。
    const platformGuidance =
      searchPlatform === "auto"
        ? [
            "平台定向(提高体感的关键):用户点名要在某个站内查资料时(B站评论区/UP主、小红书笔记、知乎回答、微博话题、贴吧帖子、豆瓣评分、抖音视频)，给 web_search 多传一个 platform 参数，结果会只含该站内容。",
            "拿不准用户是不是要站内结果时就不传 platform(全网检索)。站内索引可能比全网稀薄，零结果时工具会自动回退全网并在结果里说明——回退发生时，必须向用户交代「这些是全网来源，不是该站内内容」。",
          ].join("\n")
        : searchPlatform === "all"
          ? "用户已明确选择「全网」检索，结果不限站点。"
          : `用户已强制把检索限定在「${getSearchPlatform(searchPlatform).label}」，工具只会返回该站内容；若结果里注明已回退全网，必须如实交代来源已变。`
    systemParts.push([
      '## 联网搜索能力',
      `你拥有 web_search 工具(基于 ${engineDisplayName} 搜索 API)。当用户问题涉及以下场景时,**主动调用 web_search** 一次或多次获取实时信息再作答。`,
      '- 询问新闻、事件、近期发生的事("今天/最近/最新"+时间)',
      '- 需要事实性数据(股价、天气、比赛结果、排行榜、版本号)',
      '- 引用具体来源、查证知识、用户要求查一查',
      '- 你对某个事实没有把握、训练数据可能已过时',
      platformGuidance,
      '普通闲聊、通用知识问答、代码翻译/数学等不需要联网。回答时请自然引用来源，不要编造链接。',
    ].join('\n'))
  }

  // 课本知识库能力段:与 web_search 能力段同理,触发清单+检索纪律写在这里(模型自主决策依据)。
  // 检索纪律是踩坑总结:①中文整句无空格,整句当 query 必然 ILIKE 查空 → 强制拆关键词;
  // ②课本/资料混库,概念题与答题套路需要的来源不同 → kind 分流,拿不准各查一次。
  if (knowledgeTool) {
    systemParts.push([
      '## 课本知识库检索能力',
      '你拥有 search_knowledge 工具(检索用户上传的课本与资料:课本=教材原文,资料=答题模板/提纲/讲义)。当用户问题涉及以下场景时，**主动调用 search_knowledge** 获取原文后再作答:',
      '- 解释课本上的概念、定义、公式、法则(如「什么是相反数」「乘法分配律怎么说」)',
      '- 用户明确要求翻书/查课本时，按教材回答。',
      '- 解答题目(选择题/材料题/填空/大题)时,凡涉及具体史实、事件、人物、制度、概念、公式,先检索课本再作答——不因「我记得答案」跳过;题干数据/材料是表象,考点才是检索对象。',
      '- 讲评习题时需要引用教材原文佐证。',
      '- 你对某知识点的标准表述没有把握,需要以教材为准',
      '- 给用户出题(练习/变式/测验)时输出试卷块协议(:::choice/:::question 题块+紧跟 :::answer 答案块,答案块以**答案：X**」开头,渲染时答案默认折叠,用户先做后看;出题前若知识库覆盖该学科,先检索相关章节的【例题】【练习】举一反三,题块首行写检索到的真实出处「参考教材 §x.x 例N·学科」;知识库没有该学科课本(如语文),出处改标课文篇目「参考篇目名·学科」,用你确知的教材篇目,不得编造章节号或篇名',
      '检索纪律(每次调用必须遵守):',
      '- **先查后答是硬规则**:凡回答涉及具体史实/知识点(事件、人物、文件、制度、概念、公式),无论你多有把握,都必须先调用 search_knowledge 查课本(kind="textbook")——你的记忆只作底稿,检索命中时以课本原文为准作答;检索无果才按自己的知识作答。禁止跳过检索、凭记忆直讲课本覆盖的学科内容',
      '- query 只传 2-4 个学科关键词,**禁止把用户的问题整句直接当 query**(整句匹配不到任何课文);先从题目里提取考点词再检索,如「矛盾 普遍性 特殊性」「相反数 定义」;材料题给的数字/地名是表象,提它背后的考点词,如题干给德国铁路/煤/钢增长数据问「主要原因」,检索「德国 统一 经济」或「第二次工业革命 德国」,而不是「铁路 煤产量」。',
      '- kind 分流:概念/定义/公式/翻书/讲评/出题 → kind="textbook"(查课本原文);答题思路/大题怎么答/答题模板 → kind="material"(查资料);拿不准就先用 textbook 查一次,再用 material 查一次,两边结果按来源标注使用。',
      `闲聊、翻译、写代码、通用常识不需要调用。画图表/数据可视化也不需要调用——用户要图表时按「数据可视化规范」直接用你掌握的数据输出 \`\`\`chart 块,检索无果绝不构成改写成纯文字分析的理由。${knowledgeSubjectHint}回答时优先引用检索到的原文并标注来源:课本标注「书名+章节」,资料标注「资料名」;课本原文与你的知识冲突时,以课本为准。`,
    ].join('\n'))
  }

  // 题库练题能力段:触发清单与流程纪律写在这里(模型自主决策依据);
  // 「不提前给答案」在工具 note 里再强调一次(答案随工具结果进了模型上下文,防泄题)
  if (practiceTool) {
    systemParts.push([
      '## 题库练题能力',
      '你拥有 practice_questions(从题库抽题)与 record_practice(判分回传)工具。当用户想练题/刷题/被考时(如「练几道」「刷题」「考考我」「来几道选择题」「做做2022年的真题」),**主动调用 practice_questions** 从题库抽题,不要自己编题。',
      '- 抽题条件按用户要求传:考点(topic)/年份(year)/难度(difficulty)/题型(kind)/数量(count,默认3最多5);用户没提的维度不传,让服务端随机。',
      '- 抽到题后严格按工具 note 的呈现规范:逐字转写题干与选项、题块首行写出处行「参考 题库 …」;**绝不提前输出答案、解析或 :::answer 块**。',
      '- 用户作答后逐题判分对照,再调用 record_practice 批量上报(questionId 原样用抽题返回的 id;答错的题必传 userAnswer)。答错的题会自动收进错题本。',
      '- 上报后如实告知对错结果,并对每道错题给出正确解法讲解。',
      '用户要你现场出新题(不是从题库抽题)时,仍走出题协议(:::choice/:::question+紧跟 :::answer),不用这两个工具;用户说「练几道」这类从题库练的语义才用。',
    ].join('\n'))
  }

  // 历史回放兜底: 前端历史消息只重建 text/reasoning(工具明细在 metadata,见 toUIMessage),
  // 刷新/切会话后再作答时模型看不到 practice_questions 的工具结果 → 拿不到题目 id,
  // 判分回传会断。这里把「最近一条 assistant 消息」里的抽题明细重新注入 system,
  // 保证「答错自动进错题本」不因回放而失效;只看最后一条,避免陈旧抽题记录长期占用上下文。
  if (practiceTool) {
    type ToolCallsMeta = { kind?: string; toolCalls?: Array<{ tool?: string; output?: unknown }> }
    type PendingItem = { id: string; stem: string; answer: string }
    let pending: PendingItem[] | null = null
    for (let i = rawMessages.length - 1; i >= 0; i--) {
      const m = rawMessages[i]
      if (m.role !== "assistant") continue
      const meta = m.metadata as ToolCallsMeta | undefined
      if (meta?.kind === "tool_calls" && Array.isArray(meta.toolCalls)) {
        for (let j = meta.toolCalls.length - 1; j >= 0; j--) {
          if (meta.toolCalls[j].tool !== PRACTICE_TOOL_NAME) continue
          const items = (meta.toolCalls[j].output as { items?: Array<{ id?: unknown; stem?: unknown; answer?: unknown }> } | undefined)?.items
          if (Array.isArray(items)) {
            pending = items
              .filter((it) => typeof it?.id === "string" && it.id)
              .map((it) => ({
                id: it.id as string,
                stem: String(it.stem ?? "").replace(/\s+/g, " ").slice(0, 80),
                answer: String(it.answer ?? "").replace(/\s+/g, " ").slice(0, 120),
              }))
          }
          break
        }
      }
      break
    }
    if (pending?.length) {
      systemParts.push([
        '## 上次题库抽题记录（判分回传用）',
        '按时间顺序,最近一次 assistant 回合从题库抽出了以下题目(用户可能正在作答,或正在补充作答):',
        ...pending.map((it, k) => `${k + 1}. id=${it.id} | 答案=${it.answer} | 题干:${it.stem}`),
        '若用户本轮是在回答这些题目:判分后**必须**用上面的 id 调 record_practice 上报(原样使用,不得编造);若用户还没作答或聊的是别的,忽略本段即可。',
      ].join('\n'))
      console.log(`[chat] practice pending re-injected (${pending.length} items)`)
    }
  }
  // 学习模式能力段:/study 导师对话流。业界验证范式(ChatGPT Study Mode/Khanmigo):
  // 答案守卫+苏格拉底引导做在系统层,配逃生舱防"伪引导";结课小结+学情回灌让错题参与对话。
  if (studyModeOn && !isGameMask) {
    systemParts.push([
      '## 学习模式(导师)',
      '本会话处于学习模式:你是导师,目标是让用户真正学会,而不是替他给出答案。',
      '答案守卫(硬规则):用户问题目时,首次回复禁止直接输出最终答案——先反问定位卡点(如「你卡在哪一步」),给一层不点破计算的提示,再依据用户回应逐步推进。',
      '- 防伪引导:每轮最多一个反问;连续两轮引导用户仍卡住或明显急躁时,主动转为分步讲解(讲思路、留最后一步让用户亲手完成)。',
      '- 逃生舱:用户明确要求「直接给我讲解/给我答案」时立即服从,给完整分步讲解,不再反问;讲完仍补一道同考点变式确认是否真会。',
      '- 讲完一道题后主动给一道同考点变式小练巩固(按试卷块协议 :::choice/:::question + 紧跟 :::answer;有课本时先 search_knowledge 找课本例题改编,防超纲)。',
      '- 从题库抽题练习时严格按题库练题能力段执行:判分后必须 record_practice 上报,答错的题自动进错题本。',
      '- 用户示意结课(如「今天到这」「下课」)时给一句结课小结:本次掌握了什么、哪个考点待复习。',
      '- 开场按下方「当前学情」自然带一句最相关的复习点(如「上次『十字相乘』错了两道,今天先练这个」),不要罗列清单,不要提"系统给我看了你的数据"。',
    ].join('\n'))

    // 学情回灌:今日到期队列 + 近期薄弱点 → system 段(Khanmigo"近期解题史"机制;
    // StudyNote 建卡即 due=now,新卡也计入今日队列,与 /api/study/queue 同口径)
    try {
      const studyNow = new Date()
      const [studyDueCount, studyWeakNotes] = await Promise.all([
        prisma.studyNote.count({
          where: { userId, OR: [{ dueAt: { lte: studyNow } }, { dueAt: null }] },
        }),
        prisma.studyNote.findMany({
          where: { userId, OR: [{ lapses: { gte: 1 } }, { mastery: { lt: 0.3 } }] },
          orderBy: { createdAt: 'desc' },
          take: 6,
          select: { topic: true, title: true, lapses: true, mastery: true },
        }),
      ])
      const weakLines = studyWeakNotes.map(
        (n) => `- ${n.topic || n.title.slice(0, 16)}(遗忘 ${n.lapses} 次,掌握度 ${Math.round(n.mastery * 100)}%)`
      )
      systemParts.push([
        '## 当前学情(仅供开场参考,禁止照单罗列)',
        studyDueCount > 0
          ? `- 今日复习队列:${studyDueCount} 张到期卡,可主动提议先复习再学新内容`
          : '- 今日复习队列已清空',
        ...(weakLines.length ? ['- 近期薄弱考点:', ...weakLines] : []),
      ].join('\n'))
      console.log(`[chat] study mode on (due=${studyDueCount}, weak=${weakLines.length})`)
    } catch (err) {
      console.error('[chat] study context injection failed:', err)
    }
  }
  console.log(`[chat] webSearchEnabled=${webSearchEnabled}, engine=${engine}, searchApiKey=${searchApiKey ? 'loaded' : 'null'}, tools=${searchTool ? 'web_search attached' : 'no tools'}`)

  // Always enable reasoning extraction for models that support it or deepThink is enabled
  const shouldExtractReasoning = deepThink || modelDef.supportsReasoning
  
  if (shouldExtractReasoning) {
    // Add thinking prompt for non-reasoning models
    if (!modelDef.supportsReasoning) {
      systemParts.push(
        [
          'You are a thoughtful AI assistant. You MUST think step by step before giving the final answer.',
          'Format your response EXACTLY as follows:',
          '- Put your ENTIRE reasoning process inside one pair of <think> and </think> tags, with nothing else inside.',
          '- Put your final answer AFTER the closing </think> tag, on its own.',
          '- Do NOT skip the tags, do NOT use any other tag name, and do NOT put reasoning outside the tags.',
          'Example:',
          '<think>First, ... Then, ... Therefore, ...</think>',
          'Final answer here.',
        ].join('\n')
      )
    }

    // Apply reasoning extraction middleware for models that need it (not DeepSeek native)
    // DeepSeek V4 native thinking returns reasoning_content via API (no middleware needed)
    // Third-party providers (Fireworks, Groq, Together, etc.) require extractReasoningMiddleware
    const isDeepSeekNativeReasoning = modelDef.provider === 'deepseek' && modelDef.supportsReasoning
    if (!isDeepSeekNativeReasoning) {
      model = wrapLanguageModel({
        model,
        middleware: extractReasoningMiddleware({ tagName: 'think' }),
      })
    }
  }

  // Ensure a conversation exists
  let convId = conversationId
  let isNewConversation = false

  // A 流式恢复: 单聊(非对比)在生成开始前落一条 streaming 草稿行,
  // 流式期间节流快照已生成文本,刷新/换端后客户端轮询续显,
  // onFinish 定格为最终内容。快照写入经 snapChain 串行化,
  // 保证在途快照先落地、最终落库后执行,避免旧快照覆盖最终内容。
  let draftMessageId: string | null = null
  let snapText = ""
  let snapReasoning = ""
  let lastSnapAt = 0
  let snapStopped = false
  let snapChain: Promise<void> = Promise.resolve()
  // 流是否走到过正常收尾(onFinish / onError)。没走到就被 abort,说明流在半路断了:
  // 那种情况下 onStepFinish/onFinish 一个都不触发,服务端原本一行日志都不打。
  let streamSettled = false
  const scheduleDraftSnapshot = (): void => {
    if (!draftMessageId || snapStopped) return
    snapChain = snapChain
      .then(async () => {
        if (!draftMessageId || snapStopped) return
        try {
          await prisma.message.update({
            where: { id: draftMessageId },
            data: { content: snapText, reasoning: snapReasoning || null },
          })
          lastSnapAt = Date.now()
        } catch {
          // 快照失败不影响流式主流程
        }
      })
      .catch(() => {})
  }
  // 长上下文压缩:后台补一次摘要,只对下一次请求的注入生效,绝不干扰本次流式。
  // 阈值判定放在调用方(用真实 payload 量),这里只负责"执行 + 兜住异常"。
  const scheduleCompressionCheck = (): void => {
    const cid = convId
    if (!cid) return
    maybeCompressContext({
      conversationId: cid,
      modelId,
      model: provider(realModelId),
      userText: userContent,
      contextWindow: modelDef.contextWindow,
      force: true,
    }).catch(() => {
      // 压缩是旁路,失败不影响主流程
    })
  }

  // 传入的 conversationId 不属于当前用户时拒绝复用(不向他人会话写任何数据),
  // 改为新建会话承接本次请求;归属查询抛错时同样视为无归属(fail-closed)。
  if (conversationId && !conversationOwned) {
    console.warn(`[chat] Conversation ${conversationId} not owned by user ${userId}; creating a new conversation instead`)
  }
  if (!convId || !conversationOwned) {
    const conv = await prisma.conversation.create({
      data: {
        userId,
        isEphemeral,
        title: userContent.slice(0, 40) || "新对话",
        model: modelId,
        stylePreset: effectiveStylePreset,
        ...(effectiveMaskId ? { maskId: effectiveMaskId } : {}),
        ...(groupId ? { mode: "compare" } : {}),
      },
    })
    convId = conv.id
    isNewConversation = true
  }

  // 「只重答这条」: 被编辑 user 行的原 createdAt/库 id,用于草稿行时间插槽(见下)
  let editedUserCreatedAt: Date | null = null
  let editedUserId: string | null = null

  // Persist the last user message before streaming
  if (userContent) {
    if (groupId) {
      // 对比模式: N 个泳道并发执行,事务内查重防止同一条用户消息入库多次。
      await prisma.$transaction(async (tx) => {
        const existing = await tx.message.findFirst({
          where: { conversationId: convId, groupId, role: "user" },
          select: { id: true },
        })
        if (!existing) {
          await tx.message.create({
            data: {
              conversationId: convId,
              role: "user",
              content: userContent,
              groupId,
              ...(attachments.length > 0
                ? { attachments: JSON.stringify(attachments) }
                : {}),
            },
          })
        }
      })
    } else {
      // C 分支轻量标记: 编辑产生的新 user 消息带 editedFrom 指向被编辑消息,
      // 供前端"查看历史版本"回看入口使用(仅写入该字段,不透传任意 metadata)
      const editedFrom = (
        lastRawUserMsg?.metadata as { editedFrom?: unknown } | undefined
      )?.editedFrom
      // 「只重答这条」: 就地改写被编辑的 user 行,不再新建 user 行(旧回答与后续消息原样保留)。
      // editedUserCreatedAt(外层声明)供草稿行做时间插槽,把新回答插回该消息与下一条之间。
      if (reanswerEdit) {
        // 主路径: 客户端 PATCH 后回传的真实库 id,直接命中
        const target = reanswerEdit.editedId
          ? await prisma.message.findFirst({
              where: {
                conversationId: convId!,
                archived: false,
                role: "user",
                id: reanswerEdit.editedId,
              },
              select: { id: true, createdAt: true },
            })
          : null
        // 兜底: 无 id 时按新文本匹配(PATCH 已把原行就地改成新文本;取最早一条=被改的原行,
        // 而非冒烟修复前历史残留的重复新行)。oldContent 不再可靠,不参与定位。
        const fallback = target
          ? null
          : await prisma.message.findFirst({
              where: {
                conversationId: convId!,
                archived: false,
                role: "user",
                content: userContent,
              },
              orderBy: { createdAt: "asc" },
              select: { id: true, createdAt: true },
            }).catch(() => null)
        const located = target ?? fallback
        if (located) {
          await prisma.message.update({
            where: { id: located.id },
            data: { content: userContent },
          })
          editedUserCreatedAt = located.createdAt
          editedUserId = located.id
        } else {
          // 定位失败(库内查无此行):退化为普通追加重答,至少不丢本次新文本
          console.warn("[chat] reanswerEdit target not found; falling back to append")
        }
      }
      if (!editedUserCreatedAt) {
        await prisma.message.create({
          data: {
            conversationId: convId,
            role: "user",
            content: userContent,
            ...(attachments.length > 0
              ? { attachments: JSON.stringify(attachments) }
              : {}),
            ...(typeof editedFrom === "string" && editedFrom
              ? { metadata: JSON.stringify({ editedFrom }) }
              : {}),
          },
        })
      }
    }
  }

  // 附件孤儿的兜底清理:用户消息已落库即引用生效,此处顺带清掉
  // "上传了但从未发送"的历史孤儿(1 小时节流,fire-and-forget 不阻塞流)。
  sweepOrphanUploadsThrottled()

  // A 流式恢复: 单聊时生成开始前先落草稿行(失败不阻塞对话)。
  // 放在用户消息落库之后,保证列表时序:用户消息在前,草稿行在后。
  if (!groupId) {
    try {
      // 「只重答这条」: 新回答排在旧回答之后、下一条存活消息之前(旧回答与后续保持原顺序)
      let slotCreatedAt: Date | undefined
      if (editedUserCreatedAt) {
        const prevAnswer = await prisma.message.findFirst({
          where: {
            conversationId: convId!,
            archived: false,
            streaming: false,
            role: "assistant",
            createdAt: { gt: editedUserCreatedAt },
            ...(editedUserId ? { id: { not: editedUserId } } : {}),
          },
          orderBy: { createdAt: "asc" },
          select: { createdAt: true },
        })
        const anchorAt = prevAnswer?.createdAt ?? editedUserCreatedAt
        const nextMsg = await prisma.message.findFirst({
          where: {
            conversationId: convId!,
            archived: false,
            streaming: false,
            createdAt: { gt: anchorAt },
          },
          orderBy: { createdAt: "asc" },
          select: { createdAt: true },
        })
        const upper = nextMsg?.createdAt ?? new Date()
        const mid = Math.floor((anchorAt.getTime() + upper.getTime()) / 2)
        slotCreatedAt = mid > anchorAt.getTime() ? new Date(mid) : new Date()
      }
      const draft = await prisma.message.create({
        data: {
          conversationId: convId!,
          role: "assistant",
          content: "",
          model: modelId,
          streaming: true,
          ...(slotCreatedAt ? { createdAt: slotCreatedAt } : {}),
        },
      })
      draftMessageId = draft.id
    } catch (err) {
      console.error("[chat] Failed to create streaming draft message:", err)
    }
  }

  // AI SDK v7 forbids system messages inside the `messages` array.
  // Filter them out here; the compression summary (if any) is prepended to
  // systemParts and received by the model via the `system` param instead.
  // Branch-summary system messages are mirrored into systemParts first so the
  // LLM actually sees the upstream context, then dropped from the messages
  // array (the frontend never renders them — see MessageBubble's branch_summary
  // early return; the copy lives in the DB only as the model's upstream).
  let branchSummaryInjected = 0
  const llmMessages = messages.filter((m) => {
    if (m.role !== "system") return true
    const meta = (m as { metadata?: unknown }).metadata
    if (
      meta &&
      typeof meta === "object" &&
      (meta as Record<string, unknown>).kind === "branch_summary" &&
      typeof m.content === "string" &&
      m.content.trim()
    ) {
      // 分支 API 写入的内容已包含 "## 来自上文的上下文摘要(系统自动生成)" 头
      // 这里直接 unshift,避免重复标题
      systemParts.unshift(m.content)
      branchSummaryInjected++
      return false
    }
    // 其他 system 消息(用户手写或其他来源):同样不喂给 LLM,避免 SDK 报错
    return false
  })
  if (branchSummaryInjected > 0) {
    console.log(`[chat] injected ${branchSummaryInjected} branch_summary into system prompt`)
  }
  // Mask persona:面具人格放最前(人格层优先于摘要/记忆/风格/能力说明)。
  // 末尾统一追加逃生舱暗语(MASK_ESCAPE_HATCH),内置与自定义面具都适用
  if (effectiveMask) {
    let persona = `${effectiveMask.systemPrompt}\n\n${MASK_ESCAPE_HATCH}`
    // 示范对话以真实 user/assistant 消息注入(见下方 few-shot 拼装),
    // 不声明"是示例"会被模型当成刚发生的历史,新对话开头接着示范内容续聊。
    if (effectiveMask.fewShot.length > 0) {
      persona +=
        '\n\n消息开头若有几轮标注为示范的对话,那只是你的风格示例,不是你和用户已发生的真实历史。' +
        '不要延续或提及示范里的话题,收到用户新消息时按你的人设从头回应。'
    }
    systemParts.unshift(persona)
    console.log(`[chat] Mask persona injected: ${effectiveMask.ref}`)
  }

  // systemParts 可能被上面 unshift 过,重新 join
  const finalSystem = systemParts.length > 0 ? systemParts.join('\n\n') : undefined

  // Mask few-shot:预设对话示例插在真实消息之前。
  // 拼装发生在上下文压缩之后,不会被压缩统一吞掉。
  const maskFewShotMessages: ModelMessage[] = (effectiveMask?.fewShot ?? []).map((turn) => ({
    role: turn.role,
    content: turn.content,
  }))

  // Stream the response
  const outboundMessages: ModelMessage[] =
    maskFewShotMessages.length > 0 ? [...maskFewShotMessages, ...llmMessages] : llmMessages

  // 长上下文压缩的判定改在这里:量"这次真要发出去的对话历史",不再按本轮字数外推。
  // 旧估法(本轮字数 × 轮数)在短句重试时几乎恒为 0,大窗口档位按比例算出的阈值又高到
  // 永不触发,于是超长对话永远不自愈 —— 正是线上"思考途中整条流被断"的温床。
  // 超阈值只后台补一次摘要(让下一次请求变小),本次请求的 payload 不动;对比模式不触发。
  if (!groupId && convId && shouldCompress(outboundMessages, modelDef.contextWindow)) {
    console.log(
      `[chat] history over compress threshold: conv=${convId} window=${modelDef.contextWindow}`
    )
    scheduleCompressionCheck()
  }

  const result = streamText({
    model,
    messages: outboundMessages,
    ...(finalSystem ? { system: finalSystem } : {}),
    // DeepSeek V4.1 起“思考”由请求参数控制(默认 enabled):deepThink 开 → enabled,
    // 关 → disabled,保证日常快答不被强制思考。reasoning_content 仍走原生解析,
    // 不经过 <think> middleware(见上面的 isDeepSeekNativeReasoning 分支)。
    // 其他 provider 不读 deepseek 命名空间,该选项对它们无副作用。
    ...(modelDef.provider === "deepseek"
      ? {
          providerOptions: {
            deepseek: {
              thinking: { type: deepThink ? "enabled" : "disabled" },
              ...(deepThink ? { reasoningEffort: "high" } : {}),
            },
          },
        }
      : {}),
    // qianwen 思考联动:qwen3.8 系列默认开思考,由 provider 的自定义 fetch 把
    // reasoning_effort 翻译成 enable_thinking(见 providers/qianwen.ts)。
    // deepThink 关 → 不带参数(fetch 层强制 enable_thinking: false);
    // deepThink 开 → 传档位开启思考。
    ...(modelDef.provider === "qianwen" && modelDef.supportsReasoning && deepThink
      ? { providerOptions: { openai: { reasoningEffort: "medium" } } }
      : {}),
    // 自定义模型思考联动:DashScope 兼容端点的 fetch 层把 reasoning_effort
    // 翻译成 enable_thinking(见 openai-reasoning-adapter.ts);勾了推理的模型
    // 在其他端点也传档位(OpenAI 兼容网关普遍接受/忽略该参数)。
    // deepThink 关 → 不传,DashScope fetch 层强制关闭思考,快答不受影响。
    ...(modelDef.provider === "custom" &&
    deepThink &&
    (cmSupportsReasoning || /dashscope\.aliyuncs\.com/i.test(cmBaseURL))
      ? { providerOptions: { openai: { reasoningEffort: "medium" } } }
      : {}),
    ...((searchTool || urlReaderTool || clarifyTool || settingsTool || providerModelTool || customModelTool || deleteCustomModelTool || memoryTool || maskGeneratorTool || knowledgeTool || practiceTool || todoTool || writeDocTool || writeCodeTool || tripTool || localFileTool || mcpToolCount > 0)
      ? {
          tools: {
            ...(searchTool ? { web_search: searchTool } : {}),
            ...(mcpToolCount > 0 && mcp ? mcp.tools : {}),
            ...(urlReaderTool ? { [URL_READER_TOOL_NAME]: urlReaderTool } : {}),
            ...(knowledgeTool ? { [KNOWLEDGE_TOOL_NAME]: knowledgeTool } : {}),
            ...(practiceTool ? { [PRACTICE_TOOL_NAME]: practiceTool } : {}),
            ...(recordPracticeTool ? { [RECORD_TOOL_NAME]: recordPracticeTool } : {}),
            ...(clarifyTool ? { [CLARIFY_TOOL_NAME]: clarifyTool } : {}),
            ...(settingsTool ? { [SETTINGS_TOOL_NAME]: settingsTool } : {}),
            ...(providerModelTool ? { [PROVIDER_MODEL_TOOL_NAME]: providerModelTool } : {}),
            ...(customModelTool ? { [ADD_CUSTOM_MODEL_TOOL_NAME]: customModelTool } : {}),
            ...(deleteCustomModelTool
              ? { [DELETE_CUSTOM_MODEL_TOOL_NAME]: deleteCustomModelTool }
              : {}),
            ...(memoryTool ? { [MEMORY_TOOL_NAME]: memoryTool } : {}),
            ...(maskGeneratorTool ? { [MASK_TOOL_NAME]: maskGeneratorTool } : {}),
            ...(todoTool ? { [TODO_TOOL_NAME]: todoTool } : {}),
            ...(writeDocTool ? { [WRITE_DOC_TOOL_NAME]: writeDocTool } : {}),
            ...(writeCodeTool ? { [WRITE_CODE_TOOL_NAME]: writeCodeTool() } : {}),
            ...(tripTool ? { [TRIP_TOOL_NAME]: tripTool } : {}),
            ...(localFileTool ? { [LOCAL_FILE_TOOL_NAME]: localFileTool } : {}),
            ...(codeEditTool ? { [CODE_EDIT_TOOL_NAME]: codeEditTool } : {}),
            ...(previewCheckTool ? { [PREVIEW_CHECK_TOOL_NAME]: previewCheckTool } : {}),
          },
        }
      : {}),
    // 课本类面具首步强制检索——凡绑定 subject 的学科面具(政治/历史/数学/英语)一律命中。
    // 小模型在长 system prompt 下会凭已知答案跳过 search_knowledge,纯指令约束不完全可靠
    // (思考模式下尤其如此:推理里两次想到课本又放下,最终凭记忆作答);第 0 步定向
    // toolChoice 保证必检索,后续步骤恢复自由。
    // deepThink 分支:思考开启的请求里强制 tool_choice 会被上游 400(DeepSeek/DashScope
    // 实测,错误不以 APICallError 透出,前端只见兜底文案)。改用 per-step providerOptions
    // 把第 0 步临时切成非思考请求再强制检索,第 1 步起恢复 call 级思考配置——AI SDK
    // prepareStep 的 providerOptions 与 call 级做逐层深合并(mergeObjects),step 同名值
    // 覆盖 call 值。千问系以 reasoningEffort:"none" 关思考:DashScope fetch 层
    // (openai-reasoning-adapter)遇 "none" 强制 enable_thinking:false,与 deepThink 关的
    // 已验证请求形态完全一致;DeepSeek 系覆写 thinking.type 为 disabled(call 级的
    // reasoningEffort 会被深合并保留,待实测上游是否接受"thinking disabled + effort"组合,
    // 若 400 则把 effort 挪到第 1 步起的 per-step 注入)。自定义/中转站模型思考开关不受控,
    // 维持原 auto 行为(靠能力段软规则),避免 400。
    ...(knowledgeTool && effectiveMask?.subject
      ? {
          prepareStep: ({ stepNumber }: { stepNumber: number }) => {
            if (stepNumber !== 0) return undefined
            // 关思考覆盖只对思考参数受控的内置供应商构造;显式标注目标类型——
            // 否则两个三元分支会被 TS 归一化成联合(注入 openai?: undefined 之类),
            // 撞上 SharedV4ProviderOptions 的索引签名(JSONObject 拒绝 undefined)。
            // 千问经 DashScope fetch 层转 enable_thinking:false,与 deepThink 关的
            // 已验证请求形态一致。
            const thinkingOff: SharedV4ProviderOptions | undefined =
              modelDef.provider === "deepseek"
                ? { deepseek: { thinking: { type: "disabled" } } }
                : modelDef.provider === "qianwen"
                  ? { openai: { reasoningEffort: "none" } }
                  : undefined
            // deepThink 开且思考关不掉(自定义/中转站)→ 不强制,维持 auto(避免上游 400)
            if (deepThink && !thinkingOff) return undefined
            // as const 必须保留:无上下文类型的字面量会把 toolName 拓宽成 string,
            // 与 PrepareStepResult 的 ToolChoice 工具名联合类型冲突。
            // 恒定单形状返回:各分支若返回不同键集合的对象,TS 会对返回类型联合做
            // 归一化(给成员注入 openai?: undefined 之类),撞上 SharedV4ProviderOptions
            // 的索引签名(JSONObject)报错;providerOptions 传 undefined 时 AI SDK
            // mergeObjects 跳过该键,等价于不覆盖。
            return {
              toolChoice: { type: 'tool', toolName: KNOWLEDGE_TOOL_NAME },
              providerOptions: thinkingOff,
            } as const
          },
        }
      : {}),
    // 让模型能"思考 → 调工具 → 拿到结果 → 继续生成最终答案",
    // 默认 stepCountIs(1) 会在调完一次工具后立刻停下,无法完成多步链式调用。
    // local_file / code_edit / preview_check 均为无服务端 execute 的客户端工具(文件操作在
    // 用户本地机器 / Diff 审查与预览验证在前端):本步一旦发出任一调用立即停步,等前端
    // 执行回填后经 sendAutomaticallyWhen 续跑;否则多步循环会带着"悬空 tool-call"继续
    // 步进——模型拿不到结果就给出半截正文,前端回填后续跑判据又被正文挡住,流程死停。
    // 步数预算:编码场景(代码面板开/本地文件授权,典型链路"读→改→跑→修→验证")放宽到
    // 10 步,普通对话维持 5 步(ZCode 经验:隔离边界给硬上限,主链路预算从宽)。
    stopWhen: ({ steps }) => {
      const maxSteps =
        body.codePanelOpen === true || body.localFilesEnabled === true ? 10 : 5
      if (steps.length >= maxSteps) return true
      const last = steps[steps.length - 1]
      return !!last?.content?.some(
        (p) =>
          (p as { type?: string; toolName?: string }).type === "tool-call" &&
          [
            LOCAL_FILE_TOOL_NAME,
            CODE_EDIT_TOOL_NAME,
            PREVIEW_CHECK_TOOL_NAME,
            PROJECT_CHECK_TOOL_NAME,
          ].includes((p as { toolName?: string }).toolName as string)
      )
    },
    // A 流式恢复: 累积快照文本并节流(600ms)写库。
    // 注意: onChunk 返回 Promise 会暂停流处理,这里保持同步 + fire-and-forget。
    // AI SDK v7 的 text-delta / reasoning-delta 的文本字段为 `text`。
    onChunk: ({ chunk }) => {
      const c = chunk as { type?: string; text?: unknown }
      if (c.type === "text-delta" && typeof c.text === "string") {
        snapText += c.text
      } else if (c.type === "reasoning-delta" && typeof c.text === "string") {
        snapReasoning += c.text
      }
      if (draftMessageId && Date.now() - lastSnapAt > 600) {
        scheduleDraftSnapshot()
      }
    },
    onStepFinish: ({ stepType, toolCalls, toolResults, finishReason }: { stepType?: string; toolCalls?: unknown[]; toolResults?: unknown[]; finishReason?: string }) => {
      console.log(`[chat] step finished: type=${stepType}, toolCalls=${toolCalls?.length ?? 0}, toolResults=${toolResults?.length ?? 0}, finishReason=${finishReason}`)
      // 收集工具调用与结果(AI SDK v7: call={toolCallId,toolName,input}, result={toolCallId,output})
      const stepResults = Array.isArray(toolResults) ? toolResults : []
      for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
        const c = call as { toolCallId?: string; toolName?: string; input?: unknown }
        const r = stepResults.find((x) => (x as { toolCallId?: string }).toolCallId === c.toolCallId) as
          | { output?: unknown; result?: unknown }
          | undefined
        collectedToolCalls.push({
          tool: c.toolName ?? 'unknown',
          input: c.input ?? null,
          output: r ? (r.output ?? r.result ?? null) : null,
        })
      }
    },
    onFinish: async ({ text, reasoningText, finishReason, usage }) => {
      streamSettled = true
      // MCP 连接收尾:提前到最前,后续任何 early return 都不会泄漏连接。
      if (mcp && mcp.clients.length > 0) {
        await closeMcpClients(mcp.clients)
        mcp = null
      }
      // 诊断日志:记录流异常结果,便于排查偶发"模型没思考"问题
      if (finishReason === 'length' || finishReason === 'error') {
        console.warn(
          `[chat] ABNORMAL_FINISH: reason=${finishReason}, model=${modelId}, hasText=${!!text}, hasReasoning=${!!reasoningText}, textLen=${text?.length ?? 0}, reasoningLen=${reasoningText?.length ?? 0}`
        )
      }

      // 流出错且无任何内容时不落库,避免历史中出现空白助手消息。
      // A 流式恢复: 先等在途快照落地;草稿行已有快照内容则定格保留,
      // 完全为空则删除,不留空白消息或永远 streaming 的残留行。
      if (finishReason === 'error' && !text && !reasoningText) {
        snapStopped = true
        await snapChain
        if (draftMessageId) {
          if (snapText.trim() || snapReasoning.trim()) {
            await prisma.message
              .update({ where: { id: draftMessageId }, data: { streaming: false } })
              .catch(() => {})
          } else {
            await prisma.message.delete({ where: { id: draftMessageId } }).catch(() => {})
          }
        }
        // 断流结算:生成中断时上游成本可能已发生,按快照内容估算入账;
        // 连接没建立就失败时快照为空,settleQuota 对 0 token 自动跳过
        if (usesServerBilledKey) {
          await settleQuota({
            userId,
            modelId,
            fallbackText: snapText + snapReasoning,
            baseLimit: quotaBaseLimit,
          })
        }
        return
      }

      // Ensure content is always a non-null string (Prisma schema requires String, not String?)
      let content = text ?? ""
      let savedReasoning = reasoningText ?? null

      // 截断提示:输出被 token 上限截断时,告知用户可换模型或缩短上下文
      if (finishReason === 'length' && content) {
        content = content + '\n\n（提示：输出已达 token 上限被截断，可考虑换模型或缩短上下文）'
      }

      // 诊断:深度思考模式下,若两者都为空,说明模型真的没输出思考。
      if (deepThink && !content.trim() && !savedReasoning?.trim()) {
        console.warn(`[chat] DEEP_THINK_EMPTY: model=${modelId}, deepThink=true but both text and reasoning are empty`)
      }
      if (deepThink && savedReasoning) {
        console.log(`[chat] DEEP_THINK_OK: model=${modelId}, reasoningLen=${savedReasoning.length}, contentLen=${content.length}`)
      }

      // 兜底:模型把全部内容(含最终答案)都放进了 <think> 标签,导致正文为空。
      // 此时从推理尾部拆出答案部分作为正文,避免用户只看到思考过程而没有任何回答。
      if (!content.trim() && savedReasoning?.trim()) {
        const { head, tail } = splitReasoningTail(savedReasoning)
        content = tail
        savedReasoning = head || null
        if (content) {
          console.log(`[chat] FALLBACK_SPLIT: model=${modelId}, extracted answer from reasoning tail (reasoningLen=${savedReasoning?.length ?? 0}, contentLen=${content.length})`)
        }
      }

      // 检出 [IMG:...] 标记并调用生图(自动根据用户选择的模型分发)
      const imagePrompts = extractImagePrompts(content)
      if (imagePrompts.length > 0) {
        const userRecord = await prisma.user.findUnique({
          where: { id: userId },
          select: { imageModel: true, imageSize: true },
        })
        const modelId = userRecord?.imageModel ?? "builtin:wanx2.1-t2i-turbo"
        const size = userRecord?.imageSize ?? "1024*1024"

        const replacements: string[] = []
        for (const prompt of imagePrompts) {
          try {
            const result = await generateImage(userId, modelId, prompt, size)
            replacements.push(`![${prompt}](${result.url})`)
            // 归档到生图历史库(source=chat),失败不阻塞对话保存。
            prisma.generatedImage
              .create({
                data: {
                  userId,
                  prompt,
                  url: result.url,
                  model: result.model,
                  width: result.width,
                  height: result.height,
                  source: "chat",
                },
              })
              .catch((err) => {
                console.error("[chat] Failed to archive generated image:", err)
              })
          } catch (err) {
            const reason = err instanceof Error ? err.message : "未知原因"
            console.error("[chat] Image generation failed:", reason)
            replacements.push(`> ⚠️ 图片生成失败:${reason.replace(/\s+/g, " ")}`)
          }
        }
        let idx = 0
        content = content.replace(IMG_MARKER_REGEX, () => replacements[idx++])
      }
      // 移除模型输出被截断时残留的未闭合标记(避免原始标记入库)
      content = content.replace(/\[IMG:[^\]]*$/g, "")

      // A 流式恢复: 停止新快照并等在途快照完成,避免旧快照覆盖最终内容。
      snapStopped = true
      await snapChain

      // 公共额度结算:按真实 usage 入账;上游没报数(少数 provider)时按最终
      // 文本估算。重新生成不回补旧流水——上游成本真实发生。
      if (usesServerBilledKey) {
        await settleQuota({
          userId,
          modelId,
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
          fallbackText: (text ?? "") + (reasoningText ?? ""),
          baseLimit: quotaBaseLimit,
        })
      }

      try {
        // 工具调用明细随消息入库(前端历史回显工具卡片);极端大结果(>32KB)放弃入库防膨胀
        let toolCallsMetadata: string | undefined
        if (collectedToolCalls.length > 0) {
          const json = JSON.stringify({ kind: 'tool_calls', version: 1, toolCalls: collectedToolCalls })
          if (json.length <= 32768) toolCallsMetadata = json
          else console.warn(`[chat] toolCalls metadata too large (${json.length}B), skipped`)
        }
        if (groupId) {
          // 对比模式: 重新生成时先删除本泳道同组旧消息,避免重复入库
          await prisma.message.deleteMany({
            where: { conversationId: convId!, groupId, role: "assistant", model: modelId },
          })
        }
        // Persist assistant response (with reasoning + token usage if available)
        // A 流式恢复: 单聊时更新草稿行为最终内容并置 streaming=false;
        // 草稿行已不存在(被清理/超时 finalize)时兜底重新插入,不丢消息。
        // 对比模式无草稿行(draftMessageId 恒为 null),保持原 create 行为。
        const persistData = {
          conversationId: convId!,
          role: "assistant" as const,
          content,
          reasoning: savedReasoning,
          model: modelId,
          // token 消耗统计(某些提供商可能不返回 usage)
          promptTokens: usage?.inputTokens,
          completionTokens: usage?.outputTokens,
          ...(toolCallsMetadata ? { metadata: toolCallsMetadata } : {}),
          ...(groupId ? { groupId } : {}),
          streaming: false,
        }
        if (draftMessageId) {
          try {
            await prisma.message.update({ where: { id: draftMessageId }, data: persistData })
          } catch {
            await prisma.message.create({ data: persistData })
          }
        } else {
          await prisma.message.create({ data: persistData })
        }
        // Update conversation: timestamp + auto-generate title on first message
        const titleUpdate = isNewConversation
          ? { title: userContent.slice(0, 30) || "新对话" }
          : {}
        await prisma.conversation.update({
          where: { id: convId! },
          data: { updatedAt: new Date(), ...titleUpdate },
        })
        // 新会话: 异步让 AI 生成更精准的标题(不阻塞 onFinish)
        if (isNewConversation && userContent) {
          const convIdCapture = convId!
          generateConversationTitle(userContent, baseModel).then(async (aiTitle) => {
            try {
              await prisma.conversation.update({
                where: { id: convIdCapture },
                data: { title: aiTitle },
              })
            } catch (err) {
              console.error('[chat] Failed to update AI-generated title:', err)
            }
          })
        }
        // Extract long-term memories in the background (never blocks the chat)
        // 临时模式永不提取:借号者的聊天不得污染长期记忆;游戏回合同样不提取(沉浸叙事非用户事实)
        if (memoryEnabled && !isEphemeral && !isGameMask && content) {
          extractAndSaveMemories({
            userId,
            model: provider(realModelId),
            userText: userContent,
            assistantText: content,
          })
        }

        // 长上下文压缩的判定已前移到请求组装处(用真实 payload 量),这里不再触发。
      } catch (error) {
        // AI SDK's notify() silently swallows errors from onFinish callbacks,
        // so we must catch and log them ourselves to avoid silent data loss.
        console.error("[chat] Failed to persist assistant message:", error)
      }
    },
  })

  const responseHeaders: Record<string, string> = { "X-Conversation-Id": convId }
  if (isNewConversation) {
    const title = userContent.slice(0, 30) || "新对话"
    responseHeaders["X-Conversation-Title"] = encodeURIComponent(title)
  }

  // 半路断流取证:abort 时 streamSettled 仍为 false,说明 onFinish/onError 都没走到,
  // 流是在生成途中断的 —— 这条路径原本零日志、零收尾。打出已生成量与草稿 id,
  // 并把草稿行定格,不再留 streaming=true 的僵尸行(那会让流式恢复轮询盯住一条不会再动的消息)。
  req.signal.addEventListener("abort", () => {
    if (streamSettled) return
    const draftId = draftMessageId
    console.warn(
      `[chat] STREAM_DIED_MIDWAY: conv=${convId ?? "-"} draft=${draftId ?? "-"} textLen=${snapText.length} reasoningLen=${snapReasoning.length}`
    )
    monitor("chat_stream_aborted", {
      stage: "midway",
      textLen: snapText.length,
      reasoningLen: snapReasoning.length,
      hasDraft: Boolean(draftId),
    })
    if (!draftId) return
    snapStopped = true
    snapChain
      .then(() => prisma.message.update({ where: { id: draftId }, data: { streaming: false } }))
      .catch(() => {})
  })

  // 手动构建 UI 消息流：过滤掉 [IMG:...] 标记再发给客户端
  const uiStream = toUIMessageStream({
    stream: result.stream,
    sendReasoning: true,
    sendStart: true,
    sendFinish: true,
    // 默认只给客户端 "An error occurred.",这里把上游真实错误转成可读消息。
    onError: (error) => {
      streamSettled = true
      console.error('[chat] Stream error:', error)
      // instanceof 只认顶层 @ai-sdk/provider-utils 的类,而 @ai-sdk/deepseek 自带一份
      // 不同版本的同名类(5.0.30 vs 5.0.29) → DeepSeek 上游错误恒不匹配,全塌成兜底文案。
      // 按 name + statusCode 形状识别,覆盖多副本场景。
      const isApiCall =
        error instanceof APICallError || (error as Error)?.name === 'AI_APICallError'
      const status = isApiCall
        ? ((error as { statusCode?: number })?.statusCode ?? undefined)
        : undefined
      const info = classifyUpstreamError(error, { status })
      monitor("chat_upstream_error", { code: info.code, status: status ?? null, stage: "stream" })
      return encodeUpstreamError(info)
    },
  })

  return createUIMessageStreamResponse({
    headers: responseHeaders,
    stream: uiStream.pipeThrough(createImgMarkerFilterStream()),
  })
  } catch (error) {
    console.error("[chat] Error processing chat request:", error)
    const info = classifyUpstreamError(error, { code: "server_error" })
    monitor("chat_upstream_error", {
      code: "server_error",
      stage: "route_catch",
      raw: info.raw.slice(0, 300),
    })
    return new Response(
      JSON.stringify({ error: encodeUpstreamError(info) }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" }
      }
    )
  }
}
