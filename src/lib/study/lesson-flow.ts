import type { UIMessage } from 'ai'

export type StudyAction = 'instruction' | 'next' | 'solution'
export const STUDY_COMPLETE_MARKER = '<!-- study-complete -->'

export function getStudyAction(metadata: unknown): StudyAction | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined
  const action = (metadata as { studyAction?: unknown }).studyAction
  return action === 'instruction' || action === 'next' || action === 'solution' ? action : undefined
}

export function stripStudyMarker(text: string): string {
  // 模型偶尔会自创 HTML 注释标记(如 study-complete-check),统一剥离,
  // 避免原始注释混入正文/入库;真正的完成判定仍只看 STUDY_COMPLETE_MARKER。
  return text.replace(/<!--[\s\S]*?-->/g, '').trimEnd()
}

// 中间态收尾话术:模型只讲了一小步、把「要不要继续」抛回用户时用的句式。
// 只认「祈使用户做动作」这一形态;裸的「下一步」不算——正常小结里会写「下一步代入求值」。
const MID_LESSON_TAIL_WINDOW = 120
const MID_LESSON_PATTERNS = [
  /(说|回|告诉|喊)(我)?\s*(一声|一句|一下)?[「“"']?(下一步|继续)/,
  /(想|要|需要|希望)(再)?(继续|接着).{0,6}(就|可以|请)?(说|告诉|回|点)/,
  /要我(接着|继续)/,
  /(随时|直接)(说|告诉|喊)(我)?(一声|一句)?/,
  /(继续|往下)的话.{0,6}(说|告诉|回)/,
]

// 回复末尾是否是把球踢回用户的中间态。
export function looksLikeMidLesson(text: string): boolean {
  const tail = stripStudyMarker(text).slice(-MID_LESSON_TAIL_WINDOW)
  return MID_LESSON_PATTERNS.some((pattern) => pattern.test(tail))
}

// 结课四道闸:正常结束 + 含完成标记 + 标记落在回复末尾 + 不是「等你继续」的中间态。
// 只靠标记不够——模型常把「讲完一小步」当成本题讲完,一边标完成一边邀请继续说下一步。
export function isStudyComplete(text: string, finishReason: string | undefined): boolean {
  if (finishReason !== 'stop') return false
  if (!text.includes(STUDY_COMPLETE_MARKER)) return false
  if (!text.trimEnd().endsWith(STUDY_COMPLETE_MARKER)) return false
  if (stripStudyMarker(text).trim().length === 0) return false
  return !looksLikeMidLesson(text)
}

export function hasStudyCompletion(message: UIMessage): boolean {
  return message.role === 'assistant' && !!message.metadata && typeof message.metadata === 'object'
    && (message.metadata as { studyCompleted?: unknown }).studyCompleted === true
}

export function studyMessageText(message: UIMessage): string {
  return stripStudyMarker(message.parts.filter((part) => part.type === 'text').map((part) => part.text).join(''))
}
