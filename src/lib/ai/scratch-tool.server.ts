import { tool } from "ai"
import { upsertScratchNotes } from "@/lib/memory/scratch"
import { scratchInputSchema, type ScratchToolOutput } from "@/lib/ai/scratch-tool"

/**
 * write_scratch_memory 工具工厂（服务端专用，依赖 prisma；勿从客户端组件 import）。
 * 常量与 schema 在 scratch-tool.ts（isomorphic），拆分原因见该文件头注释。
 *
 * 写入走 upsertScratchNotes：同 topic 覆盖更新（内容与有效期一起刷新），
 * 新 topic 创建；逐条校验，单条非法不整体失败。
 */
export function createScratchTool(userId: string) {
  return tool({
    description:
      "把用户的「进行中状态」写入短期记忆（带过期时间，到期自动失效，默认 14 天）。" +
      "用户提到进度推进、备考安排、正在攻坚的内容时主动调用；同一主题重复调用 = 覆盖更新。" +
      "背单词/错题本等有结构化数据的进度不要存这里（用 study_progress 查询），只存查询不到的状态。",
    inputSchema: scratchInputSchema,
    execute: async ({ notes }): Promise<ScratchToolOutput> => {
      const result = await upsertScratchNotes(userId, notes)
      if (result.saved.length === 0) {
        return {
          ok: false,
          rejected: result.rejected,
          message: "没有可保存的条目（topic 与 content 不能为空）",
        }
      }
      return { ok: true, saved: result.saved, rejected: result.rejected }
    },
  })
}
