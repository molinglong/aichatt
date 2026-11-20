'use client'

/**
 * /papers/exam/[id] —— 在线做题考试场(design/preview-online-exam.html 方案A 定稿)。
 * 同一路由两种状态:attempt 进行中 → ExamRun(卷面仿真答题);已交卷 → ExamReportView(估分报告)。
 * 交卷由 ExamRun 就地切换(setQueryData),报告自评同样整包刷——离开页面回来(GET)也能恢复两态。
 */
import { Suspense } from 'react'
import { useParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { AuthErrorBoundary } from '@/components/AuthErrorBoundary'
import { ClientOnly } from '@/components/ClientOnly'
import { ExamRun } from '@/components/papers/ExamRun'
import { ExamReportView } from '@/components/papers/ExamReportView'
import { fetchJson } from '@/lib/query/fetcher'
import { queryKeys } from '@/lib/query/keys'
import type { AttemptReportPayload, AttemptRunPayload } from '@/lib/papers/attempt'
import './wenkai-screen.css'

function ExamContent() {
  const { id } = useParams<{ id: string }>()
  const { data, isPending, isError } = useQuery({
    queryKey: queryKeys.papers.attempt(id),
    queryFn: ({ signal }) => fetchJson<AttemptRunPayload | AttemptReportPayload>(`/api/papers/attempts/${id}`, { signal }),
    // 考试进行中数据以本地作答状态为准,后端只是存档;报告页希望快照新鲜
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  })

  if (isError) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-sm text-content-muted">
        考试不存在或无权访问
      </div>
    )
  }
  if (isPending) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="study-sk h-64 w-full max-w-2xl rounded-2xl" />
      </div>
    )
  }
  if (data.attempt.status === 'submitted') {
    return <ExamReportView payload={data as AttemptReportPayload} />
  }
  return <ExamRun payload={data as AttemptRunPayload} />
}

export default function ExamAttemptPage() {
  return (
    <AuthErrorBoundary>
      <ClientOnly>
        <Suspense fallback={<div className="h-full" />}>
          <ExamContent />
        </Suspense>
      </ClientOnly>
    </AuthErrorBoundary>
  )
}
