import { NextRequest, NextResponse } from "next/server"
import { writeFile, mkdir } from "fs/promises"
import path from "path"
import { auth } from "@/lib/auth"
import { getUserId } from "@/lib/api-auth"
import { nanoid } from "nanoid"
import {
  UPLOAD_DIR,
  sanitizeUploadName,
  deleteUploadFile,
  collectReferencedUploadNames,
  sweepOrphanUploadsThrottled,
} from "@/lib/uploads"
import { prisma } from "@/lib/db"
import { monitor } from "@/lib/monitor"
import {
  parsePdf,
  parseTextFile,
  parseXlsx,
  parseDocx,
  parsePptx,
  parseHtmlText,
} from "@/lib/file-parser"

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB
// 支持图片、纯文本、PDF、Excel、Word、PPT、HTML;文本类扩展名兜底(Windows 下 .md/.json 可能被判为 octet-stream)
const EXTRA_MIME_TYPES = ["application/pdf", "application/json"]
const TEXT_EXT_FALLBACK = new Set([".txt", ".md", ".markdown", ".csv", ".log", ".json"])
// 可在浏览器上下文执行的类型一律拒绝(存储型 XSS 防线之一;响应层另有 CSP sandbox 兜底)。
// MIME 与扩展名双重校验:防改后缀绕过 MIME 检查,也防嗅探。
// 注意:text/html 与 .html/.htm 不在此列——它们走解析型上传,但落盘时强制改写为 .txt,
// 磁盘上永远不存在 .html 文件,/uploads 无从以 text/html 渲染(XSS 面为零)
const BLOCKED_MIME_TYPES = new Set(["image/svg+xml", "application/xhtml+xml"])
const BLOCKED_EXTENSIONS = new Set([
  ".xhtml", ".xht", ".svg", ".xml", ".xsl", ".xslt",
  ".js", ".mjs", ".cjs", ".jse", ".hta", ".htc", ".swf",
])

/** 归类上传文件:图片 / 文本 / PDF / Excel / Word / PPT / HTML;不支持返回 null */
function resolveKind(
  mimeType: string,
  fileName: string
): "image" | "text" | "pdf" | "sheet" | "docx" | "pptx" | "html" | null {
  const ext = path.extname(fileName).toLowerCase()
  // 先拦可执行/标记类类型(黑名单优先于前缀放行)
  if (BLOCKED_MIME_TYPES.has(mimeType) || BLOCKED_EXTENSIONS.has(ext)) return null
  if (mimeType.startsWith("image/")) return "image"
  if (mimeType === "application/pdf") return "pdf"
  if (
    (mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      mimeType === "application/vnd.ms-excel" ||
      (mimeType === "application/octet-stream" && (ext === ".xlsx" || ext === ".xls"))) &&
    (ext === ".xlsx" || ext === ".xls")
  ) {
    return "sheet"
  }
  if (
    (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      (mimeType === "application/octet-stream" && ext === ".docx")) &&
    ext === ".docx"
  ) {
    return "docx"
  }
  if (
    (mimeType === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
      (mimeType === "application/octet-stream" && ext === ".pptx")) &&
    ext === ".pptx"
  ) {
    return "pptx"
  }
  if (mimeType === "text/html" || ext === ".html" || ext === ".htm") return "html"
  if (
    mimeType.startsWith("text/") ||
    EXTRA_MIME_TYPES.includes(mimeType) ||
    (mimeType === "application/octet-stream" && TEXT_EXT_FALLBACK.has(ext))
  ) {
    return "text"
  }
  return null
}
// 孤儿文件保留时长与节流清扫入口见 @/lib/uploads(ORPHAN_MAX_AGE_MS / sweepOrphanUploadsThrottled)

export async function POST(req: NextRequest) {
  // 双通道:cookie session 或 Bearer 令牌(浏览器扩展上传截图)
  const userId = await getUserId(req)
  if (!userId) {
    return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }

  const contentType = req.headers.get("content-type") ?? ""
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json({ error: "请求格式应为 multipart/form-data" }, { status: 400 })
  }

  const formData = await req.formData()
  const file = formData.get("file") as File | null

  if (!file) {
    return NextResponse.json({ error: "没有收到文件" }, { status: 400 })
  }

  // Validate size
  if (file.size > MAX_FILE_SIZE) {
    monitor("upload_too_large", { size: file.size, name: file.name })
    return NextResponse.json(
      { error: `文件过大，单次上限 ${MAX_FILE_SIZE / 1024 / 1024}MB` },
      { status: 413 }
    )
  }

  // Validate type
  const kind = resolveKind(file.type, file.name)
  if (!kind) {
    monitor("upload_unsupported", { mime: file.type, name: file.name })
    return NextResponse.json(
      { error: `不支持的文件类型：${file.type}` },
      { status: 415 }
    )
  }

  // Generate unique filename(扩展名白名单化,保证后续清理/删除接口可识别)
  const rawExt = path.extname(file.name) || ""
  let ext = /^\.[A-Za-z0-9]{1,10}$/.test(rawExt) ? rawExt : ""
  // HTML 原文件一律以 .txt 落盘:浏览器无从以 text/html 渲染(存储型 XSS 防线);
  // originalName/mimeType 保留原值供前端识别,解析文本入库走中转站
  if (kind === "html") ext = ".txt"
  const uniqueName = `${nanoid(12)}${ext}`

  // Ensure uploads directory exists
  const uploadDir = UPLOAD_DIR
  await mkdir(uploadDir, { recursive: true })

  // Write file to disk
  const arrayBuffer = await file.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  const filePath = path.join(uploadDir, uniqueName)
  await writeFile(filePath, buffer)

  // 中转站:上传时即解析,聊天发送时直接取结果(失败不阻塞上传,标记 failed 供前端提示)
  let parseStatus: "done" | "failed" | "skipped" = "skipped"
  let parseError: string | null = null
  let parseText: string | null = null
  let pageCount: number | null = null
  try {
    if (kind === "text") {
      parseText = parseTextFile(buffer).text
      parseStatus = "done"
    } else if (kind === "pdf") {
      const parsed = await parsePdf(buffer)
      parseText = parsed.text
      pageCount = parsed.pageCount ?? null
      parseStatus = "done"
    } else if (kind === "sheet") {
      parseText = parseXlsx(buffer).text
      parseStatus = "done"
    } else if (kind === "docx") {
      parseText = (await parseDocx(buffer)).text
      parseStatus = "done"
    } else if (kind === "pptx") {
      const parsed = await parsePptx(buffer)
      parseText = parsed.text
      pageCount = parsed.pageCount ?? null
      parseStatus = "done"
    } else if (kind === "html") {
      parseText = parseHtmlText(buffer.toString("utf-8")).text
      parseStatus = "done"
    }
  } catch (err) {
    parseStatus = "failed"
    parseError = err instanceof Error ? err.message : "解析失败"
    console.error("[upload] Parse failed:", file.name, err)
  }

  // 登记中转站记录;失败则回滚已落盘文件,避免出现无记录的孤儿
  try {
    await prisma.uploadFile.create({
      data: {
        userId,
        fileName: uniqueName,
        originalName: file.name,
        mimeType: file.type,
        size: file.size,
        parseStatus,
        parseError,
        parseText,
        pageCount,
        charCount: parseText?.length ?? null,
      },
    })
  } catch (err) {
    await deleteUploadFile(uniqueName).catch(() => {})
    console.error("[upload] Failed to create UploadFile record:", err)
    return NextResponse.json({ error: "登记上传失败" }, { status: 500 })
  }

  // 顺手清理孤儿文件(上传了但从未发送、超过 24 小时未被引用的文件;1 小时节流)
  sweepOrphanUploadsThrottled()

  monitor("upload_ok", { kind, size: file.size, parseStatus, charCount: parseText?.length ?? null })

  return NextResponse.json({
    url: `/uploads/${uniqueName}`,
    name: file.name,
    type: file.type,
    size: file.size,
    parseStatus,
    ...(parseError ? { parseError } : {}),
    ...(pageCount != null ? { pageCount } : {}),
    ...(parseText != null ? { charCount: parseText.length } : {}),
  })
}

/**
 * 删除上传文件。仅允许删除"未被任何消息引用"的文件,
 * 已发送的附件文件需通过删除会话/消息级联清理。
 * Query: ?file=<filename>
 */
export async function DELETE(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "登录已失效，请重新登录后再试" }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const fileParam = searchParams.get("file")
  if (!fileParam) {
    return NextResponse.json({ error: "缺少参数 file" }, { status: 400 })
  }

  const name = sanitizeUploadName(fileParam)
  if (!name) {
    return NextResponse.json({ error: "文件名不合法" }, { status: 400 })
  }

  // 归属校验:记录存在但不属于当前用户一律 404(不泄露他人文件的存在性);
  // 记录不存在视为已被孤儿清扫或迁移前遗留文件,继续走删除以兼容前端重试
  const record = await prisma.uploadFile.findUnique({
    where: { fileName: name },
    select: { userId: true },
  })
  if (record && record.userId !== session.user.id) {
    return NextResponse.json({ error: "内容不存在或已被删除" }, { status: 404 })
  }

  // 已被消息引用的文件不允许单独删除(避免破坏历史消息展示)
  const referenced = await collectReferencedUploadNames()
  if (referenced.has(name)) {
    monitor("upload_delete_conflict", { file: name })
    return NextResponse.json(
      { error: "该文件仍被消息引用，暂时无法删除" },
      { status: 409 }
    )
  }

  await deleteUploadFile(name)
  return NextResponse.json({ success: true })
}
