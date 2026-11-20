import type { Kind } from './types'
import { DAY_END } from './time'

/**
 * 一句话记多件事：把「9点写周报，10点到11点开会，买菜」拆成三条。
 *
 * 只认日常口语里最常见的写法 —— 时刻（9点 / 九点 / 9:30 / 9点半）、时段
 * （9点到10点 / 9:00-10:30）、上午下午这类前缀，以及句读与「然后 / 还有」
 * 这些断句词。没写时间就不猜，落到待安排里等用户自己排，避免把事排错地方。
 *
 * 纯函数，不碰 DOM，供 Composer 预览与提交共用。
 */

export interface QuickSegment {
  title: string
  kind: Kind
  /** 句子里写明了开始时间才有值（当日分钟数） */
  startMin?: number
  /** 只有写了时段才有值；单点时刻由调用方补默认时长 */
  endMin?: number
  /** 这段在原文里的区间，删胶囊时按它把原文剪掉 */
  start: number
  end: number
}

/** 断句：句读、加号，以及口语里的并列词 */
const SEGMENT_SPLIT = /[\n\r]+|[，,、；;。!！？?]+|[+＋]|(?:然后|接着|之后|还有|另外|顺便|以及)/

/**
 * 时刻：可选时段前缀 + 小时 +（冒号分钟 / 点[半|N分]）
 * 用 matchAll 而不是复用 lastIndex 的 test/exec，避免全局正则状态泄漏
 */
const CLOCK_RE =
  /(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里)?\s*(\d{1,2})\s*(?:[:：]\s*(\d{2})|点\s*(半|\d{1,2})?分?)/g

/** 时段之间允许的连接符，只有两段时刻之间真的是这些才算「时段」 */
const RANGE_JOIN = /^\s*(?:-|–|—|~|～|到|至)\s*$/

/** 记成备忘的说法 */
const MEMO_PREFIX = /^(备忘一下|备忘|记一下|记一条|记下|提醒我|记得)\s*[：:]?\s*/

/** 一听就是固定安排的事：开会、上课、看牙…… 命中就把种类判成固定 */
const EVENT_WORDS =
  /(开会|会议|例会|上课|听课|面试|约见|见面|聚餐|饭局|吃饭|健身|跑步|看病|挂号|就诊|复诊|体检|洗牙|牙医|接机|送机|航班|高铁|考试|监考|训练|直播|彩排|排练|讲座|聚会|婚礼|值班|出差|团建|打卡)/

const CN_DIGITS: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
}

/** 中文数字 → 阿拉伯数字，只覆盖 0–24 这个量级 */
function cnToNumber(cn: string): number | null {
  if (cn === '十') return 10
  if (cn.length === 1) return CN_DIGITS[cn] ?? null
  if (cn.length === 2 && cn[0] === '十') {
    const unit = CN_DIGITS[cn[1]]
    return unit == null ? null : 10 + unit
  }
  if (cn.length === 2 && cn[1] === '十') {
    const tens = CN_DIGITS[cn[0]]
    return tens == null ? null : tens * 10
  }
  if (cn.length === 3 && cn[1] === '十') {
    const tens = CN_DIGITS[cn[0]]
    const unit = CN_DIGITS[cn[2]]
    return tens == null || unit == null ? null : tens * 10 + unit
  }
  return null
}

/** 中文数字时刻只在「句首 / 标点后 / 时段词后」才换，避免「早一点」被读成 1 点 */
const CN_CLOCK = /([零一二三四五六七八九十两]{1,3})(\s*)点/g
const CLOCK_LEAD = /(^|[\s，,。、；;：:+\-]|凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里)$/

function normalizeChineseClock(text: string): string {
  return text.replace(CN_CLOCK, (whole, cn: string, space: string, offset: number) => {
    if (!CLOCK_LEAD.test(text.slice(0, offset))) return whole
    const hour = cnToNumber(cn)
    return hour == null ? whole : `${hour}${space}点`
  })
}

const PERIOD_SHIFT: Record<string, (hour: number) => number> = {
  凌晨: (hour) => (hour === 12 ? 0 : hour),
  早上: (hour) => hour,
  早晨: (hour) => hour,
  上午: (hour) => hour,
  中午: (hour) => (hour < 6 ? hour + 12 : hour),
  下午: (hour) => (hour < 12 ? hour + 12 : hour),
  傍晚: (hour) => (hour < 12 ? hour + 12 : hour),
  晚上: (hour) => (hour < 12 ? hour + 12 : hour),
  夜里: (hour) => (hour < 12 ? hour + 12 : hour),
}

interface Clock {
  total: number
  start: number
  end: number
}

/** 取出句子里所有时刻；「第3点」这种列举不算时刻 */
function readClocks(text: string): Clock[] {
  const out: Clock[] = []

  for (const match of Array.from(text.matchAll(CLOCK_RE))) {
    const index = match.index ?? 0
    // 第2点 / 第3点 是罗列，不是时间
    if (/第\s*$/.test(text.slice(0, index))) continue

    const hourRaw = Number(match[2])
    const minuteRaw = match[3] != null
      ? Number(match[3])
      : match[4] === '半'
        ? 30
        : match[4]
          ? Number(match[4])
          : 0
    if (minuteRaw > 59) continue

    const shift = match[1] ? PERIOD_SHIFT[match[1]] : null
    // 没写上午下午时，「1–6 点」按下午算（说「三点」通常指下午三点）
    const hour = shift
      ? shift(hourRaw)
      : hourRaw >= 1 && hourRaw <= 6
        ? hourRaw + 12
        : hourRaw

    const total = hour * 60 + minuteRaw
    if (total < 0 || total >= DAY_END) continue

    out.push({ total, start: index, end: index + match[0].length })
  }

  return out
}

/** 去掉时刻后剩下的标题：清掉残留的连接词，别留下「在」「的时候」 */
function readTitle(rest: string): string {
  return rest
    .replace(/^[\s，,。、；;：:\-–—~～]+/, '')
    .replace(/[\s，,。、；;：:\-–—~～]+$/, '')
    .replace(/^(在|从|于|安排在|安排|计划在|计划)/, '')
    .replace(/(左右|之前|以前|开始)$/, '')
    .trim()
}

type Draft = Omit<QuickSegment, 'start' | 'end'>

/** 单段解析：切词、找时间、判种类 */
function readSegment(raw: string): Draft | null {
  let text = raw.trim()
  if (!text) return null

  text = normalizeChineseClock(text)

  let kind: Kind | null = null
  const memo = MEMO_PREFIX.exec(text)
  if (memo) {
    kind = 'memo'
    text = text.slice(memo[0].length)
  }
  if (!text) return null

  const clocks = readClocks(text)
  const ranged =
    clocks.length >= 2 && RANGE_JOIN.test(text.slice(clocks[0].end, clocks[1].start))

  let title = text
  let startMin: number | undefined
  let endMin: number | undefined

  if (clocks.length > 0) {
    const first = clocks[0]
    const cut = ranged ? clocks[1].end : first.end
    title = readTitle(text.slice(0, first.start) + text.slice(cut))
    startMin = first.total
    if (ranged) {
      // 「11点到1点」补 12 小时；23点往后跨天就不硬凑了，封顶到当天结束
      endMin = clocks[1].total <= first.total ? clocks[1].total + 12 * 60 : clocks[1].total
      if (endMin > DAY_END) endMin = DAY_END
    }
  }

  if (!title) {
    // 只写了时间，也留一条让人改，别把输入吞掉
    title = kind === 'memo' ? '备忘' : '新安排'
  }

  if (!kind) {
    kind = EVENT_WORDS.test(title) ? 'event' : 'task'
  }

  // 备忘不占时间轴，句子里写了时间也忽略
  if (kind === 'memo') return { title, kind }

  return { title, kind, startMin, endMin }
}

const DELIM_RE = new RegExp(SEGMENT_SPLIT.source, 'g')

export function parseQuickAdd(text: string): QuickSegment[] {
  const out: QuickSegment[] = []
  let from = 0

  const take = (to: number) => {
    const draft = readSegment(text.slice(from, to))
    if (draft) out.push({ ...draft, start: from, end: to })
    from = to
  }

  for (const match of Array.from(text.matchAll(DELIM_RE))) {
    const index = match.index ?? 0
    take(index)
    from = index + match[0].length
  }
  take(text.length)

  return out
}
