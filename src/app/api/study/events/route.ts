import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { getUserId } from '@/lib/api-auth'
import { prisma } from '@/lib/db'
import {
  EVENT_TAG_VALUES,
  EVENT_DATE_RE,
  dateISOToUtc,
  dateUtcToISO,
  todayEventISO,
  type StudyEventToolRow,
} from '@/lib/ai/study-event-tool'

/** GET /api/study/events?from=YYYY-MM-DD&to=YYYY-MM-DD - 学习记录流水(按归属日倒序,组内按记录时间正序) */
export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }
  const userId = session.user.id

  // 归属日区间由客户端(本地时区)下发,服务端不做时区换算,避免 VPS 与手机端跨时区错位
  const sp = req.nextUrl.searchParams
  const from = sp.get('from') ?? ''
  const to = sp.get('to') ?? ''
  const toISO = EVENT_DATE_RE.test(to) ? to : todayEventISO()
  const fromISO = EVENT_DATE_RE.test(from)
    ? from
    : (() => {
        const d = dateISOToUtc(toISO)!
        d.setUTCDate(d.getUTCDate() - 29)
        return dateUtcToISO(d)
      })()
  const fromUtc = dateISOToUtc(fromISO)
  const toUtc = dateISOToUtc(toISO)
  if (!fromUtc || !toUtc) {
    return NextResponse.json({ error: '日期格式应为 YYYY-MM-DD' }, { status: 400 })
  }

  try {
    const rows = await prisma.studyEvent.findMany({
      where: { userId, eventDate: { gte: fromUtc, lte: toUtc } },
      orderBy: [{ eventDate: 'desc' }, { createdAt: 'asc' }],
      take: 400,
      select: { id: true, text: true, tag: true, source: true, eventDate: true, createdAt: true },
    })
    const out: StudyEventToolRow[] = rows.map((r) => ({
      id: r.id,
      text: r.text,
      tag: r.tag,
      source: r.source,
      eventDate: dateUtcToISO(r.eventDate),
      createdAt: r.createdAt.toISOString(),
    }))
    return NextResponse.json(out)
  } catch (err) {
    console.error('[study/events] list failed:', err)
    return NextResponse.json({ error: '获取学习记录失败' }, { status: 500 })
  }
}

/** POST /api/study/events - 手动补一条学习记录(text 2-160 字,tag 六选一,可补记昨天) */
export async function POST(req: NextRequest) {
  // 双通道:cookie session 或 Bearer 令牌,与 /api/study/notes 同口径
  const userId = await getUserId(req)
  if (!userId) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }

  let body: { text?: string; tag?: string | null; date?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: '请求体不是合法的 JSON' }, { status: 400 })
  }
  const text = (body.text ?? '').trim()
  if (text.length < 2 || text.length > 160) {
    return NextResponse.json({ error: '记录内容需为 2~160 字的一句话' }, { status: 400 })
  }
  const tag =
    typeof body.tag === 'string' && (EVENT_TAG_VALUES as readonly string[]).includes(body.tag)
      ? body.tag
      : null
  const dateISO = typeof body.date === 'string' && dateISOToUtc(body.date) ? body.date : todayEventISO()
  const eventDate = dateISOToUtc(dateISO)!

  try {
    const row = await prisma.studyEvent.create({
      data: { userId, text, tag, source: 'manual', eventDate },
      select: { id: true, text: true, tag: true, source: true, eventDate: true, createdAt: true },
    })
    const out: StudyEventToolRow = {
      id: row.id,
      text: row.text,
      tag: row.tag,
      source: row.source,
      eventDate: dateUtcToISO(row.eventDate),
      createdAt: row.createdAt.toISOString(),
    }
    return NextResponse.json(out, { status: 201 })
  } catch (err) {
    console.error('[study/events] create failed:', err)
    return NextResponse.json({ error: '存入学习记录失败' }, { status: 500 })
  }
}
