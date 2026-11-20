/**
 * PDF 录题 · 创建作业:
 * - POST /api/papers/pdf-import  FormData { file, subject, title?, year?, examType? }
 *   落盘 data/exam-papers/<id>/source.pdf → unpdf 逐页抽文本 → 判文本版/扫描版 → 建作业行。
 * - 拍照/图片上传:FormData { images: File[](按页序), 其余同上 }——服务端归一化(EXIF 转正/
 *   白底/限宽)后合成多页 PDF,下游切题/页图/审核台与 PDF 完全同链路(必然走扫描版视觉)。
 *   切题由客户端按块驱动(POST .../split),本路由保持秒级返回。
 */
import { NextRequest } from "next/server"
import { mkdir, writeFile } from "fs/promises"
import type { Prisma } from "@/generated/prisma/client"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"
import { extractPdfPages, imagesToPdfBuffer, importDir, MAX_IMPORT_IMAGES } from "@/lib/papers/pdf-import.server"
import { SCANNED_PDF_MIN_CHARS } from "@/lib/file-parser"
import { EMPTY_IMPORT_META } from "@/lib/papers/pdf-import"

export const dynamic = "force-dynamic"

const MAX_PDF_BYTES = 30 * 1024 * 1024
const IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"])
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"])

const SUBJECTS = new Set([
  "math", "chinese", "english", "physics", "chemistry",
  "biology", "history", "politics", "geography", "other",
])

const extOf = (name: string) => {
  const i = name.lastIndexOf(".")
  return i >= 0 ? name.slice(i).toLowerCase() : ""
}

export async function POST(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return Response.json({ error: "bad_form" }, { status: 400 })
  }
  const file = form.get("file")
  const imageFiles = form.getAll("images").filter((f): f is File => f instanceof File && f.size > 0)
  const hasImages = imageFiles.length > 0

  if (hasImages) {
    if (imageFiles.length > MAX_IMPORT_IMAGES) {
      return Response.json({ error: "too_many_images", detail: `一次最多 ${MAX_IMPORT_IMAGES} 张` }, { status: 400 })
    }
    const bad = imageFiles.find((f) => !IMAGE_MIME.has(f.type) && !IMAGE_EXT.has(extOf(f.name)))
    if (bad) return Response.json({ error: "not_image", detail: bad.name.slice(0, 80) }, { status: 400 })
    const total = imageFiles.reduce((s, f) => s + f.size, 0)
    if (total > MAX_PDF_BYTES) return Response.json({ error: "too_large" }, { status: 400 })
  } else {
    if (!(file instanceof File)) return Response.json({ error: "no_file" }, { status: 400 })
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      return Response.json({ error: "not_pdf" }, { status: 400 })
    }
    if (file.size > MAX_PDF_BYTES) return Response.json({ error: "too_large" }, { status: 400 })
  }

  const subject = String(form.get("subject") ?? "")
  if (!SUBJECTS.has(subject)) return Response.json({ error: "bad_subject" }, { status: 400 })
  const title = String(form.get("title") ?? "").trim().slice(0, 80)
  const year = String(form.get("year") ?? "").trim().slice(0, 20)
  const examType = String(form.get("examType") ?? "").trim().slice(0, 20)

  // 图片路径:归一化 + 合成多页 PDF(失败=有图读不出来);PDF 路径:原样透传
  let buffer: Buffer
  let sourceFileName: string
  let defaultTitle: string
  if (hasImages) {
    try {
      const bufs = await Promise.all(imageFiles.map((f) => f.arrayBuffer().then((ab) => Buffer.from(ab))))
      buffer = await imagesToPdfBuffer(bufs)
    } catch (err) {
      console.error("[pdf-import] image→pdf failed:", err instanceof Error ? err.message : err)
      return Response.json({ error: "image_unreadable" }, { status: 400 })
    }
    sourceFileName = imageFiles.length === 1 ? imageFiles[0].name : `${imageFiles.length} 张图片`
    defaultTitle = imageFiles.length === 1 ? imageFiles[0].name.replace(/\.(jpe?g|png|webp)$/i, "") : "拍照录题"
  } else {
    buffer = Buffer.from(await (file as File).arrayBuffer())
    sourceFileName = (file as File).name
    defaultTitle = sourceFileName.replace(/\.pdf$/i, "")
  }

  // 逐页抽文本判定文本版/扫描版;抽取失败仍允许建作业(扫描版不依赖文本层)
  let pageCount = 0
  let pageTexts: string[] = []
  let extractError: string | null = null
  try {
    const extracted = await extractPdfPages(buffer)
    pageCount = extracted.pageCount
    pageTexts = extracted.pageTexts.map((t) => (t ?? "").trim())
  } catch (err) {
    extractError = err instanceof Error ? err.message : String(err)
  }
  if (!pageCount) return Response.json({ error: "pdf_unreadable", detail: extractError }, { status: 400 })

  const mode = pageTexts.join("").length >= SCANNED_PDF_MIN_CHARS ? "text" : "scan"

  const job = await prisma.paperImport.create({
    data: {
      userId,
      status: "splitting",
      fileName: sourceFileName.slice(0, 120),
      subject,
      title: title || defaultTitle.slice(0, 80),
      pageCount,
      mode,
      pageTexts: mode === "text" ? pageTexts : [],
      meta: (year || examType
        ? { ...EMPTY_IMPORT_META, year: year || null, examType: examType || null }
        : EMPTY_IMPORT_META) as unknown as Prisma.InputJsonValue,
      candidates: [],
    },
  })

  try {
    await mkdir(importDir(job.id), { recursive: true })
    await writeFile(`${importDir(job.id)}/source.pdf`, buffer)
  } catch (err) {
    // 落盘失败:作业没有 PDF 可回看,直接作废
    await prisma.paperImport.delete({ where: { id: job.id } }).catch(() => {})
    console.error("[pdf-import] save file failed:", err)
    return Response.json({ error: "save_failed" }, { status: 500 })
  }

  return Response.json({ id: job.id, mode, pageCount })
}
