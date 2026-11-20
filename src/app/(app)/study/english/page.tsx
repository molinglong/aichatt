'use client'

/**
 * /study/english —— 英语背词工作台（全屏路由，方案 A 居中沉浸）。
 * 入口在学习台「英语」卡；本页只负责壳，队列与判分在 WordWorkspace 里。
 */
import { WordWorkspace } from '@/components/english/WordWorkspace'

export default function StudyEnglishPage() {
  return <WordWorkspace />
}
