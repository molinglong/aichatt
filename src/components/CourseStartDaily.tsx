'use client'

/* eslint-disable @next/next/no-img-element */

import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import {
  ArrowRight,
  BookOpen,
  Clock,
  Globe,
  History,
  Link2,
  Play,
  Search,
  Star,
  Tv,
} from 'lucide-react'
import {
  courseFallbackLabel,
  courseUrlKind,
  formatRecentTime,
  isBilibiliInput,
  type CourseRecent,
} from '@/lib/course-recents'
import { useCourseMeta } from '@/lib/course-start-hooks'
import s from './CourseStartDaily.module.css'

/**
 * 课程窗口 · 启动首页 · 日常态(2026-11-20 挑稿 B 案)
 * 原型: design/preview-course-start.html 的 B · 极简新标签页。
 * 日常默认(非监管)用本页;监管模式切 C 案(CourseStartPage)。
 *
 * 输入框一词两用:像 B 站链接/域名/BV 号 → 直接打开;其它词 → B 站搜索页。
 * 最近打开与 C 案共用 localStorage,封面由 /api/course/meta 补
 * (展示端 referrerPolicy=no-referrer 绕图床防盗链)。
 */

interface Props {
  ready: boolean
  preview: boolean
  recents: CourseRecent[]
  setRecents: Dispatch<SetStateAction<CourseRecent[]>>
  onOpen: (raw: string) => void | Promise<void>
}

const TILES = [
  { key: 'bili', label: 'B 站', url: 'https://www.bilibili.com', Icon: Tv },
  { key: 'fav', label: '收藏', url: 'https://space.bilibili.com', Icon: Star },
  { key: 'course', label: '课程', url: 'https://www.bilibili.com/cheese/', Icon: BookOpen },
  { key: 'later', label: '稍后', url: 'https://www.bilibili.com/watchlater/', Icon: Clock },
  { key: 'history', label: '历史', url: 'https://www.bilibili.com/account/history', Icon: History },
] as const

const KIND_LABEL: Record<ReturnType<typeof courseUrlKind>, string> = {
  video: '视频',
  cheese: '课程',
  list: '合集',
  space: 'UP 空间',
  other: 'B 站',
}

/** 输入像链接(含裸域名 / BV 号)就直接开,否则当搜索词 */
function looksLikeTarget(s: string): boolean {
  const v = s.trim()
  if (!v) return false
  if (/^BV[0-9A-Za-z]{8,}$/.test(v)) return true
  if (/^(https?:\/\/|www\.)/i.test(v)) return true
  if (/^[\w-]+(\.[\w-]+)+\//.test(v)) return true
  return isBilibiliInput(v)
}

function todayLine(): string {
  const d = new Date()
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · ${week}`
}

export function CourseStartDaily({ ready, preview, recents, setRecents, onOpen }: Props) {
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const dateLine = useMemo(() => todayLine(), [])

  useCourseMeta(recents, setRecents, preview)

  const visible = useMemo(() => recents.slice(0, 4), [recents])

  const submit = useCallback(
    async (raw: string) => {
      const v = raw.trim()
      if (!v || busy) return
      setBusy(true)
      try {
        const target = looksLikeTarget(v)
          ? v
          : `https://search.bilibili.com/all?keyword=${encodeURIComponent(v)}`
        await onOpen(target)
        setInput('')
      } finally {
        setBusy(false)
      }
    },
    [busy, onOpen]
  )

  const disabled = !ready || busy

  return (
    <div className={s.page}>
      <div className={s.inner}>
        <div className={s.top}>
          <span>{dateLine}</span>
          <span className={s.mode}>
            <span className={s.dot} aria-hidden />
            自由浏览
          </span>
        </div>

        <div className={s.mark}>
          <Globe size={22} aria-hidden />
        </div>
        <div className={s.title}>课程窗口</div>
        <div className={s.sub}>粘贴链接，边看课边在左边提问</div>

        <div className={s.search}>
          <Link2 size={13} className={s.searchIcon} aria-hidden />
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void submit(input)
              }
            }}
            placeholder="粘贴 B 站链接，或输入想搜的课"
            aria-label="搜索或粘贴课程链接"
            spellCheck={false}
          />
          <button
            type="button"
            className={s.go}
            onClick={() => void submit(input)}
            disabled={!input.trim() || disabled}
            aria-label="打开"
          >
            <ArrowRight size={15} />
          </button>
        </div>
        <div className={s.hint}>
          <kbd>Enter</kbd> 直接打开 · 支持 BV 号 / 课程页 / 搜索词
        </div>

        <div className={s.tiles}>
          {TILES.map(({ key, label, url, Icon }) => (
            <button
              key={key}
              type="button"
              className={s.tile}
              onClick={() => void submit(url)}
              disabled={disabled}
            >
              <i>
                <Icon size={15} aria-hidden />
              </i>
              <span>{label}</span>
            </button>
          ))}
          <button
            type="button"
            className={s.tile}
            onClick={() => inputRef.current?.focus()}
            disabled={disabled}
          >
            <i>
              <Search size={15} aria-hidden />
            </i>
            <span>搜索</span>
          </button>
        </div>

        <div className={s.sec}>
          <h3>最近打开</h3>
          <span>{visible.length > 0 ? `本地保存 ${recents.length} 条` : ''}</span>
        </div>

        {visible.length > 0 ? (
          <div className={s.grid}>
            {visible.map((r) => {
              const kind = courseUrlKind(r.url)
              const label = r.title || courseFallbackLabel(r.url)
              return (
                <button
                  key={r.url}
                  type="button"
                  className={s.card}
                  data-kind={kind}
                  onClick={() => void submit(r.url)}
                  title={label}
                  disabled={disabled}
                >
                  <span className={s.cover}>
                    {r.cover ? (
                      <img src={r.cover} alt="" loading="lazy" referrerPolicy="no-referrer" />
                    ) : (
                      <span className={s.coverGlyph} aria-hidden>
                        {kind === 'cheese' || kind === 'list' ? (
                          <BookOpen size={20} />
                        ) : (
                          <Play size={20} />
                        )}
                      </span>
                    )}
                    <span className={s.coverPlay} aria-hidden>
                      <Play size={11} />
                    </span>
                  </span>
                  <span className={s.cardText}>
                    <span className={s.cardTitle}>{label}</span>
                    <span className={s.cardMeta}>
                      {KIND_LABEL[kind]} · {formatRecentTime(r.ts)}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        ) : (
          <div className={s.empty}>
            还没有最近打开
            <br />
            贴一条链接，或搜一门课
          </div>
        )}

        <div className={s.foot}>只在 B 站里逛，别跑太远</div>
      </div>
    </div>
  )
}