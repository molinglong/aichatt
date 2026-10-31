'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { type BuddyMood, MOOD_EMOJI, loadBuddyConfig, saveBuddyConfig } from '@/lib/buddy-config'
import { cn } from '@/lib/utils'

/** 情绪 emoji 映射 */
const MOOD_EMOJI_MAP: Record<BuddyMood, string> = {
  happy: '😊',
  neutral: '😐',
  sad: '😢',
  excited: '🤩',
  thinking: '🤔',
  sleepy: '😴',
}

/** 气泡消息 */
interface Bubble {
  id: string
  text: string
}

export default function BuddyDesktopPage() {
  const [position, setPosition] = useState({ x: 20, y: 100 })
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const [mood, setMood] = useState<BuddyMood>('neutral')
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [bubbles, setBubbles] = useState<Bubble[]>([])
  const [clickCount, setClickCount] = useState(0)
  const [avatarColor, setAvatarColor] = useState('#ec4899')
  const [buddyName, setBuddyName] = useState('小八')
  const [unreadCount, setUnreadCount] = useState(0)
  const dragRef = useRef(false)
  const dragStartPos = useRef({ x: 0, y: 0 })

  // 加载配置
  useEffect(() => {
    const config = loadBuddyConfig()
    setAvatarColor(config.avatarColor)
    setBuddyName(config.name)
    // 从 localStorage 单独读取 mood(没有就用 'neutral')
    try {
      const stored = localStorage.getItem('buddy-mood')
      if (stored) setMood(stored as BuddyMood)
    } catch {
      // ignore
    }

    // 监听设置变化
    const handleStorage = (e: StorageEvent) => {
      if (e.key === 'buddy-config' && e.newValue) {
        try {
          const newConfig = JSON.parse(e.newValue)
          setAvatarColor(newConfig.avatarColor)
          setBuddyName(newConfig.name)
        } catch {}
      }
      if (e.key === 'buddy-mood' && e.newValue) {
        setMood(e.newValue as BuddyMood)
      }
    }
    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [])

  // 气泡自动消失
  useEffect(() => {
    if (bubbles.length === 0) return
    const timer = setTimeout(() => {
      setBubbles([])
    }, 3000)
    return () => clearTimeout(timer)
  }, [bubbles])

  // 监听主窗口发送的消息
  useEffect(() => {
    const unlisten = listen<{ type: string; data?: unknown }>('buddy-event', (event) => {
      const { type, data } = event.payload
      switch (type) {
        case 'show':
          showBubble('我来啦~')
          break
        case 'mood':
          setMood((data as { mood: BuddyMood }).mood)
          break
        case 'speaking':
          setIsSpeaking(true)
          setTimeout(() => setIsSpeaking(false), 3000)
          break
        case 'message':
          showBubble((data as { text: string }).text)
          setUnreadCount((c) => c + 1)
          break
        case 'update':
          // 从 localStorage 重新读取最新配置
          const updatedConfig = loadBuddyConfig()
          setAvatarColor(updatedConfig.avatarColor)
          setBuddyName(updatedConfig.name)
          try {
            const storedMood = localStorage.getItem('buddy-mood')
            if (storedMood) setMood(storedMood as BuddyMood)
          } catch {}
          break
      }
    })
    return () => {
      unlisten.then((fn) => fn())
    }
  }, [])

  const showBubble = (text: string) => {
    setBubbles([{ id: `bubble_${Date.now()}`, text }])
    setUnreadCount(0)
  }

  // 鼠标按下开始拖拽
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    setIsDragging(true)
    dragRef.current = false
    dragStartPos.current = { x: e.clientX, y: e.clientY }
    setDragStart({ x: e.clientX, y: e.clientY })
  }, [])

  // 鼠标移动
  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - dragStartPos.current.x
      const deltaY = e.clientY - dragStartPos.current.y
      
      // 移动超过5px认为是拖拽
      if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
        dragRef.current = true
      }

      // 更新位置
      invoke('move_buddy_window', { deltaX, deltaY }).catch(console.error)
      dragStartPos.current = { x: e.clientX, y: e.clientY }
    }

    const handleMouseUp = () => {
      setIsDragging(false)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging])

  // 点击事件（区分拖拽）
  const handleClick = useCallback(() => {
    if (dragRef.current) return
    
    setClickCount((c) => c + 1)
    setUnreadCount(0)
    
    const reactions = [
      '戳我干嘛~',
      '嘿嘿，被你发现了',
      '别戳啦，好痒！',
      '你在想我吗？',
      '有什么事吗？',
    ]
    const reaction = reactions[clickCount % reactions.length]
    showBubble(reaction)

    // 通知主窗口
    invoke('focus_main_window').catch(console.error)
  }, [clickCount])

  // 双击打开设置
  const handleDoubleClick = () => {
    invoke('focus_main_window').catch(console.error)
  }

  return (
    <div className="w-screen h-screen bg-transparent overflow-visible">
      {/* 搭子本体 */}
      <div
        className={cn(
          'absolute select-none cursor-grab active:cursor-grabbing transition-transform',
          isDragging && 'scale-110'
        )}
        style={{
          left: position.x,
          top: position.y,
        }}
        onMouseDown={handleMouseDown}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
      >
        <div className="relative">
          {/* 未读气泡 */}
          {unreadCount > 0 && (
            <div className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-red-500 text-white text-xs flex items-center justify-center font-bold animate-pulse z-10 shadow-md">
              {unreadCount}
            </div>
          )}

          {/* 头像外圈光晕 */}
          <div
            className="absolute inset-0 rounded-full blur-md opacity-40"
            style={{ backgroundColor: avatarColor }}
          />

          {/* 头像主体 */}
          <div
            className={cn(
              'relative w-16 h-16 rounded-full flex items-center justify-center shadow-lg transition-all',
              isSpeaking && 'animate-bounce'
            )}
            style={{
              backgroundColor: avatarColor,
              boxShadow: `0 4px 20px ${avatarColor}40`,
            }}
          >
            {/* 情绪 emoji */}
            <div 
              className="text-4xl leading-none select-none"
              style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.2))' }}
            >
              {MOOD_EMOJI_MAP[mood]}
            </div>

            {/* 说话音波 */}
            {isSpeaking && (
              <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 flex gap-0.5">
                {[...Array(3)].map((_, i) => (
                  <div
                    key={i}
                    className="w-1 bg-white rounded-full animate-pulse shadow-sm"
                    style={{
                      height: '4px',
                      animationDelay: `${i * 0.15}s`,
                    }}
                  />
                ))}
              </div>
            )}
          </div>

          {/* 名字标签 */}
          <div className="absolute -bottom-5 left-1/2 -translate-x-1/2 whitespace-nowrap">
            <span 
              className="text-xs px-2 py-0.5 rounded-full shadow-sm"
              style={{ 
                backgroundColor: 'rgba(0,0,0,0.6)',
                color: 'white',
              }}
            >
              {buddyName}
            </span>
          </div>
        </div>

        {/* 气泡消息 */}
        {bubbles.map((bubble) => (
          <div
            key={bubble.id}
            className="absolute -top-10 left-full ml-3 slide-in-left"
          >
            <div 
              className="relative rounded-lg px-3 py-1.5 shadow-md max-w-[180px]"
              style={{ 
                backgroundColor: 'rgba(30,30,40,0.95)',
                color: 'white',
              }}
            >
              <p className="text-xs whitespace-nowrap">
                {bubble.text}
              </p>
              {/* 气泡尖角 */}
              <div 
                className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1 w-2 h-2 rotate-45"
                style={{ 
                  backgroundColor: 'rgba(30,30,40,0.95)',
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
