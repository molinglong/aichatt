/**
 * 个人笔记库工具(isomorphic 定义层):
 * 工具名/能力段文案/zod 输入/输出类型,零服务端依赖——前端 ToolCallCard 兜底卡也会 import 本文件。
 * 执行层见 vault-tool.server.ts(createVaultTool()),服务端直接读写 VAULT_DIR 文件夹(本地 dev/本机部署可用)。
 *
 * 定位:vault = 用户自己的长期笔记库(Obsidian 同构——就是一堆 Markdown 文件,
 * 装不装 Obsidian 都能用;装了后 Obsidian 打开同一文件夹即可)。
 * 与 write_document(写作画布成品)分工:画布产物是「作品」,vault 是「知识沉淀」。
 */
import { z } from 'zod'

export const VAULT_TOOL_NAME = 'vault'

export const VAULT_TOOL_PROMPT = `【个人笔记库】你已接入 vault 工具,可读写用户自己的 Markdown 笔记库(本地文件夹,Obsidian 兼容)。
- 触发:用户说「记到我的笔记/存进笔记/整理成笔记」「归档这道错题/这份讲义」「翻翻我的笔记」「我之前记过…吗」「按我的笔记出提纲」时调用;给用户讲完一大段有沉淀价值的内容(知识框架/易错点/结论),可以主动一句「要不要存进你的笔记」再动手,别不打招呼就写。
- 动作:search(跨笔记搜关键词)→ read(读笔记,支持行范围)→ list(列全部笔记,按更新时间倒序)→ write(写笔记)。
- 路径:一律相对 vault 根的相对路径(如 aichatt/数学/数列错题.md、英语/单词.md),子文件夹按「科目/主题」组织,不存在会自动创建;扩展名 .md 可省略(自动补)。
- 写入纪律:新笔记用 mode=create(文件已存在会失败,别硬写);往已有笔记补充用 mode=append;mode=overwrite 只允许 aichatt/ 命名空间内——用户自己手写的笔记受保护,绝不能覆盖。
- 笔记格式:文首 frontmatter(title/date/tags/subject,source 可选,如来源试卷或对话主题);正文是「整理后」的结构化笔记(要点/易错点/与旧知联系),不是原文堆砌;相关笔记用 [[wikilink]] 互链。
- 检索纪律:先 search 定位再 read 精读,别盲目通读;引用时给出笔记路径;vault 为空或没搜到时如实说明,别编造笔记内容。
- 分工:结构化错题数据(卷子/题号/丢分)入应用内错题本,个人理解与知识整理入 vault;用户没明确说要存哪边时,理解性内容默认 vault。`

export const vaultInputSchema = z.object({
  action: z
    .enum(['search', 'read', 'list', 'write'])
    .describe(
      'search=跨笔记搜关键词;read=读一篇笔记(支持行范围);list=列出全部笔记(按更新时间倒序);write=写笔记'
    ),
  path: z
    .string()
    .optional()
    .describe(
      'read/write 必填:相对 vault 根的路径(如 aichatt/数学/数列错题.md)。用 / 分层,不要盘符、不要绝对路径、不要 ..。.md 后缀可省略(自动补)'
    ),
  query: z
    .string()
    .optional()
    .describe('search 必填:关键词(不区分大小写的子串匹配,如「数列」「错题」)'),
  content: z
    .string()
    .optional()
    .describe('write 必填:Markdown 笔记全文(含 frontmatter)。mode=append 时是追加的段落'),
  mode: z
    .enum(['create', 'append', 'overwrite'])
    .optional()
    .describe(
      'write 可选,默认 create。create=新建(已存在会失败);append=追加到文末;overwrite=覆盖重写(仅限 aichatt/ 命名空间内,保护用户手写笔记)'
    ),
  offset: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('read 可选:起始行号(1-based),配合 limit 分页读大笔记'),
  limit: z
    .number()
    .int()
    .positive()
    .max(500)
    .optional()
    .describe('read 可选:最多读取行数(上限 500,默认 200)'),
})

export type VaultAction = 'search' | 'read' | 'list' | 'write'

export interface VaultToolHit {
  /** 相对 vault 根的笔记路径 */
  path: string
  /** 1-based 行号 */
  line: number
  /** 命中行内容(过长截断) */
  text: string
}

export interface VaultToolNoteEntry {
  path: string
  /** 字节数 */
  size: number
  /** 本地时间字符串(服务端已格式化) */
  updatedAt: string
}

export interface VaultToolOutput {
  ok: boolean
  action: VaultAction
  /** search 命中列表 */
  hits?: VaultToolHit[]
  /** search 实际扫描的笔记数 */
  scanned?: number
  /** read 返回的笔记内容 */
  content?: string
  totalLines?: number
  /** read 还有后续内容时,下次 read 应传的 offset;已读完不传 */
  nextOffset?: number
  /** list 返回的笔记清单 */
  notes?: VaultToolNoteEntry[]
  totalNotes?: number
  /** write 实际落盘的绝对路径 */
  absPath?: string
  bytes?: number
  /** 结果说明/空态引导(回传给模型,让它向用户如实转述) */
  note?: string
  /** 失败原因(模型据此向用户解释,不臆造成功) */
  error?: string
}
