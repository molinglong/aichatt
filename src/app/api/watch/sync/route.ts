import { NextResponse } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"

/**
 * 手表端「手表对话」双向同步。
 *
 * GET  : 拉取服务端会话里的问答对，供手表合并进本地历史。
 * POST : 手表把本地问答对传上来，服务端与已有消息按 (question, answer) 去重合并后
 *        整体重写（全量覆盖但内容合并，避免 Web 端新增内容被手表覆盖丢失）。
 *
 * 鉴权：Bearer API Token，也接受 cookie。
 */

const CONVERSATION_TITLE = "手表对话"
const MAX_ENTRIES = 30
const MAX_QUESTION_CHARS = 4_000
const MAX_ANSWER_CHARS = 12_000

interface Entry {
  question: string
  answer: string
  timestamp: number
}

interface RawEntry {
  question?: unknown
  answer?: unknown
  timestamp?: unknown
}

function normalizeEntries(raw: unknown): Entry[] {
  if (!Array.isArray(raw)) return []
  return (raw as RawEntry[])
    .filter(
      (entry) =>
        typeof entry?.question === "string" &&
        entry.question.trim().length > 0 &&
        typeof entry?.answer === "string" &&
        entry.answer.trim().length > 0
    )
    .map((entry) => ({
      question: (entry.question as string).trim().slice(0, MAX_QUESTION_CHARS),
      answer: (entry.answer as string).trim().slice(0, MAX_ANSWER_CHARS),
      timestamp:
        typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)
          ? entry.timestamp
          : Date.now(),
    }))
}

function messagesToEntries(
  messages: Array<{ role: string; content: string; createdAt: Date }>
): Entry[] {
  const entries: Entry[] = []
  let pendingUser: { content: string; createdAt: Date } | null = null
  for (const message of messages) {
    if (message.role === "user") {
      pendingUser = { content: message.content, createdAt: message.createdAt }
    } else if (message.role === "assistant" && pendingUser) {
      entries.push({
        question: pendingUser.content,
        answer: message.content,
        timestamp: pendingUser.createdAt.getTime(),
      })
      pendingUser = null
    }
  }
  return entries
}

function mergeEntries(entries: Entry[]): Entry[] {
  const seen = new Set<string>()
  const merged: Entry[] = []
  for (const entry of [...entries].sort((a, b) => a.timestamp - b.timestamp)) {
    const key = `${entry.question}\u0000${entry.answer}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(entry)
  }
  return merged.slice(-MAX_ENTRIES)
}

async function findConversation(userId: string) {
  return prisma.conversation.findFirst({
    where: { userId, title: CONVERSATION_TITLE, isEphemeral: false },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  })
}

export async function GET(req: Request) {
  const userId = await getUserId(req)
  if (!userId) {
    return NextResponse.json({ error: "登录已失效，请检查 API 令牌" }, { status: 401 })
  }

  const conversation = await findConversation(userId)
  if (!conversation) return NextResponse.json({ entries: [] })

  const messages = await prisma.message.findMany({
    where: { conversationId: conversation.id, archived: false },
    orderBy: { createdAt: "asc" },
    select: { role: true, content: true, createdAt: true },
  })

  return NextResponse.json({ entries: messagesToEntries(messages) })
}

export async function POST(req: Request) {
  const userId = await getUserId(req)
  if (!userId) {
    return NextResponse.json({ error: "登录已失效，请检查 API 令牌" }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as {
    entries?: unknown
    model?: unknown
  }
  const incoming = normalizeEntries(body.entries)
  if (incoming.length === 0) {
    return NextResponse.json({ error: "没有可同步的记录" }, { status: 400 })
  }

  const model =
    typeof body.model === "string" && body.model.trim() ? body.model.trim() : "gpt-4o"

  let conversation = await findConversation(userId)
  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: { userId, title: CONVERSATION_TITLE, model },
      select: { id: true },
    })
  }

  const conversationId = conversation.id

  const existingMessages = await prisma.message.findMany({
    where: { conversationId, archived: false },
    orderBy: { createdAt: "asc" },
    select: { role: true, content: true, createdAt: true },
  })

  // 双向合并：服务端已有（可能来自 Web 端编辑）+ 手表本地，去重后重写
  const merged = mergeEntries([...messagesToEntries(existingMessages), ...incoming])

  await prisma.$transaction([
    prisma.message.deleteMany({ where: { conversationId } }),
    prisma.message.createMany({
      data: merged.flatMap((entry) => [
        {
          conversationId,
          role: "user",
          content: entry.question,
          createdAt: new Date(entry.timestamp),
        },
        {
          conversationId,
          role: "assistant",
          content: entry.answer,
          createdAt: new Date(entry.timestamp + 1),
        },
      ]),
    }),
    prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    }),
  ])

  return NextResponse.json({
    ok: true,
    conversationId,
    synced: incoming.length,
    total: merged.length,
  })
}
