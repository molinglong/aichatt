/**
 * PDF 录题 · 原文件流(GET):审核台客户端 pdfjs 渲染页图用。仅作业本人可读。
 */
import { NextRequest } from "next/server"
import { readFile } from "fs/promises"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"
import { importPdfPath } from "@/lib/papers/pdf-import.server"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })
  const { id } = await params
  const job = await prisma.paperImport.findFirst({ where: { id, userId }, select: { id: true } })
  if (!job) return Response.json({ error: "not_found" }, { status: 404 })
  try {
    const buf = await readFile(importPdfPath(id))
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/pdf",
        "Cache-Control": "private, max-age=3600",
      },
    })
  } catch {
    return Response.json({ error: "pdf_missing" }, { status: 404 })
  }
}
