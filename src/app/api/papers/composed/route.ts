/**
 * 智能拟卷（真题重组卷）：
 * - GET  /api/papers/composed  本用户拟卷列表(学习台拟卷区块 + /papers/composed 列表页共用)
 * - POST /api/papers/composed  组卷（底卷模式=同位换题 / 大纲模式=slotDefs 逐桶填充；真题槽只用有官方答案且未拉黑的题；
 *   aiFillAll=true 时真题池为空也放行,缺口按 fillInline 预算 AI 拟题补齐——四路资源 grounding,卷面逐题标注来源）
 * 鉴权:登录。写入类 API——临时模式/对比模式前端不提供入口;归属校验在引擎内按 userId 过滤。
 * 与 /api/papers/[slug]（原卷预览）互不干扰:静态段 composed 优先于动态 [slug]。
 */
import { NextRequest } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"
import { composePaper, type OutlineSlotDef } from "@/lib/papers/compose"

export const dynamic = "force-dynamic"

const SUBJECTS = new Set([
  "math", "chinese", "english", "physics", "chemistry",
  "biology", "history", "geography", "politics", "other",
])

export async function GET(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })
  const rows = await prisma.composedPaper.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      subject: true,
      totalScore: true,
      durationMin: true,
      onlyChoice: true,
      createdAt: true,
      _count: { select: { slots: true } },
    },
  })
  return Response.json({
    papers: rows.map(({ _count, ...p }) => ({ ...p, slotCount: _count.slots })),
  })
}

/** 大纲槽位定义的宽松校验(引擎内再做语义过滤);传了数组(即使过滤后为空)即视为大纲模式,空定义由引擎拒绝 */
function parseSlotDefs(raw: unknown): OutlineSlotDef[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const defs: OutlineSlotDef[] = []
  for (const d of raw.slice(0, 12)) {
    if (!d || typeof d !== "object") continue
    const kind = (d as { kind?: unknown }).kind
    const score = (d as { score?: unknown }).score
    const count = (d as { count?: unknown }).count
    if ((kind !== "choice" && kind !== "answer") || typeof score !== "number" || typeof count !== "number") continue
    const section = (d as { section?: unknown }).section
    defs.push({
      section: typeof section === "string" ? section.slice(0, 30) : undefined,
      kind,
      score: Math.round(score),
      count: Math.round(count),
    })
  }
  return defs
}

export async function POST(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })

  let body: { subject?: string; baseSlug?: string; onlyChoice?: boolean; allowAiAnswers?: boolean; slotDefs?: unknown; focusTopics?: unknown; perTopic?: unknown; extraRandom?: unknown; fillInline?: { textbook?: number; aiVariant?: number }; modelId?: string; title?: string; note?: string; aiFillAll?: boolean; restrictPaperSlug?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 })
  }
  const subject = body.subject ?? ""
  if (!SUBJECTS.has(subject)) return Response.json({ error: "bad_subject" }, { status: 400 })

  // 针对我复习的考点词(字符串数组,≤8 个每个 ≤30 字)
  const focusTopics = Array.isArray(body.focusTopics)
    ? body.focusTopics.filter((t): t is string => typeof t === "string" && !!t.trim()).map((t) => t.trim().slice(0, 30)).slice(0, 8)
    : undefined
  const perTopic = typeof body.perTopic === "number" ? Math.round(body.perTopic) : undefined
  const extraRandom = typeof body.extraRandom === "number" ? Math.round(body.extraRandom) : undefined
  const fillInline =
    body.fillInline && typeof body.fillInline === "object"
      ? {
          textbook: typeof body.fillInline.textbook === "number" ? Math.round(body.fillInline.textbook) : 0,
          aiVariant: typeof body.fillInline.aiVariant === "number" ? Math.round(body.fillInline.aiVariant) : 0,
        }
      : undefined
  const modelId = typeof body.modelId === "string" && body.modelId.trim() ? body.modelId.trim() : undefined
  // 表单「给 AI 的备注」:仅 AI 补题时进 prompt,不落库(≤200 字)
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 200) : undefined

  const result = await composePaper(userId, {
    subject,
    baseSlug: body.baseSlug,
    onlyChoice: !!body.onlyChoice,
    allowAiAnswers: !!body.allowAiAnswers,
    slotDefs: parseSlotDefs(body.slotDefs),
    focusTopics,
    fillInline,
    modelId,
    aiFillAll: !!body.aiFillAll,
    perTopic,
    extraRandom,
    note,
    title: typeof body.title === "string" ? body.title.slice(0, 60) : undefined,
    restrictPaperSlug: typeof body.restrictPaperSlug === "string" && body.restrictPaperSlug.trim() ? body.restrictPaperSlug.trim().slice(0, 60) : undefined,
  })
  if (!result.ok) {
    // no_pool=该科没有带官方答案的题且未走 AI 兜底(422,业务现实);no_base=底卷定位失败;bad_outline=大纲槽位无效
    return Response.json({ error: result.reason ?? "compose_failed" }, { status: 422 })
  }
  return Response.json({
    id: result.composedId,
    title: result.title,
    shortages: result.shortages ?? [],
    filledInline: result.filledInline ?? { textbook: 0, aiVariant: 0 },
    avoidedRecent: result.avoidedRecent ?? 0,
  })
}
