import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"

/**
 * Token / 生图消耗统计接口
 *
 * 区分两路数据:
 *  - chat: 按 token 计费(每条 assistant 消息的 promptTokens / completionTokens)
 *  - image: 按张数计费(每条 generatedImage 记录一张)
 *
 * 返回结构:
 *   { chat: { totals, byModel, byDay }, image: { totals, byModel, byDay } }
 */
export async function GET() {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }
  const userId = session.user.id

  // 最近 30 天日期序列(北京时间),保证无数据的天也出现在结果中
  const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
  const dayKeyOf = (d: Date) =>
    new Date(d.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10)
  const today = new Date()
  const recentDays: string[] = []
  for (let i = 29; i >= 0; i--) {
    recentDays.push(dayKeyOf(new Date(today.getTime() - i * 24 * 60 * 60 * 1000)))
  }
  const recentDaySet = new Set(recentDays)

  const [chat, image] = await Promise.all([
    aggregateChat(userId, recentDays, recentDaySet, dayKeyOf),
    aggregateImage(userId, recentDays, recentDaySet, dayKeyOf),
  ])

  return NextResponse.json({ chat, image })
}

// ── 聊天(token 维度) ───────────────────────────────────────────────────────
async function aggregateChat(
  userId: string,
  recentDays: string[],
  recentDaySet: Set<string>,
  dayKeyOf: (d: Date) => string
) {
  const messages = await prisma.message.findMany({
    where: {
      role: "assistant",
      conversation: { userId },
      OR: [
        { promptTokens: { not: null } },
        { completionTokens: { not: null } },
      ],
    },
    select: {
      model: true,
      promptTokens: true,
      completionTokens: true,
      // prompt caching 观测(上游未报数为 null)
      cacheReadTokens: true,
      cacheWriteTokens: true,
      createdAt: true,
    },
  })

  let totalPrompt = 0
  let totalCompletion = 0
  let totalCacheRead = 0
  let totalCacheWrite = 0

  const modelMap = new Map<
    string,
    {
      promptTokens: number
      completionTokens: number
      cacheReadTokens: number
      messages: number
    }
  >()
  const dayMap = new Map<string, number>()
  const dayCacheMap = new Map<string, number>()
  for (const day of recentDays) {
    dayMap.set(day, 0)
    dayCacheMap.set(day, 0)
  }

  for (const m of messages) {
    const prompt = m.promptTokens ?? 0
    const completion = m.completionTokens ?? 0
    // cacheReadTokens 是 promptTokens 的子集(上游计费口径),不是额外增量
    const cacheRead = m.cacheReadTokens ?? 0
    const cacheWrite = m.cacheWriteTokens ?? 0
    totalPrompt += prompt
    totalCompletion += completion
    totalCacheRead += cacheRead
    totalCacheWrite += cacheWrite

    const modelKey = m.model || "未知模型"
    const entry = modelMap.get(modelKey) ?? {
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      messages: 0,
    }
    entry.promptTokens += prompt
    entry.completionTokens += completion
    entry.cacheReadTokens += cacheRead
    entry.messages += 1
    modelMap.set(modelKey, entry)

    const day = dayKeyOf(m.createdAt)
    if (recentDaySet.has(day)) {
      dayMap.set(day, (dayMap.get(day) ?? 0) + prompt + completion)
      dayCacheMap.set(day, (dayCacheMap.get(day) ?? 0) + cacheRead)
    }
  }

  const byModel = Array.from(modelMap.entries())
    .map(([model, v]) => ({
      model,
      promptTokens: v.promptTokens,
      completionTokens: v.completionTokens,
      cacheReadTokens: v.cacheReadTokens,
      totalTokens: v.promptTokens + v.completionTokens,
      messages: v.messages,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens)

  const byDay = recentDays.map((date) => ({
    date,
    totalTokens: dayMap.get(date) ?? 0,
    cacheReadTokens: dayCacheMap.get(date) ?? 0,
  }))

  return {
    totals: {
      promptTokens: totalPrompt,
      completionTokens: totalCompletion,
      cacheReadTokens: totalCacheRead,
      cacheWriteTokens: totalCacheWrite,
      totalTokens: totalPrompt + totalCompletion,
      messages: messages.length,
    },
    byModel,
    byDay,
  }
}

// ── 生图(张数维度) ─────────────────────────────────────────────────────────
async function aggregateImage(
  userId: string,
  recentDays: string[],
  recentDaySet: Set<string>,
  dayKeyOf: (d: Date) => string
) {
  // 仅取统计所需字段;历史量大时 groupBy 更高效,但 Prisma 不支持按日期分桶,先取后聚合
  const images = await prisma.generatedImage.findMany({
    where: { userId },
    select: {
      model: true,
      size: true,
      createdAt: true,
    },
  })

  const modelMap = new Map<string, { count: number }>()
  const sizeMap = new Map<string, number>()
  const dayMap = new Map<string, number>()
  for (const day of recentDays) dayMap.set(day, 0)

  for (const img of images) {
    const modelKey = img.model || "未知模型"
    const modelEntry = modelMap.get(modelKey) ?? { count: 0 }
    modelEntry.count += 1
    modelMap.set(modelKey, modelEntry)

    const sizeKey = img.size || "未知尺寸"
    sizeMap.set(sizeKey, (sizeMap.get(sizeKey) ?? 0) + 1)

    const day = dayKeyOf(img.createdAt)
    if (recentDaySet.has(day)) {
      dayMap.set(day, (dayMap.get(day) ?? 0) + 1)
    }
  }

  const byModel = Array.from(modelMap.entries())
    .map(([model, v]) => ({ model, count: v.count }))
    .sort((a, b) => b.count - a.count)

  const bySize = Array.from(sizeMap.entries())
    .map(([size, count]) => ({ size, count }))
    .sort((a, b) => b.count - a.count)

  const byDay = recentDays.map((date) => ({
    date,
    count: dayMap.get(date) ?? 0,
  }))

  return {
    totals: { count: images.length },
    byModel,
    bySize,
    byDay,
  }
}
