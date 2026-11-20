import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { providers, getEffectiveModels } from "@/lib/ai/registry"

/**
 * GET /api/providers
 * 返回服务商列表及其模型信息。
 * - 静态字段（id、name、原始 models id 列表）始终基于内置硬编码。
 * - `effectiveModels` 字段基于当前用户的覆盖（隐藏 + 添加）计算。
 * - `hasKey` 标记该用户是否配了该 provider 的 Key：前端据此过滤「可见但不可用」
 *   的内置模型（A15——explore 曾把没 Key 的 GPT-5.5 当默认值展示）。
 *
 * 注：早期版本未鉴权（静态元数据），改造后改为需要登录，
 * 因为 effectiveModels 是用户级数据，且前端使用同一接口渲染模型选择器。
 */
export async function GET(_req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }

  const userId = session.user.id
  const effectiveModels = await getEffectiveModels(userId)
  const keyedProviders = new Set(
    (await prisma.apiKey.findMany({ where: { userId }, select: { provider: true } })).map(
      (k) => k.provider
    )
  )

  const list = Object.values(providers).map((p) => {
    const builtinModelIds = p.models.filter((m) => !m.upstreamOnly).map((m) => m.id)
    const effective = effectiveModels.filter((m) => m.provider === p.id)
    const hasKey = keyedProviders.has(p.id)
    return {
      id: p.id,
      name: p.name,
      hasKey,
      models: builtinModelIds,
      // 当前用户可见的模型（含该 provider 下的内置 + 用户添加）
      effectiveModels: effective.map((m) => ({
        id: m.id,
        name: m.name,
        contextWindow: m.contextWindow,
        supportsVision: m.supportsVision,
        supportsFiles: m.supportsFiles,
        supportsReasoning: m.supportsReasoning,
        // 公共池门面模型需要该标志:选择器对它豁免「已配置 Key」过滤(全员可见)
        ...(m.publicPool ? { publicPool: true } : {}),
        // 供前端过滤「无 Key 且非公共池」的不可用模型
        ...(hasKey ? { hasKey: true } : {}),
      })),
    }
  })

  return NextResponse.json(list)
}
