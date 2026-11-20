import { tool } from "ai"
import { prisma } from "@/lib/db"
import {
  studyProgressInputSchema,
  type StudyProgressToolOutput,
  type ExamPlanTodayItem,
} from "@/lib/ai/study-progress-tool"

/**
 * study_progress 工具工厂（服务端专用，依赖 prisma；勿从客户端组件 import）。
 * 常量与 schema 在 study-progress-tool.ts（isomorphic），拆分原因见该文件头注释。
 *
 * 只读聚合三块学习数据（全部现查，不落缓存）：
 * - 背单词：active WordPlan（词单游标）+ UserWord 队列（总量/到期/今日新学）+ 复习流水（今日次数/连续天数）
 * - 错题本：StudyNote 总量/到期 + 今日复习次数 + 平均掌握度
 * - 考前冲刺：active StudyPlan（考试倒计时）+ 今日 StudyPlanItem 完成度
 * 没有任何数据时返回 ok + message，不报错（新用户也会调）。
 */
export function createStudyProgressTool(userId: string) {
  return tool({
    description:
      "查询用户当前的学习进度快照（只读，实时查库）。当用户问\"背单词到哪了/今天复习了多少/" +
      "错题还剩多少到期/离考试还有几天/今天该学什么\"，或学习规划类回答需要真实进度时调用。" +
      "返回背单词计划与队列、错题本复习、考前冲刺计划三块结构化数据。",
    inputSchema: studyProgressInputSchema,
    execute: async (): Promise<StudyProgressToolOutput> => {
      const now = new Date()
      const dayStart = new Date(now)
      dayStart.setHours(0, 0, 0, 0)
      const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000)

      const [
        plan,
        totalWords,
        dueWords,
        newToday,
        reviewedToday,
        recentReviews,
        noteTotal,
        noteDue,
        noteReviewedToday,
        noteMastery,
        examPlan,
        todayItems,
      ] = await Promise.all([
        prisma.wordPlan.findFirst({
          where: { userId, active: true },
          include: { list: { select: { name: true, level: true, wordCount: true } } },
        }),
        prisma.userWord.count({ where: { userId, suspended: false } }),
        prisma.userWord.count({
          where: { userId, suspended: false, dueAt: { lte: now } },
        }),
        prisma.userWord.count({ where: { userId, createdAt: { gte: dayStart } } }),
        prisma.wordReviewLog.count({ where: { userId, ratedAt: { gte: dayStart } } }),
        // 连续天数：只取 ratedAt，够回溯即可（上限 60 天窗口）
        prisma.wordReviewLog.findMany({
          where: { userId, ratedAt: { gte: new Date(now.getTime() - 60 * 24 * 3600 * 1000) } },
          select: { ratedAt: true },
        }),
        prisma.studyNote.count({ where: { userId } }),
        prisma.studyNote.count({ where: { userId, dueAt: { lte: now } } }),
        prisma.studyNoteReviewLog.count({
          where: { note: { userId }, ratedAt: { gte: dayStart } },
        }),
        prisma.studyNote.aggregate({
          where: { userId },
          _avg: { mastery: true },
        }),
        prisma.studyPlan.findFirst({
          where: { userId, active: true },
          select: { title: true, examName: true, subject: true, examDate: true },
        }),
        prisma.studyPlanItem.findMany({
          where: { userId, date: { gte: dayStart, lt: dayEnd } },
          select: { topic: true, kind: true, target: true, done: true },
          orderBy: { topic: "asc" },
          take: 12,
        }),
      ])

      // 连续学习天数：从今天（或昨天，今天还没复习不算断）往回数连续有复习记录的日子
      const dayKey = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
      const reviewDays = new Set(recentReviews.map((r) => dayKey(r.ratedAt)))
      let streakDays = 0
      const cursor = new Date(now)
      if (!reviewDays.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1)
      while (reviewDays.has(dayKey(cursor))) {
        streakDays++
        cursor.setDate(cursor.getDate() - 1)
      }

      const noData =
        totalWords === 0 && noteTotal === 0 && !plan && !examPlan
      if (noData) {
        return {
          ok: true,
          generatedAt: now.toISOString(),
          words: { plan: null, total: 0, due: 0, newToday: 0, reviewedToday: 0, streakDays: 0 },
          wrongQuestions: { total: 0, due: 0, reviewedToday: 0, avgMastery: null },
          examPlan: null,
          message: "还没有学习数据（未开始背单词、无错题、无冲刺计划）",
        }
      }

      const doneItems = todayItems.filter((i) => i.done).length
      const itemList: ExamPlanTodayItem[] = todayItems.map((i) => ({
        topic: i.topic,
        kind: i.kind,
        target: i.target,
        done: i.done,
      }))

      return {
        ok: true,
        generatedAt: now.toISOString(),
        words: {
          plan: plan
            ? {
                name: plan.name,
                list: plan.list
                  ? {
                      name: plan.list.name,
                      level: plan.list.level,
                      wordCount: plan.list.wordCount,
                    }
                  : null,
                cursor: plan.cursor,
                dailyNew: plan.dailyNew,
                dailyReview: plan.dailyReview,
              }
            : null,
          total: totalWords,
          due: dueWords,
          newToday,
          reviewedToday,
          streakDays,
        },
        wrongQuestions: {
          total: noteTotal,
          due: noteDue,
          reviewedToday: noteReviewedToday,
          avgMastery:
            noteMastery._avg.mastery == null ? null : Math.round(noteMastery._avg.mastery * 100) / 100,
        },
        examPlan: examPlan
          ? {
              title: examPlan.title,
              examName: examPlan.examName,
              subject: examPlan.subject,
              examDate: examPlan.examDate.toISOString(),
              daysLeft: Math.max(
                0,
                Math.ceil((examPlan.examDate.getTime() - now.getTime()) / (24 * 3600 * 1000))
              ),
              todayItems: { total: todayItems.length, done: doneItems, list: itemList },
            }
          : null,
      }
    },
  })
}
