/**
 * /kb-pages 静态兜底路由(课本页图)。
 *
 * 页图由导入脚本运行期落盘到 public/kb-pages/{bookKey}/pNNN.webp,与
 * /uploads 同理:Next 生产模式(standalone)启动时固化 public 文件清单,
 * 新写入的文件静态层直接 404,必须走本动态路由读盘返回。
 *
 * 不放 public/uploads 的原因:uploads 有 24h 孤儿清扫(未被消息引用即删),
 * 课本页图是长期资产,会被误清。独立目录 + 独立路由,互不干扰。
 *
 * 路径结构固定两段:{bookKey(nanoid12)}/{pNNN.webp},与 /uploads 平铺不同。
 */
import path from "path"
import { readFile } from "fs/promises"
import { NextRequest } from "next/server"
import { sanitizeUploadName } from "@/lib/upload-name"

// 必须动态:读的是运行期磁盘状态,不能被构建期静态化/缓存
export const dynamic = "force-dynamic"

const KB_PAGES_DIR = path.resolve(process.cwd(), "public", "kb-pages")

// 单段路径非法字符校验(与 /uploads 同口径:防穿越/绝对路径/盘符/空字节)
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

export async function GET(
  _req: NextRequest,
  { params }: { params: { path: string[] } }
) {
  const segments = params.path ?? []
  // 固定两段:bookKey/文件名;bookKey 是 nanoid(12) 目录名,文件名 pNNN.webp
  if (segments.length !== 2 || segments.some(isUnsafeSegment)) {
    return new Response("Not Found", { status: 404 })
  }
  const [bookKey, fileName] = segments
  const safeKey = sanitizeUploadName(bookKey)
  const safeName = sanitizeUploadName(fileName)
  if (!safeKey || !safeName) {
    return new Response("Not Found", { status: 404 })
  }
  // 纵深防御:解析结果必须严格落在 kb-pages 根目录内
  const filePath = path.resolve(KB_PAGES_DIR, safeKey, safeName)
  if (!filePath.startsWith(KB_PAGES_DIR + path.sep)) {
    return new Response("Not Found", { status: 404 })
  }

  let buffer: Buffer
  try {
    buffer = await readFile(filePath)
  } catch {
    return new Response("Not Found", { status: 404 })
  }

  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "image/webp",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      // bookKey 随机且页图内容不可变(重新导入会覆盖同名文件,URL 语义仍成立) → 可长缓存
      "Cache-Control": "public, max-age=604800",
    },
  })
}
