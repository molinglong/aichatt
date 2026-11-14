/**
 * 试卷预览元数据路由:
 * - GET /api/papers/[slug]  整卷元数据 + 逐页题号索引(pages[].numbers)与题号→页码映射(questionPages)
 * 原卷页面预览(PaperPage)此前只在库中无 UI;本路由为 /papers/[slug] 预览页供数据。
 * 鉴权:登录 + 归属(自己名下或公共库主人名下均可读;写路径另按 owner 校验)。
 */
import { NextRequest } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { libraryScopes } from "@/lib/library-scope"
import { prisma } from "@/lib/db"

export const dynamic = "force-dynamic"

/** 从 PaperPage html 片段扫描题号(契约:<div class="question" data-number="N">)。
 * 与 import-exam-paper.cjs 同一判定口径:凡带合法 data-number 的 div 开标签即题容器。 */
function scanQuestionNumbers(html: string): number[] {
  const out: number[] = []
  const divRe = /<div\b[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = divRe.exec(html))) {
    const n = /(?:^|\s)data-number="(\d+)"/.exec(m[0])
    if (n) out.push(Number(n[1]))
  }
  return out
}

/** GET 整卷元数据 + 题号→页码定位 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const userId = await getUserId(_req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })

  const { slug } = await params
  const paper = await prisma.paper.findFirst({ where: { slug, userId: { in: await libraryScopes(userId) } } })
  if (!paper) return Response.json({ error: "not_found" }, { status: 404 })

  const pages = await prisma.paperPage.findMany({
    where: { paperId: paper.id },
    orderBy: { pageNo: "asc" },
    select: { pageNo: true, html: true },
  })

  const pageItems = pages.map((p) => ({ pageNo: p.pageNo, numbers: scanQuestionNumbers(p.html) }))
  const questionPages: Record<string, number> = {}
  for (const p of pageItems) for (const n of p.numbers) if (!(n in questionPages)) questionPages[String(n)] = p.pageNo

  return Response.json({
    slug: paper.slug,
    title: paper.title,
    subject: paper.subject,
    year: paper.year,
    region: paper.region,
    examType: paper.examType,
    totalPages: pages.length,
    pages: pageItems,
    questionPages,
  })
}
