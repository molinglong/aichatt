import { tool } from "ai"
import { prisma } from "@/lib/db"
import { MAX_WRITE_CONTENT_CHARS, normalizeWriteTitle } from "@/lib/write/doc-input"
import { writeDocToolSchema, looksLikeHtmlPage, type WriteDocToolOutput } from "@/lib/ai/write-doc-tool"

/**
 * write_document 工具工厂（服务端专用，依赖 prisma；勿从客户端组件 import）。
 * 常量与 schema 在 write-doc-tool.ts（isomorphic），拆分原因见该文件头注释。
 *
 * 与 REST API（/api/write/docs）共用 WriteDoc 表与校验口径
 * （normalizeWriteTitle 同一函数），聊天创建的文档与 /write 手动新建完全互通。
 */
export function createWriteDocTool(userId: string) {
  return tool({
    description:
      "把成篇幅的「人读文字成品」（小说/故事/作文/演讲稿/公众号文章/文案）创建为用户的写作文档，" +
      "在写作画布(/write)中打开继续编辑。用户要求写这类内容时调用；" +
      "网页/HTML/代码等可执行产物改用 write_code，短回答、问答、翻译不要调用。",
    inputSchema: writeDocToolSchema,
    execute: async ({ action, docId, title, content }): Promise<WriteDocToolOutput> => {
      const body = content.trim()
      if (!body) {
        return { ok: false, message: "正文内容为空" }
      }
      // 误路由兜底：HTML 网页源码不应进写作画布（高频误用，提示模型改道 write_code）
      if (looksLikeHtmlPage(body)) {
        return {
          ok: false,
          message: "检测到这是网页/HTML 源码，属于代码产物：请改用 write_code 工具创建代码文档，不要用 write_document",
        }
      }
      try {
        if (action === "append") {
          if (!docId) {
            return { ok: false, message: "缺少要续写的文档 id" }
          }
          const doc = await prisma.writeDoc.findFirst({
            where: { id: docId, userId },
            select: { id: true, title: true, content: true },
          })
          if (!doc) {
            return { ok: false, message: "要续写的文档不存在或无权限" }
          }
          const merged = `${doc.content}\n\n${body}`
          if (merged.length > MAX_WRITE_CONTENT_CHARS) {
            return { ok: false, message: "续写后超过文档长度上限，请缩短本次内容" }
          }
          const updated = await prisma.writeDoc.update({
            where: { id: doc.id },
            data: { content: merged, charCount: merged.length },
            select: { id: true, title: true, charCount: true },
          })
          return { ok: true, action: "append", docId: updated.id, title: updated.title, charCount: updated.charCount }
        }
        if (action === "replace") {
          // 整篇替换:压缩/扩写/改写全文等「改这篇」诉求,标题保持不变,避免模型新建「xx 版」副本
          if (!docId) {
            return { ok: false, message: "缺少要替换的文档 id" }
          }
          const doc = await prisma.writeDoc.findFirst({
            where: { id: docId, userId },
            select: { id: true, title: true },
          })
          if (!doc) {
            return { ok: false, message: "要替换的文档不存在或无权限" }
          }
          if (body.length > MAX_WRITE_CONTENT_CHARS) {
            return { ok: false, message: "替换后超过文档长度上限，请缩短本次内容" }
          }
          const updated = await prisma.writeDoc.update({
            where: { id: doc.id },
            data: { content: body, charCount: body.length },
            select: { id: true, title: true, charCount: true },
          })
          return { ok: true, action: "replace", docId: updated.id, title: updated.title, charCount: updated.charCount }
        }
        const doc = await prisma.writeDoc.create({
          data: {
            userId,
            title: normalizeWriteTitle(title),
            content: body,
            charCount: body.length,
          },
          select: { id: true, title: true, charCount: true },
        })
        return { ok: true, action: "create", docId: doc.id, title: doc.title, charCount: doc.charCount }
      } catch {
        return { ok: false, message: "文档保存失败，请稍后重试" }
      }
    },
  })
}
