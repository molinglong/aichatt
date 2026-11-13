import { createOpenAI } from "@ai-sdk/openai"
import { ProviderDefinition } from "../types"
import { wrapOpenAIReasoningResponse } from "../openai-reasoning-adapter"

// 规格依据火山方舟官方模型列表(2026-09 核实)。
// 方舟 model id 带日期后缀,且每月新增快照;下表为 2026-09 时点值。
// doubao-pro / doubao-lite 一代已不在在售清单,已删除并登记别名。

/**
 * 方舟思考受控模型(deepseek-* 与 doubao-seed 系)思考开关适配,契约与 qianwen/DashScope
 * 一致:
 * - 请求体带 reasoning_effort(非 none)= 开思考:注入 thinking enabled 并保留档位
 *   (2026-11-10 实测 Ark 对两族模型均接受 thinking+reasoning_effort 同传);
 * - 不带或 none = 注入 thinking disabled(两族默认开思考,快答必须显式关,
 *   否则公共池快答白白烧思考 token);
 * - thinking enabled 的请求里,历史 assistant 工具调用轮补中性 reasoning_content 占位
 *   (与 providers/deepseek.ts 同因:上游要求思考模式回传 reasoning_content)。
 * 不匹配的模型(如有)请求体零改动。
 */
function arkRequestAdapt(init: RequestInit | undefined): RequestInit | undefined {
  if (!init || typeof init.body !== "string" || !init.body.startsWith("{")) return init
  try {
    const parsed = JSON.parse(init.body) as {
      model?: string
      reasoning_effort?: unknown
      thinking?: { type?: string }
      messages?: Array<{ role?: string; reasoning_content?: unknown; tool_calls?: unknown }>
    }
    if (typeof parsed.model !== "string" || !/^(deepseek|doubao-seed)/.test(parsed.model)) return init
    const effort = parsed.reasoning_effort
    delete parsed.reasoning_effort
    const enabled = typeof effort === "string" && effort !== "none"
    parsed.thinking = { type: enabled ? "enabled" : "disabled" }
    if (enabled) {
      parsed.reasoning_effort = effort
      if (Array.isArray(parsed.messages)) {
        for (const msg of parsed.messages) {
          if (
            msg.role === "assistant" &&
            msg.tool_calls != null &&
            typeof msg.reasoning_content !== "string"
          ) {
            msg.reasoning_content = "（此步为定向工具调用，未开启思考。）"
          }
        }
      }
    }
    return { ...init, body: JSON.stringify(parsed) }
  } catch {
    return init
  }
}

export const doubaoProvider: ProviderDefinition = {
  id: "doubao",
  name: "字节豆包",
  models: [
    // ── 主力 ─────────────────────────────────────────────
    { id: "doubao-seed-2-1-pro-260915", name: "Doubao Seed 2.1 Pro", provider: "doubao", contextWindow: 1024000, supportsVision: true, supportsFiles: false, supportsReasoning: true },
    { id: "doubao-seed-2-1-lite-260915", name: "Doubao Seed 2.1 Lite", provider: "doubao", contextWindow: 256000, supportsVision: true, supportsFiles: false, supportsReasoning: true },
    { id: "doubao-seed-evolving", name: "Doubao Seed Evolving", provider: "doubao", contextWindow: 1024000, supportsVision: true, supportsFiles: false, supportsReasoning: true },
    // ── 公共池锚点(upstreamOnly 不进用户模型列表与设置页内置管理)──
    // 方舟 DeepSeek-V4.1-Flash economy 档:128K/多模态/深度思考,
    // 2026-11-10 官方文档+实测(thinking 开关、reasoning_effort、1x1 PNG 视觉)三确认。
    { id: "deepseek-v4-1-flash-economy-261017", name: "DeepSeek V4.1 Flash Economy (方舟)", provider: "doubao", contextWindow: 128000, supportsVision: true, supportsFiles: false, supportsReasoning: true, upstreamOnly: true },
    // ── 旧版(默认折叠)────────────────────────────────────
    { id: "doubao-seed-2-1-turbo-260628", name: "Doubao Seed 2.1 Turbo", provider: "doubao", contextWindow: 256000, supportsVision: true, supportsFiles: false, supportsReasoning: true, tier: "legacy" },
    { id: "doubao-seed-2-1-pro-260628", name: "Doubao Seed 2.1 Pro (0628)", provider: "doubao", contextWindow: 256000, supportsVision: true, supportsFiles: false, supportsReasoning: true, tier: "legacy" },
  ],
  createProvider: (apiKey: string) => {
    const openai = createOpenAI({
      apiKey,
      baseURL: "https://ark.cn-beijing.volces.com/api/v3",
      // 请求侧:方舟 DeepSeek 思考开关;响应侧:reasoning_content → <think> 文本
      // 交给 chat 路由 extractReasoningMiddleware 统一抽取(@ai-sdk/openai 不解析该字段)。
      fetch: async (input, init) => {
        const res = await fetch(input, arkRequestAdapt(init))
        if (!res.ok || !res.body) return res
        return wrapOpenAIReasoningResponse(res)
      },
    })
    // 统一走 Chat Completions 端点(与 qianwen 同款):SDK 默认 responses 协议下
    // 方舟的思考参数/思维链行为未验证,思考开关适配按 chat 形状实现并实测
    // (2026-11-10:thinking 开关、reasoning_effort 同传、reasoning_content 回传均过)。
    return (modelId: string) => openai.chat(modelId)
  },
}
