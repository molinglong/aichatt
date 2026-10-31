/**
 * /uploads 静态兜底路由(生产模式修复)。
 *
 * 背景:Next 生产模式(standalone)启动时把 public/ 的文件清单一次性固化进内存
 * (setupFsCheck,仅 !dev 时执行),运行期新写入 public/uploads 的文件不在清单里,
 * 静态层直接 404(直到容器重启)。生图产物、聊天附件都是运行期落盘,故线上新图必裂。
 * 本地 dev 每次请求动态查盘,所以不复现。
 *
 * 本动态路由在静态层未命中时兜底读盘返回,URL 不变、存储目录不变;
 * 容器启动后新写入的文件即刻可访问,无需重启。
 */
import path from "path"
import { readFile } from "fs/promises"
import { NextRequest } from "next/server"
import { sanitizeUploadName } from "@/lib/upload-name"

// 必须动态:读的是运行期磁盘状态,不能被构建期静态化/缓存
export const dynamic = "force-dynamic"

const UPLOAD_DIR = path.resolve(process.cwd(), "public", "uploads")

// 单段也可能带穿越/绝对路径/盘符/空字节/反斜杠(URL 解码产物), 一律按非法处理
function isUnsafeSegment(segment: string): boolean {
  return (
    segment.includes("..") ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes("\0") ||
    path.isAbsolute(segment) ||
    /^[A-Za-z]:/.test(segment)
  )
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { path: string[] } }
) {
  // uploads 目录是平铺结构(文件名 = 随机 id + 扩展名),多段路径一律非法
  const segments = params.path ?? []
  if (segments.length !== 1 || isUnsafeSegment(segments[0])) {
    return new Response("Not Found", { status: 404 })
  }
  // 文件名白名单校验(防路径穿越;与上传/生图落盘命名同一规范)
  const name = sanitizeUploadName(segments[0])
  if (!name) {
    return new Response("Not Found", { status: 404 })
  }
  // 纵深防御:解析结果必须严格落在 uploads 根目录内
  const filePath = path.resolve(UPLOAD_DIR, name)
  if (!filePath.startsWith(UPLOAD_DIR + path.sep)) {
    return new Response("Not Found", { status: 404 })
  }

  let buffer: Buffer
  try {
    buffer = await readFile(filePath)
  } catch {
    return new Response("Not Found", { status: 404 })
  }

  const ext = path.extname(name).toLowerCase()
  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": MIME_BY_EXT[ext] ?? "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      // 文件名随机且内容不可变 → 可长缓存(与静态层同 URL 语义一致)
      "Cache-Control": "public, max-age=604800",
    },
  })
}
