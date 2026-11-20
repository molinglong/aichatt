'use client'

/**
 * /papers/import —— PDF 录题上传页:拖入 PDF 或试卷照片 → 选学科(可改卷名/年份/考试类型)→
 * 建作业(落盘+逐页抽文本+判文本版/扫描版)→ 跳审核台按块切题。
 * PDF 走原有管线;多张照片(拍照/相册)服务端归一化后合成多页 PDF,走扫描版视觉切题。
 * 入口:拟卷列表页头部「PDF 录题」。
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Camera, ChevronLeft, FileText, Images, Upload, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { SUBJECT_LABELS } from '@/lib/study/subject-labels'
import { AuthErrorBoundary } from '@/components/AuthErrorBoundary'
import { ClientOnly } from '@/components/ClientOnly'

const EXAM_TYPES = ['学业水平', '期末', '期中', '月考', '模拟', '高考', '其他']

const SUBJECT_KEYS = Object.keys(SUBJECT_LABELS) as Array<keyof typeof SUBJECT_LABELS>

const MAX_IMAGES = 30
const MAX_TOTAL_BYTES = 30 * 1024 * 1024
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp']

const isImage = (f: File) => IMAGE_TYPES.has(f.type) || IMAGE_EXTS.some((e) => f.name.toLowerCase().endsWith(e))

function ImportContent() {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const cameraInputRef = useRef<HTMLInputElement | null>(null)
  const galleryInputRef = useRef<HTMLInputElement | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [images, setImages] = useState<File[]>([])
  const [subject, setSubject] = useState<keyof typeof SUBJECT_LABELS>('math')
  const [title, setTitle] = useState('')
  const [year, setYear] = useState('')
  const [examType, setExamType] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  // 缩略图 objectURL:随 images 变化重建,旧的全部回收
  const thumbs = useMemo(() => images.map((f) => ({ f, url: URL.createObjectURL(f) })), [images])
  useEffect(() => () => thumbs.forEach((t) => URL.revokeObjectURL(t.url)), [thumbs])

  const pickPdf = useCallback((f: File | null | undefined) => {
    if (!f) return
    if (f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) {
      toast.error('只收 PDF 文件')
      return
    }
    if (f.size > MAX_TOTAL_BYTES) {
      toast.error('PDF 超过 30MB,先拆小一点')
      return
    }
    setImages([])
    setFile(f)
    setTitle((t) => t || f.name.replace(/\.pdf$/i, ''))
  }, [])

  const pickImages = useCallback((list: FileList | null | undefined) => {
    if (!list?.length) return
    const arr = Array.from(list)
    const bad = arr.find((f) => !isImage(f))
    if (bad) {
      toast.error(`只收 JPG/PNG/WebP 图片(${bad.name.slice(0, 30)} 不是)`)
      return
    }
    const total = arr.reduce((s, f) => s + f.size, 0)
    if (total > MAX_TOTAL_BYTES) {
      toast.error('图片总共超过 30MB,少选几张或先压缩')
      return
    }
    if (arr.length > MAX_IMAGES) {
      toast.error(`一次最多 ${MAX_IMAGES} 张,先到「浏览文件」里分批传`)
      return
    }
    setFile(null)
    setImages(arr)
    setTitle((t) => t || (arr.length === 1 ? arr[0].name.replace(/\.(jpe?g|png|webp)$/i, '') : ''))
  }, [])

  /** 拖入区收两种来源:第一项是 PDF 走 PDF,否则全部按图片(保序) */
  const pickDropped = useCallback(
    (files: FileList | null | undefined) => {
      if (!files?.length) return
      const first = files[0]
      if (first.type === 'application/pdf' || first.name.toLowerCase().endsWith('.pdf')) {
        pickPdf(first)
        return
      }
      pickImages(files)
    },
    [pickPdf, pickImages]
  )

  const removeImage = (idx: number) => setImages((prev) => prev.filter((_, i) => i !== idx))

  const submit = async () => {
    if (submitting || (!file && !images.length)) return
    setSubmitting(true)
    // multipart 不走 fetchJson(它会 JSON.stringify),裸 fetch + 手动超时
    const form = new FormData()
    if (file) form.append('file', file)
    images.forEach((img) => form.append('images', img))
    form.append('subject', subject)
    if (title.trim()) form.append('title', title.trim())
    if (year.trim()) form.append('year', year.trim())
    if (examType) form.append('examType', examType)
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 120_000)
    try {
      const res = await fetch('/api/papers/pdf-import', {
        method: 'POST',
        credentials: 'include',
        body: form,
        signal: ctrl.signal,
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        const msgMap: Record<string, string> = {
          not_pdf: '只收 PDF 文件',
          not_image: '只收 JPG/PNG/WebP 图片',
          too_many_images: '一次最多 30 张照片',
          image_unreadable: '有图片读不出来(可能损坏或格式不支持)',
          too_large: file ? 'PDF 超过 30MB,先拆小一点' : '图片总共超过 30MB,少选几张',
          bad_subject: '学科不对,重选一下',
          pdf_unreadable: '这份 PDF 读不出来(可能已损坏)',
        }
        throw new Error(msgMap[body.error ?? ''] ?? `服务端错误(${res.status})`)
      }
      const r = (await res.json()) as { id: string; mode: string; pageCount: number }
      toast.success(`已建作业:${r.pageCount} 页 · ${r.mode === 'text' ? '文本版直切' : '扫描版走视觉'}`)
      router.push(`/papers/pdf-import/${r.id}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`建作业失败:${msg.slice(0, 100)}`)
      setSubmitting(false)
    } finally {
      clearTimeout(timer)
    }
  }

  const sizeLabel = useMemo(() => {
    const bytes = file ? file.size : images.reduce((s, f) => s + f.size, 0)
    return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`
  }, [file, images])

  const hasSource = !!file || images.length > 0

  return (
    <div className="relative h-full">
      <div className="absolute inset-x-0 top-0 z-10 flex min-h-[52px] items-center gap-1.5 border-b border-line/60 bg-surface/95 px-1.5 backdrop-blur-md max-md:pt-[var(--sat)] md:px-4">
        <button
          type="button"
          onClick={() => router.push('/papers/composed')}
          aria-label="返回"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-content-secondary transition-colors hover:bg-surface-subtle hover:text-content-primary"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1 py-1 text-[13px] font-medium text-content-primary md:text-sm">PDF 录题</div>
      </div>

      <div className="h-full overflow-y-auto pt-[calc(52px+var(--sat))]">
        <div className="mx-auto w-full max-w-[560px] px-2 pt-4 pb-16 md:px-4">
          <p className="mb-3 px-1 text-[12.5px] leading-relaxed text-content-muted">
            上传整卷 PDF 或试卷照片,AI 切题出候选清单,你逐题审核后入库题库、建进卷库。文本版 PDF 直切最快;照片自动走视觉切题,拍清楚些效果最好。
          </p>

          {/* 拖入区:PDF / 图片两用 */}
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              pickDropped(e.dataTransfer.files)
            }}
            className={cn(
              'flex w-full flex-col items-center gap-2 rounded-[16px] border-[1.5px] border-dashed px-6 py-9 text-center transition-colors',
              dragOver ? 'border-accent bg-accent-soft' : 'border-line-strong hover:border-accent'
            )}
          >
            {file ? (
              <>
                <FileText className="h-6 w-6 text-accent" />
                <span className="max-w-full truncate text-[13px] font-semibold text-content-primary">{file.name}</span>
                <span className="text-[11px] text-content-muted tabular-nums">
                  {sizeLabel} · 点这里换一个文件
                </span>
              </>
            ) : images.length ? (
              <>
                <Images className="h-6 w-6 text-accent" />
                <span className="text-[13px] font-semibold text-content-primary">
                  {images.length} 张图片 · 按选择顺序作为页序
                </span>
                <span className="text-[11px] text-content-muted tabular-nums">
                  共 {sizeLabel} · 点这里重新选
                </span>
              </>
            ) : (
              <>
                <Upload className="h-6 w-6 text-content-muted" />
                <span className="text-[13px] font-semibold text-content-primary">
                  拖入 PDF 或试卷照片,或<span className="text-accent">浏览文件</span>
                </span>
                <span className="text-[11px] leading-relaxed text-content-muted">
                  单文件 ≤ 30MB · 照片最多 {MAX_IMAGES} 张 · 文本版 PDF 直切最快
                </span>
              </>
            )}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            onChange={(e) => pickPdf(e.target.files?.[0])}
          />

          {/* 拍照 / 选图入口(手机上「拍照」直接唤起相机) */}
          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => cameraInputRef.current?.click()}
              className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full border border-line bg-surface text-[12px] font-medium text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary"
            >
              <Camera className="h-3.5 w-3.5" />
              拍照上传
            </button>
            <button
              type="button"
              onClick={() => galleryInputRef.current?.click()}
              className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full border border-line bg-surface text-[12px] font-medium text-content-secondary transition-colors hover:border-line-strong hover:text-content-primary"
            >
              <Images className="h-3.5 w-3.5" />
              从相册选图
            </button>
          </div>
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              pickImages(e.target.files)
              e.target.value = ''
            }}
          />
          <input
            ref={galleryInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
            multiple
            className="hidden"
            onChange={(e) => {
              pickImages(e.target.files)
              e.target.value = ''
            }}
          />

          {/* 照片缩略图(可单删) */}
          {images.length > 0 && (
            <div className="mt-3 grid grid-cols-5 gap-1.5">
              {thumbs.map((t, i) => (
                <div key={t.url} className="group relative aspect-[3/4] overflow-hidden rounded-[8px] border border-line bg-surface-subtle">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={t.url} alt={`第 ${i + 1} 页`} className="h-full w-full object-cover" />
                  <span className="absolute inset-x-0 bottom-0 bg-black/45 py-px text-center text-[9.5px] font-semibold text-white tabular-nums">
                    第 {i + 1} 页
                  </span>
                  <button
                    type="button"
                    aria-label={`移除第 ${i + 1} 页`}
                    onClick={() => removeImage(i)}
                    className="absolute right-0.5 top-0.5 flex h-4.5 w-4.5 items-center justify-center rounded-full bg-black/55 text-white transition-colors hover:bg-black/80"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* 表单 */}
          <div className={cn('mt-4 transition-opacity', !hasSource && 'pointer-events-none opacity-45')}>
            <div className="mb-1.5 block px-1 text-[11px] font-semibold tracking-wide text-content-secondary">学科</div>
            <div className="flex flex-wrap gap-1.5 px-0.5">
              {SUBJECT_KEYS.map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setSubject(k)}
                  className={cn(
                    'rounded-full border px-3 py-1.5 text-[12px] transition-colors',
                    subject === k
                      ? 'border-accent bg-accent-soft font-semibold text-accent'
                      : 'border-line bg-surface text-content-secondary hover:border-line-strong hover:text-content-primary'
                  )}
                >
                  {SUBJECT_LABELS[k]}
                </button>
              ))}
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
              <label className="block">
                <span className="mb-1.5 block px-1 text-[11px] font-semibold tracking-wide text-content-secondary">卷名</span>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={images.length > 1 ? '默认「拍照录题」' : '默认取文件名'}
                  className="w-full rounded-[9px] border border-line bg-surface px-2.5 py-2 text-[12.5px] text-content-primary outline-none transition-colors focus:border-accent"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block px-1 text-[11px] font-semibold tracking-wide text-content-secondary">年份/考期(选填)</span>
                <input
                  value={year}
                  onChange={(e) => setYear(e.target.value)}
                  placeholder="如 2025 / 2025 上半年"
                  className="w-full rounded-[9px] border border-line bg-surface px-2.5 py-2 text-[12.5px] text-content-primary outline-none transition-colors focus:border-accent"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block px-1 text-[11px] font-semibold tracking-wide text-content-secondary">考试类型(选填)</span>
                <select
                  value={examType}
                  onChange={(e) => setExamType(e.target.value)}
                  className="w-full rounded-[9px] border border-line bg-surface px-2.5 py-2 text-[12.5px] text-content-primary outline-none transition-colors focus:border-accent"
                >
                  <option value="">AI 从卷头抽</option>
                  {EXAM_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <button
              type="button"
              onClick={() => void submit()}
              disabled={!hasSource || submitting}
              className="mt-5 flex h-11 w-full items-center justify-center gap-2 rounded-full bg-accent text-[13.5px] font-bold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {submitting ? (
                <>
                  <i className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-foreground" />
                  {images.length ? '正在合成页图,几秒钟…' : '正在抽文本层,几秒钟…'}
                </>
              ) : (
                '开始切题'
              )}
            </button>
            <p className="mt-2.5 px-1 text-[11px] leading-relaxed text-content-muted">
              切题按页分块跑,整卷约几十秒;进审核台后每道题都要经你手:入库 / 跳过 / 改字段。缺答案的题不进练题池,可让 AI 先解。
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function PdfImportUploadPage() {
  return (
    <AuthErrorBoundary>
      <ClientOnly>
        <Suspense fallback={<div className="h-full" />}>
          <ImportContent />
        </Suspense>
      </ClientOnly>
    </AuthErrorBoundary>
  )
}
