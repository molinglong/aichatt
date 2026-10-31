import { NextResponse } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"
import { getEffectiveModels } from "@/lib/ai/registry"

/**
 * 手表端可选模型列表：只返回该账号「已配置 Key、可直接调用」的模型。
 * 公共池门面模型（publicPool）不返回 —— quick-chat 未接公共池计费，
 * 显式传门面 id 会被上游拒绝。
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const userId = await getUserId(req)
  if (!userId) {
    return NextResponse.json({ error: "登录已失效，请检查 API 令牌" }, { status: 401 })
  }

  const models = await getEffectiveModels(userId)
  const result: Array<{ id: string; name: string }> = []

  for (const model of models) {
    if (model.publicPool) continue

    if (model.id.startsWith("custom:")) {
      const row = await prisma.customModel
        .findFirst({
          where: { id: model.id.slice(7), userId },
          select: { apiKey: true, keyProvider: true },
        })
        .catch(() => null)
      if (row && (row.apiKey || row.keyProvider)) {
        result.push({ id: model.id, name: model.name })
      }
      continue
    }

    const key = await prisma.apiKey
      .findUnique({
        where: { userId_provider: { userId, provider: model.provider } },
        select: { id: true },
      })
      .catch(() => null)

    if (key || (model.provider === "qianwen" && Boolean(process.env.API_KEY_DASHSCOPE))) {
      result.push({ id: model.id, name: model.name })
    }
  }

  return NextResponse.json({ models: result })
}
