/**
 * 学校考试成绩分析聚合:
 * - GET /api/exam-records/analysis?subject=math  成绩分析弹层的数据层(可选按科目过滤)
 * 返回:逐条成绩(带逐次考点丢分)+ 科目汇总 + 考点丢分跨考试聚合(与错题本交叉)+ 丢分结构(按大题)。
 * 口径统一在 src/lib/exam/analysis.server.ts(AI 报告与冲刺计划加权共用)。
 */
import { NextRequest } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { buildExamAnalysis } from "@/lib/exam/analysis.server"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })

  const subject = req.nextUrl.searchParams.get("subject") ?? undefined
  const analysis = await buildExamAnalysis(userId, { subject: subject || undefined })
  return Response.json({ analysis })
}
