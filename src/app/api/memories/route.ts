import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { upsertMemories } from "@/lib/memory/dedupe"
import { detectConflictGroups } from "@/lib/memory/conflict"
import { MEMORY_STATUS_ACTIVE, MEMORY_STATUS_SUPERSEDED } from "@/lib/memory/store"

const VALID_CATEGORIES = new Set([
  "user_info",
  "preference",
  "habit",
  "project",
  "skill",
  "other",
  "manual",
  "general",
])

export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }

  const [activeMemories, supersededMemories, user] = await Promise.all([
    prisma.memory.findMany({
      where: { userId: session.user.id, status: MEMORY_STATUS_ACTIVE },
      orderBy: [{ source: "desc" }, { updatedAt: "desc" }],
    }),
    // 已被取代的条目单独返回：UI 折叠展示，给用户「恢复」的反悔余地
    prisma.memory.findMany({
      where: { userId: session.user.id, status: MEMORY_STATUS_SUPERSEDED },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { memoryEnabled: true },
    }),
  ])

  // 冲突组由服务端算好（纯本地槽位/常识判定，零 LLM 调用），前端只负责呈现与裁决
  const groups = detectConflictGroups(
    activeMemories.map((m) => ({
      id: m.id,
      content: m.content,
      category: m.category,
      updatedAt: m.updatedAt,
      conflictPeers: m.conflictPeers,
    }))
  )
  const conflicts = groups.map((g) => ({
    ids: g.ids,
    winnerId: g.winnerId,
    reason: g.hits[0]?.reason ?? "两条记忆互相矛盾",
  }))

  return NextResponse.json({
    memories: activeMemories,
    superseded: supersededMemories,
    conflicts,
    memoryEnabled: user?.memoryEnabled ?? true,
  })
}

export async function POST(req: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))

  // ─── 批量导入模式（从 ChatGPT / Claude 等导入多条记忆）────────────
  // 走统一写入管线：与站内已有画像互斥的条目（如外部说"27岁"、站内已记"高中生"）
  // 不再静默共存，导入的这条胜出，旧条转入「已被取代」。
  if (Array.isArray(body.items)) {
    const sourceDetail = (body.sourceDetail ?? "").toString().trim().slice(0, 50)
    const rawItems = body.items as Array<Record<string, unknown>>

    const normalized = rawItems
      .map((it) => {
        const category =
          typeof it.category === "string" && VALID_CATEGORIES.has(it.category)
            ? it.category
            : "other"
        const content =
          typeof it.content === "string" ? it.content.trim().slice(0, 200) : ""
        return { category, content }
      })
      .filter((it) => it.content.length >= 4)

    if (normalized.length === 0) {
      return NextResponse.json(
        { error: "没有可导入的记忆（每条至少 4 字、最多 200 字）" },
        { status: 400 }
      )
    }

    const result = await upsertMemories(
      session.user.id,
      normalized.map((it) => ({ category: it.category, content: it.content })),
      { source: "imported", sourceDetail: sourceDetail || null }
    )

    return NextResponse.json(
      {
        created: result.created,
        skipped: result.duplicates.length + result.rejected.length,
        superseded: result.superseded,
        supersededDetails: result.supersededDetails,
        total: normalized.length,
      },
      { status: 201 }
    )
  }

  // ─── 单条手动添加模式 ─────────────────────────────────────────────
  const content = (body.content ?? "").toString().trim()
  if (!content) {
    return NextResponse.json({ error: "内容不能为空" }, { status: 400 })
  }
  if (content.length > 200) {
    return NextResponse.json({ error: "内容过长（最多 200 字）" }, { status: 400 })
  }

  const category = (body.category ?? "manual").toString() || "manual"
  const result = await upsertMemories(
    session.user.id,
    [{ category, content }],
    { source: "manual" }
  )

  if (result.duplicates.includes(content)) {
    return NextResponse.json({ error: "已存在相同或相似的记忆" }, { status: 409 })
  }
  if (result.rejected.includes(content)) {
    return NextResponse.json({ error: "内容太短（至少 4 字）" }, { status: 400 })
  }

  return NextResponse.json(
    {
      ...(result.createdRows[0] ?? null),
      superseded: result.superseded,
      supersededDetails: result.supersededDetails,
    },
    { status: 201 }
  )
}
