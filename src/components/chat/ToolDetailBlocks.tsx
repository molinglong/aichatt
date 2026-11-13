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
import { knowledgeVolumeLabel, type KnowledgeHit, type KnowledgeOutlineDoc } from '@/lib/ai/knowledge-tool'
import type { PracticeItem } from '@/lib/ai/practice-tool'
import type { PaperSearchOutput, PaperAnalyzeOutput, ComposePaperOutput } from '@/lib/ai/paper-tool'

const KIND_LABEL: Record<string, string> = { textbook: '课本', material: '资料' }

/** 智能拟卷:卷面入口 + 来源卷声明;整卷内容不进聊天(卷面页有完整排版与打印) */
export function ComposeDetail({ output }: { output: ComposePaperOutput }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-content-secondary">
        {output.composedId && (
          <a
            href={output.url ?? `/papers/composed/${output.composedId}`}
            target="_blank"
            rel="noreferrer"
            className="whitespace-nowrap rounded bg-surface-subtle px-1.5 py-0.5 text-[10.5px] text-content-muted underline decoration-line underline-offset-2 transition-colors hover:text-accent"
          >
            打开卷面页（换题 / 删题 / 打印）↗
          </a>
        )}
        {!!output.durationMin && <MetaChip>建议 {output.durationMin} 分钟</MetaChip>}
      </div>
      {!!output.sources?.length && (
        <div className="text-[11px] leading-snug text-content-secondary">
          <span className="font-medium text-content-primary">来源卷</span>
          <span> · {output.sources.join('、')}</span>
        </div>
      )}
      <div className="text-[11px] leading-snug text-content-muted">
        全部题目与答案出自官方答案卷原文，零 AI 拟题；「这题有误」的题会全局退池。
      </div>
    </div>
  )
}

/** 真题检索:考次统计 + 逐题出处与题干原文;官方答案只标注有无,不展示内容(防剧透) */
export function PaperDetail({ output }: { output: PaperSearchOutput }) {
  return (
    <div className="flex flex-col gap-3">
      {output.topicCounts.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-[10px] font-medium text-content-muted">考点考次（一题多考点各计一次）</div>
          {output.topicCounts.map((t) => (
            <div key={t.topic} className="text-[11px] leading-snug text-content-secondary">
              <span className="font-medium text-content-primary">{t.topic}</span>
              <span> · 考过 {t.count} 次</span>
              {t.refs.length > 0 && <span className="text-content-muted"> · {formatPaperRefs(t.refs)}</span>}
            </div>
          ))}
        </div>
      )}
      {output.results.map((r, i) => (
        <div key={`${r.paperSlug}-${r.number}-${i}`} className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-content-muted">
            <span className="shrink-0 font-mono">[{i + 1}]</span>
            <span className="text-content-secondary">{r.paperTitle}</span>
            <span>· 第 {r.number} 题</span>
            <MetaChip>{r.score} 分</MetaChip>
            <MetaChip>{r.kind === 'choice' ? (r.multiple ? '选择·多选' : '选择') : '解答/填空'}</MetaChip>
            <MetaChip>{r.answer == null ? '官方答案缺失' : '有官方答案'}</MetaChip>
            <a
              href={`/papers/${r.paperSlug}?number=${r.number}`}
              target="_blank"
              rel="noreferrer"
              className="shrink-0 whitespace-nowrap rounded bg-surface-subtle px-1 py-0.5 text-[10px] text-content-muted underline decoration-line underline-offset-2 transition-colors hover:text-accent"
            >
              原卷页 ↗
            </a>
          </div>
          <MarkdownRenderer content={r.stem} rich className="text-[12px] leading-[1.7] text-content-secondary" />
          {r.options.length > 0 && (
            <MarkdownRenderer
              content={r.options.join('\n\n')}
              rich
              className="text-[12px] leading-[1.7] text-content-secondary"
            />
          )}
          {r.images.map((src) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={src} src={src} alt="题图" className="max-h-28 rounded border border-line/60" />
          ))}
        </div>
      ))}
    </div>
  )
}

const SUBJECT_LABEL: Record<string, string> = {
  math: '数学',
  chinese: '语文',
  english: '英语',
  physics: '物理',
  chemistry: '化学',
  biology: '生物',
  history: '历史',
  geography: '地理',
  politics: '政治',
}

/** 试卷整理:试卷清单(题量/题型/答案与打标状态) + 考点考次榜(带课本章) + 错题本弱点联动 */
export function PaperAnalysisDetail({ output }: { output: PaperAnalyzeOutput }) {
  return (
    <div className="flex flex-col gap-3">
      {output.overview.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-[10px] font-medium text-content-muted">试卷清单</div>
          {output.overview.map((p) => {
            const meta = [p.year, p.region, SUBJECT_LABEL[p.subject] ?? p.subject].filter(Boolean).join(' · ')
            return (
              <div key={p.slug} className="text-[11px] leading-snug text-content-secondary">
                <span className="font-medium text-content-primary">{p.title}</span>
                {meta && <span className="text-content-muted"> · {meta}</span>}
                <span>
                  {' '}
                  ·{' '}
                  {p.questions === 0
                    ? '未录入题目'
                    : `${p.questions} 题（选择 ${p.choice}${p.multiChoice > 0 ? ` 含多选 ${p.multiChoice}` : ''} / 解答·填空 ${p.answerQ}）`}
                </span>
                {p.questions > 0 && p.answered < p.questions && <MetaChip>缺答案 {p.questions - p.answered}</MetaChip>}
                {p.questions > 0 && <MetaChip>已打标 {p.tagged}</MetaChip>}
              </div>
            )
          })}
        </div>
      )}
      {output.topicStats.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-[10px] font-medium text-content-muted">考点考次排行（一题多考点各计一次）</div>
          {output.topicStats.map((s) => (
            <div key={s.topic} className="text-[11px] leading-snug text-content-secondary">
              <span className="font-medium text-content-primary">{s.topic}</span>
              <span> · 考过 {s.count} 次</span>
              {s.chapter && <span className="text-content-muted"> · {s.chapter}</span>}
              {s.refs.length > 0 && (
                <span className="text-content-muted"> · {formatPaperRefs(s.refs.slice(0, 3))}</span>
              )}
            </div>
          ))}
        </div>
      )}
      {output.weakTopics.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-[10px] font-medium text-content-muted">错题本弱点联动</div>
          {output.weakTopics.map((w) => (
            <div key={w.topic} className="text-[11px] leading-snug text-content-secondary">
              <span className="font-medium text-content-primary">{w.topic}</span>
              <span> · 错题 {w.noteCount} 张</span>
              <span> · 平均掌握度 {Math.round(w.avgMastery * 100)}%</span>
              {w.dueCount > 0 && <MetaChip>{w.dueCount} 张待复习</MetaChip>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
const DIFFICULTY_LABEL: Record<string, string> = { basic: '基础', medium: '中等', hard: '较难' }

function MetaChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 whitespace-nowrap rounded bg-surface-subtle px-1 py-0.5 text-[10px] text-content-muted">
      {children}
    </span>
  )
}

/** 出处精简:全部命中同一卷时只列题号(「卷名 · 第8/7/9题」),不同卷才逐条铺开 */
function formatPaperRefs(refs: string[]): string {
  if (refs.length === 0) return ''
  if (refs.length === 1) return refs[0]
  const titles = new Set(refs.map((r) => r.replace(/\s*·\s*第\d+题$/, '')))
  if (titles.size === 1) {
    const nums = refs.map((r) => (r.match(/第(\d+)题/) || [])[1]).filter(Boolean)
    if (nums.length === refs.length) return `${Array.from(titles)[0]} · 第${nums.join('/')}题`
  }
  return refs.join(' / ')
}

/** 查课本:每条命中的出处(书 / 册别 / 章·节) + 框题 + 正文;按页导入的书附「看原文」跳阅读器对应页 */
export function KnowledgeDetail({ results }: { results: KnowledgeHit[] }) {
  return (
    <div className="flex flex-col gap-3">
      {results.map((r, i) => {
        const place = [r.chapter, r.section].filter(Boolean).join(' / ')
        const volume = knowledgeVolumeLabel(r)
        return (
          <div key={`${r.doc}-${r.heading}-${i}`} className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-content-muted">
              <span className="shrink-0 font-mono">[{i + 1}]</span>
              <span className="text-content-secondary">{r.doc}</span>
              {volume && <span>· {volume}</span>}
              {place && <span className="truncate">· {place}</span>}
              <MetaChip>{KIND_LABEL[r.kind] ?? r.kind}</MetaChip>
              {r.docId && r.page != null && (
                <a
                  href={`/kb/${r.docId}?page=${r.page}`}
                  className="shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent transition-opacity hover:opacity-80"
                >
                  看原文 P{r.page}
                </a>
              )}
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
