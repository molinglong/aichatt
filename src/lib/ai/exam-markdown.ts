/**
 * 试卷块（材料/设问/作答）markdown 约定 —— 纯文本层解析，无 React 依赖。
 *
 * 材料题里材料/设问/作答混在一坨难读，约定 AI 按试卷结构分块输出：
 *   :::material …（材料原文）… :::
 *   :::question …（设问+分值）… :::
 *   :::answer …（分点作答）… :::
 *   :::poem …（诗歌原文，一句一行）… :::
 *   :::lyrics …（歌词原文，一句一行，渲染同诗块但标签为「歌词」）… :::
 *   :::essay …（作文纸：首行标题，正文段落，末行「全文约 X 字」）… :::
 *   :::timeline …（时间轴：首行可选标题，每行「年份｜朝代｜事件｜一句话｜出处」，行首 * = 关键节点）… :::
 *   :::translate …（英文题目的中文译文：首行题干，之后每行「A. 选项中文」；无选项行时整块按普通文本渲染）… :::
 *   :::sentence …（句子成分分析：首行原句，之后每行「成分名：内容｜说明」，主干行「主干：主语 ‖ 谓语 ‖ 宾语」；成分内容须为原句连续片段，渲染层自动回标着色）… :::
 *   :::gamestatus …（游戏状态面板：每行一条「名称 值」或「名称：值」，值形如 60/100 渲染为进度条）… :::
 *   :::gamechoice …（游戏行动面板：每行一个可点行动，点击即当作 user 消息发送；自由行动仍走输入框）… :::
 *   出处行「参考 xx·科目」支持各学科面具：数学/语文/英语/物理/化学/生物/历史/政治/地理
 * 解析为片段流后由 MarkdownRenderer 分别渲染成试卷卡片；
 * 关键词双色标注（==术语== / @@材料词@@）在渲染层处理，见 MarkdownRenderer.tsx。
 */

export type ExamKind = 'choice' | 'material' | 'question' | 'answer' | 'poem' | 'lyrics' | 'essay' | 'timeline' | 'translate' | 'sentence' | 'gamestatus' | 'gamechoice'

export type ExamSegment =
  | { type: 'md'; text: string }
  | { type: 'exam'; kind: ExamKind; text: string }

export interface ExamChoiceOption {
  /** 大写选项字母（A-F） */
  letter: string
  text: string
}

export interface ExamChoiceGroup {
  /** 单题题干 */
  stem: string
  options: ExamChoiceOption[]
}

export interface ExamChoice {
  stem: string
  options: ExamChoiceOption[]
  /** 一块多题兜底拆组：模型把多题塞进一个块时按题拆分（题号行数与「A」重现次数对齐才拆）；单题时为空数组 */
  groups: ExamChoiceGroup[]
}

/** 选项行：A. / A、 / A． / A: 等前缀（允许首尾空白），内容非空才算选项 */
const CHOICE_OPTION_RE = /^\s*([A-Fa-f])[.、．:：]\s*(.+)$/

/** 题号行：1. / 1、 / 1) 等前缀（数字后紧跟分隔符，避免误伤「755 年乱起」类正文） */
const QUESTION_NO_RE = /^\s*\d{1,3}[.、．)]\s*(\S.*)$/

const EXAM_OPEN_RE = /^:::(choice|material|question|answer|poem|lyrics|essay|timeline|translate|sentence|gamestatus|gamechoice)(?:\s+(.*?))?\s*$/
const EXAM_CLOSE_RE = /^:::\s*$/

/**
 * 选择题块内解析：题干与选项分离。
 * 以「A.」等前缀的行识别为选项（字母统一大写），其余行归入题干；
 * 选项内容不连续（中间夹空行）也能正确归组。
 * 多题兜底：模型偶尔把多题塞进一个块（题干连排+选项连排/交替），
 * 题号行数与「A」选项重现次数对齐（都 ≥2）时按题拆组；对不齐一律退回单组，不吞内容。
 */
export function parseChoice(text: string): ExamChoice {
  const lines = text.split('\n')
  const stemLines: string[] = []
  const options: ExamChoiceOption[] = []
  const noRows: { text: string; idx: number }[] = []
  const optRows: ({ letter: string; text: string; idx: number })[] = []
  const plainRows: { text: string; idx: number }[] = []
  lines.forEach((line, idx) => {
    const om = line.match(CHOICE_OPTION_RE)
    if (om) {
      const opt = { letter: om[1].toUpperCase(), text: om[2].trim() }
      options.push(opt)
      optRows.push({ ...opt, idx })
      return
    }
    stemLines.push(line)
    const qm = line.match(QUESTION_NO_RE)
    if (qm) noRows.push({ text: qm[1].trim(), idx })
    else plainRows.push({ text: line, idx })
  })
  const base: ExamChoice = { stem: stemLines.join('\n').trim(), options, groups: [] }

  if (noRows.length < 2 || optRows.length < 4) return base
  const optGroups: typeof optRows[] = []
  for (const r of optRows) {
    if (r.letter === 'A' || optGroups.length === 0) optGroups.push([r])
    else optGroups[optGroups.length - 1].push(r)
  }
  if (optGroups.length !== noRows.length) return base

  // 非题干非选项的普通行（说明/空行）：归属 idx 前最近的题号行；首题之前归前言拼入第一组
  const groupNotes: string[][] = noRows.map(() => [])
  const prefix: string[] = []
  let cursor = 0
  for (const p of plainRows) {
    while (cursor < noRows.length && noRows[cursor].idx < p.idx) cursor++
    ;(cursor === 0 ? prefix : groupNotes[cursor - 1]).push(p.text)
  }
  const groups: ExamChoiceGroup[] = noRows.map((n, i) => ({
    stem: [i === 0 && prefix.length ? prefix.join('\n').trim() : '', n.text, groupNotes[i].join('\n').trim()]
      .filter(Boolean)
      .join('\n\n'),
    options: optGroups[i].map((r) => ({ letter: r.letter, text: r.text })),
  }))
  return { ...base, groups }
}

export interface ExamEssay {
  /** 自拟标题（块内首行，渲染层居中疏排） */
  title: string
  /** 正文（继续走完整 markdown 渲染，双色标注照常生效） */
  body: string
  /** 历史消息中模型自写的字数行（兼容带括号），提取剥离后不再展示——徽标改为前端实时计数 */
  wordCount: string
}

/**
 * 作文纸块内解析：首行为标题，末行以「全文约」开头的行（历史消息遗留，可带括号）剥离不展示，
 * 其余为正文。识别失败时各段回空/并入正文，不吞内容。
 */
export function parseEssay(text: string): ExamEssay {
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length && !lines[i].trim()) i++
  const title = i < lines.length ? lines[i].trim() : ''
  const titleIdx = i
  let j = lines.length - 1
  while (j > titleIdx && !lines[j].trim()) j--
  let wordCount = ''
  if (j > titleIdx) {
    const last = lines[j].trim().replace(/^[（(]\s*/, '').replace(/\s*[）)]$/, '')
    if (/^全文约/.test(last)) {
      wordCount = last
      j--
    }
  }
  const body = lines.slice(titleIdx + 1, j + 1).join('\n').trim()
  return { title, body, wordCount }
}

/**
 * 作文字数前端实时计数（作文纸占格口径）：标题+正文合并，按字符数计、含标点，
 * 剔除空白与行内语法符（== == / @@ @@ / ** / ~~），与模型自写估算无关。
 */
export function countEssayChars(title: string, body: string): number {
  const cleaned = (title + '\n' + body)
    .replace(/(==+|@@+|\*{2,}|~{2,})/g, '')
    .replace(/\s/g, '')
  return Array.from(cleaned).length
}

/**
 * 作文一键复制的纯文本：标题 + 空行 + 正文，剥除行内语法符（== == / @@ @@ / ** / ~~），
 * 保留文字、标点与段落结构，复制出来可直接誊抄或粘贴。
 */
export function essayToPlainText(title: string, body: string): string {
  return (title + '\n\n' + body).replace(/(==+|@@+|\*{2,}|~{2,})/g, '')
}

export interface ExamTimelineEvent {
  /** 左侧年份列（如 605 / 前221 / 1905） */
  year: string
  /** 朝代/时期徽标（如 隋）；可空 */
  era: string
  /** 事件名 */
  name: string
  /** 一句话说明；可空 */
  desc: string
  /** 出处（如《史记·秦始皇本纪》）；可空 */
  src: string
  /** 行首 * 标记的关键节点（渲染为红点） */
  key: boolean
}

export interface ExamTimeline {
  /** 首行标题（可选） */
  title: string
  events: ExamTimelineEvent[]
  /** 未匹配事件行的其余行（尾注，不吞内容） */
  note: string
}

/**
 * 时间轴块内解析：不含分隔符的首行作标题，其余按「年份｜朝代｜事件｜一句话｜出处」
 * 切分（全角/半角竖线均可，至少 3 段且年份/事件名非空）；行首 * 标记关键节点。
 * 缺段留空，非事件行入尾注，不吞内容；流式期间逐次重算即可（幂等无状态）。
 */
export function parseTimeline(text: string): ExamTimeline {
  const events: ExamTimelineEvent[] = []
  const noteBuf: string[] = []
  let title = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const key = line.startsWith('*')
    const body = key ? line.slice(1).trim() : line
    const parts = body.split(/[｜|]/).map((p) => p.trim())
    if (parts.length >= 3 && parts[0] && parts[2]) {
      events.push({
        year: parts[0],
        era: parts[1] ?? '',
        name: parts[2],
        desc: parts[3] ?? '',
        src: parts[4] ?? '',
        key,
      })
      continue
    }
    // 非事件行：首个且尚无事件时当标题，其余入尾注
    if (!title && !events.length) title = line
    else noteBuf.push(line)
  }
  return { title, events, note: noteBuf.join('\n') }
}

export interface ExamSentencePart {
  /** 成分名（主干/主语/谓语/宾语/表语/定语/状语/补语/同位语/插入语/从句及各类从句） */
  role: string
  /** 成分内容（约定为原句连续片段，渲染层据此回标；主干行内容为主干提炼不回标） */
  text: string
  /** ｜后的说明（从句类型/修饰对象等）；可空 */
  note: string
  /** 主干行（主干：…）：渲染层单独强调 */
  backbone: boolean
}

export interface ExamSentence {
  /** 首行原句；模型省略原句直接列成分时为空串 */
  sentence: string
  parts: ExamSentencePart[]
  /** 未按「成分名：」格式的其余行（尾注，不吞内容） */
  note: string
}

/** 成分行格式：「成分名：内容」，成分名白名单（长词在前避免「主语从句」被「主语」截胡）；配色由渲染层按 role 映射 */
const SENTENCE_ROLE_RE = /^(主干|主语从句|主语|谓语动词|谓语|宾语从句|宾语|表语从句|表语|定语从句|定语|状语从句|状语|补语|同位语从句|同位语|插入语|中心语|从句)\s*[:：]\s*(.*)$/

/**
 * 句子成分块内解析：首个非成分行作原句（剥离可选「原句：」前缀），
 * 其余按「成分名：内容｜说明」逐行切分（全角/半角冒号与竖线均可）；
 * 首行即成分行时视为省略原句（sentence 为空，渲染层只列明细）。
 * 白名单外或无冒号的行入尾注，不吞内容；流式逐次重算幂等。
 */
export function parseSentence(text: string): ExamSentence {
  const parts: ExamSentencePart[] = []
  const noteBuf: string[] = []
  let sentence = ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const pm = line.match(SENTENCE_ROLE_RE)
    if (!pm) {
      if (!sentence && !parts.length) sentence = line.replace(/^原句\s*[:：]\s*/, '')
      else noteBuf.push(line)
      continue
    }
    const role = pm[1]
    const segs = (pm[2] ?? '').split(/[｜|]/)
    parts.push({
      role,
      text: segs[0].trim(),
      note: segs.slice(1).join('｜').trim(),
      backbone: role === '主干',
    })
  }
  return { sentence, parts, note: noteBuf.join('\n') }
}

export interface GameStat {
  label: string
  value: string
  /** 数值型状态（如「精力 60/100」）：拆出 cur/max 供渲染层画进度条；否则 undefined */
  cur?: number
  max?: number
}

/**
 * 游戏状态块内解析：每行一条状态「名称 值」或「名称：值」，值形如「60/100」时拆出 cur/max 画进度条。
 * 分隔符判定：冒号/等号/竖线（：: = ｜ |）仅当它出现在首个空白之前才当分隔符
 * （否则「时间 …07:12」里时间值的冒号会被误当分隔符）；一律优先按首个空白切分。
 * 无分隔符的整行作纯标签（value 空）。幂等无状态，流式逐次重算即可。
 */
export function parseGameStatus(text: string): GameStat[] {
  const stats: GameStat[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const wsIdx = line.search(/\s/)
    const sepMatch = line.match(/[：:=｜|]/)
    const sepIdx = sepMatch?.index ?? -1
    let label = ''
    let value = ''
    if (sepIdx >= 0 && (wsIdx < 0 || sepIdx < wsIdx)) {
      label = line.slice(0, sepIdx).trim()
      value = line.slice(sepIdx + sepMatch![0].length).trim()
    } else if (wsIdx >= 0) {
      label = line.slice(0, wsIdx).trim()
      value = line.slice(wsIdx).trim()
    } else {
      label = line
    }
    if (!label) continue
    const bar = value.match(/^(\d+)\s*\/\s*(\d+)/)
    stats.push({ label, value, cur: bar ? Number(bar[1]) : undefined, max: bar ? Number(bar[2]) : undefined })
  }
  return stats
}

/**
 * 游戏行动块内解析：每行一个可点选项。剥掉行首列表符/序号/字母（- * • · > 或「1.」「A.」），
 * 使模型即便偶尔仍写「A. xxx」也被规整为纯行动文案；空行忽略。幂等无状态。
 * 渲染层把每条行动做成按钮，点击即当作 user 消息发送；自由行动仍走输入框，不占选项。
 */
export function parseGameChoice(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/^[-*•·>\s]+/, '').replace(/^[A-Fa-f0-9]{1,3}[.、．)）]\s*/, '').trim())
    .filter(Boolean)
}

export interface ExamSourceRef {
  /** 出处定位，如「§1.2.3 例3(2)」（不含「参考」前缀与科目标签） */
  ref: string
  /** 科目标签映射（如「·数学」→ math），未写则 null（入库时降级 other） */
  subject: string | null
}

/** 出题协议出处行：块内首行「参考 §1.2.3 例3(2)·数学」（科目标签可选，覆盖各学科面具） */
const SOURCE_REF_RE = /^\s*参考[::\s]*([^·]+?)(?:\s*·\s*(数学|语文|英语|物理|化学|生物|历史|政治|地理))?\s*$/

const REF_SUBJECT_MAP: Record<string, string> = {
  数学: 'math',
  语文: 'chinese',
  英语: 'english',
  物理: 'physics',
  化学: 'chemistry',
  生物: 'biology',
  历史: 'history',
  政治: 'politics',
  地理: 'geography',
}

/**
 * 题块出处行解析：剥离首行「参考 §x.x·科目」，供渲染层徽标与收进题库联动。
 * 仅在首行匹配成功时剥离；普通题干不受影响。流式中出处行先到、正文后到，
 * 每次重算即可（幂等无状态）。
 */
export function parseSourceRefLine(text: string): { sourceRef: ExamSourceRef | null; body: string } {
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length && !lines[i].trim()) i++
  if (i < lines.length) {
    const m = lines[i].match(SOURCE_REF_RE)
    if (m) {
      const subjectTag = m[2] ? REF_SUBJECT_MAP[m[2]] ?? null : null
      return {
        sourceRef: { ref: m[1].trim(), subject: subjectTag },
        body: lines.slice(i + 1).join('\n').trim(),
      }
    }
  }
  return { sourceRef: null, body: text }
}

/**
 * 按 ::: 块切分 markdown 为片段流；无 ::: 时单段返回（渲染路径与旧版一致）。
 * - fenced code 内的 ::: 不识别（代码示例不误伤）
 * - 未闭合块兜底回普通文本（连 ::: 开行一起还原），不吞内容
 * - 开标记行尾允许携带余料（如模型把出处写成「:::choice 参考 §x.x·数学」），
 *   余料作块内首行交给块内解析器（choice 的出处行剥离/timeline 的标题行），历史消息同样救回
 * - 闭合容错: 模型常把闭合「:::」与块内末行写在同一行（如「…让我这样吧 :::」），
 *   旧约定下永不闭合、整块兜底回纯文本；行尾恰好是 ::: 且前面仍有内容时拆开入块再闭合
 */
export function parseExamSegments(md: string): ExamSegment[] {
  if (!md.includes(':::')) return [{ type: 'md', text: md }]
  const segments: ExamSegment[] = []
  let mdBuf: string[] = []
  let examKind: ExamKind | null = null
  let examBuf: string[] = []
  let inFence = false
  let fenceChar = ''
  const push = (line: string) => (examKind ? examBuf : mdBuf).push(line)
  const flushMd = () => {
    if (mdBuf.length && mdBuf.some((l) => l.trim())) {
      segments.push({ type: 'md', text: mdBuf.join('\n') })
      mdBuf = []
    }
  }
  const closeExam = () => {
    if (!examKind) return
    segments.push({ type: 'exam', kind: examKind, text: examBuf.join('\n') })
    examBuf = []
    examKind = null
  }
  for (const line of md.split('\n')) {
    const fence = line.trim().match(/^(`{3,}|~{3,})/)
    if (fence) {
      if (!inFence) {
        inFence = true
        fenceChar = fence[1][0]
      } else if (fence[1][0] === fenceChar) {
        inFence = false
        fenceChar = ''
      }
      push(line)
      continue
    }
    if (inFence) {
      push(line)
      continue
    }
    if (!examKind) {
      const open = line.match(EXAM_OPEN_RE)
      if (open) {
        flushMd()
        examKind = open[1] as ExamKind
        // 开标记行内余料（如「:::choice 参考 §x.x·数学」）作块内首行，不吞内容
        const inline = (open[2] ?? '').trim()
        if (inline) examBuf.push(inline)
      } else {
        mdBuf.push(line)
      }
    } else if (EXAM_CLOSE_RE.test(line)) {
      closeExam()
    } else {
      // 尾随闭合容错: 行尾恰好是「:::」且前面仍有内容时，拆开入块再闭合（见顶部注释）
      const trimmed = line.trimEnd()
      const content = trimmed.endsWith(':::') ? trimmed.slice(0, -3).trimEnd() : ''
      if (content.trim()) {
        examBuf.push(content)
        closeExam()
      } else {
        examBuf.push(line)
      }
    }
  }
  if (examKind) {
    // 游戏面板块: 快模型偶尔漏写结尾的「:::」——宁可渲染成面板,
    // 也不把「:::gamechoice …」原文吐给玩家
    if (examKind === 'gamestatus' || examKind === 'gamechoice') closeExam()
    else mdBuf.push(`:::${examKind}`, ...examBuf)
  }
  flushMd()
  return segments
}
