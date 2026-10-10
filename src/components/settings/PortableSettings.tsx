'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { FileJson, Loader2, Upload, Download, AlertCircle, Check, X, Zap } from 'lucide-react'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { useChatStore } from '@/store/chat-store'
import { downloadConversationBundle } from '@/lib/portable-client'
import {
  chunkIds,
  fetchAllLocalConversationIds,
  normalizeBaseUrl,
  previewPush,
  probeRemote,
  pushBatch,
  PUSH_TOKEN_KEY,
  PUSH_URL_KEY,
  type ProbeResult,
  type PushReportItem,
  type RemoteTarget,
} from '@/lib/portable-push'

/**
 * 设置 → 对话搬运:把会话在两套实例之间挪(本地 dev ↔ 线上)。
 *
 * 真实场景是"不知不觉在本地聊完了,想在线上/手机上接着用",所以这里的动词有三个:
 * 导出(拿走一个 .aichat.json)、导入(把这个文件灌进当前实例)、
 * 推送(本地直接把包灌进线上实例 —— 远端用 sk- 令牌鉴权,不输密码,
 * 走的仍是导入那一套「预演→实推」判据,只是把文件流收进了浏览器里)。
 *
 * 导入与推送都先预演:preview 拿回来的清单告诉用户会有几条新建、
 * 几条已经存在会被跳过、几条是别人的所以被拒 —— 搬运是写库动作,
 * 让人先看清楚再点头,比写完再想办法撤回便宜得多。
 */

/** 远端单次导入上限(与 conversation-portable 契约同值) */
const PUSH_BATCH = 200

interface ImportReport {
  outcome: 'created' | 'pending' | 'duplicate' | 'invalid' | 'foreign'
  title: string
  id?: string
  reason?: string
  messages?: number
  strippedAttachments?: number
  maskDropped?: boolean
}

interface PreviewResponse {
  preview?: boolean
  reports?: ImportReport[]
  parsed?: number
  skippedInvalid?: number
  errors?: string[]
  error?: string
}

const OUTCOME_LABEL: Record<ImportReport['outcome'], string> = {
  pending: '将新建',
  created: '已导入',
  duplicate: '已存在，跳过',
  foreign: '他人记录，拒绝',
  invalid: '写入失败',
}

const OUTCOME_TONE: Record<ImportReport['outcome'], string> = {
  pending: 'text-accent',
  created: 'text-green-600',
  duplicate: 'text-content-muted',
  foreign: 'text-amber-600',
  invalid: 'text-red-500',
}

/** 选中/粘贴之后一律先解析成对象;失败原因用人话,不抛 JSON.parse 的原话 */
function parseJsonText(text: string): { data?: unknown; error?: string } {
  if (!text.trim()) return { error: '还没有选择或粘贴任何内容' }
  if (text.length > 40_000_000) return { error: '这份记录太大了（>40MB），请分批导出' }
  try {
    return { data: JSON.parse(text) }
  } catch {
    return { error: '这不是有效的 JSON 文件，请确认选的是导出的 .aichat.json' }
  }
}

export function PortableSettings() {
  const bumpConversationVersion = useChatStore((s) => s.bumpConversationVersion)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [pasteText, setPasteText] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [pendingBundle, setPendingBundle] = useState<unknown | null>(null)
  const [reports, setReports] = useState<ImportReport[]>([])
  const [notes, setNotes] = useState<string[]>([])
  const [busy, setBusy] = useState<'preview' | 'import' | 'export' | null>(null)
  const [imported, setImported] = useState(false)

  // 换一份内容就要把上一轮的预演清单清空,否则会出现"看着旧清单点确认新文件"的错配
  const resetPreview = useCallback(() => {
    setPendingBundle(null)
    setReports([])
    setNotes([])
    setImported(false)
  }, [])

  const readFile = useCallback(
    async (file: File) => {
      resetPreview()
      setFileName(file.name)
      setPasteText('')
      try {
        const text = await file.text()
        const { data, error } = parseJsonText(text)
        if (error) {
          toast.error(error, { title: '读取记录包' })
          return
        }
        setPendingBundle(data ?? null)
      } catch {
        toast.error('文件读取失败，请重试或改用粘贴', { title: '读取记录包' })
      }
    },
    [resetPreview]
  )

  const usePasteText = useCallback(() => {
    resetPreview()
    const { data, error } = parseJsonText(pasteText)
    if (error) {
      toast.error(error, { title: '解析粘贴内容' })
      return
    }
    setFileName(null)
    setPendingBundle(data ?? null)
  }, [pasteText, resetPreview])

  const submitImport = useCallback(
    async (preview: boolean) => {
      if (!pendingBundle) return
      setBusy(preview ? 'preview' : 'import')
      try {
        const res = await fetch('/api/conversations/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bundle: pendingBundle, preview }),
        })
        const data = (await res.json().catch(() => null)) as PreviewResponse | null
        if (!res.ok || !data?.reports) {
          throw new Error(typeof data?.error === 'string' ? data.error : `请求失败（HTTP ${res.status}）`)
        }
        setReports(data.reports)
        setNotes(
          [
            ...(data.skippedInvalid ? [`${data.skippedInvalid} 条结构不完整，本次忽略`] : []),
            ...(data.errors ?? []).slice(0, 3),
          ].filter(Boolean) as string[]
        )
        if (!preview) {
          const created = data.reports.filter((r) => r.outcome === 'created').length
          bumpConversationVersion()
          setImported(true)
          if (created > 0) toast.success(`已导入 ${created} 条对话`, { title: '导入对话' })
          else toast.info('没有新对话被写入（可能都已存在）', { title: '导入对话' })
        }
      } catch (err) {
        console.error('[PortableSettings] import failed:', err)
        toast.error(err instanceof Error ? err.message : '导入失败，请重试', { title: '导入对话' })
      } finally {
        setBusy(null)
      }
    },
    [pendingBundle, bumpConversationVersion]
  )

  const exportAll = useCallback(async () => {
    setBusy('export')
    try {
      const res = await downloadConversationBundle({
        all: true,
        fileName: `aichat-全部对话-${new Date().toISOString().slice(0, 10)}`,
      })
      toast.success(
        `已导出 ${res.exported} 条对话${res.truncated ? '（已达单次上限，其余请分批导出）' : ''}`,
        { title: '导出全部' }
      )
    } catch (err) {
      console.error('[PortableSettings] export all failed:', err)
      toast.error(err instanceof Error ? err.message : '导出失败，请重试', { title: '导出全部' })
    } finally {
      setBusy(null)
    }
  }, [])

  // ── 推送到线上实例（第零波文件流的一键化，远端鉴权走 sk- 令牌）──
  const [pushUrl, setPushUrl] = useState('')
  const [pushToken, setPushToken] = useState('')
  const [rememberToken, setRememberToken] = useState(false)
  const [probe, setProbe] = useState<ProbeResult | null>(null)
  const [pushReports, setPushReports] = useState<PushReportItem[]>([])
  const [pushSummary, setPushSummary] = useState<{ created: number; duplicate: number; foreign: number; invalid: number } | null>(null)
  const [pushBusy, setPushBusy] = useState<'probe' | 'preview' | 'push' | null>(null)
  const [pushProgress, setPushProgress] = useState<string | null>(null)

  // 挂载时回填上次记住的地址/令牌（「记住令牌」勾选过才留令牌）
  useEffect(() => {
    try {
      setPushUrl(localStorage.getItem(PUSH_URL_KEY) ?? '')
      const saved = localStorage.getItem(PUSH_TOKEN_KEY)
      if (saved) {
        setPushToken(saved)
        setRememberToken(true)
      }
    } catch {
      /* 隐私模式等拿不到 localStorage:不弹错,手填即可 */
    }
  }, [])

  const pushTarget = useCallback(
    (): RemoteTarget => ({ baseUrl: normalizeBaseUrl(pushUrl), token: pushToken }),
    [pushUrl, pushToken]
  )

  const handleProbe = useCallback(async () => {
    setPushBusy('probe')
    try {
      const result = await probeRemote(pushTarget())
      setProbe(result)
      if (result.status === 'ok' && rememberToken) {
        localStorage.setItem(PUSH_URL_KEY, normalizeBaseUrl(pushUrl))
        localStorage.setItem(PUSH_TOKEN_KEY, pushToken.trim())
      } else if (result.status === 'ok') {
        localStorage.setItem(PUSH_URL_KEY, normalizeBaseUrl(pushUrl))
        localStorage.removeItem(PUSH_TOKEN_KEY)
      }
    } finally {
      setPushBusy(null)
    }
  }, [pushTarget, rememberToken, pushUrl, pushToken])

  /** 把本地全部会话按 200 切块,逐块在远端预演;不落库 */
  const handlePushPreview = useCallback(async () => {
    setPushBusy('preview')
    setPushReports([])
    setPushSummary(null)
    try {
      const ids = await fetchAllLocalConversationIds()
      if (ids.length === 0) {
        toast.info('本地没有可推送的对话', { title: '推送' })
        return
      }
      const batches = chunkIds(ids, PUSH_BATCH)
      const all: PushReportItem[] = []
      for (let i = 0; i < batches.length; i++) {
        setPushProgress(`预演第 ${i + 1}/${batches.length} 批…`)
        all.push(...(await previewPush(pushTarget(), batches[i])))
      }
      setPushReports(all)
      setProbe((p) => (p?.status === 'ok' ? p : p))
    } catch (err) {
      console.error('[PortableSettings] push preview failed:', err)
      toast.error(err instanceof Error ? err.message : '预演失败，请检查地址与令牌', { title: '推送' })
    } finally {
      setPushProgress(null)
      setPushBusy(null)
    }
  }, [pushTarget])

  /** 实推:逐块写远端;远端按 cuid 幂等,重复推送只会命中「已存在」 */
  const handlePush = useCallback(async () => {
    setPushBusy('push')
    try {
      const ids = await fetchAllLocalConversationIds()
      const batches = chunkIds(ids, PUSH_BATCH)
      const all: PushReportItem[] = []
      const sum = { created: 0, duplicate: 0, foreign: 0, invalid: 0 }
      for (let i = 0; i < batches.length; i++) {
        setPushProgress(`推送第 ${i + 1}/${batches.length} 批…`)
        const res = await pushBatch(pushTarget(), batches[i])
        all.push(...res.reports)
        sum.created += res.created
        sum.duplicate += res.duplicate
        sum.foreign += res.foreign
        sum.invalid += res.invalid
      }
      setPushReports(all)
      setPushSummary(sum)
      if (sum.created > 0) toast.success(`已推送 ${sum.created} 条对话到线上`, { title: '推送完成' })
      else toast.info('没有新对话被写入（可能线上都已存在）', { title: '推送完成' })
    } catch (err) {
      console.error('[PortableSettings] push failed:', err)
      toast.error(err instanceof Error ? err.message : '推送中断，已写入的批次不回滚，可重试', { title: '推送' })
    } finally {
      setPushProgress(null)
      setPushBusy(null)
    }
  }, [pushTarget])

  useEffect(() => () => resetPreview(), [resetPreview])

  const willCreate = reports.filter((r) => r.outcome === 'pending').length
  const didCreate = reports.filter((r) => r.outcome === 'created').length
  const skippedAttachments = reports.reduce((n, r) => n + (r.strippedAttachments ?? 0), 0)

  return (
    <div className="space-y-3 text-left">
      {/* 导入 */}
      <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3 space-y-2.5">
        <div className="min-w-0">
          <p className="text-xs text-content-secondary">导入对话</p>
          <p className="text-[11px] text-content-muted">
            选择导出的 <code className="px-1 rounded bg-surface-subtle">.aichat.json</code> 文件；
            手机上没有文件时，也可以把文件内容粘进下方文本框。导入后手机端刷新即可看到。
          </p>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void readFile(file)
            // 复位 value:同一个文件改完再选也要能触发 change
            e.target.value = ''
          }}
        />

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy !== null}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-[11px] font-medium text-accent-foreground disabled:opacity-50"
          >
            <Upload className="w-3.5 h-3.5" />
            选择文件
          </button>
          {fileName && (
            <span className="flex items-center gap-1 text-[11px] text-content-muted min-w-0">
              <FileJson className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate max-w-[160px]">{fileName}</span>
            </span>
          )}
        </div>

        <textarea
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          rows={3}
          placeholder="或把 .aichat.json 的内容粘贴到这里"
          className="w-full rounded-lg border border-line/60 bg-surface/60 px-2.5 py-2 text-[11px]
            text-content-primary placeholder:text-content-muted/60 outline-none focus:border-accent/60 resize-y"
        />
        {pasteText.trim().length > 0 && (
          <button
            type="button"
            onClick={usePasteText}
            disabled={busy !== null}
            className="rounded-lg border border-line/60 px-2.5 py-1.5 text-[11px] text-content-secondary
              hover:bg-surface-subtle transition-colors disabled:opacity-50"
          >
            使用粘贴内容
          </button>
        )}

        {pendingBundle !== null && (
          <div className="flex items-center gap-2 pt-0.5">
            <button
              type="button"
              onClick={() => void submitImport(true)}
              disabled={busy !== null}
              className="flex items-center gap-1.5 rounded-lg border border-line/60 px-2.5 py-1.5 text-[11px]
                text-content-secondary hover:bg-surface-subtle transition-colors disabled:opacity-50"
            >
              {busy === 'preview' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {busy === 'preview' ? '正在核对…' : '先看看会导进什么'}
            </button>
            {(willCreate > 0 || didCreate > 0 || imported) && (
              <button
                type="button"
                onClick={() => void submitImport(false)}
                disabled={busy !== null || imported}
                className="flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-[11px] font-medium
                  text-accent-foreground disabled:opacity-50"
              >
                {busy === 'import' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {busy === 'import'
                  ? '正在写入…'
                  : imported
                    ? '已导入'
                    : `确认导入${willCreate > 0 ? ` ${willCreate} 条` : ''}`}
              </button>
            )}
          </div>
        )}

        {notes.length > 0 && (
          <p className="flex items-start gap-1.5 text-[11px] text-amber-600">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{notes[0]}</span>
          </p>
        )}

        {reports.length > 0 && (
          <ul className="space-y-1 max-h-52 overflow-y-auto pr-1">
            {reports.map((r, idx) => (
              <li
                key={`${r.id ?? 'x'}-${idx}`}
                className="flex items-start justify-between gap-2 rounded-lg bg-surface-subtle/60 px-2.5 py-1.5"
              >
                <span className="min-w-0">
                  <span className="block text-[11px] text-content-primary truncate">{r.title}</span>
                  <span className="block text-[10px] text-content-muted">
                    {[
                      r.messages ? `${r.messages} 条消息` : null,
                      r.strippedAttachments ? `${r.strippedAttachments} 个附件未迁移` : null,
                      r.maskDropped ? '面具不在本实例' : null,
                      r.reason,
                    ]
                      .filter(Boolean)
                      .join(' · ') || '—'}
                  </span>
                </span>
                <span className={cn('shrink-0 text-[11px] tabular-nums', OUTCOME_TONE[r.outcome])}>
                  {OUTCOME_LABEL[r.outcome]}
                </span>
              </li>
            ))}
          </ul>
        )}

        {skippedAttachments > 0 && (
          <p className="text-[11px] text-content-muted">
            本包含 {skippedAttachments} 个附件引用。附件文件躺在导出时的机器上，不随记录包走，
            导入后会在原位置标注「附件未迁移」。
          </p>
        )}
      </div>

      {/* 导出 */}
      <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3 space-y-2.5">
        <div className="min-w-0">
          <p className="text-xs text-content-secondary">导出对话</p>
          <p className="text-[11px] text-content-muted">
            单条对话在历史列表右键「导出对话包」或「推送到线上（这一条）」；整个列表用下方按钮。
            一次上限 200 条，超出请分批。
          </p>
        </div>
        <button
          type="button"
          onClick={exportAll}
          disabled={busy !== null}
          className="flex items-center gap-1.5 rounded-lg border border-line/60 px-2.5 py-1.5 text-[11px]
            text-content-secondary hover:bg-surface-subtle transition-colors disabled:opacity-50"
        >
          {busy === 'export' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
          {busy === 'export' ? '正在打包…' : '导出全部对话'}
        </button>
        <p className="flex items-start gap-1.5 text-[11px] text-content-muted">
          {busy === null ? <Check className="w-3.5 h-3.5 mt-0.5 shrink-0 text-green-600" /> : <X className="w-3.5 h-3.5 mt-0.5 shrink-0 opacity-0" />}
          <span>
            重复导入同一份记录不会翻倍：记录用的是全局唯一 id，已存在的条目会被跳过而不是再写一份。
          </span>
        </p>
      </div>

      {/* 推送到线上实例 */}
      <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3 space-y-2.5">
        <div className="min-w-0">
          <p className="text-xs text-content-secondary">一键推送到线上</p>
          <p className="text-[11px] text-content-muted">
            在目标实例（如线上）的 设置→API 令牌 生成一枚 sk- 令牌填在这里，
            本地全部对话直接灌进那边，不用下载再上传。全程不输账号密码，令牌随时可在那边撤销。
          </p>
        </div>

        <input
          type="url"
          value={pushUrl}
          onChange={(e) => {
            setPushUrl(e.target.value)
            setProbe(null)
          }}
          placeholder="线上地址，如 https://chat.yuban.icu"
          className="w-full rounded-lg border border-line/60 bg-surface/60 px-2.5 py-2 text-[11px]
            text-content-primary placeholder:text-content-muted/60 outline-none focus:border-accent/60"
        />
        <input
          type="password"
          value={pushToken}
          onChange={(e) => {
            setPushToken(e.target.value)
            setProbe(null)
          }}
          placeholder="sk- 令牌（在目标实例生成）"
          autoComplete="off"
          className="w-full rounded-lg border border-line/60 bg-surface/60 px-2.5 py-2 text-[11px]
            text-content-primary placeholder:text-content-muted/60 outline-none focus:border-accent/60"
        />
        <label className="flex items-center gap-1.5 text-[11px] text-content-muted cursor-pointer select-none">
          <input
            type="checkbox"
            checked={rememberToken}
            onChange={(e) => setRememberToken(e.target.checked)}
            className="accent-[var(--accent,var(--color-accent))] w-3.5 h-3.5"
          />
          记住令牌（存本机浏览器；不勾则刷新后需重填）
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void handleProbe()}
            disabled={pushBusy !== null}
            className="flex items-center gap-1.5 rounded-lg border border-line/60 px-2.5 py-1.5 text-[11px]
              text-content-secondary hover:bg-surface-subtle transition-colors disabled:opacity-50"
          >
            {pushBusy === 'probe' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
            {pushBusy === 'probe' ? '检测中…' : '检测连通性'}
          </button>
          <button
            type="button"
            onClick={() => void handlePushPreview()}
            disabled={pushBusy !== null}
            className="flex items-center gap-1.5 rounded-lg border border-line/60 px-2.5 py-1.5 text-[11px]
              text-content-secondary hover:bg-surface-subtle transition-colors disabled:opacity-50"
          >
            {pushBusy === 'preview' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {pushBusy === 'preview' ? (pushProgress ?? '预演中…') : '先看看线上会收什么'}
          </button>
          {(pushReports.length > 0 || probe?.status === 'ok') && (
            <button
              type="button"
              onClick={() => void handlePush()}
              disabled={pushBusy !== null}
              className="flex items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-[11px] font-medium
                text-accent-foreground disabled:opacity-50"
            >
              {pushBusy === 'push' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {pushBusy === 'push' ? (pushProgress ?? '推送中…') : '确认推送全部'}
            </button>
          )}
        </div>

        {probe && (
          <p
            className={cn(
              'flex items-start gap-1.5 text-[11px]',
              probe.status === 'ok' ? 'text-green-600' : 'text-amber-600'
            )}
          >
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{probe.message}</span>
          </p>
        )}

        {pushSummary && (
          <p className="text-[11px] text-content-secondary">
            推送结果：新建 {pushSummary.created} · 已存在跳过 {pushSummary.duplicate} · 拒写{' '}
            {pushSummary.foreign} · 失败 {pushSummary.invalid}
          </p>
        )}

        {pushReports.length > 0 && (
          <ul className="space-y-1 max-h-52 overflow-y-auto pr-1">
            {pushReports.map((r, idx) => (
              <li
                key={`${r.id ?? 'x'}-${idx}`}
                className="flex items-start justify-between gap-2 rounded-lg bg-surface-subtle/60 px-2.5 py-1.5"
              >
                <span className="min-w-0">
                  <span className="block text-[11px] text-content-primary truncate">{r.title}</span>
                  <span className="block text-[10px] text-content-muted">
                    {[
                      r.messages ? `${r.messages} 条消息` : null,
                      r.strippedAttachments ? `${r.strippedAttachments} 个附件未迁移` : null,
                      r.maskDropped ? '面具不在那边' : null,
                      r.reason,
                    ]
                      .filter(Boolean)
                      .join(' · ') || '—'}
                  </span>
                </span>
                <span
                  className={cn(
                    'shrink-0 text-[11px] tabular-nums',
                    OUTCOME_TONE[(r.outcome as ImportReport['outcome']) ?? 'pending'] ?? 'text-content-muted'
                  )}
                >
                  {OUTCOME_LABEL[r.outcome as ImportReport['outcome']] ?? r.outcome}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
