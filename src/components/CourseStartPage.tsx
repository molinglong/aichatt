'use client'

import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { BookOpen, Globe, Play, Star } from 'lucide-react'
import { CrayonChick } from '@/components/CrayonChick'
import {
  courseFallbackLabel,
  courseUrlKind,
  formatRecentTime,
  isCourseUrlAllowedWhenLocked,
  type CourseRecent,
} from '@/lib/course-recents'
import { useClipboardCourseLink, useCourseMeta } from '@/lib/course-start-hooks'
import s from './CourseStartPage.module.css'

/**
 * 课程窗口 · 启动首页 · 监管模式专用(2026-11-19 挑稿 C 案)
 * 原型: design/preview-course-start.html 的 C · 小鸡书房;用户口径:
 * 去掉背景小灰点,加「最近打开」;2026-11-20 追加口径:
 * C 只在监管模式下出现,日常态用 B 案(CourseStartDaily)。
 *
 * 行为:
 * - 贴链接 / Enter 打开(Tauri 侧 norm 与 Rust parse_course_url 同口径);
 * - 最近打开走 localStorage(course-recents.ts),标题/封面异步补 /api/course/meta;
 * - 剪贴板探测只在输入框获得焦点/窗口重新聚焦时做,避免一进面板就弹权限;
 * - 锁定态隐藏 B 站首页入口,并过滤最近里非白名单地址(前端镜像 Rust 门卫)。
 */

interface Props {
  ready: boolean
  locked: boolean
  preview: boolean
  recents: CourseRecent[]
  setRecents: Dispatch<SetStateAction<CourseRecent[]>>
  onOpen: (raw: string) => void | Promise<void>
}

const QUICK = [
  { key: 'home', label: 'B 站', url: 'https://www.bilibili.com', Icon: Globe },
  { key: 'fav', label: '收藏', url: 'https://space.bilibili.com', Icon: Star },
  { key: 'course', label: '课程', url: 'https://www.bilibili.com/cheese/', Icon: BookOpen },
] as const

const KIND_LABEL: Record<ReturnType<typeof courseUrlKind>, string> = {
  video: 'B 站视频',
  cheese: 'B 站课程',
  list: 'B 站合集',
  space: 'UP 主空间',
  other: 'B 站页面',
}

function greeting(): string {
  const h = new Date().getHours()
  if (h < 6) return '凌晨好呀'
  if (h < 12) return '早上好呀'
  if (h < 14) return '中午好呀'
  if (h < 18) return '下午好呀'
  return '晚上好呀'
}

function todayLine(): string {
  const d = new Date()
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · ${week}`
}

export function CourseStartPage({ ready, locked, preview, recents, setRecents, onOpen }: Props) {
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const { clip, checkClipboard, clearClip } = useClipboardCourseLink()

  const greet = useMemo(() => greeting(), [])
  const dateLine = useMemo(() => todayLine(), [])

  // 最近打开:锁定态过滤掉白名单外地址,最多展示 3 条
  const visible = useMemo(() => {
    const list = locked ? recents.filter((r) => isCourseUrlAllowedWhenLocked(r.url)) : recents
    return list.slice(0, 3)
  }, [recents, locked])

  // 标题 / 封面补齐(缺的才问,写回 localStorage)
  useCourseMeta(recents, setRecents, preview)

  const submit = useCallback(
    async (raw: string) => {
      const u = raw.trim()
      if (!u || busy) return
      setBusy(true)
      try {
        await onOpen(u)
        setInput('')
        clearClip()
      } finally {
        setBusy(false)
      }
    },
    [busy, onOpen, clearClip]
  )

  return (
    <div className={s.page}>
      <div className={s.inner}>
        <div className={s.hero}>
          <div className={s.heroText}>
            <div className={s.hi}>{greet}</div>
            <div className={s.date}>{dateLine} · 今天想学点什么?</div>
          </div>
          <div className={s.chickWrap}>
            <div className={s.bubble}>贴个链接，我陪你看</div>
            <CrayonChick className={s.chick} />
          </div>
        </div>

        <div className={s.noteWrap}>
          <span className={s.tape} aria-hidden />
          <div className={s.note}>
            <div className={s.noteLabel}>贴一条课程链接</div>
            <div className={s.row}>
              <div className={s.field}>
                <Globe className={s.fieldIcon} aria-hidden />
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onFocus={() => void checkClipboard()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void submit(input)
                    }
                  }}
                  placeholder="bilibili.com/video/…"
                  aria-label="课程链接"
                  spellCheck={false}
                />
              </div>
              <button
                type="button"
                className={s.open}
                disabled={!input.trim() || busy || !ready}
                onClick={() => void submit(input)}
              >
                {busy ? '打开中…' : '打开'}
              </button>
            </div>
            {clip && (
              <button type="button" className={s.clip} onClick={() => void submit(clip)} title={clip}>
                <span className={s.clipLabel}>剪贴板里有一条 B 站链接</span>
                <span className={s.clipGo}>直接打开</span>
              </button>
            )}
          </div>
        </div>

        <div className={s.secHead}>
          <h3>最近打开</h3>
          <span className={s.rule} aria-hidden />
        </div>

        {visible.length > 0 ? (
          <ul className={s.list}>
            {visible.map((r) => {
              const kind = courseUrlKind(r.url)
              const label = r.title || courseFallbackLabel(r.url)
              return (
                <li key={r.url}>
                  <button type="button" className={s.item} onClick={() => void submit(r.url)} title={label}>
                    <span className={s.pin} aria-hidden>
                      {kind === 'video' ? <Play size={11} /> : <BookOpen size={11} />}
                    </span>
                    <span className={s.itemText}>
                      <span className={s.itemTitle}>{label}</span>
                      <span className={s.itemMeta}>{KIND_LABEL[kind]}</span>
                    </span>
                    <span className={s.itemTime}>{formatRecentTime(r.ts)}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        ) : (
          <div className={s.empty}>
            {locked && recents.length > 0
              ? '专注模式下只显示 B 站视频与课程页'
              : '最近还没打开过课程'}
            <br />
            贴第一条链接，它就住在这里
          </div>
        )}

        <div className={s.quick}>
          {QUICK.filter((q) => !locked || q.key !== 'home').map(({ key, label, url, Icon }) => (
            <button
              key={key}
              type="button"
              className={s.chip}
              onClick={() => void submit(url)}
              disabled={!ready || busy}
            >
              <Icon size={13} aria-hidden />
              <span>{label}</span>
            </button>
          ))}
        </div>

        <div className={s.foot}>
          {locked ? '专注中 · 只能去 B 站视频与课程页' : '别跑太远，学完再逛'}
        </div>
      </div>
    </div>
  )
}