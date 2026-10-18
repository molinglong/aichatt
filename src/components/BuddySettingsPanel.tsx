'use client'

import { useBuddyStore } from '@/store/buddy-store'
import { type BuddyPersonality, type BuddyMood } from '@/lib/buddy-config'
import { cn } from '@/lib/utils'
import { X, Palette, Brain, MessageSquare, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { useBackToClose } from '@/hooks/useBackToClose'

const PERSONALITY_OPTIONS: { value: BuddyPersonality; label: string; desc: string }[] = [
  { value: 'friendly', label: '友善型', desc: '温暖体贴，会关心你' },
  { value: 'tsundere', label: '傲娇型', desc: '嘴硬心软，偶尔吐槽' },
  { value: 'cheerful', label: '活泼型', desc: '充满活力，正能量满满' },
  { value: 'wise', label: '睿智型', desc: '说话有深度，善用比喻' },
  { value: 'silly', label: '傻萌型', desc: '有点傻气，可爱治愈' },
]

const RESPONSE_STYLE_OPTIONS = [
  { value: 'short', label: '简短', desc: '一句话搞定' },
  { value: 'medium', label: '适中', desc: '几句说明白' },
  { value: 'long', label: '详细', desc: '展开讲讲' },
]

const AVATAR_COLORS = [
  '#6366f1', // indigo
  '#ec4899', // pink
  '#f59e0b', // amber
  '#10b981', // emerald
  '#06b6d4', // cyan
  '#8b5cf6', // violet
  '#f43f5e', // rose
  '#84cc16', // lime
]

const MOOD_OPTIONS: { value: BuddyMood; label: string }[] = [
  { value: 'happy', label: '开心' },
  { value: 'excited', label: '兴奋' },
  { value: 'neutral', label: '平静' },
  { value: 'thinking', label: '思考' },
  { value: 'sad', label: '难过' },
  { value: 'sleepy', label: '困了' },
]

export function BuddySettingsPanel() {
  const {
    enabled,
    config,
    mood,
    settingsOpen,
    setEnabled,
    updateConfig,
    setMood,
    toggleSettings,
  } = useBuddyStore()

  const [localName, setLocalName] = useState(config.name)

  // 系统/浏览器「返回」先收面板:面板不占路由,而壳内返回键固定走 WebView goBack
  // (与 MobileDrawer/SettingsModal 同一套哨兵机制,不加的话手机端按返回直接退出 App)
  useBackToClose(settingsOpen, toggleSettings)

  if (!settingsOpen) return null

  const handleNameChange = (name: string) => {
    setLocalName(name)
    if (name.trim()) {
      updateConfig({ name: name.trim() })
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* 背景遮罩 */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={toggleSettings}
      />

      {/* 面板内容 */}
      <div className="relative w-full max-w-md max-h-[80vh] bg-surface border border-line rounded-2xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-line">
          <h2 className="text-lg font-semibold text-content-primary">搭子设置</h2>
          <button
            onClick={toggleSettings}
            className="p-1.5 rounded-lg hover:bg-surface-subtle transition-colors"
          >
            <X className="w-5 h-5 text-content-secondary" />
          </button>
        </div>

        {/* 内容区 */}
        <div className="p-4 space-y-6 overflow-y-auto max-h-[calc(80vh-60px)]">
          {/* 启用开关 */}
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-content-primary">开启搭子</p>
              <p className="text-xs text-content-muted mt-0.5">让搭子陪伴你聊天</p>
            </div>
            <button
              onClick={() => setEnabled(!enabled)}
              className={cn(
                'relative w-12 h-6 rounded-full transition-colors',
                enabled ? 'bg-accent' : 'bg-surface-subtle'
              )}
            >
              <div
                className={cn(
                  'absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-transform',
                  enabled ? 'translate-x-7' : 'translate-x-1'
                )}
              />
            </button>
          </div>

          {/* 搭子名字 */}
          <div>
            <label className="flex items-center gap-2 text-sm font-medium text-content-primary mb-2">
              <MessageSquare className="w-4 h-4" />
              搭子名字
            </label>
            <input
              type="text"
              value={localName}
              onChange={(e) => handleNameChange(e.target.value)}
              maxLength={20}
              placeholder="给你的搭子起个名字"
              className="w-full px-3 py-2 bg-surface-subtle border border-line rounded-lg text-content-primary placeholder:text-content-muted focus:outline-none focus:ring-2 focus:ring-accent/50"
            />
          </div>

          {/* 人设选择 */}
          <div>
            <label className="flex items-center gap-2 text-sm font-medium text-content-primary mb-2">
              <Brain className="w-4 h-4" />
              搭子性格
            </label>
            <div className="grid grid-cols-1 gap-2">
              {PERSONALITY_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => updateConfig({ personality: opt.value })}
                  className={cn(
                    'flex items-center justify-between px-3 py-2 rounded-lg border transition-all text-left',
                    config.personality === opt.value
                      ? 'border-accent bg-accent/10'
                      : 'border-line hover:border-content-muted'
                  )}
                >
                  <div>
                    <p className="text-sm font-medium text-content-primary">{opt.label}</p>
                    <p className="text-xs text-content-muted">{opt.desc}</p>
                  </div>
                  {config.personality === opt.value && (
                    <div className="w-2 h-2 rounded-full bg-accent" />
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* 回复风格 */}
          <div>
            <label className="flex items-center gap-2 text-sm font-medium text-content-primary mb-2">
              <MessageSquare className="w-4 h-4" />
              回复风格
            </label>
            <div className="flex gap-2">
              {RESPONSE_STYLE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => updateConfig({ responseStyle: opt.value as 'short' | 'medium' | 'long' })}
                  className={cn(
                    'flex-1 px-3 py-2 rounded-lg border transition-all',
                    config.responseStyle === opt.value
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-line hover:border-content-muted text-content-secondary'
                  )}
                >
                  <p className="text-sm font-medium">{opt.label}</p>
                  <p className="text-xs opacity-70">{opt.desc}</p>
                </button>
              ))}
            </div>
          </div>

          {/* 幽默程度 */}
          <div>
            <label className="flex items-center gap-2 text-sm font-medium text-content-primary mb-2">
              <Sparkles className="w-4 h-4" />
              幽默程度
            </label>
            <input
              type="range"
              min="0"
              max="100"
              value={config.humorLevel}
              onChange={(e) => updateConfig({ humorLevel: Number(e.target.value) })}
              className="w-full accent-accent"
            />
            <div className="flex justify-between text-xs text-content-muted mt-1">
              <span>正经</span>
              <span>{config.humorLevel}%</span>
              <span>幽默</span>
            </div>
          </div>

          {/* 头像颜色 */}
          <div>
            <label className="flex items-center gap-2 text-sm font-medium text-content-primary mb-2">
              <Palette className="w-4 h-4" />
              头像颜色
            </label>
            <div className="flex gap-2 flex-wrap">
              {AVATAR_COLORS.map((color) => (
                <button
                  key={color}
                  onClick={() => updateConfig({ avatarColor: color })}
                  className={cn(
                    'w-8 h-8 rounded-full transition-transform hover:scale-110',
                    config.avatarColor === color && 'ring-2 ring-offset-2 ring-offset-surface ring-accent'
                  )}
                  style={{ backgroundColor: color }}
                />
              ))}
            </div>
          </div>

          {/* 主动模式 (高级功能，预留) */}
          <div className="flex items-center justify-between pt-2 border-t border-line">
            <div>
              <p className="font-medium text-content-primary">主动问候</p>
              <p className="text-xs text-content-muted mt-0.5">搭子会主动找你聊天</p>
            </div>
            <button
              onClick={() => updateConfig({ proactiveEnabled: !config.proactiveEnabled })}
              className={cn(
                'relative w-12 h-6 rounded-full transition-colors',
                config.proactiveEnabled ? 'bg-accent' : 'bg-surface-subtle'
              )}
            >
              <div
                className={cn(
                  'absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-transform',
                  config.proactiveEnabled ? 'translate-x-7' : 'translate-x-1'
                )}
              />
            </button>
          </div>

          {/* 测试情绪 (调试用) */}
          <div className="pt-2 border-t border-line">
            <p className="text-sm font-medium text-content-primary mb-2">测试情绪</p>
            <div className="flex gap-2 flex-wrap">
              {MOOD_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setMood(opt.value)}
                  className={cn(
                    'px-2 py-1 text-xs rounded-full border transition-all',
                    mood === opt.value
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-line hover:border-content-muted text-content-secondary'
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
