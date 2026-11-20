/** 学科 id → 中文显示名。与服务端 tagging.ts 的 NOTE_SUBJECTS 保持一致(keys 必须相同)。 */
export const SUBJECT_LABELS = {
  math: '数学',
  english: '英语',
  chinese: '语文',
  physics: '物理',
  chemistry: '化学',
  biology: '生物',
  history: '历史',
  geography: '地理',
  politics: '政治',
  other: '其他',
} as const

export type NoteSubject = keyof typeof SUBJECT_LABELS

/** 学科识别色（低饱和，深浅两态通用；2026-11-14 学科选择器美化定稿，后续考点 chip/来源徽章复用同一套）。
 *  与 SUBJECT_LABELS 同 keys。 */
export const SUBJECT_COLORS: Record<NoteSubject, string> = {
  math: '#5b6ef5', // 靛
  english: '#3aa0d8', // 天蓝
  chinese: '#e0592e', // 朱
  physics: '#8a5cf6', // 紫
  chemistry: '#1d9db5', // 青
  biology: '#55a04f', // 绿
  history: '#c28a30', // 琥珀
  geography: '#2f9d85', // 孔雀
  politics: '#d9536f', // 绯
  other: '#98989f', // 灰
}

/** hex → css rgb() 串,带透明度(如 'rgb(91 110 245 / .12)'),供 tint 底色用 */
export function subjectTint(hex: string, alpha: number): string {
  const n = hex.replace('#', '')
  const r = parseInt(n.slice(0, 2), 16)
  const g = parseInt(n.slice(2, 4), 16)
  const b = parseInt(n.slice(4, 6), 16)
  return `rgb(${r} ${g} ${b} / ${alpha})`
}

