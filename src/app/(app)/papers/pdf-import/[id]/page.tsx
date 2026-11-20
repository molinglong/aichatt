'use client'

/**
 * /papers/pdf-import/[id] —— PDF 录题审核台(方案A 双栏工作台 + C 批量 + B 编辑抽屉)。
 * 组件实现在 src/components/papers/PdfImportWorkbench.tsx。
 */
import { Suspense } from 'react'
import { useParams } from 'next/navigation'
import { AuthErrorBoundary } from '@/components/AuthErrorBoundary'
import { ClientOnly } from '@/components/ClientOnly'
import { PdfImportWorkbench } from '@/components/papers/PdfImportWorkbench'

function PdfImportContent() {
  const { id } = useParams<{ id: string }>()
  if (!id || typeof id !== 'string') return <div className="h-full" />
  return <PdfImportWorkbench id={id} />
}

export default function PdfImportReviewPage() {
  return (
    <AuthErrorBoundary>
      <ClientOnly>
        <Suspense fallback={<div className="h-full" />}>
          <PdfImportContent />
        </Suspense>
      </ClientOnly>
    </AuthErrorBoundary>
  )
}
