'use client'

import { Suspense, useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { useSuspenseQuery, useQueryClient } from '@tanstack/react-query'
import Image from 'next/image'
import {
  Loader2,
  Sparkles,
  Trash2,
  Download,
  Copy,
  X,
  ChevronDown,
  Check,
  Wand2,
  Brush,
  Layers,
  ChevronRight,
  Grid3x3,
  ImagePlus,
  Upload,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/Skeleton'
import { AuthErrorBoundary } from '@/components/AuthErrorBoundary'
import { MobileWorkHead } from '@/components/mobile/MobileWorkHead'
import { ClientOnly } from '@/components/ClientOnly'
import { queryKeys, STALE, IMAGES_PAGE_SIZE as PAGE_SIZE } from '@/lib/query/keys'
import { fetchJson } from '@/lib/query/fetcher'
import { deleteUploadedFile } from '@/components/chat/FileUpload'
import { ChatImageLightbox } from '@/components/chat/ChatImageLightbox'
import { confirmDialog } from '@/components/ui/ConfirmDialog'
import { toast } from '@/lib/toast'

interface GeneratedImage {
  id: string
  prompt: string
  url: string
  model: string
  width: number
  height: number
  source: string
  createdAt: string
  parentId?: string | null
  editType?: string
  referenceImageUrl?: string | null
}

type EditTab = 'edit' | 'inpaint' | 'variation'
type MaskRect = { x: number; y: number; w: number; h: number } // 归一化坐标 0~1

const PROMPT_PRESETS = [
  '赛博朋克风格的城市夜景,霓虹灯,雨后街道',
  '一只可爱的橘猫坐在窗台,水彩画风格',
  '日系治愈系插画,少女,樱花飘落,柔和光线',
  '极简几何风格的山脉海报,扁平设计',
]

// 与服务端默认一致(image-settings GET / images POST 的兜底值);
// 本地 state 初始化和「存档模型已下线」自愈都回落到它
const DEFAULT_IMAGE_MODEL = 'builtin:wanx2.1-t2i-turbo'

// ─── 生图进度:消费 /api/images 的 NDJSON 阶段流 ────────────────────────────────
// 阶段与 src/lib/ai/image.ts 的 GenStage 对齐
type GenStage = 'submit' | 'running' | 'saving'

const STAGE_LABEL: Record<GenStage, string> = {
  submit: '提交任务',
  running: '模型生成中',
  saving: '下载保存',
}

type StageEvent = { stage: GenStage; poll?: number; elapsedMs?: number }

/**
 * 阶段 → 进度条百分比。
 * submit/saving 是瞬时阶段给固定值;running 拿不到真实百分比(接口是轮询/同步返回),
 * 用已用时近似:约 30s 爬到 85%,再慢也不超过 95(避免"卡在 99%")。
 */
function stagePercent(stage: GenStage, elapsedMs: number): number {
  if (stage === 'submit') return 6
  if (stage === 'saving') return 92
  return Math.min(95, Math.round(12 + (elapsedMs / 30_000) * 73))
}

/**
 * 发起生图并消费进度流(POST + fetch ReadableStream;EventSource 只支持 GET)。
 * - 服务端返回 NDJSON:逐行解析 stage/done/error 事件
 * - 服务端返回 JSON(参数校验失败/旧版本):按 JSON 语义回退,不改行为
 */
async function readGenerationStream<T>(
  body: Record<string, unknown>,
  onStage: (e: StageEvent) => void
): Promise<T> {
  const res = await fetch('/api/images', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/x-ndjson',
    },
    body: JSON.stringify(body),
  })

  if (!(res.headers.get('content-type') ?? '').includes('application/x-ndjson')) {
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error((data as { error?: string }).error || `生成失败 (HTTP ${res.status})`)
    }
    return data as T
  }

  const reader = res.body?.getReader()
  if (!reader) throw new Error('生成失败:响应不可读')

  const decoder = new TextDecoder()
  const outcome: { result?: T; error?: string } = {}
  let buffer = ''

  const handleLine = (line: string) => {
    const text = line.trim()
    if (!text) return
    let evt: {
      type?: string
      stage?: GenStage
      poll?: number
      elapsedMs?: number
      payload?: T
      message?: string
    }
    try {
      evt = JSON.parse(text)
    } catch {
      return
    }
    if (evt.type === 'stage' && evt.stage) {
      onStage({ stage: evt.stage, poll: evt.poll, elapsedMs: evt.elapsedMs })
    } else if (evt.type === 'done') {
      outcome.result = evt.payload
    } else if (evt.type === 'error') {
      outcome.error = evt.message || '生成失败'
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) handleLine(line)
  }
  buffer += decoder.decode()
  if (buffer.trim()) handleLine(buffer)

  if (outcome.error) throw new Error(outcome.error)
  const payload = outcome.result
  if (payload === undefined) throw new Error('生成失败:连接中断,请重试')
  return payload
}

function ImagesContent() {
  const queryClient = useQueryClient()
  const [prompt, setPrompt] = useState('')
  const [generating, setGenerating] = useState(false)
  // 生图阶段进度(提交/生成中/保存 + 起始时间);非 null 时按钮下方显示进度条
  const [genProgress, setGenProgress] = useState<{
    stage: GenStage
    poll?: number
    startedAt: number
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [images, setImages] = useState<GeneratedImage[]>([])
  const [loadingList, setLoadingList] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [total, setTotal] = useState(0)
  // 用户当前的 model/size 选择由本地 state 持有,与"模型列表"分离。
  // useState 初始化在 query data 尚未到达时使用 fallback,然后用 useEffect 一次性同步。
  const [userImageConfig, setUserImageConfig] = useState<{
    model: string
    size: string
  }>({
    model: DEFAULT_IMAGE_MODEL,
    size: '1024*1024',
  })
  const [viewMode, setViewMode] = useState<'gallery' | 'preview'>('gallery')
  const [latestGeneratedId, setLatestGeneratedId] = useState<string | null>(null)
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false)
  const [switchingModel, setSwitchingModel] = useState(false)
  const [switchingSize, setSwitchingSize] = useState(false)
  // 参考图:工作台「上传一张图作为生成参考」,最多 1 张,持久化在 /uploads
  const [referenceImage, setReferenceImage] = useState<{
    url: string
    name: string
    size: number
  } | null>(null)
  const [referenceUploading, setReferenceUploading] = useState(false)
  const [referenceError, setReferenceError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const modelDropRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!modelDropdownOpen) return
    function onPointerDown(e: PointerEvent) {
      if (modelDropRef.current && !modelDropRef.current.contains(e.target as Node)) {
        setModelDropdownOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [modelDropdownOpen])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 240) + 'px'
  }, [prompt])

  const fetchPage = useCallback(async (offset: number, append: boolean) => {
    const res = await fetch(`/api/images?limit=${PAGE_SIZE}&offset=${offset}`)
    if (!res.ok) throw new Error('加载历史失败')
    const data = await res.json()
    setTotal(data.total ?? 0)
    setHasMore(offset + (data.items?.length ?? 0) < (data.total ?? 0))
    setImages((prev) => (append ? [...prev, ...(data.items ?? [])] : data.items ?? []))
    return data as { items?: GeneratedImage[]; total?: number }
  }, [])

  useEffect(() => {
    // 先用缓存回填(TopBar 预热/上次拉取写回的同一 key):切回本页时
    // 立即有内容可渲染,不再主区空白等待接口;后台仍会刷新最新数据。
    const cached = queryClient.getQueryData<{
      items?: GeneratedImage[]
      total?: number
    }>(queryKeys.images.list(PAGE_SIZE, 0))
    if (cached?.items?.length || cached?.total) {
      setImages(cached.items ?? [])
      setTotal(cached.total ?? 0)
      setHasMore((cached.items?.length ?? 0) < (cached.total ?? 0))
      setLoadingList(false)
    }
    setLoadingList(true)
    fetchPage(0, false)
      .then((data) => {
        // 写回缓存,供下次切回本页时秒开
        queryClient.setQueryData(queryKeys.images.list(PAGE_SIZE, 0), {
          items: data.items ?? [],
          total: data.total ?? 0,
        })
      })
      .catch((err) => {
        console.error(err)
        setError(err instanceof Error ? err.message : '加载失败')
      })
      .finally(() => setLoadingList(false))
  }, [fetchPage, queryClient])

  // ── 图片设置(模型 + 尺寸) ─────────────────────────────────
  // 5 分钟 staleTime 内跨路由共享,首次进入切到 images 时几乎秒开。
  const settingsQuery = useSuspenseQuery<{
    settings?: { imageModel?: string; imageSize?: string }
    builtinModels?: Array<Record<string, unknown>>
    customModels?: Array<Record<string, unknown>>
  }>({
    queryKey: queryKeys.images.settings(),
    queryFn: () =>
      fetchJson<{
        settings?: { imageModel?: string; imageSize?: string }
        builtinModels?: Array<Record<string, unknown>>
        customModels?: Array<Record<string, unknown>>
      }>('/api/image-settings'),
    staleTime: STALE.imageSettings,
  })

  const imageSettingsFromQuery = settingsQuery.data
  // 用户当前的 model/size 选择来自上方 userImageConfig (useState)。
  const settingsHydratedRef = useRef(false)
  // 第一次拿到 query data 后,同步 DB 中的当前选择,之后不再覆盖用户操作。
  useEffect(() => {
    if (settingsHydratedRef.current) return
    if (!settingsQuery.data) return
    settingsHydratedRef.current = true
    setUserImageConfig((prev) => {
      const model = settingsQuery.data?.settings?.imageModel
      // 存档模型已不存在(旧 ID 被下线且未配自定义模型)时回落默认,
      // 避免下拉显示裸 ID、点生成报「未知的内置模型」
      const known =
        !!model &&
        [...(settingsQuery.data?.builtinModels ?? []), ...(settingsQuery.data?.customModels ?? [])]
          .some((m) => m.id === model)
      return {
        model: model ? (known ? model : DEFAULT_IMAGE_MODEL) : prev.model,
        size: settingsQuery.data?.settings?.imageSize ?? prev.size,
      }
    })
  }, [settingsQuery.data])

  const imageSettings = useMemo(() => {
    const data = settingsQuery.data
    return {
      model: userImageConfig.model,
      size: userImageConfig.size,
      builtinModels: data?.builtinModels ?? ([] as Array<Record<string, unknown>>),
      customModels: data?.customModels ?? ([] as Array<Record<string, unknown>>),
    }
  }, [settingsQuery.data, userImageConfig])

  const setImageSettings = useCallback(
    (updater: (prev: typeof imageSettings) => typeof imageSettings) => {
      const next = updater(imageSettings)
      // builtin/custom 列表由 query 供给,只接受 model/size 的本地修改
      setUserImageConfig({ model: next.model, size: next.size })
    },
    [imageSettings]
  )

  // 监听:用户上传了参考图,但当前模型不支持 → 自动切换到 qwen-image-edit
  useEffect(() => {
    if (!referenceImage) return
    const allModels = [...imageSettings.builtinModels, ...imageSettings.customModels]
    const current = allModels.find((m) => m.id === imageSettings.model)
    // 支持参考图的判断:
    //  - 内置模型:supportsEdit = true
    //  - 自定义模型(provider === 'custom'):一律视为支持(后端会按中转站 OpenAI 格式处理)
    const provider = (current as { provider?: string } | undefined)?.provider
    const supportsEdit = !!(current as { supportsEdit?: boolean } | undefined)?.supportsEdit
    const supportsRef = provider === 'custom' || supportsEdit
    if (supportsRef) return
    if (switchingModel) return
    handleSwitchModel('builtin:qwen-image-edit')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [referenceImage])

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        const first = entries[0]
        if (first.isIntersecting && hasMore && !loadingMore && !loadingList) {
          setLoadingMore(true)
          fetchPage(images.length, true)
            .catch((err) => console.error(err))
            .finally(() => setLoadingMore(false))
        }
      },
      { rootMargin: '200px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, loadingMore, loadingList, images.length, fetchPage])

  async function handleGenerate() {
    const text = prompt.trim()
    if (!text || generating) return
    setGenerating(true)
    setError(null)
    const startedAt = Date.now()
    setGenProgress({ stage: 'submit', startedAt })
    try {
      const body: Record<string, unknown> = {
        prompt: text,
        source: 'workspace',
      }
      if (referenceImage) {
        body.referenceImageUrl = referenceImage.url
      }
      const record = await readGenerationStream<GeneratedImage>(body, (e) => {
        setGenProgress((prev) => ({
          stage: e.stage,
          poll: e.poll,
          startedAt: prev?.startedAt ?? startedAt,
        }))
      })
      setImages((prev) => [record, ...prev])
      setTotal((n) => n + 1)
      setLatestGeneratedId(record.id)
      setViewMode('preview')
      setPrompt('')
      // 生成成功后清空参考图(避免误用在下一轮)
      if (referenceImage) {
        deleteUploadedFile(referenceImage.url)
        setReferenceImage(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败')
    } finally {
      setGenerating(false)
      setGenProgress(null)
    }
  }

  async function handleReferencePick(file: File) {
    if (referenceUploading || referenceImage) return
    if (!file.type.startsWith('image/')) {
      setReferenceError('只支持图片文件')
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      setReferenceError('文件不能超过 10MB')
      return
    }
    setReferenceUploading(true)
    setReferenceError(null)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/upload', { method: 'POST', body: form })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `上传失败 (HTTP ${res.status})`)
      }
      const data = (await res.json()) as { url: string; name: string; size: number }
      setReferenceImage({ url: data.url, name: data.name, size: data.size })
    } catch (err) {
      setReferenceError(err instanceof Error ? err.message : '上传失败')
    } finally {
      setReferenceUploading(false)
    }
  }

  function handleReferenceRemove() {
    if (!referenceImage) return
    deleteUploadedFile(referenceImage.url)
    setReferenceImage(null)
    setReferenceError(null)
  }

  /** 二创完成:把生成的若干张插到画廊顶部 + 切到预览视图显示主图 */
  function handleEditComplete(primary: GeneratedImage, all: GeneratedImage[]) {
    setImages((prev) => [...all, ...prev])
    setTotal((n) => n + all.length)
    setLatestGeneratedId(primary.id)
    setViewMode('preview')
  }

  async function handleDelete(id: string) {
    if (!(await confirmDialog({ title: '删除图片', message: '确定删除这张图片吗？', danger: true, okText: '删除' }))) return
    try {
      const res = await fetch(`/api/images/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('删除失败')
      setImages((prev) => prev.filter((img) => img.id !== id))
      setTotal((n) => Math.max(0, n - 1))
      setLatestGeneratedId((prev) => (prev === id ? null : prev))
      setViewMode((prev) => (prev === 'preview' && latestGeneratedId === id ? 'gallery' : prev))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    }
  }

  function handleCopyPrompt(text: string) {
    navigator.clipboard.writeText(text).catch(() => {})
  }

  function handleDownload(img: GeneratedImage) {
    const a = document.createElement('a')
    a.href = img.url
    a.download = `aichat-${img.id}.png`
    a.target = '_blank'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleGenerate()
    }
  }

  function handleSwitchModel(modelId: string) {
    setSwitchingModel(true)
    fetch('/api/image-settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { imageModel: modelId } }),
    })
      .then((r) => r.json())
      .then(() => {
        setImageSettings((s) => ({ ...s, model: modelId }))
        setModelDropdownOpen(false)
      })
      .catch(() => {})
      .finally(() => setSwitchingModel(false))
  }

  function handleSwitchSize(size: string) {
    if (size === imageSettings.size || switchingSize) return
    setSwitchingSize(true)
    fetch('/api/image-settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: { imageSize: size } }),
    })
      .then((r) => r.json())
      .then(() => {
        setImageSettings((s) => ({ ...s, size }))
      })
      .catch(() => {})
      .finally(() => setSwitchingSize(false))
  }

  return (
    <div className="h-full flex flex-col">
      {/* 方案 C 手机端页头(徽章+标题+副标题,让开悬浮圆钮) */}
      <MobileWorkHead icon={Sparkles} title="生图工作台" subtitle={imageSettings.model ? `${imageSettings.model} · 每张图需数秒生成` : '通义万相 · 每张图需数秒生成'} />
      {/* data-tauri-drag-region="deep":客户端下内容区顶部此栏即页面「标题栏」,
          deep = 子树任意处按下都能拖窗(标题文字/图标也算),视觉与手感整块一致;
          按钮等可点元素由 Tauri 脚本自动排除(模型下拉照旧可点),双击转最大化
          方案 C 手机端:本条桌面标题栏下线(md:hidden → hidden md:flex),移动端由 MobileWorkHead 承担 */}
      <div
        data-tauri-drag-region="deep"
        className="flex px-4 md:py-3 max-md:pt-2 max-md:pb-1 max-md:px-6 max-md:justify-end border-b md:border-line/50 max-md:border-transparent items-center gap-2 shrink-0 relative"
      >
        <Sparkles className="hidden md:block w-4 h-4 text-accent" />
        <h2 className="hidden md:block text-sm font-semibold">生图工作台</h2>
        <div className="ml-auto relative" ref={modelDropRef}>
          <button
            onClick={() => setModelDropdownOpen((o) => !o)}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-xs bg-surface-muted hover:bg-surface-subtle text-content-secondary transition-colors border border-line/60"
          >
            {switchingModel ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Sparkles className="w-3 h-3" />
            )}
            <span className="max-w-[120px] truncate">
              {(() => {
                const allModels = [...imageSettings.builtinModels, ...imageSettings.customModels]
                const current = allModels.find((m) => m.id === imageSettings.model)
                // 已下线的存档模型不展示裸 ID,提示用户重新选择
                return current ? (current.name as string) : '模型已下线 · 点击切换'
              })()}
            </span>
            <ChevronDown
              className={cn(
                'w-3 h-3 shrink-0 transition-transform',
                modelDropdownOpen && 'rotate-180'
              )}
            />
          </button>

          {modelDropdownOpen && (
            <div className="absolute right-0 top-full mt-1.5 w-64 bg-surface border border-line/60 rounded-lg shadow-xl z-50 py-1 overflow-hidden">
              {imageSettings.builtinModels.length > 0 && (
                <>
                  <div className="px-3 py-1.5 text-[11px] text-content-muted font-medium uppercase tracking-wide">
                    内置模型
                  </div>
                  {imageSettings.builtinModels.map((m) => {
                    const isActive = m.id === imageSettings.model
                    const supportsEdit = !!(m as Record<string, unknown>).supportsEdit
                    return (
                      <button
                        key={m.id as string}
                        onClick={() => handleSwitchModel(m.id as string)}
                        className={cn(
                          'w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-surface-subtle transition-colors',
                          isActive && 'bg-accent/10 text-accent'
                        )}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate flex items-center gap-1">
                            <span>{(m as Record<string, unknown>).name as string}</span>
                            {supportsEdit && (
                              <span className="px-1 py-px rounded text-[9px] bg-accent/15 text-accent">
                                参考图
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] text-content-muted mt-0.5 truncate">
                            {((m as Record<string, unknown>).desc as string) ||
                              ((m as Record<string, unknown>).modelId as string)}
                          </div>
                        </div>
                        {isActive && <Check className="w-3 h-3 shrink-0 text-accent" />}
                      </button>
                    )
                  })}
                </>
              )}
              {imageSettings.customModels.length > 0 && (
                <>
                  <div className="mx-3 my-1 border-t border-line/40" />
                  <div className="px-3 py-1.5 text-[11px] text-content-muted font-medium uppercase tracking-wide">
                    自定义模型
                  </div>
                  {imageSettings.customModels.map((m) => {
                    const isActive = m.id === imageSettings.model
                    return (
                      <button
                        key={m.id as string}
                        onClick={() => handleSwitchModel(m.id as string)}
                        className={cn(
                          'w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-surface-subtle transition-colors',
                          isActive && 'bg-accent/10 text-accent'
                        )}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate">
                            {(m as Record<string, unknown>).name as string}
                          </div>
                          <div className="text-[10px] text-content-muted mt-0.5 truncate">
                            {((m as Record<string, unknown>).modelId as string) ||
                              ((m as Record<string, unknown>).baseURL as string)}
                          </div>
                        </div>
                        {isActive && <Check className="w-3 h-3 shrink-0 text-accent" />}
                      </button>
                    )
                  })}
                </>
              )}
              {imageSettings.builtinModels.length === 0 && imageSettings.customModels.length === 0 && (
                <div className="px-3 py-4 text-xs text-content-muted text-center">加载中...</div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 flex flex-col md:grid md:grid-cols-[40%_1fr] min-h-0 overflow-hidden">
        <aside className="w-full shrink-0 border-b md:border-b-0 md:border-r border-line/50 max-md:border-transparent p-4 flex flex-col gap-3 overflow-y-auto
          max-md:[&>div]:rounded-[18px] max-md:[&>div]:border max-md:[&>div]:border-white/55 max-md:[&>div]:bg-surface/80 max-md:[&>div]:p-4 max-md:[&>div]:shadow-[0_8px_24px_rgb(0_0_0_/_0.10)]">
          <div>
            <label className="text-xs text-content-secondary font-medium">提示词</label>
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="描述你想生成的图片,例如:一只在窗台看雨的猫,水彩风格"
              maxLength={500}
              className={cn(
                'mt-1.5 w-full min-h-28 max-h-60 px-3 py-2 rounded-lg resize-none',
                'bg-surface-subtle border border-line/60 text-base sm:text-sm leading-relaxed',
                'placeholder:text-content-muted focus:outline-none focus:ring-2 focus:ring-accent/40',
                'transition-shadow'
              )}
            />
            <div className="flex items-center justify-between mt-1 text-[11px] text-content-muted">
              <span>{prompt.length}/500</span>
              {/* 桌面快捷键提示;触屏无键盘意义,仅 sm+ 显示 */}
              <span className="hidden sm:inline">Cmd/Ctrl + Enter 生成</span>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs text-content-secondary font-medium">
                参考图 <span className="text-content-muted font-normal">(可选)</span>
              </label>
              {referenceImage && (
                <button
                  onClick={handleReferenceRemove}
                  className="text-[11px] text-content-muted hover:text-red-500 transition-colors"
                  type="button"
                >
                  移除
                </button>
              )}
            </div>
            <ReferenceImageDropZone
              image={referenceImage}
              uploading={referenceUploading}
              onPick={handleReferencePick}
            />
            {(() => {
              const allModels = [...imageSettings.builtinModels, ...imageSettings.customModels]
              const current = allModels.find((m) => m.id === imageSettings.model)
              const provider = (current as { provider?: string } | undefined)?.provider
              const supportsEdit = !!(current as { supportsEdit?: boolean } | undefined)?.supportsEdit
              const supportsRef = provider === 'custom' || supportsEdit
              if (!referenceImage) {
                return (
                  <div className="mt-1.5 text-[11px] text-content-muted leading-relaxed">
                    上传一张图,模型会参考它的风格/构图来生成新图。
                  </div>
                )
              }
              if (!supportsRef) {
                return (
                  <div className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400 leading-relaxed">
                    当前模型「{(current as { name?: string } | undefined)?.name}」不支持参考图,生成时将自动切换到「通义千问 · 图像编辑」。
                  </div>
                )
              }
              return (
                <div className="mt-1.5 text-[11px] text-content-muted leading-relaxed">
                  将以「{(current as { name?: string } | undefined)?.name}」执行参考图生图。
                </div>
              )
            })()}
            {referenceError && (
              <div className="mt-1.5 text-[11px] text-red-600 dark:text-red-400">
                {referenceError}
              </div>
            )}
          </div>

          <button
            onClick={handleGenerate}
            disabled={
              !prompt.trim() ||
              generating ||
              referenceUploading ||
              (!referenceImage && false)
            }
            className={cn(
              'w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium',
              'bg-accent text-accent-foreground hover:bg-accent-hover',
              'disabled:opacity-50 disabled:cursor-not-allowed transition-colors'
            )}
          >
            {generating ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                生成中...
              </>
            ) : (
              <>
                <Sparkles className="w-3.5 h-3.5" />
                {referenceImage ? '参考图生图' : '生成图片'}
              </>
            )}
          </button>

          {genProgress && (
            <GenerationProgress
              stage={genProgress.stage}
              poll={genProgress.poll}
              startedAt={genProgress.startedAt}
            />
          )}

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs text-content-secondary font-medium">图片尺寸</label>
              <span className="text-[11px] text-content-muted">
                {imageSettings.size.replace('*', '×')}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {[
                { value: '1024*1024', label: '正方形' },
                { value: '720*1280', label: '竖向' },
                { value: '1280*720', label: '横向' },
              ].map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => handleSwitchSize(opt.value)}
                  disabled={switchingSize}
                  className={cn(
                    'px-2 py-1.5 rounded-md text-xs border transition-colors',
                    imageSettings.size === opt.value
                      ? 'bg-accent/10 border-accent/40 text-accent font-medium'
                      : 'bg-surface-subtle border-line/60 text-content-secondary hover:bg-surface-muted'
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {error && (
            <div className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-600 dark:text-red-400">
              {error}
            </div>
          )}

          <div>
            <div className="text-xs text-content-secondary font-medium mb-1.5">试试这些</div>
            <div className="flex flex-col gap-1.5">
              {PROMPT_PRESETS.map((p) => (
                <button
                  key={p}
                  onClick={() => setPrompt(p)}
                  className="text-left text-xs px-2.5 py-1.5 rounded-md border border-line/60 hover:bg-surface-subtle text-content-secondary hover:text-content-primary transition-colors"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-auto pt-3 border-t border-line/40 text-[11px] text-content-muted leading-relaxed">
            <p>· 每张图片需数秒生成,稍安勿躁</p>
            <p>· 首次使用请在「设置 → 服务商」配置千问/百炼密钥</p>
            <p>· 模型和尺寸可在工作台顶部直接切换</p>
            <p>· 对话中用 [IMG:描述] 触发的图片也会自动归档到这里</p>
            <p>· 生成完成后,大图标题栏点 🔁 二次创作(以图生图/局部重绘/变体)</p>
            <p>· 缩略图右键也能二创</p>
            <p>· 上传参考图 → 选择「通义千问 · 图像编辑」→ 让模型参考其风格/构图生图</p>
          </div>
        </aside>

        <div className="flex-1 min-w-0 overflow-y-auto p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-content-secondary">
              历史记录 <span className="text-content-muted">({total})</span>
            </h3>
          </div>

          {loadingList ? (
            <div className="flex items-center justify-center h-40 text-content-muted text-sm gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> 加载中...
            </div>
          ) : images.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-content-muted text-sm gap-2">
              <Sparkles className="w-8 h-8 opacity-40" />
              <p>还没有生图记录,左侧输入提示词开始吧</p>
            </div>
          ) : viewMode === 'preview' && latestGeneratedId ? (
            (() => {
              const target = images.find((img) => img.id === latestGeneratedId) ?? images[0]
              return target ? (
                <PreviewView
                  image={target}
                  allImages={images}
                  onClose={() => setViewMode('gallery')}
                  onDelete={() => handleDelete(target.id)}
                  onCopyPrompt={() => handleCopyPrompt(target.prompt)}
                  onEditComplete={handleEditComplete}
                  onNavigate={(img) => setLatestGeneratedId(img.id)}
                  onDownload={handleDownload}
                />
              ) : null
            })()
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-3">
              {images.map((img) => (
                <ImageCard
                  key={img.id}
                  image={img}
                  onPreview={() => {
                    setLatestGeneratedId(img.id)
                    setViewMode('preview')
                  }}
                  onDelete={() => handleDelete(img.id)}
                  onCopyPrompt={() => handleCopyPrompt(img.prompt)}
                />
              ))}
            </div>
          )}

          <div
            ref={sentinelRef}
            className="h-8 mt-2 flex items-center justify-center text-xs text-content-muted"
          >
            {loadingMore && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {!hasMore && images.length > 0 && <span>已经到底了</span>}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── 参考图上传区域 ────────────────────────────────────────────────────────────
function ReferenceImageDropZone({
  image,
  uploading,
  onPick,
}: {
  image: { url: string; name: string; size: number } | null
  uploading: boolean
  onPick: (file: File) => void
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [dragging, setDragging] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragging(false)
    if (image || uploading) return
    const file = e.dataTransfer.files?.[0]
    if (file) onPick(file)
  }

  if (image) {
    return (
      <>
        <div
          role="button"
          tabIndex={0}
          aria-label={`查看参考图:${image.name}`}
          onClick={() => setPreviewOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setPreviewOpen(true)
            }
          }}
          className="relative w-full aspect-[3/2] rounded-lg overflow-hidden border border-line/60 bg-surface-muted group cursor-zoom-in"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={image.url}
            alt={image.name}
            className="w-full h-full object-contain"
          />
          <div className="absolute bottom-0 inset-x-0 px-2 py-1 bg-gradient-to-t from-black/70 to-transparent">
            <div className="text-[11px] text-white truncate" title={image.name}>
              {image.name}
            </div>
          </div>
        </div>
        {previewOpen && (
          <ChatImageLightbox
            images={[
              { url: image.url, name: image.name, type: 'image/*', size: image.size },
            ]}
            index={0}
            onClose={() => setPreviewOpen(false)}
            onIndexChange={() => {}}
          />
        )}
      </>
    )
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        e.preventDefault()
        setDragging(false)
      }}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      className={cn(
        'w-full h-24 rounded-lg border border-dashed cursor-pointer',
        'flex flex-col items-center justify-center gap-1',
        'text-[11px] text-content-muted transition-colors',
        dragging
          ? 'border-accent bg-accent/5 text-accent'
          : 'border-line/60 bg-surface-subtle hover:bg-surface-muted hover:border-line-strong'
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onPick(f)
          e.target.value = ''
        }}
      />
      {uploading ? (
        <>
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>上传中...</span>
        </>
      ) : (
        <>
          {dragging ? <Upload className="w-4 h-4" /> : <ImagePlus className="w-4 h-4" />}
          <span>点击或拖拽上传图片</span>
        </>
      )}
    </div>
  )
}

// ─── 生图进度条(工作台生图 / 二创共用) ────────────────────────────────────────
function GenerationProgress({
  stage,
  poll,
  startedAt,
}: {
  stage: GenStage
  poll?: number
  startedAt: number
}) {
  const [elapsedMs, setElapsedMs] = useState(() => Date.now() - startedAt)
  useEffect(() => {
    setElapsedMs(Date.now() - startedAt)
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 500)
    return () => clearInterval(timer)
  }, [startedAt])

  const percent = stagePercent(stage, elapsedMs)
  const seconds = Math.floor(elapsedMs / 1000)
  return (
    <div className="rounded-lg border border-line/60 bg-surface-subtle px-3 py-2">
      <div className="flex items-center justify-between text-[11px] mb-1.5">
        <span className="flex items-center gap-1.5 text-content-secondary">
          <Loader2 className="w-3 h-3 animate-spin text-accent" />
          {STAGE_LABEL[stage]}
          {stage === 'running' && poll ? (
            <span className="text-content-muted">· 第 {poll} 次查询</span>
          ) : null}
        </span>
        <span className="text-content-muted tabular-nums">{seconds}s</span>
      </div>
      <div className="h-1.5 rounded-full bg-surface-muted overflow-hidden">
        <div
          className="h-full bg-accent transition-[width] duration-500 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>
      {seconds >= 90 && (
        <div className="mt-1.5 text-[10px] text-amber-600 dark:text-amber-400">
          耗时超出常规,模型可能繁忙;可继续等待,或稍后重试
        </div>
      )}
    </div>
  )
}

// ─── 共享二创面板(PreviewView 与弹窗共用) ───────────────────────────────────
function EditPanel({
  image,
  onComplete,
  onCancel,
  layout,
}: {
  image: GeneratedImage
  onComplete: (primary: GeneratedImage, all: GeneratedImage[]) => void
  onCancel: () => void
  /** preview = 嵌在大图预览里 | modal = 嵌在弹窗右侧抽屉 */
  layout: 'preview' | 'modal'
}) {
  const [editTab, setEditTab] = useState<EditTab>('edit')
  const [editPrompt, setEditPrompt] = useState('')
  const [editN, setEditN] = useState(1)
  const [maskRect, setMaskRect] = useState<MaskRect | null>(null)
  const [editBusy, setEditBusy] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const [variations, setVariations] = useState<GeneratedImage[] | null>(null)
  // 二创阶段进度(与工作台生图同一套阶段流)
  const [editProgress, setEditProgress] = useState<{
    stage: GenStage
    poll?: number
    startedAt: number
  } | null>(null)
  const imgWrapRef = useRef<HTMLDivElement | null>(null)
  const dragStateRef = useRef<null | { startX: number; startY: number }>(null)

  // 换图重置
  useEffect(() => {
    setEditPrompt('')
    setMaskRect(null)
    setEditError(null)
    setVariations(null)
    setEditTab('edit')
  }, [image.id])

  async function runEdit() {
    if (editBusy) return
    setEditBusy(true)
    setEditError(null)
    setVariations(null)
    const startedAt = Date.now()
    setEditProgress({ stage: 'submit', startedAt })
    try {
      const body: Record<string, unknown> = {
        parentId: image.id,
        editType: editTab,
        prompt: editPrompt.trim(),
        source: 'workspace',
      }
      if (editTab === 'variation') body.n = editN
      if (editTab === 'inpaint' && maskRect) body.maskRect = maskRect

      const data = await readGenerationStream<{
        primary: GeneratedImage
        items: GeneratedImage[]
      }>(body, (e) => {
        setEditProgress((prev) => ({
          stage: e.stage,
          poll: e.poll,
          startedAt: prev?.startedAt ?? startedAt,
        }))
      })
      if (editTab === 'variation') {
        setVariations(data.items)
      } else {
        onComplete(data.primary, data.items)
      }
    } catch (err) {
      setEditError(err instanceof Error ? err.message : '二创失败')
    } finally {
      setEditBusy(false)
      setEditProgress(null)
    }
  }

  function pickVariation(img: GeneratedImage) {
    if (!variations) return
    const others = variations.filter((v) => v.id !== img.id)
    onComplete(img, [img, ...others])
  }

  function cancelAll() {
    setVariations(null)
    onCancel()
  }

  // ── inpaint mask 拖拽交互 ──────────────────────────────────────────────────
  function handleMaskDown(e: React.PointerEvent<HTMLDivElement>) {
    if (editTab !== 'inpaint') return
    const wrap = imgWrapRef.current
    if (!wrap) return
    const rect = wrap.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const y = (e.clientY - rect.top) / rect.height
    if (x < 0 || x > 1 || y < 0 || y > 1) return
    dragStateRef.current = { startX: x, startY: y }
    setMaskRect({ x, y, w: 0, h: 0 })
    ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
  }

  function handleMaskMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragStateRef.current || editTab !== 'inpaint') return
    const wrap = imgWrapRef.current
    if (!wrap) return
    const rect = wrap.getBoundingClientRect()
    const cx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    const cy = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
    const sx = dragStateRef.current.startX
    const sy = dragStateRef.current.startY
    const x = Math.min(sx, cx)
    const y = Math.min(sy, cy)
    const w = Math.abs(cx - sx)
    const h = Math.abs(cy - sy)
    setMaskRect({ x, y, w, h })
  }

  function handleMaskUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragStateRef.current) return
    dragStateRef.current = null
    try {
      ;(e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId)
    } catch {}
    // 若矩形太小则清空
    setMaskRect((prev) => (prev && (prev.w < 0.02 || prev.h < 0.02) ? null : prev))
  }

  return (
    <div className="flex flex-col min-h-0">
      {variations && (
        <div className="p-3 border-b border-line/60">
          <div className="text-xs text-content-secondary mb-2">点击挑一张作为新图</div>
          <div className="grid grid-cols-2 gap-2">
            {variations.map((v) => (
              <button
                key={v.id}
                onClick={() => pickVariation(v)}
                className="relative aspect-square rounded-md overflow-hidden border border-line/60 hover:border-accent hover:ring-2 hover:ring-accent/40 transition group"
              >
                <Image
                  src={v.url}
                  alt={v.prompt}
                  width={v.width}
                  height={v.height}
                  className="w-full h-full object-cover"
                  unoptimized
                />
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition flex items-center justify-center">
                  <Check className="w-6 h-6 text-white opacity-0 group-hover:opacity-100 transition" />
                </div>
              </button>
            ))}
          </div>
          <div className="flex justify-end mt-2">
            <button
              onClick={() => setVariations(null)}
              className="text-[11px] text-content-muted hover:text-content-primary"
            >
              返回
            </button>
          </div>
        </div>
      )}

      {!variations && (
        <>
          <div className="p-3 border-b border-line/60">
            <div className="flex items-center gap-1.5">
              <EditTabButton
                active={editTab === 'edit'}
                onClick={() => setEditTab('edit')}
                icon={<Wand2 className="w-3 h-3" />}
                label="以图生图"
              />
              <EditTabButton
                active={editTab === 'inpaint'}
                onClick={() => setEditTab('inpaint')}
                icon={<Brush className="w-3 h-3" />}
                label="局部重绘"
              />
              <EditTabButton
                active={editTab === 'variation'}
                onClick={() => setEditTab('variation')}
                icon={<Layers className="w-3 h-3" />}
                label="变体"
              />
            </div>
            <div className="mt-2 text-[10px] text-content-muted leading-relaxed">
              二创始终由 通义千问 · 图像编辑 (qwen-image-edit) 执行,与右上角生图模型无关。
            </div>
          </div>

          {/* 提示词输入 / variation N 选择 */}
          <div className="p-3 border-b border-line/60 flex flex-col gap-2">
            {editTab !== 'variation' && (
              <textarea
                value={editPrompt}
                onChange={(e) => setEditPrompt(e.target.value.slice(0, 500))}
                placeholder={
                  editTab === 'inpaint'
                    ? '描述要修改的内容(只对红框区域生效):把头发颜色改成银色'
                    : '描述要修改的内容:把背景换成雪山,保持人物不变'
                }
                maxLength={500}
                className={cn(
                  'w-full min-h-16 max-h-32 px-3 py-2 rounded-lg resize-none',
                  'bg-surface-subtle border border-line/60 text-xs leading-relaxed',
                  'placeholder:text-content-muted focus:outline-none focus:ring-2 focus:ring-accent/40'
                )}
              />
            )}
            {editTab === 'variation' && (
              <div className="flex items-center gap-2 text-xs text-content-secondary">
                <span>生成数量</span>
                <div className="flex gap-1">
                  {[1, 2, 3, 4].map((n) => (
                    <button
                      key={n}
                      onClick={() => setEditN(n)}
                      className={cn(
                        'px-2.5 py-1 rounded-md border text-xs transition',
                        editN === n
                          ? 'bg-accent/10 border-accent/40 text-accent'
                          : 'border-line/60 hover:bg-surface'
                      )}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <span className="text-content-muted truncate">· 多张供挑</span>
              </div>
            )}
            {editTab === 'inpaint' && (
              <div className="text-[11px] text-content-muted">
                {maskRect
                  ? `mask: ${(maskRect.x * 100).toFixed(0)},${(maskRect.y * 100).toFixed(0)},${(maskRect.w * 100).toFixed(0)},${(maskRect.h * 100).toFixed(0)}%`
                  : '在下方图片上拖动鼠标绘制要重绘的区域'}
              </div>
            )}
          </div>

          {/* inpaint 时在图片区域显示 mask 编辑器；其他模式显示提示 */}
          {editTab === 'inpaint' && layout === 'preview' && (
            <div className="px-3 pt-3">
              <div
                ref={imgWrapRef}
                onPointerDown={handleMaskDown}
                onPointerMove={handleMaskMove}
                onPointerUp={handleMaskUp}
                className="relative w-full max-w-md mx-auto aspect-square bg-surface rounded-md overflow-hidden cursor-crosshair select-none touch-none"
              >
                <Image
                  src={image.url}
                  alt={image.prompt}
                  width={image.width}
                  height={image.height}
                  className="w-full h-full object-contain pointer-events-none"
                  unoptimized
                  draggable={false}
                />
                {maskRect && maskRect.w > 0 && (
                  <div
                    className="absolute border-2 border-red-500 bg-red-500/30 pointer-events-none"
                    style={{
                      left: `${maskRect.x * 100}%`,
                      top: `${maskRect.y * 100}%`,
                      width: `${maskRect.w * 100}%`,
                      height: `${maskRect.h * 100}%`,
                    }}
                  />
                )}
                {!maskRect && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-white text-xs pointer-events-none">
                    拖动鼠标绘制要重绘的区域
                  </div>
                )}
              </div>
            </div>
          )}

          {editError && (
            <div className="mx-3 mt-3 px-3 py-2 rounded-md bg-red-500/10 border border-red-500/20 text-xs text-red-600 dark:text-red-400">
              {editError}
            </div>
          )}

          {editProgress && (
            <div className="px-3 pt-3">
              <GenerationProgress
                stage={editProgress.stage}
                poll={editProgress.poll}
                startedAt={editProgress.startedAt}
              />
            </div>
          )}

          <div className="p-3 mt-auto flex items-center justify-end gap-2 border-t border-line/60">
            <button
              onClick={cancelAll}
              className="px-3 py-1.5 text-xs rounded-md border border-line/60 hover:bg-surface"
              disabled={editBusy}
            >
              取消
            </button>
            <button
              onClick={runEdit}
              disabled={
                editBusy ||
                (editTab !== 'variation' && !editPrompt.trim()) ||
                (editTab === 'inpaint' && !maskRect)
              }
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md font-medium',
                'bg-accent text-accent-foreground hover:bg-accent-hover',
                'disabled:opacity-50 disabled:cursor-not-allowed transition-colors'
              )}
            >
              {editBusy ? (
                <>
                  <Loader2 className="w-3 h-3 animate-spin" />
                  生成中…
                </>
              ) : (
                <>
                  <Sparkles className="w-3 h-3" />
                  生成
                </>
              )}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// ─── 大图预览视图（集成二创） ──────────────────────────────────────────────────
function PreviewView({
  image,
  allImages,
  onClose,
  onDelete,
  onCopyPrompt,
  onEditComplete,
  onNavigate,
  onDownload,
}: {
  image: GeneratedImage
  allImages: GeneratedImage[]
  onClose: () => void
  onDelete: () => void
  onCopyPrompt: () => void
  onEditComplete: (primary: GeneratedImage, all: GeneratedImage[]) => void
  onNavigate: (img: GeneratedImage) => void
  onDownload: (img: GeneratedImage) => void
}) {
  const [editing, setEditing] = useState(false)

  const breadcrumb = (() => {
    const chain: GeneratedImage[] = []
    const visited = new Set<string>()
    let cur: GeneratedImage | undefined = image
    while (cur && !visited.has(cur.id)) {
      visited.add(cur.id)
      chain.push(cur)
      if (!cur.parentId) break
      cur = allImages.find((i) => i.id === cur!.parentId)
    }
    return chain.reverse()
  })()

  return (
    <div className="rounded-xl overflow-hidden border border-line/60 bg-surface shadow-sm">
      {/* 模拟 mac 标题栏 */}
      <div className="flex items-center px-3 py-2 bg-surface-subtle border-b border-line/60">
        <div className="flex items-center gap-1.5">
          <button
            onClick={onClose}
            className="w-3 h-3 rounded-full bg-[#ff5f57] hover:brightness-90 transition flex items-center justify-center group"
            title="返回画廊"
            aria-label="关闭预览,返回画廊视图"
          >
            <X
              className="w-2 h-2 text-black/60 opacity-0 group-hover:opacity-100 transition"
              strokeWidth={3}
            />
          </button>
          <span className="w-3 h-3 rounded-full bg-[#febc2e]" />
          <span className="w-3 h-3 rounded-full bg-[#28c840]" />
        </div>

        {/* 面包屑 */}
        <div className="flex-1 mx-4 text-xs text-content-muted truncate flex items-center justify-center gap-1 min-w-0">
          {breadcrumb.length <= 1 ? (
            <span className="truncate">{image.prompt}</span>
          ) : (
            <>
              {breadcrumb.map((b, idx) => (
                <span key={b.id} className="flex items-center gap-1 min-w-0">
                  <button
                    onClick={() => onNavigate(b)}
                    className={cn(
                      'truncate max-w-[140px] hover:text-content-primary transition-colors',
                      idx === breadcrumb.length - 1
                        ? 'text-content-primary font-medium'
                        : 'hover:underline'
                    )}
                    title={b.prompt}
                  >
                    {idx === 0
                      ? '原图'
                      : idx === breadcrumb.length - 1
                        ? '当前'
                        : `v${idx + 1}`}
                  </button>
                  {idx < breadcrumb.length - 1 && (
                    <ChevronRight className="w-3 h-3 shrink-0 opacity-60" />
                  )}
                </span>
              ))}
            </>
          )}
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setEditing((e) => !e)}
            className={cn(
              'p-1.5 rounded-md transition flex items-center gap-1 text-xs',
              editing
                ? 'bg-accent text-accent-foreground'
                : 'hover:bg-surface text-content-muted hover:text-content-primary'
            )}
            title="二次创作"
            aria-pressed={editing}
          >
            <Wand2 className="w-3.5 h-3.5" />
            <span>二创</span>
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-surface text-content-muted hover:text-content-primary text-xs flex items-center gap-1"
            title="返回画廊"
          >
            <Grid3x3 className="w-3.5 h-3.5" />
            <span>画廊</span>
          </button>
          <button
            onClick={onCopyPrompt}
            className="p-1.5 rounded-md hover:bg-surface text-content-muted hover:text-content-primary"
            title="复制提示词"
          >
            <Copy className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onDownload(image)}
            className="p-1.5 rounded-md hover:bg-surface text-content-muted hover:text-content-primary"
            title="下载"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onDelete}
            className="p-1.5 rounded-md hover:bg-surface text-content-muted hover:text-red-500"
            title="删除"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="flex min-h-0 max-h-[70vh]">
        {/* 大图区 */}
        <div className="flex-1 min-w-0 bg-surface-muted flex items-center justify-center p-4 relative">
          <div className="w-full h-full flex items-center justify-center">
            <Image
              src={image.url}
              alt={image.prompt}
              width={image.width}
              height={image.height}
              className={cn(
                'max-w-full max-h-[68vh] w-auto h-auto object-contain',
                editing && 'pointer-events-none'
              )}
              unoptimized
              draggable={false}
            />
          </div>
        </div>

        {/* 二创右侧面板 */}
        {editing && (
          <div className="w-72 shrink-0 border-l border-line/60 bg-surface min-h-0">
            <EditPanel
              image={image}
              onComplete={(primary, all) => {
                onEditComplete(primary, all)
                setEditing(false)
              }}
              onCancel={() => setEditing(false)}
              layout="preview"
            />
          </div>
        )}
      </div>

      {/* 提示词/元信息 */}
      <div className="border-t border-line/60 px-3 py-2 text-xs text-content-secondary flex items-center justify-between gap-2">
        <div className="truncate min-w-0">
          <span className="text-content-muted">提示词：</span>
          {image.prompt}
        </div>
        <div className="shrink-0 flex items-center gap-2 text-[11px] text-content-muted">
          {image.referenceImageUrl && (
            <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
              参考图
            </span>
          )}
          {image.editType && image.editType !== 't2i' && (
            <span className="px-1.5 py-0.5 rounded bg-accent/10 text-accent">
              {image.editType === 'edit'
                ? '二创'
                : image.editType === 'inpaint'
                  ? '局部重绘'
                  : '变体'}
            </span>
          )}
          <span>{new Date(image.createdAt).toLocaleString()}</span>
        </div>
      </div>

      {/* 参考图原图预览(若有) */}
      {image.referenceImageUrl && (
        <div className="border-t border-line/60 px-3 py-2.5 bg-surface-subtle/40">
          <div className="text-[11px] text-content-muted mb-1.5 flex items-center gap-1">
            <span className="font-medium">原参考图：</span>
            <span>模型基于这张图生成了上方结果</span>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <a
            href={image.referenceImageUrl}
            target="_blank"
            rel="noreferrer"
            className="block w-32 h-32 rounded-md overflow-hidden border border-line/60 hover:border-accent transition-colors"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={image.referenceImageUrl}
              alt="参考图"
              className="w-full h-full object-cover"
            />
          </a>
        </div>
      )}
    </div>
  )
}

function EditTabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1 px-2.5 py-1 rounded-md text-xs transition border',
        active
          ? 'bg-accent text-accent-foreground border-accent'
          : 'border-line/60 hover:bg-surface text-content-secondary'
      )}
    >
      {icon}
      {label}
    </button>
  )
}

function ImageCard({
  image,
  onPreview,
  onDelete,
  onCopyPrompt,
}: {
  image: GeneratedImage
  onPreview: () => void
  onDelete: () => void
  onCopyPrompt: () => void
}) {
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const ctxRef = useRef<HTMLDivElement | null>(null)

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY })
  }

  useEffect(() => {
    if (!ctxMenu) return
    function onDown(e: MouseEvent) {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) {
        setCtxMenu(null)
      }
    }
    function onScroll() {
      setCtxMenu(null)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [ctxMenu])

  function run(action: 'preview' | 'copy' | 'delete') {
    setCtxMenu(null)
    if (action === 'preview') onPreview()
    else if (action === 'copy') onCopyPrompt()
    else onDelete()
  }

  return (
    <div
      className="group relative aspect-square rounded-lg overflow-hidden bg-surface-muted border border-line/60 cursor-pointer"
      onClick={onPreview}
      onContextMenu={handleContextMenu}
    >
      <Image
        src={image.url}
        alt={image.prompt}
        width={image.width}
        height={image.height}
        className="w-full h-full object-cover"
        unoptimized
      />
      {image.referenceImageUrl && (
        <span className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/85 text-white shadow">
          参考图
        </span>
      )}
      {image.editType && image.editType !== 't2i' && !image.referenceImageUrl && (
        <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded text-[10px] bg-accent/85 text-accent-foreground shadow">
          {image.editType === 'edit'
            ? '二创'
            : image.editType === 'inpaint'
              ? '局部重绘'
              : '变体'}
        </span>
      )}
      <div
        className={cn(
          'absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent',
          'opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-2'
        )}
      >
        <div className="text-[11px] text-white line-clamp-2 mb-1.5">{image.prompt}</div>
        <div className="flex items-center gap-1">
          <button
            onClick={(e) => {
              e.stopPropagation()
              onCopyPrompt()
            }}
            className="p-1 rounded bg-white/15 hover:bg-white/25 text-white"
            title="复制提示词"
          >
            <Copy className="w-3 h-3" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            className="p-1 rounded bg-white/15 hover:bg-red-500/40 text-white ml-auto"
            title="删除"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {ctxMenu && (
        <div
          ref={ctxRef}
          className="fixed z-50 min-w-[140px] bg-surface border border-line/60 rounded-lg shadow-xl py-1 text-xs"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => run('preview')}
            className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-surface-subtle text-left"
          >
            <Sparkles className="w-3 h-3" /> 查看 / 二创
          </button>
          <button
            onClick={() => run('copy')}
            className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-surface-subtle text-left"
          >
            <Copy className="w-3 h-3" /> 复制提示词
          </button>
          <div className="my-1 border-t border-line/40" />
          <button
            onClick={() => run('delete')}
            className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-red-500/10 text-red-600 dark:text-red-400 text-left"
          >
            <Trash2 className="w-3 h-3" /> 删除
          </button>
        </div>
      )}
    </div>
  )
}

// ── Default export ───────────────────────────────────────────────
// 用 Suspense 包住 ImagesContent:useSuspenseQuery 在 cache miss 时抛 promise,
// Next.js App Router 的 Router Suspense 自动用 loading.tsx 兜底;
// cache hit(TopBar hover/click 已预热)则同步渲染,体感"瞬间"。
// 设置查询 cache miss 时的本页 fallback:无缓存时 useSuspenseQuery 抛 promise,
// 没有 fallback 则整个内容区空白直到请求返回(实测 ~1.5s)。给个轻骨架;
// cache hit(TopBar 预热/二次进入)则同步渲染,不经过此 fallback。
function ImagesSuspenseFallback() {
  return (
    <div className="h-full flex flex-col px-4 py-3">
      <div className="flex items-center gap-2 shrink-0">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-7 w-32 ml-auto" rounded="lg" />
      </div>
      <div className="flex-1 min-h-0 pt-3">
        <Skeleton className="h-28 w-full" rounded="lg" />
      </div>
    </div>
  )
}

export default function ImagesPage() {
  return (
    <AuthErrorBoundary>
      <Suspense fallback={<ImagesSuspenseFallback />}>
        <ClientOnly>
          <ImagesContent />
        </ClientOnly>
      </Suspense>
    </AuthErrorBoundary>
  )
}
