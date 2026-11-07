'use client'

/**
 * /kb —— 课本书架:列出知识库中「可翻原文」的课本(按页导入、有页图的)。
 *
 * 数据来自 GET /api/kb/docs(只含 bookKey 非空的 KnowledgeDoc);封面即第 1 页
 * (/kb-pages/{bookKey}/p001.webp),点进 /kb/[docId] 阅读器。
 * 导入入口是服务端脚本(import-kb-pdf-pages.cjs),这里没有上传/管理动作——
 * 书架是纯阅读视图,符合「知识库管理走脚本、用户侧只消费」的分层。
 */
import { useSuspenseQuery } from '@tanstack/react-query'
import { BookOpen, Library } from 'lucide-react'
import { AuthErrorBoundary } from '@/components/AuthErrorBoundary'
import { ClientOnly } from '@/components/ClientOnly'
import { fetchJson } from '@/lib/query/fetcher'
import { queryKeys } from '@/lib/query/keys'
import { KNOWLEDGE_SUBJECT_LABELS } from '@/lib/ai/knowledge-tool'

export interface KbDoc {
  id: string
  title: string
  subject: string
  grade: string | null
  kind: string
  publisher: string | null
  bookKey: string
  pageCount: number | null
  chunkCount: number
  charCount: number
  createdAt: string
}

function KbShelf() {
  const { data: docs } = useSuspenseQuery({
    queryKey: queryKeys.kb.docs(),
    queryFn: ({ signal }) => fetchJson<KbDoc[]>('/api/kb/docs', { signal }),
  })

  return (
    <div className="mx-auto h-full w-full max-w-5xl overflow-y-auto px-4 pb-10 pt-6 md:px-8">
      <header className="mb-6 flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Library className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-content-primary">课本</h1>
          <p className="text-xs text-content-muted">
            {docs.length > 0 ? `${docs.length} 本 · 翻看教材原文页面` : '知识库里的教材原文页面'}
          </p>
        </div>
      </header>

      {docs.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-line/70 px-6 py-16 text-center">
          <BookOpen className="h-8 w-8 text-content-muted/60" />
          <p className="text-sm text-content-secondary">还没有可翻阅的课本</p>
          <p className="max-w-xs text-xs leading-relaxed text-content-muted">
            通过导入脚本把教材 PDF 按页导入后，会出现在这里
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {docs.map((doc) => (
            <a
              key={doc.id}
              href={`/kb/${doc.id}`}
              className="group flex flex-col gap-2.5"
            >
              <div
                className="relative overflow-hidden rounded-xl border border-line/60 bg-surface-subtle shadow-sm transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:shadow-md"
                style={{ aspectRatio: '1191 / 1684' }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/kb-pages/${doc.bookKey}/p001.webp`}
                  alt={doc.title}
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover"
                />
              </div>
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium text-content-primary" title={doc.title}>
                  {doc.title}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-content-muted">
                  {doc.grade && <span className="truncate">{doc.grade}</span>}
                  <span className="shrink-0 rounded bg-surface-subtle px-1 py-0.5">
                    {KNOWLEDGE_SUBJECT_LABELS[doc.subject] ?? doc.subject}
                  </span>
                  {doc.pageCount != null && <span className="shrink-0">{doc.pageCount} 页</span>}
                </div>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

export default function KbShelfPage() {
  return (
    <AuthErrorBoundary>
      <ClientOnly>
        <KbShelf />
      </ClientOnly>
    </AuthErrorBoundary>
  )
}
