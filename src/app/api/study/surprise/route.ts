/**
 * GET /api/study/surprise —— 组一套突击测验(概念选择题 × 3)
 *
 * 题源配额与顺延见 lib/study/surprise.ts;三池全空或无可用模型时返回
 * { empty:true, missing } 而不是 500,前端据此展示空态文案。
 */
import { NextRequest, NextResponse } from 'next/server'
import { getUserId } from '@/lib/api-auth'
import { assembleSurpriseQuiz } from '@/lib/study/surprise'

export async function GET(req: NextRequest) {
  const userId = await getUserId(req)
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { items, missing } = await assembleSurpriseQuiz(userId)
  if (!items.length) {
    return NextResponse.json({ empty: true, missing })
  }
  return NextResponse.json({ empty: false, items })
}
