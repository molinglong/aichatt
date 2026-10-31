'use client'

import { useEffect, useState } from 'react'
import { useChatStore } from '@/store/chat-store'
import type { ModelDefinition } from '@/lib/ai/types'
import { PROVIDER_DOT } from '@/lib/ai/provider-meta'
import { cn } from '@/lib/utils'
import { MobileSheet, SheetRow } from '@/components/ui/MobileSheet'

/**
 * 手机端模型快切 —— 底部面板统一版(≤md)。
 *
 * 外壳走 MobileSheet(把手 / 居中标题 / 取消行 / 下滑关闭 / 统一遮罩与进出场);
 * 列表行为 SheetRow:主文 14px、行高 48、选中只铺整行浅底(不画分隔线、不加勾与竖条)。
 * 入口:欢迎页 hero 模型胶囊、输入框 compact 触发钮(ModelSelector 移动分支)。
 * 选中走 onModelChange + recordModelUsage,与桌面下拉同链路。
 */

interface ModelQuickSheetProps {
  open: boolean
  onClose: () => void
  models: ModelDefinition[]
  selectedModel: string
  onModelChange: (modelId: string) => void
}

export function ModelQuickSheet({ open, onClose, models, selectedModel, onModelChange }: ModelQuickSheetProps) {
  const recordModelUsage = useChatStore((s) => s.recordModelUsage)
  // 已配置 Key 的 provider 名单(null=未加载):与桌面 ModelSelector 同口径,
  // 只列已配置 provider 的模型 + 自定义 + 公共池门面 —— 手机端此前不过滤,全量内置全漏出来
  const [configuredProviders, setConfiguredProviders] = useState<Set<string> | null>(null)

  useEffect(() => {
    if (!open) return
    // 用 keys-status 而非 /api/keys:后者返回掩码密钥,临时模式被 middleware 整体 403(同桌面口径)
    let cancelled = false
    fetch('/api/providers/keys-status')
      .then((r) => r.json())
      .then((keys: { provider: string }[]) => {
        if (!cancelled) setConfiguredProviders(new Set(keys.map((k) => k.provider)))
      })
      .catch(() => {
        if (!cancelled) setConfiguredProviders(new Set())
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const pick = (id: string) => {
    onModelChange(id)
    recordModelUsage(id)
    onClose()
  }

  // 与桌面 ModelSelector isVisible 同口径:已配置 provider / 自定义 / 公共池门面豁免
  const visibleModels =
    configuredProviders === null
      ? []
      : models.filter(
          (m) => configuredProviders.has(m.provider) || m.provider === 'custom' || m.publicPool === true
        )

  return (
    <MobileSheet open={open} onClose={onClose} title="切换模型" ariaLabel="切换模型">
      {configuredProviders === null ? (
        <p className="px-6 py-8 text-center text-[13px] text-content-muted">正在加载模型…</p>
      ) : visibleModels.length === 0 ? (
        <p className="px-6 py-8 text-center text-[13px] text-content-muted">请先在设置中配置 API Key</p>
      ) : (
        <div className="pb-1">
          {visibleModels.map((m) => (
            <SheetRow
              key={m.id}
              title={m.name}
              selected={m.id === selectedModel}
              onClick={() => pick(m.id)}
              lead={
                <span
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    PROVIDER_DOT[m.provider] ?? 'bg-content-muted'
                  )}
                />
              }
              trailing={
                m.publicPool ? (
                  <span className="flex-none rounded bg-accent-soft px-1.5 py-0.5 text-[10px] leading-none text-content-secondary">
                    公共额度
                  </span>
                ) : undefined
              }
            />
          ))}
        </div>
      )}
    </MobileSheet>
  )
}
