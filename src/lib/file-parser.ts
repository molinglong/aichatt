/**
 * 文件中转站的解析层:把上传文件提取为纯文本/Markdown。
 * PDF 用 unpdf(pdfjs 的 serverless 构建,纯 JS,无 native 依赖);
 * Excel 用 SheetJS 转 Markdown 表格;Word 用 mammoth(HTML 中间层)转 Markdown;
 * PPT/PPTX 用 JSZip 解包后按页抽 XML 文本(标题/要点/表格/备注);
 * HTML 剥离可执行/样式块后转 Markdown;纯文本按 utf-8 全文读取;图片不走解析(由视觉模型直接看图)。
 * 仅可在服务端使用。
 */
import { extractText, getDocumentProxy } from "unpdf"
// SheetJS npm 源停留在 0.18.5(官方修复版只发 cdn.sheetjs.com,但该源在本项目网络环境不可达)。
// 已知 CVE(GHSA-4r6h ReDoS / GHSA-v9w6 原型污染)影响面:本项目仅 read+sheet_to_json 只读,
// 不使用 write/公式解析,污染路径不可达;若未来网络可达请升级 cdn 源 0.20.x
import * as XLSX from "xlsx"
import mammoth from "mammoth"
import TurndownService from "turndown"
import JSZip from "jszip"

export interface ParseResult {
  text: string
  pageCount?: number
}

/** 非空白字符低于该阈值视为扫描件/图片型 PDF(纯扫描页提取结果≈0,只混有页码/水印) */
export const SCANNED_PDF_MIN_CHARS = 10

export function isPdfMimeType(mimeType: string): boolean {
  return mimeType === "application/pdf"
}

/** 解析 PDF,提取全文与页数;失败时抛出异常,由调用方记录 parseError */
export async function parsePdf(buffer: Buffer): Promise<ParseResult> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer))
  const { totalPages, text } = await extractText(pdf, { mergePages: true })
  // unpdf 类型签名在 mergePages: true 时已把 text 收窄为 string
  return { text, pageCount: totalPages }
}

/** 纯文本文件按 utf-8 读取全文 */
export function parseTextFile(buffer: Buffer): ParseResult {
  return { text: buffer.toString("utf-8") }
}

/** XLSX 每个 sheet 转 Markdown 表格的最大行数(含表头),超出截断(注入时另有 20000 字符兜底) */
const XLSX_MAX_ROWS_PER_SHEET = 500

/** 解析 Excel(xlsx/xls),每个 sheet 输出一段 Markdown 表格;无数据时抛异常,由调用方记录 parseError */
export function parseXlsx(buffer: Buffer): ParseResult {
  const wb = XLSX.read(buffer, { type: "buffer" })
  const sections: string[] = []
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name]
    if (!sheet) continue
    // header:1 得二维数组;defval:"" 保证空单元格占位,否则行长度不齐导致 Markdown 表格错位
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      blankrows: false,
      defval: "",
    })
    if (!rows.length) continue
    const truncated = rows.length > XLSX_MAX_ROWS_PER_SHEET
    const slice = truncated ? rows.slice(0, XLSX_MAX_ROWS_PER_SHEET) : rows
    // 单元格内的 | 与换行会破坏 Markdown 表格结构,统一转义/压平
    const cells = (row: unknown[]) =>
      row.map((c) => String(c ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " "))
    const lines: string[] = [`## Sheet: ${name}`]
    lines.push(`| ${cells(slice[0]).join(" | ")} |`)
    lines.push(`| ${slice[0].map(() => "---").join(" | ")} |`)
    for (const row of slice.slice(1)) {
      lines.push(`| ${cells(row).join(" | ")} |`)
    }
    if (truncated) {
      lines.push(`（该 sheet 共 ${rows.length} 行，仅展示前 ${XLSX_MAX_ROWS_PER_SHEET} 行）`)
    }
    sections.push(lines.join("\n"))
  }
  if (!sections.length) {
    throw new Error("工作簿中没有可读取的数据")
  }
  return { text: sections.join("\n\n") }
}

// turndown 实例线程内复用;script/style 等噪音标签交给 stripNoiseBlocks 统一处理
const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" })
turndown.remove(["script", "style", "iframe", "noscript", "head"])

/** 剥离可执行/纯样式块与注释,防脚本内容混入解析结果 */
function stripNoiseBlocks(html: string): string {
  return html
    .replace(/<(script|style|iframe|noscript)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
}

function htmlToMarkdown(html: string): string {
  return turndown
    .turndown(stripNoiseBlocks(html))
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** 解析 Word(docx):mammoth 提取语义 HTML,再转 Markdown 保留标题/列表/加粗结构;不支持老版 .doc */
export async function parseDocx(buffer: Buffer): Promise<ParseResult> {
  const { value: html } = await mammoth.convertToHtml({ buffer })
  const md = htmlToMarkdown(html)
  if (!md) throw new Error("文档内容为空")
  return { text: md }
}

/** PPTX 最多解析的幻灯片数,防超大课件拖慢上传(超出截断并标注) */
const PPTX_MAX_SLIDES = 200

/** 解 XML 文本节点中的转义实体(ppt 里 &amp; &lt; &#x4E2D; 都常见) */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

/** 取一段 XML 里的段落文本:一个 <a:p> 一行,<a:br/> 断行,同段多个 <a:t> 运行拼接 */
function pptParagraphs(xml: string): string[] {
  const out: string[] = []
  for (const p of Array.from(xml.matchAll(/<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g))) {
    for (const chunk of p[1].split(/<a:br\s*\/>/)) {
      const text = Array.from(chunk.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g))
        .map((r) => decodeXmlEntities(r[1]))
        .join("")
        .replace(/\s+/g, " ")
        .trim()
      if (text) out.push(text)
    }
  }
  return out
}

/** 表格块(<a:tbl>)转 Markdown 表格:行列按第一个 <a:tc> 补齐,空单元格留空格占位 */
function pptTable(block: string): string {
  const rows: string[][] = []
  for (const tr of Array.from(block.matchAll(/<a:tr(?:\s[^>]*)?>([\s\S]*?)<\/a:tr>/g))) {
    const cells = Array.from(tr[1].matchAll(/<a:tc(?:\s[^>]*)?>([\s\S]*?)<\/a:tc>/g)).map(
      (tc) => pptParagraphs(tc[1]).join(" ").replace(/\|/g, "\\|") || " "
    )
    if (cells.length) rows.push(cells)
  }
  if (!rows.length) return ""
  const cols = Math.max(...rows.map((r) => r.length))
  const pad = (r: string[]) => [...r, ...Array<string>(cols - r.length).fill(" ")]
  const lines = [
    `| ${pad(rows[0]).join(" | ")} |`,
    `| ${Array<string>(cols).fill("---").join(" | ")} |`,
  ]
  for (const row of rows.slice(1)) lines.push(`| ${pad(row).join(" | ")} |`)
  return lines.join("\n")
}

/** 单页幻灯片 XML 转 Markdown:按形状出现顺序输出标题/要点,表格单独成表 */
function pptSlideToMarkdown(xml: string): string {
  const parts: string[] = []
  // 逐个形状、表格块扫描(不含 grpSp,分组里的子形状仍会被单独匹配到)
  for (const m of Array.from(xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>|<a:tbl>[\s\S]*?<\/a:tbl>/g))) {
    const block = m[0]
    if (block.startsWith("<a:tbl")) {
      const table = pptTable(block)
      if (table) parts.push(table)
      continue
    }
    // 页码/日期/页脚占位符是噪音
    if (/<p:ph[^>]*type="(?:dt|ftr|sldNum)"/.test(block)) continue
    const paras = pptParagraphs(block)
    if (!paras.length) continue
    const isTitle = /<p:ph[^>]*type="(?:title|ctrTitle)"/.test(block)
    parts.push(paras.map((p) => (isTitle ? `### ${p}` : `- ${p}`)).join("\n"))
  }
  return parts.join("\n\n")
}

/** 关系文件里的 Target 可能是 slides/slide1.xml、../notesSlides/x.xml 或 /ppt/... ,统一归一成 zip 内路径 */
function resolveZipPath(baseFile: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1)
  const parts = [...baseFile.split("/").slice(0, -1), ...target.split("/")]
  const out: string[] = []
  for (const p of parts) {
    if (p === "..") out.pop()
    else if (p && p !== ".") out.push(p)
  }
  return out.join("/")
}

/** 按 presentation.xml 的 sldIdLst 顺序取幻灯片路径(文件序号不能代表放映顺序),失败时回退按序号 */
async function orderedSlidePaths(zip: JSZip): Promise<string[]> {
  const presFile = "ppt/presentation.xml"
  const pres = await zip.file(presFile)?.async("string")
  const rels = await zip.file("ppt/_rels/presentation.xml.rels")?.async("string")
  if (pres && rels) {
    const targets = new Map<string, string>()
    for (const rel of Array.from(rels.matchAll(/<Relationship\b[^>]*>/g))) {
      const id = /\bId="([^"]+)"/.exec(rel[0])?.[1]
      const target = /\bTarget="([^"]+)"/.exec(rel[0])?.[1]
      if (id && target) targets.set(id, resolveZipPath(presFile, target))
    }
    const paths: string[] = []
    for (const sld of Array.from(pres.matchAll(/<p:sldId\b[^>]*>/g))) {
      const rid = /\br:id="([^"]+)"/.exec(sld[0])?.[1]
      const path = rid ? targets.get(rid) : undefined
      if (path && zip.file(path)) paths.push(path)
    }
    if (paths.length) return paths
  }
  return zip
    .file(/^ppt\/slides\/slide\d+\.xml$/)
    .map((f) => f.name)
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0))
}

/** 读取该页的演讲者备注(没有则返回空串);页码占位符内容过滤掉 */
async function readSlideNotes(zip: JSZip, slidePath: string): Promise<string> {
  const relsPath = slidePath.replace(/^(.*\/)([^/]+)$/, "$1_rels/$2.rels")
  const rels = await zip.file(relsPath)?.async("string")
  if (!rels) return ""
  for (const rel of Array.from(rels.matchAll(/<Relationship\b[^>]*>/g))) {
    if (!/notesSlide/.test(rel[0])) continue
    const target = /\bTarget="([^"]+)"/.exec(rel[0])?.[1]
    if (!target) continue
    const xml = await zip.file(resolveZipPath(slidePath, target))?.async("string")
    if (!xml) return ""
    return pptParagraphs(xml)
      .filter((t) => !/^\d{1,3}$/.test(t))
      .join(" ")
  }
  return ""
}

/** 解析 PPT/PPTX(仅 Office Open XML 的 .pptx):按页抽文字层;不支持老版二进制 .ppt */
export async function parsePptx(buffer: Buffer): Promise<ParseResult> {
  const zip = await JSZip.loadAsync(buffer)
  const slidePaths = await orderedSlidePaths(zip)
  if (!slidePaths.length) throw new Error("未在演示文稿中找到幻灯片")

  const limited = slidePaths.slice(0, PPTX_MAX_SLIDES)
  const sections: string[] = []
  for (let i = 0; i < limited.length; i++) {
    const xml = await zip.file(limited[i])?.async("string")
    if (!xml) continue
    const lines: string[] = [`## 第 ${i + 1} 页`]
    lines.push(pptSlideToMarkdown(xml) || "（本页无可提取文字，可能是图片或图表）")
    const notes = await readSlideNotes(zip, limited[i])
    if (notes) lines.push(`> 备注：${notes}`)
    sections.push(lines.join("\n"))
  }
  if (!sections.length) throw new Error("演示文稿中没有可读取的文字")
  if (limited.length < slidePaths.length) {
    sections.push(`（该演示文稿共 ${slidePaths.length} 页，仅解析前 ${PPTX_MAX_SLIDES} 页）`)
  }
  return { text: sections.join("\n\n"), pageCount: slidePaths.length }
}

/** 解析 HTML 文件文本为 Markdown;原文件落盘时强制改写为 .txt(见 upload route) */
export function parseHtmlText(html: string): ParseResult {
  const md = htmlToMarkdown(html)
  if (!md) throw new Error("未能从 HTML 中提取到文本")
  return { text: md }
}
