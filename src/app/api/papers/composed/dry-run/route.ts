/**
 * 试装 dry-run（POST /api/papers/composed/dry-run）：
 * 按大纲槽位+考点提示+真卷限定从真题池试抽，不落库——全屏结构工作台右侧仿真预览用。
 * 与正式组卷同口径（pickSlotsForDefs / loadPool 官方池），纯真题零 AI；抽题随机，
 * 「换一批」由前端换 seed 重调。stem 截断 240 字（预览用途）。
 */
import { NextRequest } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { loadPool, pickSlotsForDefs, type OutlineSlotDef } from "@/lib/papers/compose"
import { topicTokens } from "@/lib/ai/paper-question-generator"

export const dynamic = "force-dynamic"

const SUBJECTS = new Set([
  "math", "chinese", "english", "physics", "chemistry",
  "biology", "history", "geography", "politics", "other",
])

export async function POST(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })

  let body: { subject?: string; slotDefs?: unknown; restrictPaperSlug?: string; focusTopics?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 })
  }
  const subject = body.subject ?? ""
  if (!SUBJECTS.has(subject)) return Response.json({ error: "bad_subject" }, { status: 400 })
  if (!Array.isArray(body.slotDefs)) return Response.json({ error: "bad_outline" }, { status: 400 })
  const restrictSlug =
    typeof body.restrictPaperSlug === "string" && body.restrictPaperSlug.trim()
      ? body.restrictPaperSlug.trim().slice(0, 60)
      : undefined
  const focusTopics = Array.isArray(body.focusTopics)
    ? body.focusTopics.filter((t): t is string => typeof t === "string" && !!t.trim()).map((t) => t.trim().slice(0, 30)).slice(0, 8)
    : undefined

  const pool = await loadPool(userId, subject, false, restrictSlug)
  const { groups } = pickSlotsForDefs(
    pool,
    subject,
    body.slotDefs as OutlineSlotDef[],
    focusTopics?.length ? topicTokens(focusTopics) : null
  )
  const slots = groups.flatMap((g) =>
    g.picks.map((p) => ({
      section: p.section,
      kind: p.kind,
      score: p.score,
      q: p.q
        ? {
            number: p.q.number,
            stem: p.q.stem.length > 240 ? p.q.stem.slice(0, 240) + "……" : p.q.stem,
            options: p.q.options,
            topics: p.q.topics,
            paperTitle: p.q.paperTitle,
          }
        : null,
    }))
  )
  return Response.json({ slots })
}
