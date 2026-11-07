import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * 学习内容专用:单个换行 → 段落换行(markdown 默认折叠单换行)。
 * 学习总结/解析是"逐行要点"格式(1. / 2. / 每步一行),直接进 markdown
 * 会被黏成一段——渲染前把单换行升格成段落换行,双换行保持不变。
 */
export function expandSingleNewlines(text: string): string {
  return text.replace(/(?<!\n)\n(?!\n)/g, '\n\n')
}

/**
 * 深度思考兜底拆分:当模型把全部内容(含最终答案)都放进 <think> 标签时,
 * 标签抽取后的正文为空。此时从推理文本尾部拆出答案部分作为正文。
 *
 * 拆分优先级:
 * 1. 按常见"答案/结论"标记从最后一个出现位置切分
 * 2. 无标记时取最后一个非空行作为正文
 * 3. 单行无标记时整个推理作为正文(推理置空,等价于模型未用标签)
 */
export function splitReasoningTail(reasoning: string): { head: string; tail: string } {
  // 扩展标记列表,覆盖中英文常见措辞,避免"模型有输出但无法切分"导致正文为空
  const markers = [
    // 中文 - 显式标记
    '【答案】', '【解答】', '【结论】', '【最终答案】', '【最终结论】',
    '【回答】', '【回复】', '【回复如下】',
    // 中文 - 带冒号标记(全角)
    '答案：', '解答：', '结论：', '最终结论：', '最终答案：',
    '回答如下：', '回复如下：', '总结：', '总结一下：',
    '所以答案是：', '所以结论是：', '综上：', '综上，',
    // 中文 - 带冒号标记(半角)
    '答案:', '解答:', '结论:', '最终结论:', '最终答案:',
    '回答如下:', '回复如下:', '总结:', '总结一下:',
    '所以答案是:', '所以结论是:', '综上:',
    // 英文 - 带冒号
    'Answer:', 'Answer：', 'Final answer:', 'Final Answer:',
    'Conclusion:', 'Conclusion：', 'Result:', 'Result：',
    'So the answer is:', 'So the answer is：',
    'To summarize:', 'In summary:', 'In conclusion:',
  ]
  for (const marker of markers) {
    const idx = reasoning.lastIndexOf(marker)
    if (idx >= 0) {
      const tail = reasoning.slice(idx).trim()
      // 标记后面必须有实际内容才切分,避免切出空正文
      if (tail.length > marker.length + 1) {
        return { head: reasoning.slice(0, idx).trim(), tail }
      }
    }
  }
  const lines = reasoning
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "")
  if (lines.length > 1) {
    const tail = lines.pop()!.trim()
    if (tail) {
      return { head: lines.join("\n").trim(), tail }
    }
  }
  return { head: "", tail: reasoning.trim() }
}
