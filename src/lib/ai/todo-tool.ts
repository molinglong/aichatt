import { z } from "zod"

/**
 * 待办管理工具（manage_todo）—— 纯常量模块（isomorphic，客户端可安全 import）
 *
 * 与 add_memory 同一协议：纯 DB 数据，服务端 execute 直接写库（见 todo-tool.server.ts），
 * 前端 ToolCallCard 只负责渲染，无执行器参与。
 *
 * ⚠ 本文件禁止 import prisma/ai 等服务端依赖（ToolCallCard 只需要
 * TODO_TOOL_NAME，混入会连 pg 一起打进客户端 bundle 报 fs 错误）。
 *
 * 完整/删除按内容模糊匹配（双向 includes）：AI 无法凭空知道 todo id，
 * 内容匹配让"把补牙那条删了"一句话即可执行；命中多条时返回 candidates
 * 交由模型向用户澄清，绝不擅自选择。
 *
 * 注入条件：!isEphemeral && !groupId（临时模式禁写长期数据；对比模式
 * 与 add_memory 同规则不注入），关闭时注入 TODO_DISABLED_PROMPT 降级提示。
 * 数据与 REST API（/api/todos，供新标签页插件等）共用 Todo 表。
 */

export const TODO_TOOL_NAME = "manage_todo"

export const TODO_OPERATIONS = ["add", "update", "complete", "delete", "list"] as const

export const todoInputSchema = z.object({
  operation: z
    .enum(TODO_OPERATIONS)
    .describe("add=添加待办 update=修改待办 complete=标记完成 delete=删除 list=查看当前待办"),
  items: z
    .array(
      z.object({
        content: z
          .string()
          .min(1)
          .max(100)
          .describe("待办内容，简洁明确可勾验，如「周五 交物理作业」"),
        dueAt: z
          .string()
          .optional()
          .describe(
            "可选截止时间，ISO 8601 格式（如 2026-09-25T23:59:00+08:00）；用户说「周五」指本周五，无明确时间则省略"
          ),
      })
    )
    .max(5)
    .optional()
    .describe("add 必填：1-5 条待办，用户一句话要求记多件事时拆成多条"),
  match: z
    .string()
    .max(60)
    .optional()
    .describe(
      "complete/delete/update 必填：匹配关键词，与待办内容双向包含匹配（如「补牙」可匹配「周六 上午补牙」）"
    ),
  update: z
    .object({
      content: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe("新的待办内容；不改内容则省略"),
      dueAt: z
        .string()
        .optional()
        .describe(
          "新的截止时间，ISO 8601（如 2026-10-27T20:00:00+08:00）；传空字符串表示清除截止时间；不改时间则省略"
        ),
    })
    .optional()
    .describe("update 必填：要改成什么，配合 match 定位待办；只改时间时只传 dueAt"),
})

export type TodoToolInput = z.infer<typeof todoInputSchema>

/** 工具 output 形状（ToolCallCard 渲染与类型收窄用） */
export interface TodoToolOutput {
  ok: boolean
  operation?: string
  added?: Array<{ content: string; dueAt?: string | null }>
  completed?: string[]
  updated?: string[] // update 后的内容（展示用）
  deleted?: string[]
  todos?: Array<{ id: string; content: string; done: boolean; dueAt: string | null }>
  candidates?: string[] // match 命中多条时的候选项（ambiguous）
  reason?: "not_found" | "ambiguous" | "invalid_input"
  message?: string
}

/** 注入 system prompt 的使用规则段 */
export const TODO_TOOL_PROMPT: string = [
  "## 待办管理（manage_todo 工具）",
  "- 用户提到记待办/提醒/安排事项（\"提醒我\"\"帮我记着\"\"加个待办\"）时调用 add 立即创建，不要只口头答应",
  "- \"做完了/完成了/勾掉\"→ complete；\"删掉/不用了/取消\"→ delete；\"看看待办/有什么安排\"→ list",
  "- 改内容或改时间（\"改成八点\"\"换成周六\"\"把那条改成买咖啡\"）→ update，match 定位 + 只传要改的字段；**禁止用 delete+add 代替修改**（多花一步预算，还会在两步之间留下空档导致待办丢失）",
  "- complete/delete/update 用 match 关键词与待办内容模糊匹配；返回 ambiguous 时列出候选项请用户确认，绝不擅自选择",
  "- 时间解析：以 system 里的「当前时间」为基准（\"周五\"→ 本周五 23:59，\"明天上午\"→ 明日 12:00），转 ISO 8601 传 dueAt；解析不出就省略该字段",
  "- 执行成功后用一句话确认结果（如\"已添加待办：周五 交物理作业\"），不要复述整个列表",
].join("\n")

/** 临时模式降级提示（工具不注入，避免模型虚构已操作） */
export const TODO_DISABLED_PROMPT: string = [
  "## 待办功能（临时模式不可用）",
  "当前处于临时聊天模式，待办等长期数据不可修改。用户要求管理待办时，",
  "请如实告知临时模式下无法操作，可退出临时模式后再试；不要虚构已添加或已完成。",
].join("\n")
