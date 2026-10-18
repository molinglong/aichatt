/**
 * Anthropic Messages 兼容端点(半透明代理)——让外部 agent(如 ACode)以 aichatt 为唯一模型网关。
 *
 * 鉴权:x-api-key → 个人访问令牌(ApiToken 表)解析出 userId,或部署级 env 令牌回退(管理员)。
 * 隔离:模型解析按该用户的 CustomModel 行匹配——每个 aichatt 账号只能走自己配置的模型。
 * 转发:resolveApiKey 解密该行 key,原样转发到 {normalized baseURL}/messages,
 *       响应(含 SSE 流)逐字节透传。
 * 记忆(路线 D,2026-09-30):x-zcode-session-type=main 的请求——
 *       读注入:把该账号长期记忆追加到末条 user 消息尾部(逐请求注入,理由与 cache
 *       安全见 lib/memory/gateway-injection.ts);写提取:从请求内历史取上一完成轮
 *       异步提取回记忆库(见 lib/memory/gateway-extraction.ts)。
 *       读写失败均仅记监控,降级回纯转发。
 * 为什么(仍然)是透明代理而不是协议翻译:ACode 说 anthropic 协议,中转站也说 anthropic 协议,
 * aichatt 只做「key 保险箱 + 地址映射 + 请求侧记忆读写」——工具调用/流式事件零改动全保留,
 * 中转站原始 key 从此只存在 aichatt 一处。
 */
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/db"
import {
  createCustomLanguageModel,
  normalizeCustomBaseURL,
  resolveApiKey,
} from "@/lib/ai/custom-model"
import { gatewayJsonError, resolveGatewayUserId } from "@/lib/api/gateway-auth"
import { extractAndSaveMemories } from "@/lib/memory/extractor"
import { getRelevantMemories } from "@/lib/memory/relevance"
import {
  buildGatewayMemoryBlock,
  findLatestUserText,
  injectMemoryIntoBody,
  type AnthropicMessagesBody,
} from "@/lib/memory/gateway-injection"
import {
  claimExtractionSlot,
  extractionFingerprint,
  findExtractionPair,
} from "@/lib/memory/gateway-extraction"
import { monitor } from "@/lib/monitor"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** 连通性自检(不暴露任何敏感信息;与 401 的区别仅在于不用带 token) */
export async function GET() {
  return Response.json({ ok: true, service: "aichatt-anthropic-proxy" })
}

export async function POST(req: NextRequest) {
  const userId = await resolveGatewayUserId(req)
  if (!userId) {
    return gatewayJsonError(401, "authentication_error", "invalid x-api-key")
  }

  let body: unknown = null
  try {
    body = await req.json()
  } catch {
    return gatewayJsonError(400, "invalid_request_error", "invalid JSON body")
  }
  const model =
    typeof body === "object" && body !== null && "model" in body
      ? (body as { model?: unknown }).model
      : undefined
  if (typeof model !== "string" || !model) {
    return gatewayJsonError(400, "invalid_request_error", "missing model")
  }

  const cm = await prisma.customModel.findFirst({
    where: { modelId: model, protocol: "anthropic", userId },
  })
  if (!cm) {
    return gatewayJsonError(404, "not_found_error", `no anthropic-protocol custom model named "${model}"`)
  }

  const apiKey = await resolveApiKey(cm.userId, cm).catch(() => undefined)
  const base = normalizeCustomBaseURL(cm.baseURL)
  if (!base) {
    return gatewayJsonError(500, "api_error", "custom model has no baseURL")
  }

  // —— 记忆(路线 D):读注入 + 写提取,仅 main 会话请求(用户可见对话) ——
  // 读:逐请求注入是必须的——ACode 每发请求从自己的状态重序列化 messages,注入内容
  //     不进客户端历史,只在用户新发言轮注入会让模型在工具续轮丢失记忆;
  // 写:客户端重发全历史,所以「上一已完成轮」就在当前请求里——取它异步提取回记忆库,
  //     无需解析响应流;会话最后一段回复要等用户下次发言才被补提取(已与用户对齐)。
  // 标题生成/压缩/子代理等 sidecar 会话既不注入也不提取。
  // 任何一步失败只记监控、降级为透明转发,绝不阻断模型流量。
  if (req.headers.get("x-zcode-session-type") === "main") {
    const sessionId = req.headers.get("x-session-id") ?? undefined
    try {
      const settings = await prisma.user.findUnique({
        where: { id: userId },
        select: { memoryEnabled: true },
      })
      if (settings?.memoryEnabled ?? true) {
        const messagesBody = body as AnthropicMessagesBody
        const memories = await prisma.memory.findMany({
          where: { userId, status: "active" },
          orderBy: { updatedAt: "desc" },
        })
        if (memories.length > 0) {
          const userText = findLatestUserText(messagesBody.messages ?? [])
          const relevant = getRelevantMemories(memories, userText)
          const block = buildGatewayMemoryBlock(relevant)
          if (block && injectMemoryIntoBody(messagesBody, block)) {
            monitor("gateway.memory.injected", {
              sessionId,
              total: memories.length,
              injected: relevant.length,
            })
          }
        }

        // 写提取:复用本请求同款模型,fire-and-forget 不阻塞转发与流式响应
        const pair = findExtractionPair(messagesBody)
        if (pair) {
          try {
            const extractionModel = createCustomLanguageModel(cm, apiKey)
            if (claimExtractionSlot(extractionFingerprint(userId, pair))) {
              void extractAndSaveMemories({
                userId,
                model: extractionModel,
                userText: pair.userText,
                assistantText: pair.assistantText,
              }).then((result) => {
                if (result) {
                  monitor("gateway.memory.extracted", {
                    sessionId,
                    created: result.created,
                    replaced: result.replaced,
                  })
                }
              })
            }
          } catch (error) {
            monitor("gateway.memory.extract_failed", {
              sessionId,
              error: error instanceof Error ? error.message : String(error),
            })
          }
        }
      }
    } catch (error) {
      monitor("gateway.memory.inject_failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": apiKey && apiKey.trim() !== "" ? apiKey : "local",
    "anthropic-version": req.headers.get("anthropic-version") ?? "2023-06-01",
  }
  const beta = req.headers.get("anthropic-beta")
  if (beta) headers["anthropic-beta"] = beta

  const upstream = await fetch(`${base}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })

  // 逐字节透传(含 SSE 流);上游错误(401/429/5xx)同样原样转交,客户端按 anthropic 错误格式处理
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
  })
}
