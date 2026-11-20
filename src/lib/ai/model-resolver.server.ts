/**
 * 模型/Key 解析(server-only):
 * 从 chat/route.ts 的内联解析段(原 628-870)抽出的可复用版本,语义与 chat 管线一致——
 * 自定义模型(custom: 前缀)、内置有效模型(含公共池门面/上游映射)、Key 解析链
 * (公共池服务端 Key > DashScope env > DeepSeek env[仅计费名单] > 用户自带 Key),
 * 以及服务端计费标记与公共额度闸。学习模式等新管线直接用,不再各自复制一份。
 *
 * 失败时返回 ok:false + 已装配好的 NextResponse(错误体走 error-catalog envelope,
 * 与 chat 管线同款中文提示),调用方原样返回即可。
 */
import { NextResponse } from "next/server"
import { prisma } from "@/lib/db"
import { decrypt } from "@/lib/crypto"
import { classifyUpstreamError, encodeUpstreamError } from "@/lib/error-catalog"
import {
  getEffectiveModel,
  getCappedPublicPoolModel,
  createProviderInstanceForEffectiveModel,
} from "@/lib/ai/registry"
import type { ModelDefinition } from "@/lib/ai/types"
import type { UpstreamErrorCode } from "@/lib/error-catalog"
import { buildCustomModelDefinition, resolveApiKey, createCustomLanguageModel } from "@/lib/ai/custom-model"
import { getPublicPoolKey, isQuotaBilledModel, checkQuota } from "@/lib/quota"
import { monitor } from "@/lib/monitor"

export interface ResolvedChatModel {
  modelDef: ModelDefinition
  apiKey: string | undefined
  provider: (modelId: string) => ReturnType<typeof createProviderInstanceForEffectiveModel>
  realModelId: string
  /** 本次请求走「服务端兜底 Key」的计费模型:请求前过额度闸,结束后 settleQuota */
  usesServerBilledKey: boolean
  /** 自定义模型的推理开关与 Base URL(deepThink 档位注入用) */
  cmSupportsReasoning: boolean
  cmBaseURL: string
  /** 公共额度闸返回的个人基础额度(结算附加余额扣减用) */
  quotaBaseLimit: number | null
}

export type ResolveModelResult =
  | ({ ok: true } & ResolvedChatModel)
  | { ok: false; response: NextResponse }

function errResponse(err: unknown, status: number, code: UpstreamErrorCode, fallbackDetail?: string): NextResponse {
  return NextResponse.json(
    { error: encodeUpstreamError(classifyUpstreamError(err, { code, status, fallbackDetail })) },
    { status, headers: { "Content-Type": "application/json" } }
  )
}

export interface ResolveChatModelOpts {
  userId: string
  modelId: string
  /** 临时会话不过个人额度闸 */
  isEphemeral?: boolean
  /** 日志前缀(区分调用方,如 [study]) */
  logTag?: string
}

/** 解析模型 + Key + provider,并执行公共额度闸。失败返回 ok:false + 可直接返回的响应 */
export async function resolveChatModel(opts: ResolveChatModelOpts): Promise<ResolveModelResult> {
  const { userId, modelId, isEphemeral = false, logTag = "[chat]" } = opts
  let modelDef: ModelDefinition
  let apiKey: string | undefined
  let usesServerBilledKey = false
  let provider: (modelId: string) => ReturnType<typeof createProviderInstanceForEffectiveModel>
  let realModelId = modelId
  let cmSupportsReasoning = false
  let cmBaseURL = ""

  if (modelId.startsWith("custom:")) {
    const cmId = modelId.slice(7)
    const cmRecord = await prisma.customModel.findFirst({ where: { id: cmId, userId } })
    if (!cmRecord) {
      console.error(`${logTag} Unknown custom model: ${modelId} for user ${userId}`)
      monitor("chat_upstream_error", { code: "model_not_found", stage: "precheck" })
      return { ok: false, response: errResponse(new Error(`自定义模型记录不存在: ${modelId}`), 400, "model_not_found") }
    }
    modelDef = buildCustomModelDefinition(cmRecord)
    realModelId = cmRecord.modelId
    cmSupportsReasoning = cmRecord.supportsReasoning
    cmBaseURL = cmRecord.baseURL || ""
    apiKey = await resolveApiKey(userId, cmRecord)
    provider = () => createCustomLanguageModel(cmRecord, apiKey)
  } else {
    const builtinModelDef = await getEffectiveModel(userId, modelId)
    if (!builtinModelDef) {
      const capped = await getCappedPublicPoolModel(modelId).catch(() => null)
      if (capped) {
        console.warn(`${logTag} MODEL_CAPPED: model=${modelId}, user=${userId}`)
        monitor("chat_quota_denied", { reason: "model_capped", provider: modelId })
        return {
          ok: false,
          response: errResponse(new Error(`「${capped.name}」的公共额度已用完`), 429, "quota_exhausted", "该模型的公共额度预算已用完，请换个模型"),
        }
      }
      console.error(`${logTag} Unknown model: ${modelId}`)
      monitor("chat_upstream_error", { code: "model_not_found", stage: "precheck" })
      return { ok: false, response: errResponse(new Error(`模型 ${modelId} 不在可用列表中`), 400, "model_not_found") }
    }
    modelDef = builtinModelDef
    if (modelDef.upstreamId) realModelId = modelDef.upstreamId

    const apiKeyRecord = await prisma.apiKey.findUnique({
      where: { userId_provider: { userId, provider: modelDef.provider } },
    })

    if (modelDef.publicPool) {
      apiKey = (await getPublicPoolKey(modelDef.provider)) ?? undefined
      if (!apiKey) {
        console.error(`${logTag} No public pool key configured for provider ${modelDef.provider} (user ${userId})`)
        monitor("chat_upstream_error", { code: "config_missing", stage: "precheck", provider: modelDef.provider })
        return { ok: false, response: errResponse(new Error(`公共池未配置 ${modelDef.provider} 的服务端 Key`), 400, "config_missing") }
      }
      usesServerBilledKey = true
    } else if (!apiKeyRecord && modelDef.provider === "qianwen") {
      apiKey = process.env.API_KEY_DASHSCOPE
      if (!apiKey) {
        console.error(`${logTag} No DashScope API key configured for user ${userId}`)
        monitor("chat_upstream_error", { code: "config_missing", stage: "precheck", provider: "qianwen" })
        return { ok: false, response: errResponse(new Error("服务端环境变量 API_KEY_DASHSCOPE 未配置"), 400, "config_missing") }
      }
    } else if (!apiKeyRecord && modelDef.provider === "deepseek" && isQuotaBilledModel(modelDef.id)) {
      apiKey = process.env.API_KEY_DEEPSEEK
      if (!apiKey) {
        console.error(`${logTag} No DeepSeek API key configured for user ${userId}`)
        monitor("chat_upstream_error", { code: "config_missing", stage: "precheck", provider: "deepseek" })
        return { ok: false, response: errResponse(new Error("服务端环境变量 API_KEY_DEEPSEEK 未配置"), 400, "config_missing") }
      }
      usesServerBilledKey = true
    } else if (!apiKeyRecord) {
      console.error(`${logTag} No API key configured for ${modelDef.provider} for user ${userId}`)
      monitor("chat_upstream_error", { code: "config_missing", stage: "precheck", provider: modelDef.provider })
      return { ok: false, response: errResponse(new Error(`未配置 ${modelDef.provider} 的 API Key`), 400, "config_missing") }
    } else {
      try {
        apiKey = decrypt(apiKeyRecord.encryptedKey)
      } catch (err) {
        console.error(`${logTag} Failed to decrypt API key for user ${userId}:`, err)
        monitor("chat_upstream_error", { code: "config_missing", stage: "decrypt" })
        return { ok: false, response: errResponse(err, 500, "config_missing", "已保存的 Key 解密失败，请在设置里重新填写一次") }
      }
    }

    try {
      provider = createProviderInstanceForEffectiveModel(modelDef, apiKey)
    } catch (err) {
      console.error(`${logTag} Failed to create provider instance for ${modelId}:`, err)
      monitor("chat_upstream_error", { code: "server_error", stage: "provider_init" })
      return { ok: false, response: errResponse(err, 500, "server_error", `无法初始化 ${modelDef.provider} 的调用客户端`) }
    }
  }

  if (usesServerBilledKey) {
    const check = await checkQuota(userId, isEphemeral, { modelId: modelDef.id })
    if (!check.ok) {
      console.warn(`${logTag} QUOTA_DENIED: reason=${check.reason}, user=${userId}, model=${modelId}`)
      monitor("chat_quota_denied", { reason: check.reason, provider: "deepseek" })
      return {
        ok: false,
        response: errResponse(
          new Error("公共额度已用完"),
          429,
          "quota_exhausted",
          check.reason === "pool_exhausted"
            ? "全站公共池已耗尽，等待每日自动补货"
            : "你今日的个人额度已用完，北京时间 0 点自动恢复"
        ),
      }
    }
    return { ok: true, modelDef, apiKey, provider, realModelId, usesServerBilledKey, cmSupportsReasoning, cmBaseURL, quotaBaseLimit: check.baseLimit ?? null }
  }

  return { ok: true, modelDef, apiKey, provider, realModelId, usesServerBilledKey, cmSupportsReasoning, cmBaseURL, quotaBaseLimit: null }
}
