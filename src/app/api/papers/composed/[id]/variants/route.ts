/**
 * 举一反三——加题面板内对某道真题出 AI 变式(POST /api/papers/composed/[id]/variants):
 * body { paperQuestionId, modelId, count? }。只生成、不落库:变式先回面板预览,
 * 用户「收进题库」走 /api/study/quiz/save 进 Question 练习题库,或「加入本卷」走
 * PATCH insert_inline 进内联槽。模型解析/公共额度闸与 chat 管线同口径(resolveChatModel)。
 * 种子题限定本卷学科池内的真题(自己名下或公共库,answer 非空);变式钉死原题题型/分值,难度递进。
 */
import { NextRequest } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { libraryScopes } from "@/lib/library-scope"
import { prisma } from "@/lib/db"
import { generateQuestionVariants } from "@/lib/ai/paper-question-generator"
import { resolveChatModel } from "@/lib/ai/model-resolver.server"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, { params }: Ctx) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })
  const { id } = await params

  let body: { paperQuestionId?: unknown; modelId?: unknown; count?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 })
  }
  const qid = typeof body.paperQuestionId === "string" ? body.paperQuestionId : ""
  if (!qid) return Response.json({ error: "need_paperQuestionId" }, { status: 400 })
  const count = Math.min(4, Math.max(1, Math.round(Number(body.count)) || 2))

  const paper = await prisma.composedPaper.findFirst({
    where: { id, userId },
    select: { id: true, subject: true },
  })
  if (!paper) return Response.json({ error: "not_found" }, { status: 404 })

  const q = await prisma.paperQuestion.findFirst({
    where: { id: qid, userId: { in: await libraryScopes(userId) }, answer: { not: null } },
    select: {
      id: true, number: true, kind: true, score: true, stem: true, options: true, answer: true,
      paper: { select: { title: true, subject: true } },
    },
  })
  if (!q) return Response.json({ error: "question_not_found" }, { status: 404 })
  // 变式跟卷走:种子题学科必须与本卷一致(候选面板本就只出同学科池题,这里是双保险)
  if (q.paper.subject !== paper.subject) return Response.json({ error: "subject_mismatch" }, { status: 422 })

  const modelId = typeof body.modelId === "string" && body.modelId.trim() ? body.modelId.trim() : ""
  if (!modelId) return Response.json({ error: "need_model" }, { status: 400 })
  const resolved = await resolveChatModel({ userId, modelId, logTag: "[paper-variants]" })
  if (!resolved.ok) return resolved.response

  try {
    const variants = await generateQuestionVariants({
      userId,
      seed: { stem: q.stem, options: q.options, answer: q.answer as string, kind: q.kind, score: q.score },
      count,
      modelId,
      sourceRef: `举一反三 · ${q.paper.title} 第${q.number}题`.slice(0, 100),
    })
    return Response.json({ variants })
  } catch (err) {
    console.error("[paper-variants] generate failed:", err instanceof Error ? err.message : err)
    return Response.json({ error: "generate_failed" }, { status: 502 })
  }
}
