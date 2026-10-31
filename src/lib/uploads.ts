/**
 * 上传文件的服务端管理助手。
 * 负责:文件名校验、磁盘删除、孤儿清理(未被消息引用且超时的文件)。
 * 仅可在服务端使用(fs / prisma 依赖)。
 */
import path from "path"
import { readFile, readdir, stat, unlink } from "fs/promises"
import { prisma } from "@/lib/db"
import { sanitizeUploadName } from "@/lib/upload-name"

export const UPLOAD_DIR = path.join(process.cwd(), "public", "uploads")

// 文件名校验的实现移到了无 fs/prisma 依赖的 @/lib/upload-name,
// 供 /uploads 静态兜底路由复用;此处 re-export 保持既有调用方不变
export { sanitizeUploadName }

/** 收集全库被引用的附件文件名(聊天消息 / 生图产物 / 错题本题目截图) */
export async function collectReferencedUploadNames(): Promise<Set<string>> {
  const [msgRows, imgRows, noteRows] = await Promise.all([
    prisma.message.findMany({
      where: { attachments: { not: null } },
      select: { attachments: true },
    }),
    // 生图产物(workspace 工作台 + chat 对话中触发的)也会落盘到 /uploads,
    // 必须一并扫描,避免被 24h 孤儿清理误删导致历史消息图片裂开
    prisma.generatedImage.findMany({
      select: { url: true },
    }),
    // 错题本题目截图:可能只被 StudyNote 引用(会话删除后仍要保留)
    prisma.studyNote.findMany({
      where: { imageUrl: { not: null } },
      select: { imageUrl: true },
    }),
  ])
  const names = new Set<string>()
  for (const row of msgRows) {
    for (const name of parseAttachmentNames(row.attachments)) {
      names.add(name)
    }
  }
  for (const row of imgRows) {
    const name = sanitizeUploadName(row.url)
    if (name) names.add(name)
  }
  for (const row of noteRows) {
    if (row.imageUrl) {
      const name = sanitizeUploadName(row.imageUrl)
      if (name) names.add(name)
    }
  }
  return names
}

/** 解析一条消息的 attachments JSON,返回其中的合法文件名列表 */
export function parseAttachmentNames(attachmentsJson: string | null): string[] {
  if (!attachmentsJson) return []
  try {
    const list = JSON.parse(attachmentsJson)
    if (!Array.isArray(list)) return []
    const names: string[] = []
    for (const att of list) {
      if (att && typeof att.url === "string") {
        const name = sanitizeUploadName(att.url)
        if (name) names.push(name)
      }
    }
    return names
  } catch {
    return []
  }
}

/** 解析 GeneratedImage.url(/uploads/xxx.png)得到文件名 */
export function parseGeneratedImageName(url: string | null | undefined): string | null {
  if (!url) return null
  return sanitizeUploadName(url)
}

/** 删除一条消息 attachments JSON 中引用的全部文件(级联清理用) */
export async function deleteReferencedFiles(attachmentsJson: string | null): Promise<void> {
  for (const name of parseAttachmentNames(attachmentsJson)) {
    await deleteUploadFile(name)
  }
}

/** 删除一个上传文件及其中转站记录(不存在时静默成功) */
export async function deleteUploadFile(name: string): Promise<void> {
  const safe = sanitizeUploadName(name)
  if (!safe) return
  // 同步删除中转站记录(调用方:未发送附件删除 / 消息级联清理 / 孤儿清扫)
  await prisma.uploadFile.deleteMany({ where: { fileName: safe } }).catch((err) => {
    console.error("[uploads] Failed to delete UploadFile record:", safe, err)
  })
  try {
    await unlink(path.join(UPLOAD_DIR, safe))
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== "ENOENT") {
      console.error("[uploads] Failed to delete file:", name, err)
    }
  }
}

/**
 * 孤儿清理:删除超过 maxAgeMs 且未被任何消息引用的上传文件。
 * 兜底"上传了但未发送就离开页面"的场景。
 */
export async function sweepOrphanUploads(maxAgeMs: number): Promise<number> {
  let entries: string[]
  try {
    entries = await readdir(UPLOAD_DIR)
  } catch {
    return 0
  }
  const referenced = await collectReferencedUploadNames()
  const now = Date.now()
  let removed = 0
  for (const entry of entries) {
    if (entry === ".gitkeep") continue
    if (referenced.has(entry)) continue
    const filePath = path.join(UPLOAD_DIR, entry)
    try {
      const info = await stat(filePath)
      if (now - info.mtimeMs > maxAgeMs) {
        await unlink(filePath)
        // 文件被清,中转站记录一并删除
        await prisma.uploadFile.deleteMany({ where: { fileName: entry } }).catch(() => {})
        removed++
      }
    } catch {
      // 文件可能已被并发删除,忽略
    }
  }
  return removed
}

/** 孤儿文件保留时长:超过 24 小时且未被任何消息引用则清理 */
export const ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** 孤儿清扫节流窗口:1 小时内至多一次全库引用扫描 */
const SWEEP_THROTTLE_MS = 60 * 60 * 1000
let lastSweepAt = 0

/**
 * 带节流的孤儿清扫入口(触发点:上传 POST / 消息创建后,均为 fire-and-forget)。
 * 失败时重置节流,允许下次调用立即重试。
 */
export function sweepOrphanUploadsThrottled(
  maxAgeMs: number = ORPHAN_MAX_AGE_MS
): void {
  const now = Date.now()
  if (now - lastSweepAt < SWEEP_THROTTLE_MS) return
  lastSweepAt = now
  sweepOrphanUploads(maxAgeMs).catch((err) => {
    console.error("[uploads] Orphan sweep failed:", err)
    lastSweepAt = 0
  })
}

/** 读取上传文件的原始内容(先校验文件名) */
export async function readUploadFile(name: string): Promise<Buffer | null> {
  const safe = sanitizeUploadName(name)
  if (!safe) return null
  try {
    return await readFile(path.join(UPLOAD_DIR, safe))
  } catch {
    return null
  }
}

/** 将上传文件读为 data URL(base64),用于多模态 image part */
export async function readUploadAsDataUrl(name: string, mimeType: string): Promise<string | null> {
  const buffer = await readUploadFile(name)
  if (!buffer) return null
  return `data:${mimeType};base64,${buffer.toString("base64")}`
}
