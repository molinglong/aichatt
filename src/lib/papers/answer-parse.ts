/**
 * 官方答案头部解析（纯函数，客户端/服务端共用）。
 * 从 attempt.ts 抽出：今晚测验弹卡要在浏览器里对选择题自动判分，
 * 判分口径必须与考试场 attempt 同源，禁止两处各写一套。
 */

/**
 * 从官方答案文本头部解析标准答案:
 * 「11. C」→ C;「27. BC（…解析…）」→ BC;「29. $x=-1$（由…）」→ x=-1。
 * 解析段(第一个全/半角括号起)不参与;填空支持「或」「;」分隔的多答案。
 */
export function parseObjectiveAnswer(q: { kind: string; multiple: boolean; answer: string | null }): string[] {
  if (!q.answer) return []
  let head = q.answer.replace(/^\s*\d+\s*[.、．]\s*/, "")
  const parenAt = head.search(/[（(]/)
  if (parenAt >= 0) head = head.slice(0, parenAt)
  head = head.replace(/^(解|答)[:：]\s*/, "").trim()
  if (q.kind === "choice") {
    const letters = head.toUpperCase().match(/[A-D]/g)
    if (!letters) return []
    const uniq = Array.from(new Set(letters))
    return q.multiple ? [uniq.join("")] : [uniq[0]]
  }
  // 填空:可能一题多解「x=1 或 x=-1」
  const parts = head.split(/或|;；|、/).map((s) => s.trim()).filter(Boolean)
  return parts.length ? parts : [head].filter(Boolean)
}
