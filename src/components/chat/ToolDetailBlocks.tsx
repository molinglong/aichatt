'use client'

/**
 * 工具卡展开区详情块 —— 把「查课本 / 题库抽题 / 翻课本目录」的一次调用结果摊开给用户看。
 *
 * 数据全部来自 view.output(当轮流式 parts 与历史 metadata.toolCalls 同构),不额外请求后端:
 * - 课本:服务端已把每段截断到 800 字(见 knowledge-tool-server HIT_CONTENT_LIMIT),
 *   这里只做展示,要「整段全文」需后端补 chunkId + 只读接口。
 * - 抽题:题干原样展示(纯文本保留换行,选择题的 A./B. 行不能被 markdown 折叠);
 *   answer 字段是「仅供模型判分」,严禁在此展示,否则剧透。
 * - 目录:docs → 章 → 节 → 框题三级缩进,框题悬停看该框题开头 160 字预览。
 */
import { MarkdownRenderer } from './MarkdownRenderer'
import type { KnowledgeHit, KnowledgeOutlineDoc } from '@/lib/ai/knowledge-tool'
import type { PracticeItem } from '@/lib/ai/practice-tool'

const KIND_LABEL: Record<string, string> = { textbook: '课本', material: '资料' }
const DIFFICULTY_LABEL: Record<string, string> = { basic: '基础', medium: '中等', hard: '较难' }

function MetaChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded bg-surface-subtle px-1 py-0.5 text-[10px] text-content-muted">{children}</span>
  )
}

/** 查课本:每条命中的出处(书 / 章·节) + 框题 + 正文 */
export function KnowledgeDetail({ results }: { results: KnowledgeHit[] }) {
  return (
    <div className="flex flex-col gap-3">
      {results.map((r, i) => {
        const place = [r.chapter, r.section].filter(Boolean).join(' / ')
        return (
          <div key={`${r.doc}-${r.heading}-${i}`} className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-content-muted">
              <span className="shrink-0 font-mono">[{i + 1}]</span>
              <span className="text-content-secondary">{r.doc}</span>
              {place && <span className="truncate">· {place}</span>}
              <MetaChip>{KIND_LABEL[r.kind] ?? r.kind}</MetaChip>
            </div>
            {r.heading && (
              <div className="text-[11px] font-medium text-content-primary leading-snug">{r.heading}</div>
            )}
            <MarkdownRenderer
              content={r.content}
              rich
              className="text-[12px] leading-[1.7] text-content-secondary"
            />
          </div>
        )
      })}
    </div>
  )
}

/** 题库抽题:逐题给出题干(含选项行),答案刻意不展示 */
export function PracticeDetail({ items }: { items: PracticeItem[] }) {
  return (
    <div className="flex flex-col gap-3">
      {items.map((it, i) => (
        <div key={it.id || i} className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-content-muted">
            <span className="shrink-0">第 {i + 1} 题</span>
            <MetaChip>{it.kind === 'choice' ? '选择题' : '解答题'}</MetaChip>
            {it.topic && (
              <span className="shrink-0 rounded bg-accent/10 px-1 py-0.5 text-[10px] text-accent">{it.topic}</span>
            )}
            <MetaChip>{DIFFICULTY_LABEL[it.difficulty] ?? it.difficulty}</MetaChip>
            {it.refLine && <span className="truncate">{it.refLine}</span>}
          </div>
          {/* 选择题的 A./B. 逐行排列靠单换行,markdown 会把单换行折叠成空格:
              每行末尾补硬换行(两个空格)保住分行,同时仍在同一段内,行距不会散开 */}
          <MarkdownRenderer
            content={toHardBreaks(it.stem)}
            rich
            className="text-[12px] leading-[1.7] text-content-secondary"
          />
        </div>
      ))}
    </div>
  )
}

/** 逐行硬换行(markdown 行尾两空格):连续空行先归一,空行丢弃避免留白 */
function toHardBreaks(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('  \n')
}

/** 单值/多步结果:mathjs 多条表达式按行拼接(见 calc-tool.server formatResult) */
export function CalcDetail({
  expression,
  tex,
  result,
  error,
  purpose,
}: {
  expression: string
  /** 服务端 toTex() 产出的逐条 LaTeX;缺省(旧消息/语法不合法)则显示原始表达式 */
  tex?: string[]
  result?: string
  error?: string
  purpose?: string
}) {
  const rows = (result ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  // 表达式按 ; 切段,条数与结果条数相等时可一一对应展示("式 = 值"),否则退化为编号列表
  // (带分号结尾的中间赋值会被 mathjs 静默不返回结果,此时两侧条数对不上)
  const parts = expression
    .split(/;|\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  const aligned = parts.length > 0 && parts.length === rows.length
  // 正式书写只在「算成功且逐条对齐」时启用:失败态(无结果)保留原始代码,
  // 因为报错信息(date 之类)与用户看到的原文一一对应,换成公式反而对不上
  const texUsable = !!tex && tex.length > 0 && tex.length === parts.length && aligned

  return (
    <div className="flex flex-col gap-2">
      {purpose && <div className="text-[10px] text-content-muted">用途:{purpose}</div>}
      {texUsable ? (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-content-muted">
            {rows.length > 1 ? `逐条结果（${rows.length} 步）` : '结果'}
          </span>
          <MarkdownRenderer
            content={toTexLines(tex, rows)}
            rich
            className="text-[12px] leading-[1.9] text-content-secondary"
          />
        </div>
      ) : aligned ? (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] text-content-muted">
            {rows.length > 1 ? `逐条结果（${rows.length} 步）` : '结果'}
          </span>
          {parts.map((p, i) => (
            <div key={`${i}-${p}`} className="flex flex-wrap items-baseline gap-1.5">
              <span className="min-w-0 break-all font-mono text-[11px] leading-relaxed text-content-secondary">
                {p}
              </span>
              <span className="shrink-0 text-[11px] text-content-muted">=</span>
              <span className="break-all font-mono text-[11px] leading-relaxed text-content-primary">
                {rows[i]}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-content-muted">表达式</span>
            {/* 多步用 ; 分隔,保留原样才看得出喂进去的是什么 */}
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-content-secondary">
              {expression}
            </pre>
          </div>
          {rows.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-[10px] text-content-muted">
                结果{rows.length > 1 ? `（${rows.length} 步）` : ''}
              </span>
              {rows.map((r, i) => (
                <div key={`${i}-${r}`} className="flex items-start gap-1.5">
                  {rows.length > 1 && (
                    <span className="shrink-0 font-mono text-[10px] text-content-muted">{i + 1}.</span>
                  )}
                  <span className="min-w-0 break-words font-mono text-[11px] leading-relaxed text-content-primary">
                    {r}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {error && <div className="break-words text-[11px] leading-relaxed text-red-500/90">{error}</div>}
    </div>
  )
}

/** 逐条「公式 = 值」,行间用 markdown 硬换行(两空格)保持紧凑 */
function toTexLines(tex: string[], rows: string[]): string {
  return tex.map((t, i) => (rows[i] ? `\\(${t}\\) = ${rows[i]}` : `\\(${t}\\)`)).join('  \n')
}

/** 翻课本目录:册 → 章 → 节 → 框题三级缩进 */
export function OutlineDetail({ docs }: { docs: KnowledgeOutlineDoc[] }) {
  return (
    <div className="flex flex-col gap-3">
      {docs.map((doc, di) => (
        <div key={`${doc.title}-${di}`} className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="text-content-primary">{doc.title}</span>
            {doc.grade && <MetaChip>{doc.grade}</MetaChip>}
            <MetaChip>{KIND_LABEL[doc.kind] ?? doc.kind}</MetaChip>
          </div>
          {(doc.chapters ?? []).map((ch, ci) => (
            <div key={`c-${ci}`} className="flex flex-col gap-1 border-l border-line/50 pl-2">
              {ch.chapter && <div className="text-[11px] text-content-secondary">{ch.chapter}</div>}
              {(ch.sections ?? []).map((sec, si) => (
                <div key={`s-${si}`} className="flex flex-col gap-0.5 pl-2">
                  {sec.section && <div className="text-[10px] text-content-muted">{sec.section}</div>}
                  {(sec.headings ?? []).map((h, hi) => (
                    <div
                      key={`h-${hi}`}
                      className="truncate pl-2 text-[11px] text-content-secondary"
                      title={h.preview || undefined}
                    >
                      · {h.heading}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
