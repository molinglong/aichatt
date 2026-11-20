/**
 * 个人笔记库工具(服务端执行层):createVaultTool() 直接读写 VAULT_DIR 文件夹。
 * vault 就是一堆 Markdown 文件(Obsidian 兼容,但不依赖 Obsidian 在跑)。
 *
 * 安全边界:
 * - 路径一律相对 VAULT_ROOT,拒绝绝对路径/盘符/../反斜杠越界,resolve 后二次校验仍在根内;
 * - 写保护:overwrite/append 对 aichatt/ 命名空间外已有文件一律拒绝(保护用户手写笔记);
 *   全库无删除、无移动;
 * - 只处理 .md/.markdown,跳过 .obsidian 等隐藏目录;
 * - 读写都有体积上限;异常 catch 降级返回 error+note,绝不臆造笔记内容。
 *
 * VAULT_DIR 缺省 D:\Vault(本机 dev/部署);远程 VPS 站摸不到本机磁盘,工具会在
 * 目录缺失时降级说明(以后要远程用走 frp 隧道,闲鱼价桥同款配方)。
 */
import fs from 'fs'
import path from 'path'
import { tool } from 'ai'
import {
  VAULT_TOOL_NAME,
  VAULT_TOOL_PROMPT,
  vaultInputSchema,
  type VaultAction,
  type VaultToolHit,
  type VaultToolNoteEntry,
  type VaultToolOutput,
} from './vault-tool'

export { VAULT_TOOL_NAME, VAULT_TOOL_PROMPT }

/** vault 根目录(环境变量可覆盖) */
const VAULT_ROOT = process.env.VAULT_DIR || 'D:\\Vault'

/** AI 归档命名空间:此前缀内可覆盖/改写已有笔记,之外只能新建 */
const AI_NAMESPACE = 'aichatt/'

const SEARCH_MAX_HITS = 50
const SEARCH_MAX_FILES = 2000
const READ_MAX_CHARS = 32_768
const READ_DEFAULT_LIMIT = 200
const WRITE_MAX_CHARS = 65_536
const HIT_TEXT_MAX = 160

/** 跳过的隐藏/配置目录(Obsidian 自己的库不进检索) */
const SKIP_DIRS = new Set(['.obsidian', '.git', '.trash', '.smart-env', 'node_modules'])

/** 相对路径清洗:拒绝越界,统一正斜杠返回;非法返回 null */
function sanitizeRel(raw: string): string | null {
  const trimmed = raw.trim().replace(/\\/g, '/').replace(/^\/+/, '')
  if (!trimmed) return null
  if (/^[a-z]:/i.test(trimmed) || trimmed.startsWith('//')) return null
  const parts = trimmed.split('/').filter((p) => p.length > 0)
  if (parts.length === 0) return null
  if (parts.some((p) => p === '..' || p === '.' || p.startsWith('.'))) return null
  const rel = parts.join('/')
  // resolve 后必须仍在根内(双保险)
  const resolved = path.resolve(VAULT_ROOT, rel)
  if (resolved !== path.resolve(VAULT_ROOT) && !resolved.startsWith(path.resolve(VAULT_ROOT) + path.sep)) {
    return null
  }
  return rel
}

/** .md 后缀补全(aichatt/数学/数列 → aichatt/数学/数列.md) */
function withMdExt(rel: string): string {
  return /\.(md|markdown)$/i.test(rel) ? rel : `${rel}.md`
}

function isMarkdown(name: string): boolean {
  return /\.(md|markdown)$/i.test(name)
}

/** 递归收集 vault 内全部 Markdown 相对路径(跳过隐藏目录),超出上限截断 */
function walkMarkdown(dir: string, relPrefix: string, out: string[]): void {
  if (out.length >= SEARCH_MAX_FILES) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (out.length >= SEARCH_MAX_FILES) return
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
    const abs = path.join(dir, e.name)
    const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name
    if (e.isDirectory()) {
      walkMarkdown(abs, rel, out)
    } else if (e.isFile() && isMarkdown(e.name)) {
      out.push(rel)
    }
  }
}

function fmtLocalDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 目录不存在时给模型的引导说明 */
function vaultMissingNote(): string {
  return `笔记库(${VAULT_ROOT})还不存在。可以告诉用户:第一次使用,先让 AI 写第一篇笔记(会自动建库),或手动创建该文件夹。`
}

export function createVaultTool() {
  return tool({
    description:
      '读写用户自己的 Markdown 笔记库(本地文件夹,Obsidian 兼容)。' +
      '动作:search=跨笔记搜关键词;read=读笔记(行范围);list=列全部笔记(按更新时间倒序);write=写笔记(create 新建/append 追加/overwrite 仅限 aichatt/ 命名空间)。' +
      '用户要记笔记、归档讲义/错题整理、查自己之前记的内容时使用。',
    inputSchema: vaultInputSchema,
    execute: async ({ action, path: rawPath, query, content, mode, offset, limit }): Promise<VaultToolOutput> => {
      try {
        const rootExists = fs.existsSync(VAULT_ROOT)

        // ---- search:全库子串检索 ----
        if (action === 'search') {
          const q = (query ?? '').trim()
          if (!q) return { ok: false, action, error: '缺少 query 参数' }
          if (!rootExists) return { ok: true, action, hits: [], scanned: 0, note: vaultMissingNote() }
          const lower = q.toLowerCase()
          const files: string[] = []
          walkMarkdown(VAULT_ROOT, '', files)
          const hits: VaultToolHit[] = []
          for (const rel of files) {
            let text: string
            try {
              text = fs.readFileSync(path.join(VAULT_ROOT, rel), 'utf8')
            } catch {
              continue
            }
            const lines = text.split('\n')
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i]
              if (!line.toLowerCase().includes(lower)) continue
              const t = line.trim()
              hits.push({ path: rel, line: i + 1, text: t.length > HIT_TEXT_MAX ? `${t.slice(0, HIT_TEXT_MAX)}…` : t })
              if (hits.length >= SEARCH_MAX_HITS) break
            }
            if (hits.length >= SEARCH_MAX_HITS) break
          }
          return {
            ok: true,
            action,
            hits,
            scanned: files.length,
            note:
              hits.length === 0
                ? `没搜到含「${q}」的笔记(已扫 ${files.length} 篇)。`
                : `命中 ${hits.length} 条(上限 ${SEARCH_MAX_HITS})。需要上下文用 read 按路径精读。`,
          }
        }

        // ---- read:单篇笔记(行范围) ----
        if (action === 'read') {
          if (!rawPath?.trim()) return { ok: false, action, error: '缺少 path 参数' }
          const rel = sanitizeRel(rawPath)
          if (!rel) return { ok: false, action, error: `路径不合法:${rawPath}` }
          const abs = path.join(VAULT_ROOT, withMdExt(rel))
          if (!rootExists || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
            return { ok: false, action, error: `笔记不存在:${withMdExt(rel)}` }
          }
          const text = fs.readFileSync(abs, 'utf8')
          const lines = text.split('\n')
          const start = Math.max(1, offset ?? 1)
          const perPage = Math.min(Math.max(limit ?? READ_DEFAULT_LIMIT, 1), 500)
          const slice = lines.slice(start - 1, start - 1 + perPage)
          let out = slice.join('\n')
          let truncated = false
          if (out.length > READ_MAX_CHARS) {
            out = out.slice(0, READ_MAX_CHARS)
            truncated = true
          }
          const consumed = truncated
            ? out.length // 截断时无法精确按行,给出已读字符数对应的保守 nextOffset
            : start - 1 + slice.length
          const nextOffset = start - 1 + slice.length < lines.length ? consumed + 1 : undefined
          return {
            ok: true,
            action,
            content: out,
            totalLines: lines.length,
            ...(nextOffset ? { nextOffset } : {}),
            note: truncated
              ? `内容超 ${READ_MAX_CHARS} 字符已截断,请用 offset 继续读。`
              : undefined,
          }
        }

        // ---- list:全库清单(更新时间倒序) ----
        if (action === 'list') {
          if (!rootExists) return { ok: true, action, notes: [], totalNotes: 0, note: vaultMissingNote() }
          const files: string[] = []
          walkMarkdown(VAULT_ROOT, '', files)
          const entries: VaultToolNoteEntry[] = []
          for (const rel of files) {
            try {
              const st = fs.statSync(path.join(VAULT_ROOT, rel))
              entries.push({ path: rel, size: st.size, updatedAt: fmtLocalDate(st.mtime) })
            } catch {
              continue
            }
          }
          entries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
          return {
            ok: true,
            action,
            notes: entries.slice(0, 200),
            totalNotes: entries.length,
            note:
              entries.length === 0
                ? `笔记库还是空的(${VAULT_ROOT})。`
                : `共 ${entries.length} 篇,按更新时间倒序返回前 ${Math.min(entries.length, 200)} 篇。`,
          }
        }

        // ---- write:写入(命名空间保护) ----
        if (action === 'write') {
          const body = content ?? ''
          if (!rawPath?.trim()) return { ok: false, action, error: '缺少 path 参数' }
          if (!body.trim()) return { ok: false, action, error: '缺少 content 参数' }
          if (body.length > WRITE_MAX_CHARS) return { ok: false, action, error: `内容超限(${body.length} 字符,上限 ${WRITE_MAX_CHARS}),请拆分多篇` }
          const rel = sanitizeRel(rawPath)
          if (!rel) return { ok: false, action, error: `路径不合法:${rawPath}` }
          const relMd = withMdExt(rel)
          const abs = path.join(VAULT_ROOT, relMd)
          const inAiNamespace = relMd.replace(/\\/g, '/').startsWith(AI_NAMESPACE)
          const writeMode = mode ?? 'create'

          const exists = rootExists && fs.existsSync(abs) && fs.statSync(abs).isFile()
          if (writeMode === 'create' && exists) {
            return {
              ok: false,
              action,
              error: `笔记已存在:${relMd}。补充内容用 mode=append;整篇重写用 mode=overwrite(仅限 ${AI_NAMESPACE} 命名空间)。`,
            }
          }
          if ((writeMode === 'append' || writeMode === 'overwrite') && exists && !inAiNamespace) {
            return {
              ok: false,
              action,
              error: `${relMd} 不在 ${AI_NAMESPACE} 命名空间内,不允许覆盖/追加(AI 只能新建笔记;要改用户手写笔记请用户自己在 Obsidian 里改)。可以先 read 后用 create 换个文件名。`,
            }
          }

          fs.mkdirSync(path.dirname(abs), { recursive: true })
          let bytes: number
          if (writeMode === 'append' && exists) {
            const prev = fs.readFileSync(abs, 'utf8')
            const glue = prev.length === 0 || prev.endsWith('\n\n') ? '' : prev.endsWith('\n') ? '\n' : '\n\n'
            const merged = prev + glue + body
            fs.writeFileSync(abs, merged, 'utf8')
            bytes = Buffer.byteLength(merged, 'utf8')
          } else {
            fs.writeFileSync(abs, body, 'utf8')
            bytes = Buffer.byteLength(body, 'utf8')
          }
          return {
            ok: true,
            action,
            absPath: abs,
            bytes,
            note: `已${writeMode === 'append' ? '追加' : writeMode === 'overwrite' ? '覆盖' : '新建'} ${relMd}(${bytes} 字节)。`,
          }
        }

        return { ok: false, action: action as VaultAction, error: '未知 action' }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { ok: false, action, error: message, note: '笔记库操作失败,请如实告知用户,不要臆造结果。' }
      }
    },
  })
}
