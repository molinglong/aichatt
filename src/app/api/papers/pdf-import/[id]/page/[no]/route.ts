/**
 * PDF 录题 · 单页资产(GET {id}/page/{no}):
 * 返回 { dataUrl, width, height, items }——页图(服务端 2x 渲染,落盘缓存)+
 * 文本项坐标(PDF pt,DB 缓存)。审核台客户端零 pdfjs,叠加高亮按百分比定位。
 */
import { NextRequest } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"
import { loadPageAssets } from "@/lib/papers/pdf-import.server"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; no: string }> }) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })
  const { id, no } = await params
  const job = await prisma.paperImport.findFirst({
    where: { id, userId },
    select: { id: true, pageCount: true, pageBoxes: true },
  })
  if (!job) return Response.json({ error: "not_found" }, { status: 404 })
  const pageNo = Number(no)
  if (!Number.isInteger(pageNo) || pageNo < 1 || pageNo > job.pageCount) {
    return Response.json({ error: "bad_page" }, { status: 400 })
  }
  try {
    const asset = await loadPageAssets(prisma, job, pageNo)
    return Response.json(asset, {
      headers: { "Cache-Control": "private, max-age=3600" },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[pdf-import] page asset ${id}#${pageNo} failed:`, msg)
    return Response.json({ error: "page_failed", detail: msg }, { status: 500 })
  }
}
