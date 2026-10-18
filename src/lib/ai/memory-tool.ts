import { z } from "zod"

/**
 * 显式记忆添加工具（add_memory）—— 纯常量模块（isomorphic，客户端可安全 import）
 *
 * 与 update_settings 的执行位置对照：记忆是纯 DB 数据，服务端 execute 直接写库
 * （chat route 已持有 session userId），前端只负责 ToolCallCard 渲染，无执行器参与。
 *
 * ⚠ 本文件禁止 import prisma/ai 等服务端依赖（ToolCallCard 只需要
 * MEMORY_TOOL_NAME，混入会连 pg 一起打进客户端 bundle 报 fs 错误）；
 * 工具工厂在 memory-tool.server.ts。
 *
 * 写入规范与手动添加（POST /api/memories 单条模式）保持一致：
 * - content trim 后 4-200 字
 * - 与已有记忆互相包含视为重复（跳过，不报错，让模型告知用户）
 * - source: "manual"（记忆面板置顶显示）
 *
 * 注入条件：memoryEnabled && !groupId（与 onFinish 的自动记忆提取一致：
 * 记忆功能关闭时不注入工具，改注入 MEMORY_DISABLED_PROMPT 降级提示）。
 * 与自动提取的分工：自动提取靠模型自行判断"值得记"；本工具响应显式指令
 * （"帮我记住/添加一条记忆"），优先级与确定性更高。
 */

export const MEMORY_TOOL_NAME = "add_memory"

/** AI 可选的分类（user_info 等需明确判断才传；manual/general 留给手动添加） */
const MEMORY_CATEGORIES = ["user_info", "preference", "habit", "project", "skill", "other"] as const

export const memoryInputSchema = z.object({
  memories: z
    .array(
      z.object({
        content: z
          .string()
          .min(4)
          .max(200)
          .describe(
            "记忆内容，精炼成不依赖本轮对话也能读懂的第三人称陈述句（如\"用户偏好深色主题\"），4-200 字"
          ),
        category: z
          .enum(MEMORY_CATEGORIES)
          .optional()
          .describe("分类：user_info=个人信息 preference=偏好 habit=习惯 project=项目 skill=技能 other=其他"),
      })
    )
    .min(1)
    .max(3)
    .describe("1-3 条要保存的记忆，用户一句话要求记多件事时合并为多条"),
})

export type MemoryToolInput = z.infer<typeof memoryInputSchema>

/** 注入 system prompt 的使用规则段 */
export const MEMORY_TOOL_PROMPT: string = [
  "## 显式记忆添加（add_memory 工具）",
  "- 用户明确要求记住某件事（\"帮我记住\"\"记一下\"\"添加记忆\"）时，调用本工具立即保存，不要只口头答应",
  "- 内容精炼成不依赖本轮对话也能读懂的第三人称陈述句，能明确判断时附带分类",
  "- 用户要求记多件事时拆成多条（一次最多 3 条）；临时信息（验证码、一次性数据）不保存",
  "- 返回 duplicates 时告知用户\"已有相同或相似的记忆\"；返回 ok 后用一句话确认记住了什么",
  "- 返回 superseded > 0 时，用 supersededNote 里的说明告知用户\"原来那条 X 已被这句取代\"（用户可在 设置 → 记忆 里恢复旧条目），不要自己编造被取代的内容",
  "- 用户只是陈述事实而未要求保存时，不要主动调用本工具（自动记忆提取机制仍会工作）",
].join("\n")

/** 记忆功能关闭时的降级提示（工具不注入，避免模型虚构已保存） */
export const MEMORY_DISABLED_PROMPT: string = [
  "## 记忆功能（已关闭）",
  "本应用的长期记忆功能已在 设置 → 记忆 中关闭。用户要求记住内容时，",
  "请如实告知记忆功能当前已关闭，可在设置中开启；不要虚构已保存。",
].join("\n")
