/**
 * 错题本检索工具(search_notes):只读,卷面 AI 助手/学习类管线用。
 * 让 AI 在讲评题目、出「举一反三」变式题时了解用户在该考点的错误史
 * (题干摘要、考点、掌握度、遗忘次数),变式题才能针对性补弱。
 */
import { tool } from "ai"
import { z } from "zod"
import { prisma } from "@/lib/db"

export const STUDY_NOTES_TOOL_NAME = "search_notes"

export function createStudyNotesTool(userId: string, subject?: string | null) {
  void subject // 学科过滤参数位:execute 全库查(topic 比学科更准),漏检由 fallback 兜
  return tool({
    description:
      "错题本检索工具。检索用户错题本里的历史错题(题干摘要/考点/掌握度/遗忘次数/AI解析)。讲评题目、分析薄弱考点、出「举一反三」变式题时使用——出变式题前先查这个考点用户错过什么,让变式针对性补弱。",
    inputSchema: z.object({
      query: z.string().max(40).describe("检索词,1-4 个,考点词或题面词,如「十字相乘」「新闻压缩」"),
    }),
    execute: async ({ query }) => {
      const terms = query
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 4)
      const rows = terms.length
        ? await prisma.studyNote.findMany({
            where: {
              userId,
              OR: terms.flatMap((t) => [
                { title: { contains: t } },
                { topic: { contains: t } },
                { content: { contains: t } },
              ]),
            },
            orderBy: [{ lapses: "desc" }, { createdAt: "desc" }],
            take: 6,
            select: {
              title: true,
              topic: true,
              subject: true,
              mastery: true,
              lapses: true,
              analysis: true,
            },
          })
        : []
      // 无命中回退:给全局最弱几条,让模型知道用户整体薄弱面
      const fallback =
        rows.length
          ? []
          : await prisma.studyNote.findMany({
              where: { userId },
              orderBy: [{ lapses: "desc" }, { createdAt: "desc" }],
              take: 4,
              select: { title: true, topic: true, subject: true, mastery: true, lapses: true },
            })
      return {
        matched: rows.length,
        notes: rows.map((r) => ({
          title: r.title,
          topic: r.topic,
          subject: r.subject,
          mastery: Math.round(r.mastery * 100) / 100,
          lapses: r.lapses,
          analysisBrief: r.analysis ? r.analysis.replace(/[#*`]/g, "").slice(0, 120) : null,
        })),
        ...(rows.length === 0 && fallback.length
          ? {
              fallbackWeak: fallback.map((r) => ({
                title: r.title,
                topic: r.topic,
                subject: r.subject,
                mastery: Math.round(r.mastery * 100) / 100,
                lapses: r.lapses,
              })),
            }
          : {}),
      }
    },
  })
}
