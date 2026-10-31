'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

const STORAGE_KEY = 'chat:defaultModel'

/**
 * 设置 → 通用：新对话默认模型。
 * - standard（默认）：新对话自动选中公共池「标准」档（deepseek-standard）
 * - auto：沿用原逻辑（公共池第一个 / 上次使用）
 * 偏好存 localStorage，与风格/篇幅等轻量设置同口径。
 */
export function DefaultModelSetting() {
  const [value, setValue] = useState<'standard' | 'auto'>('standard')

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    setValue(saved === 'auto' ? 'auto' : 'standard')
  }, [])

  function change(next: 'standard' | 'auto') {
    setValue(next)
    localStorage.setItem(STORAGE_KEY, next)
  }

  return (
    <div className="rounded-xl border border-line/60 bg-surface/60 px-3.5 py-3">
      <div className="text-left">
        <p className="text-xs text-content-secondary">默认模型</p>
        <p className="text-[11px] text-content-muted max-md:hidden">
          新对话默认选中「标准」档；选「自动」则沿用公共池优先或上次使用
        </p>
      </div>
      <div className="mt-2.5 flex gap-2">
        {(
          [
            { id: 'standard', label: '标准' },
            { id: 'auto', label: '自动' },
          ] as const
        ).map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => change(option.id)}
            className={cn(
              // min-h-8: 带端按钮默认被 .m-set 规则撑到 40px,档位胶囊用 32px 更扁(类名含 min-h- 即豁免)
              'min-h-8 rounded-lg border px-3 py-1 text-[11px] transition-colors',
              value === option.id
                ? 'border-transparent bg-accent text-accent-foreground'
                : 'border-line/60 text-content-muted hover:text-content-primary'
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}
