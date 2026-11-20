import { z } from "zod"

/**
 * 短期记忆写入工具（write_scratch_memory）—— 纯常量模块（isomorphic，客户端可安全 import）
 *
 * 与 add_memory / manage_todo 同一协议：纯 DB 数据，服务端 execute 直接写库
 * （见 scratch-tool.server.ts），前端 ToolCallCard 只负责渲染，无执行器参与。
 * ⚠ 本文件禁止 import prisma/ai 等服务端依赖（会连 pg 一起打进客户端 bundle）。
 *
 * 与长期记忆(add_memory)的分工：
 * - 长期记忆 = 完成时态（用户是什么样的人：身份/偏好/习惯），不过期；
 * - 短期记忆 = 进行时态（用户正在做什么：进度/备考/攻坚中），14 天或到期日自动失效。
 * 背单词等有结构化数据的进度不写这里（DB 是事实源，AI 用 study_progress 查），
 * 短期记忆只记查询不到的状态，避免两处数据漂移。
 *
 * 注入条件与 add_memory 同闸门：memoryEnabled && !isEphemeral && !groupId（临时模式
 * 禁写长期数据；对比模式不注入），关闭时注入 SCRATCH_DISABLED_PROMPT 降级提示。
 */

export const SCRATCH_TOOL_NAME = "write_scratch_memory"

export const scratchInputSchema = z.object({
  notes: z
    .array(
      z.object({
        topic: z
          .string()
          .min(1)
          .max(30)
          .describe(
            "短标签，同一主题重复写 = 覆盖更新而非新增，如「背单词」「数学期中考」「物理攻坚」；尽量沿用已有条目的 topic"
          ),
        content: z
          .string()
          .min(1)
          .max(300)
          .describe("当前状态一句话，进度写具体数字（如「高考3500 推进到 List 12 第 40 个」），下次接着聊不用重新问"),
        expiresAt: z
          .string()
          .optional()
          .describe(
            "可选过期时间，ISO 8601（如 2026-11-26T23:59:00+08:00）；有明确到期日（考试日/截止日）时传，日常进度省略（默认 14 天自动失效）"
          ),
      })
    )
    .min(1)
    .max(3)
    .describe("1-3 条进行中状态；更新已有主题时传同 topic"),
})

export type ScratchToolInput = z.infer<typeof scratchInputSchema>

/** 工具 output 形状（ToolCallCard 渲染与类型收窄用） */
export interface ScratchToolOutput {
  ok: boolean
  saved?: Array<{ topic: string; content: string; expiresAt: string; replaced: boolean }>
  rejected?: string[]
  message?: string
}

/** 注入 system prompt 的使用规则段 */
export const SCRATCH_TOOL_PROMPT: string = [
  "## 短期记忆（write_scratch_memory 工具）",
  "- 对话中出现「进行中的状态」——进度推进（\"背到 List 12 了\"\"刷完第三章了\"）、备考安排（\"下周三考数学\"）、正在攻坚的内容（\"最近在补导数\"）——主动调用保存或更新，不要等用户开口说\"记一下\"",
  "- 先看注入的短期记忆里有没有同主题条目：有则同 topic 覆盖更新，不要新建近义词 topic（如「背单词」与「词汇进度」并存）",
  "- 分工边界：身份/偏好这类长期稳定的事实走 add_memory；背单词、错题本等有结构化数据的进度不要写这里——用 study_progress 查询即可，短期记忆只记查询不到的状态（备考意图、口头约定、正在攻坚的章节）",
  "- content 写当前状态的一句话快照；有明确到期日（考试、截止日）传 expiresAt，日常进度省略（默认 14 天自动失效）；一次性信息（验证码、临时数字）与已完成失效的旧状态不存",
  "- 写入成功后用一句话确认（如\"已记下：数学 11 月 26 日考试\"），不要复述全部条目",
].join("\n")

/** 临时模式/记忆关闭降级提示（工具不注入，避免模型虚构已保存） */
export const SCRATCH_DISABLED_PROMPT: string = [
  "## 短期记忆（当前不可用）",
  "短期记忆功能未开启（或处于临时聊天模式），进行中状态无法记录。用户要求\"记一下进度\"时，",
  "请如实告知当前无法保存，可开启记忆功能（或退出临时模式）后再试；不要虚构已记录。",
].join("\n")
