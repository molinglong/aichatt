'use client'

import { useState, useRef, useCallback, useEffect, DragEvent } from 'react'
import { Paperclip, X, Upload, FileText, Image as ImageIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export type { Attachment } from '@/lib/attachment-types'
import type { Attachment } from '@/lib/attachment-types'

export interface UploadingItem {
  id: string
  name: string
  progress: number
  status: 'uploading' | 'done' | 'error'
  error?: string
}

interface FileUploadProps {
  attachments: Attachment[]
  onAttachmentsChange: React.Dispatch<React.SetStateAction<Attachment[]>>
  disabled?: boolean
  onUploadingChange?: (uploading: boolean) => void
  /** 隐藏已上传附件的预览(由 ChatInput 顶部统一展示),仅保留上传中进度 */
  hideAttachmentsPreview?: boolean
  /** 视觉变体: 'icon'(默认) 28px 圆形图标按钮; 'pill' 带文字的胶囊按钮(输入框下方) */
  variant?: 'icon' | 'pill'
  /** pill 变体的样式覆盖(twMerge 合并,后写优先),用于会话页紧凑胶囊 */
  pillClassName?: string
  /** 不渲染上传触发钮:手机端胶囊只留 ⋯ + 发送,入口由外部经 openRef 唤起 */
  hideTrigger?: boolean
  /** 外部触发文件选择的句柄,挂载时写入、卸载时清空 */
  openRef?: React.MutableRefObject<(() => void) | null>
  /** 外部投递文件的句柄(输入框 Ctrl+V 粘贴):复用同一套上传/进度/错误链路 */
  filesRef?: React.MutableRefObject<((files: FileList | File[]) => void) | null>
  /** 不在本组件内渲染上传进度卡(由宿主放到附件行统一渲染,避免撑高输入框底部工具行) */
  hideUploads?: boolean
  /** 上传中条目变化回调,配合 hideUploads 由宿主自行渲染进度 */
  onUploadingFilesChange?: (items: UploadingItem[]) => void
}

/**
 * 上传中的附件卡:与 ChatInput 已上传附件卡同骨架(40px 图块 + 文件名 + 进度/报错)。
 * 宿主可经 hideUploads 接管渲染位置(会话输入框把它和已上传卡排在同一行)。
 */
export function UploadingChip({ item }: { item: UploadingItem }) {
  const failed = item.status === 'error'
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 rounded-xl border p-1.5 pr-2 w-full sm:w-auto sm:max-w-[228px]',
        failed
          ? 'border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30'
          : 'border-line bg-surface-muted/70'
      )}
    >
      <span
        aria-hidden
        className={cn(
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg',
          failed ? 'bg-red-100 dark:bg-red-900/40' : 'bg-surface-subtle'
        )}
      >
        <Upload className={cn('w-4 h-4', failed ? 'text-red-500' : 'text-content-muted animate-pulse')} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[11px] font-medium leading-tight text-content-primary">{item.name}</p>
        {failed ? (
          <p className="mt-1 truncate text-[10px] leading-none text-red-500">{item.error || '上传失败'}</p>
        ) : (
          <div className="mt-1 flex items-center gap-1.5">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface-subtle">
              <div
                className="h-full rounded-full bg-accent transition-all duration-200"
                style={{ width: `${item.progress}%` }}
              />
            </div>
            <span className="shrink-0 text-[9px] leading-none tabular-nums text-content-muted">
              {item.progress}%
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

export function deleteUploadedFile(url: string) {
  try {
    const name = url.split('/').pop()
    if (!name) return
    fetch(`/api/upload?file=${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => {
      // 删除失败不影响主流程,孤儿清理会兜底
    })
  } catch {
    // 忽略
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatChars(count: number): string {
  if (count < 1000) return `${count} 字`
  return `${(count / 1000).toFixed(1)}k 字`
}

function uploadFile(file: File, onProgress: (pct: number) => void): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const formData = new FormData()
    formData.append('file', file)

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100))
      }
    })

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText))
        } catch {
          reject(new Error('Invalid response'))
        }
      } else {
        try {
          const err = JSON.parse(xhr.responseText)
          reject(new Error(err.error || 'Upload failed'))
        } catch {
          reject(new Error('Upload failed'))
        }
      }
    })

    xhr.addEventListener('error', () => reject(new Error('Network error')))
    xhr.open('POST', '/api/upload')
    xhr.send(formData)
  })
}

let idCounter = 0

export function FileUpload({
  attachments,
  onAttachmentsChange,
  disabled,
  onUploadingChange,
  hideAttachmentsPreview = false,
  variant = 'icon',
  pillClassName,
  hideTrigger = false,
  openRef,
  filesRef,
  hideUploads = false,
  onUploadingFilesChange,
}: FileUploadProps) {
  const [uploading, setUploading] = useState<UploadingItem[]>([])
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const uploadPending = uploading.some((file) => file.status === 'uploading')
  useEffect(() => {
    onUploadingChange?.(uploadPending)
  }, [uploadPending, onUploadingChange])

  // 上传中条目同步给宿主(它要把进度卡渲染到附件行):回调走 ref,避免宿主内联函数导致 effect 反复触发
  const uploadingCbRef = useRef(onUploadingFilesChange)
  useEffect(() => {
    uploadingCbRef.current = onUploadingFilesChange
  }, [onUploadingFilesChange])
  useEffect(() => {
    uploadingCbRef.current?.(uploading)
  }, [uploading])
  // 卸载时清空宿主那份副本,避免残留一条永不结束的进度卡
  useEffect(() => () => uploadingCbRef.current?.([]), [])

  // 外部触发入口(手机端 ⋯ 面板「添加附件」):input 始终挂载,点击代理到隐藏 input
  useEffect(() => {
    if (!openRef) return
    openRef.current = () => inputRef.current?.click()
    return () => {
      openRef.current = null
    }
  }, [openRef])

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const fileArray = Array.from(files)
      if (fileArray.length === 0) return

      const tasks = fileArray.map(async (file) => {
        const id = `upload-${++idCounter}`
        const entry: UploadingItem = { id, name: file.name, progress: 0, status: 'uploading' }
        setUploading((prev) => [...prev, entry])

        try {
          const result = await uploadFile(file, (pct) => {
            setUploading((prev) =>
              prev.map((u) => (u.id === id ? { ...u, progress: pct } : u))
            )
          })
          setUploading((prev) => prev.filter((u) => u.id !== id))
          // 函数式更新,避免并发上传时覆盖彼此的结果
          onAttachmentsChange((prev) => [...prev, result])
        } catch (err) {
          setUploading((prev) =>
            prev.map((u) =>
              u.id === id
                ? { ...u, status: 'error', error: (err as Error).message }
                : u
            )
          )
          // Remove error entries after 3 seconds
          setTimeout(() => {
            setUploading((prev) => prev.filter((u) => u.id !== id))
          }, 3000)
        }
      })

      await Promise.all(tasks)
    },
    [onAttachmentsChange]
  )

  // 外部投递文件(输入框 Ctrl+V):与点选/拖拽共用同一条上传链路,进度与报错一并复用
  useEffect(() => {
    if (!filesRef) return
    filesRef.current = (files) => {
      if (disabled) return
      void handleFiles(files)
    }
    return () => {
      filesRef.current = null
    }
  }, [filesRef, handleFiles, disabled])

  function handleRemove(index: number) {
    const removed = attachments[index]
    onAttachmentsChange((prev) => prev.filter((_, i) => i !== index))
    // 移除未发送的附件时同步删除服务端文件(已发送的文件会被接口拒绝删除)
    if (removed) {
      deleteUploadedFile(removed.url)
    }
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragging(true)
  }

  function handleDragLeave(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragging(false)
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragging(false)
    if (disabled) return
    if (e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files)
    }
  }

  // 隐藏文件选择器:trigger 收在外部(手机端 ⋯ 面板)时它是本组件唯一的常驻节点
  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      multiple
      accept="image/*,text/*,application/pdf,.xlsx,.xls,.docx,.pptx,.html,.htm"
      className="hidden"
      onChange={(e) => {
        if (e.target.files) handleFiles(e.target.files)
        e.target.value = '' // reset
      }}
    />
  )

  // 手机端:无上传进行中且预览由宿主渲染时,只留这个 display:none 的 input。
  // 若照常挂 flex 容器,它会作为空子项占掉胶囊一整行(实测手机端输入胶囊被顶高 4px)
  if (hideTrigger && hideAttachmentsPreview && (uploading.length === 0 || hideUploads)) return fileInput

  return (
    <div className="flex flex-col gap-1.5 max-md:w-full">
      {/* Hidden file input */}
      {fileInput}

      {/* Attachments preview(进度卡可经 hideUploads 交给宿主渲染) */}
      {((!hideAttachmentsPreview && attachments.length > 0) || (!hideUploads && uploading.length > 0)) && (
          <div className="flex flex-wrap gap-2 px-1">
            {!hideAttachmentsPreview &&
              attachments.map((att, idx) => (
                <div
                  key={att.url + idx}
                  className={cn(
                    'relative group flex items-center gap-2 rounded-lg border',
                    'border-line bg-surface-muted',
                    'px-2 py-1.5 max-w-[180px]'
                  )}
                >
                  {att.type.startsWith('image/') ? (
                    <ImageIcon className="w-4 h-4 text-content-secondary shrink-0" />
                  ) : (
                    <FileText className="w-4 h-4 text-content-muted shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-content-primary truncate">
                      {att.name}
                    </p>
                    {att.parseStatus ? (
                      // 中转站解析型附件(文本/PDF/Excel/Word/PPT/HTML):展示解析状态
                      att.parseStatus === 'failed' ? (
                        <p className="text-[10px] text-red-500 truncate">
                          解析失败{att.parseError ? `：${att.parseError}` : ''}
                        </p>
                      ) : att.pageCount != null ? (
                        <p className="text-[10px] text-content-muted">
                          {att.pageCount} 页 · {formatChars(att.charCount ?? 0)}
                        </p>
                      ) : (
                        <p className="text-[10px] text-content-muted">
                          {formatChars(att.charCount ?? 0)}
                        </p>
                      )
                    ) : (
                      <p className="text-[10px] text-content-muted">
                        {formatSize(att.size)}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemove(idx)}
                    className={cn(
                      'shrink-0 p-0.5 rounded-md transition-colors',
                      'opacity-0 show-on-touch group-hover:opacity-100',
                      'hover:bg-red-100 dark:hover:bg-red-900/30 hover:text-red-500'
                    )}
                    aria-label="移除文件"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}

          {!hideUploads && uploading.map((u) => <UploadingChip key={u.id} item={u} />)}
        </div>
      )}

      {/* Drag overlay hint / attach button row —— hideTrigger(手机端)时整块不渲染,只留 input 与进度卡 */}
      {!hideTrigger && (
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          'relative',
          dragging && 'ring-2 ring-line-strong rounded-lg bg-surface-muted/50'
        )}
      >
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled}
          className={cn(
            'flex items-center justify-center transition-colors',
            variant === 'pill'
              ? cn(
                  // 胶囊态: 已图标化(与工具组圆形钮同构,不再渲染文字),无文字内边距;
                  // 尺寸/配色由 pillClassName 覆盖(桌面 28px / 移动 44px 触控)
                  'h-8 rounded-full border shrink-0',
                  'border-line bg-surface text-content-secondary',
                  'hover:bg-surface-subtle hover:text-content-primary hover:border-line-strong',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                  pillClassName
                )
              : cn(
                  // 图标态: 28px 圆形按钮(输入框内联使用)
                  'h-7 w-7 rounded-full',
                  'text-content-muted hover:text-content-primary',
                  'hover:bg-surface-subtle',
                  'disabled:opacity-50 disabled:cursor-not-allowed'
                )
          )}
          aria-label="添加附件"
          title="添加附件 (图片、文本、PDF, 最大10MB) · 支持 Ctrl+V 粘贴"
        >
          <Paperclip className="w-3.5 h-3.5" />
          {/* pill 变体已图标化(与工具组圆形钮同构),不再渲染文字 */}
        </button>

        {dragging && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <p className="text-sm text-content-secondary font-medium">松开以上传文件</p>
          </div>
        )}
      </div>
      )}
    </div>
  )
}
