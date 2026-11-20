/**
 * 估分报告「去问AI」深链消息(与闲鱼自动回报同配方):
 * - 报告页各入口构造 buildExamAskMessage → 跳 /chat?q=<全文>,聊天页 autoSend 自动发出;
 * - 消息正文 = 固定标签 + 首行卡片元数据(JSON) + 完整 prompt(题目/参考答案/我的作答等),
 *   模型照常读到全文,渲染端识别标签把气泡 hydrate 成小卡片(ExamAskCard);
 * - 解析失败(旧数据/手改)回落普通气泡,零风险。
 */
export interface ExamAskCardData {
  /** grade=主观题批改 | explain=错题讲解 | topics=考点复习 | wrongpack=错因归类 | review=整卷点评 */
  kind: string
  no?: number
  title: string
  meta: string
  prompt: string
}

/** 自动发出消息的固定标签(发出与渲染识别都靠它) */
export const EXAM_ASK_TAG = '【估分报告·去问AI】'

const EXAM_ASK_KIND_LABEL: Record<string, string> = {
  grade: 'AI 批改',
  explain: '错题讲解',
  topics: '考点复习',
  wrongpack: '错因归类',
  review: '整卷点评',
}

/**
 * 深链会话的人类可读兜底标题(建会话瞬间就可见,AI 标题生成后覆盖):
 * 消息正文以标签开头时返回「第 N 题 · AI 批改」/「整卷点评」,否则 null。
 * 直接用消息头当标题会把裸 JSON 泄漏进历史记录(A7)。
 */
export function examAskFallbackTitle(text: string): string | null {
  const card = parseExamAskCard(text)
  if (!card) return null
  const label = EXAM_ASK_KIND_LABEL[card.kind] ?? (card.title || '估分报告')
  return card.no ? `第 ${card.no} 题 · ${label}` : label
}

/** 构造深链消息正文:标签 + JSON 元数据行 + prompt 全文 */
export function buildExamAskMessage(data: ExamAskCardData): string {
  const head = JSON.stringify({ k: data.kind, n: data.no, t: data.title, m: data.meta })
  return `${EXAM_ASK_TAG}${head}\n${data.prompt}`
}

/** 识别并解析估分报告深链消息;非本类消息/结构损坏返回 null(回落普通气泡) */
export function parseExamAskCard(text: string): ExamAskCardData | null {
  if (!text.startsWith(EXAM_ASK_TAG)) return null
  const nl = text.indexOf('\n')
  if (nl < 0) return null
  try {
    const head = JSON.parse(text.slice(EXAM_ASK_TAG.length, nl)) as {
      k?: unknown
      n?: unknown
      t?: unknown
      m?: unknown
    }
    if (typeof head.t !== 'string' || typeof head.k !== 'string') return null
    return {
      kind: head.k,
      no: typeof head.n === 'number' ? head.n : undefined,
      title: head.t,
      meta: typeof head.m === 'string' ? head.m : '',
      prompt: text.slice(nl + 1),
    }
  } catch {
    return null
  }
}
