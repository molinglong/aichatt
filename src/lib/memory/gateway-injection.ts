import type { Memory, ScratchNote } from "@/generated/prisma/client"
import { buildMemorySystemPrompt } from "./prompt"
import { buildScratchMemoryPrompt } from "./scratch"

/**
 * ACode 网关记忆注入(读注入)——/api/v1/messages 请求侧的 messages 尾部改写。
 *
 * 设计依据(2026-09-30 用真实 ACode CLI 抓包验证,第零波结论):
 * 1. ACode 每发请求都从自己的会话状态重新序列化 messages,网关注入的内容不会进入
 *    客户端历史——所以必须逐请求注入(工具续轮 tool_result 请求也要),否则模型在
 *    续轮就看不到记忆;
 * 2. 请求的 cache_control 断点恒为 4 个(system 三块 + 最后一条非 system 消息的末块,
 *    Anthropic 上限即 4)。注入块追加在末条 user 消息尾部(带 cc 的块之后)且自身不带
 *    cache_control——缓存前缀零污染,断点数也不可能超限;
 * 3. 末条 user 消息可能是普通文本(用户新发言)或 tool_result(工具续轮);
 *    tool_result 之后追加 text 块符合 Anthropic 顺序要求(tool_result 在前)。
 */

/** 注入块的包裹标签:让模型能区分系统提供的长期记忆与用户原文 */
export const MEMORY_CONTEXT_TAG = "memory-context"

export interface AnthropicContentBlock {
  type?: string
  text?: string
  [key: string]: unknown
}

export interface AnthropicMessage {
  role?: string
  content?: string | AnthropicContentBlock[]
  [key: string]: unknown
}

export interface AnthropicMessagesBody {
  messages?: AnthropicMessage[]
  [key: string]: unknown
}

function isTextBlock(
  block: AnthropicContentBlock
): block is AnthropicContentBlock & { text: string } {
  return block?.type === "text" && typeof block.text === "string"
}

function isToolResultBlock(block: AnthropicContentBlock): boolean {
  return block?.type === "tool_result"
}

/**
 * 取最近一条「真实用户发言」的文本,用于记忆相关性计算。
 * 工具续轮请求的末条 user 消息只含 tool_result——跳过它,向前找用户当轮的原话
 * (最近一条不含 tool_result 且带文本块的 user 消息)。只取该消息的最后一个文本块:
 * ZCode 会把系统提醒放在用户原文之前的文本块里,最后一块才是用户的话。
 */
export function findLatestUserText(messages: readonly AnthropicMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== "user") continue
    const content = message.content
    if (typeof content === "string") return content.trim()
    if (!Array.isArray(content)) continue
    if (content.some(isToolResultBlock)) continue
    const texts = content.filter(isTextBlock)
    const last = texts[texts.length - 1]
    if (last) return last.text
  }
  return ""
}

/** 组装注入块;无记忆时返回 null(调用方跳过注入) */
export function buildGatewayMemoryBlock(
  memories: Pick<Memory, "category" | "content">[]
): string | null {
  if (!memories.length) return null
  return [
    `<${MEMORY_CONTEXT_TAG}>`,
    buildMemorySystemPrompt(memories),
    `</${MEMORY_CONTEXT_TAG}>`,
  ].join("\n")
}

/**
 * 短期记忆(进行中状态)注入块;无条目返回 null。
 * 与长期记忆块同 tag 包裹、同通道追加(逐请求注入,工具续轮也要)——
 * 措辞是中性的(不提 write_scratch_memory),因为网关侧没有本站工具。
 */
export function buildGatewayScratchBlock(
  notes: Pick<ScratchNote, "topic" | "content">[]
): string | null {
  if (!notes.length) return null
  return [
    `<${MEMORY_CONTEXT_TAG}>`,
    buildScratchMemoryPrompt(notes),
    `</${MEMORY_CONTEXT_TAG}>`,
  ].join("\n")
}

/**
 * 把注入块追加到末条 user 消息尾部。返回是否发生改写:
 * - messages 为空或末条不是 user(如 assistant 预填) → 不改;
 * - content 为 blocks 数组 → 直接 push;带 cc 的块保持原位,cc 不上移也不新增;
 * - content 为字符串(少见形态) → 转成两个 text 块,语义等价且无断点语义变化。
 */
export function injectMemoryIntoBody(body: AnthropicMessagesBody, block: string): boolean {
  const messages = body?.messages
  if (!Array.isArray(messages) || messages.length === 0) return false
  const last = messages[messages.length - 1]
  if (!last || last.role !== "user") return false
  const content = last.content
  if (typeof content === "string") {
    last.content = [
      { type: "text", text: content },
      { type: "text", text: block },
    ]
    return true
  }
  if (!Array.isArray(content)) return false
  content.push({ type: "text", text: block })
  return true
}
