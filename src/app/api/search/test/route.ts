import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/db"
import { decrypt } from "@/lib/crypto"
import { executeQianfanSearch } from "@/lib/ai/search-engines/qianfan"
import { executeTavilySearch } from "@/lib/ai/search-engines/tavily"
import { executeDeepseekSearch } from "@/lib/ai/search-engines/deepseek"
import type { SearchEngineId } from "@/lib/ai/search-engines"
import { SEARCH_ENGINES } from "@/lib/ai/search-engines"

/**
 * POST /api/search/test
 * Body: { query: string, engine?: SearchEngineId }
 * 用用户配置的联网搜索 Key 执行一次真实搜索，返回前 3 条结果。
 * 用于设置页"测试搜索"按钮，验证 Key 有效性与搜索可用性。
 * engine 默认 qianfan。
 */
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }

  const body = await req.json().catch(() => null)
  const query = typeof body?.query === "string" ? body.query.trim() : ""
  const engine: SearchEngineId = (body?.engine && typeof body.engine === "string" && body.engine in SEARCH_ENGINES)
    ? body.engine
    : "qianfan"

  if (!query) {
    return NextResponse.json({ error: "请输入搜索关键词" }, { status: 400 })
  }

  const keyRecord = await prisma.searchApiKey.findUnique({
    where: { userId_engine: { userId: session.user.id, engine } },
  })
  if (!keyRecord) {
    return NextResponse.json(
      { error: `尚未配置 ${SEARCH_ENGINES[engine].name} 联网搜索 Key，请先在下方设置` },
      { status: 400 }
    )
  }

  let apiKey: string
  try {
    apiKey = decrypt(keyRecord.encryptedKey)
  } catch (err) {
    console.error("[search/test] 解密 Key 失败:", err)
    return NextResponse.json({ error: "API Key 解密失败" }, { status: 500 })
  }

  try {
    const results =
      engine === "tavily"
        ? await executeTavilySearch(query, apiKey, 3)
        : engine === "deepseek"
          ? await executeDeepseekSearch(query, apiKey, 3)
          : await executeQianfanSearch(query, apiKey, 3)
    return NextResponse.json({ ok: true, items: results, engine })
  } catch (err) {
    const message = err instanceof Error ? err.message : "搜索失败"
    console.error(`[search/test] ${engine} 搜索失败:`, message)
    return NextResponse.json({ error: message, engine }, { status: 502 })
  }
}
