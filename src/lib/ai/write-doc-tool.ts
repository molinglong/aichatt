import { z } from "zod"
import { DEAI_WRITING_DISCIPLINE } from "@/lib/text/deai"

/**
 * 写作文档工具（write_document）
 *
 * 设计目标：用户在普通聊天里要一篇文字成品时（长短不限，微博体短文也算），
 * 模型把完整正文写进写作画布（/write）的文档，聊天流内只渲染一张文档卡片，
 * 点卡片深链进编辑器继续划词润色/续写 —— 豆包「帮我写作」的聊天互通形态。
 *
 * 与 generate_mask 的差异：**有 execute** —— 正文是用户明确要求的内容产物，
 * 直接落库（同 manage_todo 模式），不设"草稿确认"环节；误创建的文档可在
 * /write 列表里删除，成本远低于让用户在聊天里再点一次确认。
 *
 * 动作三种：create 新建文档；append 续写用户当前打开的文档（docId 由服务端
 * 注入的上下文提供——画布面板打开时前端随请求附带，模型只回传不凭空编）；
 * replace 整篇替换当前文档（压缩/扩写/改结尾等「改这篇」诉求，避免模型被迫
 * 新建「xx 版」副本把文档列表冲乱——2026-11-08 踩坑定案）。
 *
 * 值限制与 REST 校验（normalizeWriteTitle / MAX_WRITE_CONTENT_CHARS）对齐：
 * 入库走同一规则，不会有第二种文档口径。
 * 本文件纯常量无服务端依赖，客户端组件可安全 import。
 */

export const WRITE_DOC_TOOL_NAME = "write_document"

/** AI 创建写作文档的 schema（值限制与 /api/write/docs 校验对齐 + describe 指引） */
export const writeDocToolSchema = z.object({
  action: z
    .enum(["create", "append", "replace"])
    .default("create")
    .describe("create=新建文档;append=向已有文档末尾续写(必须传 docId);replace=整篇替换已有文档(压缩/扩写/改写等,必须传 docId)"),
  docId: z
    .string()
    .optional()
    .describe("append/replace 时目标文档 id,只来自系统注入的「当前打开文档」上下文,不要自己编造"),
  title: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe("文档标题，简短点题，最多 100 字；不填默认「未命名」"),
  content: z
    .string()
    .trim()
    .min(1)
    .max(30000)
    .describe("完整可直接使用的正文，段落之间用空行分隔；不要包含解释、标题记号或 Markdown 修饰；网页/HTML/代码等可执行产物不要用本工具（改走 write_code）"),
})

/**
 * 网页/HTML 源码特征探测 —— write_document 误路由拦截（服务端 execute 兜底）。
 * 只拦截"确凿的 HTML 网页源码"（开头 DOCTYPE/html 标签或整篇以 </html> 收尾），
 * 避免误伤正常的记叙/说明文（讲编程的文章里出现个别标签词属合法）。
 */
export function looksLikeHtmlPage(text: string): boolean {
  const head = text.slice(0, 600).toLowerCase()
  if (/^\s*<!doctype\s+html/.test(head)) return true
  if (/^\s*(<!--[\s\S]*?-->\s*)*<html[\s>]/.test(head)) return true
  const tail = text.slice(-80).toLowerCase()
  return head.includes("<body") && /<\/html>\s*$/.test(tail)
}

/** 工具输出（卡片据 ok 分支渲染成功/失败） */
export type WriteDocToolOutput =
  | { ok: true; action: "create" | "append" | "replace"; docId: string; title: string; charCount: number }
  | { ok: false; message: string }

/** 未知形状收窄：卡片/历史回放时判断 output 是否为成功的文档创建结果 */
export function isWriteDocOutput(o: unknown): o is WriteDocToolOutput {
  return (
    !!o &&
    typeof o === "object" &&
    "ok" in o &&
    typeof (o as { ok: unknown }).ok === "boolean"
  )
}

/** 注入 system prompt 的使用规则段 */
export const WRITE_DOC_TOOL_PROMPT: string = [
  "## 写作文档（write_document 工具）",
  "- 用户想要一篇可拿去发布/保存/使用的「人读文字成品」时，调用本工具把完整正文创建为写作文档：小说章节/故事/作文/演讲稿/公众号文章/正式文稿要调用，微博体短文、朋友圈文案、小红书笔记、贺卡祝词等短小的成篇内容同样要调用，篇幅长短不限",
  "- 判断标准是「成品还是回答」：一篇拿去用的东西→调用；对话里看的一个回答→不调用",
  "- 【高频误用警示】网页/HTML/CSS/JS、代码、脚本、配置文件等「可执行/机器可读」产物一律不要用本工具——用户说「写个主页/落地页/网站首页/网页」时默认是网页代码，必须改调 write_code 工具创建代码文档；本工具只收纯文字",
  "- 正文只写进工具参数，聊天回复里最多一句引入语（如「已写好，点卡片打开」），绝不要在聊天里重复正文",
  "- 上下文里给出「用户当前打开的写作文档」时,按诉求选动作:续写/接着写/往这篇补充 → action=append 传那个文档 id,content 只写新增的正文(与原文自然衔接,不要重复原文);压缩/缩短/扩写全篇/改写全文/换结尾等「整篇改这篇」诉求 → action=replace 传那个文档 id,content 写替换后的完整正文(标题不变,不要新建文档副本);未给出当前文档时不要编造 id,仍用 create 新建",
  "- 正文必须完整可直接使用：符合用户要求的题材、篇幅与文风，段落之间用空行分隔，不要出现解释或元话语",
  "- 问答、概念解释、翻译、闲聊等对话式内容不要调用本工具",
  "- 写小说/故事/网文类正文（含续写）时，以下文风纪律必须遵守，其他文体不受此约束：",
  DEAI_WRITING_DISCIPLINE,
].join("\n")
