import { tool } from "ai"
import { upsertMemories } from "@/lib/memory/dedupe"
import { memoryInputSchema } from "@/lib/ai/memory-tool"

/**
 * add_memory 工具工厂（服务端专用；勿从客户端组件 import）。
 * 常量与 schema 在 memory-tool.ts（isomorphic），拆分原因见该文件头注释。
 *
 * 写入一律走统一管线 upsertMemories：本入口以前只做"互相包含"去重、完全不判矛盾，
 * 用户显式说"帮我记住我是高中生"时，库里的"27岁"会原样留着，两条一起注入 prompt。
 * 现在命中矛盾的旧条目标记 superseded（不物理删，用户可在设置→记忆里恢复）。
 */
export function createMemoryTool(userId: string) {
  return tool({
    description:
      "向用户长期记忆中添加条目。当用户明确要求你记住某件事（\"帮我记住…\"\"记一下…\"\"添加一条记忆\"）时调用；" +
      "每次 1-3 条，内容精炼为独立的陈述句。临时信息（验证码、一次性数据、当前时间天气）不要保存。" +
      "返回的 duplicates 表示已有相同或相似记忆，superseded 表示本次取代了哪些与之矛盾的旧记忆，需如实告知用户。",
    inputSchema: memoryInputSchema,
    execute: async ({ memories }) => {
      const result = await upsertMemories(
        userId,
        memories.map((m) => ({
          category: m.category ?? "manual",
          content: m.content.trim(),
        })),
        { source: "manual" }
      )

      const supersededNote = result.supersededDetails
        .slice(0, 3)
        .map((d) => `已取代旧记忆「${d.content}」：${d.reason}`)

      return {
        ok: result.created > 0,
        saved: result.createdRows.map((row) => row.content),
        duplicates: result.duplicates,
        rejected: result.rejected,
        superseded: result.superseded,
        supersededNote,
      }
    },
  })
}
