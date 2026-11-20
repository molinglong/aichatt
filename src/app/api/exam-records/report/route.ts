/**
 * AI 成绩分析报告(落库可回看):
 * - POST /api/exam-records/report  生成报告。body: { kind:'exam', examRecordId } 或 { kind:'stage', subject? }
 *   数据快照(生成时口径)存 ExamReport.scope,回看不再依赖当时数据;模型走 resolveStudyModel
 *   (用户最近会话的模型,与冲刺计划 AI 排期同款),无可用模型返回 422。
 * - GET  /api/exam-records/report  报告列表(createdAt 倒序,content/scope 全量,量小不分页)
 */
import { NextRequest } from "next/server"
import { generateText } from "ai"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"
import { resolveStudyModel } from "@/lib/study/tagging"
import { buildExamAnalysis } from "@/lib/exam/analysis.server"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })

  const examRecordId = req.nextUrl.searchParams.get("examRecordId")
  const kind = req.nextUrl.searchParams.get("kind")
  const reports = await prisma.examReport.findMany({
    where: {
      userId,
      ...(examRecordId ? { examRecordId } : {}),
      ...(kind === "exam" || kind === "stage" ? { kind } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  })
  return Response.json({ reports })
}

export async function POST(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })

  let body: { kind?: unknown; examRecordId?: unknown; subject?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 })
  }
  const kind = body.kind === "exam" || body.kind === "stage" ? body.kind : null
  if (!kind) return Response.json({ error: "bad_kind" }, { status: 422 })
  const examRecordId = typeof body.examRecordId === "string" ? body.examRecordId : undefined
  const subject = typeof body.subject === "string" && body.subject.trim() ? body.subject.trim() : undefined

  // 数据聚合:exam=单次小结(该卷成绩+本科目汇总+该卷考点丢分);stage=阶段总结(全量/按科目)
  const analysis = await buildExamAnalysis(userId, { subject: kind === "stage" ? subject : undefined })
  const record = kind === "exam" && examRecordId ? analysis.records.find((r) => r.id === examRecordId) : undefined
  if (kind === "exam" && !record) return Response.json({ error: "record_not_found" }, { status: 422 })

  const data =
    kind === "exam" && record
      ? {
          kind,
          record,
          subjectSummary: analysis.bySubject.find((s) => s.subject === record.subject),
          topicLossAgg: analysis.topicLossAgg.filter((t) => record.topicLoss.some((tl) => tl.topic === t.topic)),
        }
      : { kind, bySubject: analysis.bySubject, topicLossAgg: analysis.topicLossAgg, sectionLoss: analysis.sectionLoss }

  const model = await resolveStudyModel(userId)
  if (!model) return Response.json({ error: "no_model" }, { status: 422 })

  const system = `你是一位严谨的学习教练,基于用户提供的结构化考试数据写一份 markdown 成绩分析报告。硬性要求:
1. 只依据数据作答,绝不编造数字;引用数字必须与数据一致。
2. 结构固定:## 总体判断(2-3 句,先给结论)→ ## 趋势(结合 bySubject 的 avgPercent/latestPercent/trend)→ ## 考点诊断(优先讲 loss 大且 source=both 的考点——「错题本也丢+考场又丢」是真漏洞,复习了还没堵住;source=exam 的考点提示可能是审题/时间/考场发挥问题,建议限时练而非重学)→ ## 最值得做的三件事(具体可执行,每件一句话+一句为什么)。
3. 语言简洁直接,不写空话套话,总长 300-500 字。
4. source 字段含义:both=错题本里也有该考点的卡;exam=仅考场丢分。`
  const prompt = `${kind === "exam" ? "这是某一次学校考试的成绩数据,请写考后小结。" : "这是某阶段所有学校考试的聚合数据,请写阶段总结。"}\n\n${JSON.stringify(data)}`

  let content: string
  try {
    const result = await generateText({ model, system, prompt })
    content = result.text.trim()
  } catch (err) {
    console.error("[exam-report] generate failed:", err)
    return Response.json({ error: "generate_failed" }, { status: 502 })
  }
  if (!content) return Response.json({ error: "empty_report" }, { status: 502 })

  const examName =
    kind === "exam" && record ? `${record.examName} · 考后小结` : `${subject ? subject + " " : ""}阶段总结`
  const report = await prisma.examReport.create({
    data: {
      userId,
      kind,
      examRecordId: kind === "exam" && examRecordId ? examRecordId : null,
      subject: subject ?? (kind === "exam" && record ? record.subject : null),
      examName,
      // record 里有 Date,JSON 字段先规整成纯 JSON(Date→ISO 串)
      scope: JSON.parse(JSON.stringify(data)) as object,
      content,
    },
  })
  return Response.json({ report })
}
