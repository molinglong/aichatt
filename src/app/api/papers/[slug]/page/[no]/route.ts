/**
 * 试卷预览单页路由:
 * - GET /api/papers/[slug]/page/[no]  返回该页 PaperPage 原始 html 片段(PaperPage 是整卷原件,不可动)
 * 供 /papers/[slug] 预览页取页渲染;片段为 <article> 契约结构,由前端套纸质样式渲染。
 * 鉴权:登录 + paper.userId 归属校验;防 XSS 顺手剥 <script>(契约内容本不含,防御性)。
 */
import { NextRequest } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"

export const dynamic = "force-dynamic"

/** GET 单页 html */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ slug: string; no: string }> }) {
  const userId = await getUserId(_req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })

  const { slug, no } = await params
  const pageNo = Number(no)
  if (!Number.isInteger(pageNo) || pageNo < 1) return Response.json({ error: "invalid_page" }, { status: 400 })

  const paper = await prisma.paper.findFirst({ where: { slug, userId }, select: { id: true } })
  if (!paper) return Response.json({ error: "not_found" }, { status: 404 })

  const page = await prisma.paperPage.findUnique({
    where: { paperId_pageNo: { paperId: paper.id, pageNo } },
    select: { html: true },
  })
  if (!page) return Response.json({ error: "page_not_found" }, { status: 404 })

  return Response.json({ html: page.html.replace(/<script[\s\S]*?<\/script>/gi, "") })
}
