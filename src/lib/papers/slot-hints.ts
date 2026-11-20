/**
 * 槽位考点提示（常考规律）：来自库内 33 套广西合格考真题的逐题统计（2026-11-14，
 * 明细 scripts/_hxkg-dump.json）。只收「多套全中」的强规律，弱规律（数学填空、
 * 多选、物理实验桶、英语/信息技术）不收，宁缺勿错。
 *
 * 引擎用法（compose.ts）：①真题抽题时槽位优先抽 tags 命中的题，命中不足退随机
 * （与「针对我复习」不同：不产生缺口）；②AI 补题 topic 用真实考点，替代
 * 「解答与证明题」这类对检索无效的大题名。
 * UI 用法（组卷表单 OutlineTable）：大题行下挂虚线子行「第 N 题 → 常考考点」。
 *
 * 匹配口径：学科 + 题型 + 每题分 + 大题名（剥编号后包含匹配，如「解答」同时
 * 命中 解答与证明题/解答题与证明题）+ 行内题序。
 */
export interface SlotHint {
  /** 展示名（卷子结构子行） */
  label: string
  /** AI 拟题考点（课本检索 / 生成 prompt 用） */
  topic: string
  /** 真题匹配：PaperQuestion.topics 任一标签含这些子串即命中 */
  tags: string[]
}

interface SlotHintRule {
  subject: string
  /** 大题名关键词（剥「一、」编号后包含匹配） */
  section: string
  kind: 'choice' | 'answer'
  score: number
  /** 按行内题序给提示；length=1 时该行所有题同提示 */
  hints: SlotHint[]
}

export const SLOT_HINT_RULES: SlotHintRule[] = [
  // ── 数学：解答三大块轮转（10 套全中：三角/向量、立体几何、统计概率各占一槽，
  //    顺序不固定，此处取多数卷序 33=三角 34=立体 35=统计）──
  {
    subject: 'math', section: '解答', kind: 'answer', score: 10,
    hints: [
      { label: '三角与解三角形', topic: '解三角形', tags: ['三角', '平面向量', '解三角形'] },
      { label: '立体几何', topic: '立体几何', tags: ['8.'] },
      { label: '统计与概率', topic: '统计', tags: ['9.', '10.'] },
    ],
  },
  // ── 政治：非选择一槽一模块（综合卷一~六固定 5/8/12/15；真题/模拟卷分值浮动不硬套）──
  { subject: 'politics', section: '非选择', kind: 'answer', score: 5, hints: [{ label: '中国特色社会主义', topic: '中国特色社会主义', tags: ['中国特色社会主义'] }] },
  { subject: 'politics', section: '非选择', kind: 'answer', score: 8, hints: [{ label: '经济与社会', topic: '经济与社会', tags: ['经济与社会'] }] },
  { subject: 'politics', section: '非选择', kind: 'answer', score: 12, hints: [{ label: '政治与法治', topic: '政治与法治', tags: ['政治与法治'] }] },
  { subject: 'politics', section: '非选择', kind: 'answer', score: 15, hints: [{ label: '哲学与文化', topic: '哲学与文化', tags: ['哲学与文化'] }] },
  // ── 物理：计算 27=运动学+牛顿定律、28=功和能（6 套全中；实验题桶天然同质不加提示）──
  { subject: 'physics', section: '计算', kind: 'answer', score: 6, hints: [{ label: '运动学与牛顿定律', topic: '牛顿运动定律', tags: ['牛顿', '匀变速', '加速度'] }] },
  { subject: 'physics', section: '计算', kind: 'answer', score: 10, hints: [{ label: '功和能', topic: '动能定理', tags: ['动能定理', '机械能', '重力势能', '功与功率', '能量守恒'] }] },
  // ── 语文：桶序按 9 套真题的 (kind,score) 桶内题号众数（病句在这套卷里是主观题，
  //    文言翻译/古诗归属 choice 或 answer 跨卷有出入，以桶内多数为准；作文 40 分不加）──
  {
    subject: 'chinese', section: '积累运用', kind: 'choice', score: 2,
    hints: [
      { label: '字音字形', topic: '字音', tags: ['字音', '字形'] },
      { label: '词语与成语运用', topic: '词语与成语运用', tags: ['词语与成语运用'] },
      { label: '句子衔接与连贯', topic: '句子衔接与连贯', tags: ['句子衔接与连贯'] },
      { label: '修辞手法', topic: '修辞手法', tags: ['修辞手法'] },
      { label: '文学文化常识', topic: '文学文化常识', tags: ['文学文化常识'] },
    ],
  },
  {
    subject: 'chinese', section: '积累运用', kind: 'answer', score: 4,
    hints: [
      { label: '病句辨析与修改', topic: '病句辨析与修改', tags: ['病句辨析与修改'] },
      { label: '压缩与概括', topic: '压缩与概括', tags: ['压缩与概括'] },
      { label: '名篇名句默写', topic: '名篇名句默写', tags: ['名篇名句默写'] },
    ],
  },
  {
    subject: 'chinese', section: '阅读（一）', kind: 'choice', score: 3,
    hints: [
      { label: '信息类文本阅读', topic: '信息类文本阅读', tags: ['信息类文本阅读'] },
      { label: '信息类文本阅读', topic: '信息类文本阅读', tags: ['信息类文本阅读'] },
      { label: '文学类文本阅读', topic: '文学类文本阅读', tags: ['文学类文本阅读', '整本书阅读'] },
    ],
  },
  {
    subject: 'chinese', section: '阅读（一）', kind: 'answer', score: 4,
    hints: [
      { label: '信息类文本阅读', topic: '信息类文本阅读', tags: ['信息类文本阅读'] },
      { label: '文学类文本阅读', topic: '文学类文本阅读', tags: ['文学类文本阅读', '整本书阅读'] },
      { label: '文学类文本阅读', topic: '文学类文本阅读', tags: ['文学类文本阅读', '整本书阅读'] },
    ],
  },
  {
    subject: 'chinese', section: '阅读（二）', kind: 'choice', score: 3,
    hints: [
      { label: '文言文阅读', topic: '文言文阅读', tags: ['文言文阅读', '文言断句'] },
      { label: '文言文阅读', topic: '文言文阅读', tags: ['文言文阅读', '文言断句'] },
      { label: '古代诗歌鉴赏', topic: '古代诗歌鉴赏', tags: ['古代诗歌鉴赏'] },
    ],
  },
  {
    subject: 'chinese', section: '阅读（二）', kind: 'answer', score: 4,
    hints: [
      { label: '文言文翻译', topic: '文言文翻译', tags: ['文言文翻译'] },
      { label: '古代诗歌鉴赏', topic: '古代诗歌鉴赏', tags: ['古代诗歌鉴赏'] },
    ],
  },
]

/** 大题名归一：剥「一、」「(一)」「1.」编号前缀（与 compose.sectionToTopic 同口径） */
export function normalizeSectionName(section: string | null): string {
  return (section ?? '')
    .trim()
    .replace(/^[（(]?[0-9一二三四五六七八九十]{1,3}[）)]?\s*[.、．:：]?\s*/, '')
    .trim()
}

/** 该槽位行的全部提示（按行内题序；无匹配返回 []） */
export function slotHintsFor(subject: string, section: string | null, kind: string, score: number): SlotHint[] {
  const norm = normalizeSectionName(section)
  if (!norm) return []
  for (const r of SLOT_HINT_RULES) {
    if (r.subject !== subject || r.kind !== kind || r.score !== score) continue
    if (norm.includes(r.section)) return r.hints
  }
  return []
}
