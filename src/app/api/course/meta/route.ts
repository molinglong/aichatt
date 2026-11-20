import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'

/**
 * GET /api/course/meta?url=...
 * 课程窗口「最近打开」补真实标题:BV → web-interface/view,课程 → pgc season。
 * 只接受 B 站域名,实际请求固定走官方 API(不跟随用户 URL),无 SSRF 面。
 * 失败一律 200 + title:null,前端保留兜底标签。
 */
export const runtime = 'nodejs'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36'

function bilibiliTarget(raw: string): { kind: 'video' | 'cheese'; id: string } | null {
  let u: URL
  try {
    u = new URL(raw.includes('://') ? raw : `https://${raw}`)
  } catch {
    return null
  }
  if (!(u.hostname === 'bilibili.com' || u.hostname.endsWith('.bilibili.com'))) return null
  const bv = u.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i)?.[1]
  if (bv) return { kind: 'video', id: bv }
  const ep = u.pathname.match(/\/cheese\/play\/(ep\d+)/i)?.[1]
  if (ep) return { kind: 'cheese', id: ep }
  const epQuery = u.searchParams.get('ep_id')
  if (u.pathname.includes('/cheese/') && epQuery && /^\d+$/.test(epQuery)) {
    return { kind: 'cheese', id: `ep${epQuery}` }
  }
  return null
}

function normPic(p?: string | null): string | null {
  if (!p) return null
  return p.startsWith('//') ? `https:${p}` : p.replace(/^http:/, 'https:')
}

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效' }, { status: 401 })
  }
  const raw = req.nextUrl.searchParams.get('url') ?? ''
  const target = bilibiliTarget(raw)
  if (!target) return NextResponse.json({ title: null })

  const api =
    target.kind === 'video'
      ? `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(target.id)}`
      : // 课程(cheese)走 pugv 域,与番剧 pgc 不互通(bilibili-API-collect cheese/info.md);
        // ep_id 参数同为纯数字
        `https://api.bilibili.com/pugv/view/web/season?ep_id=${encodeURIComponent(target.id.slice(2))}`

  try {
    const res = await fetch(api, {
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
      cache: 'no-store',
      signal: AbortSignal.timeout(6000),
    })
    if (!res.ok) return NextResponse.json({ title: null })
    const json = (await res.json()) as {
      code?: number
      data?: {
        title?: string
        duration?: number
        pic?: string
        cover?: string
        // pugv season:分集列表挂在 data.episodes,分集 epid 字段名是 id
        // (番剧 pgc 是 result.episodes[].ep_id,两者不可混用)
        episodes?: Array<{ id?: number; title?: string; duration?: number; cover?: string }>
      }
    }
    if (json.code !== 0 || !json.data) return NextResponse.json({ title: null })
    if (target.kind === 'video') {
      if (!json.data.title) return NextResponse.json({ title: null })
      return NextResponse.json({
        title: json.data.title,
        duration: json.data.duration ?? null,
        cover: normPic(json.data.pic),
      })
    }
    // cheese:优先分集标题,缺了退课程标题(pugv 无 long_title,不做二级拼接)
    const data = json.data
    const epId = Number(target.id.slice(2))
    const ep = data.episodes?.find((e) => e.id === epId)
    const title = ep?.title || data.title
    return NextResponse.json({
      title: title ?? null,
      duration: ep?.duration ?? null,
      cover: normPic(ep?.cover ?? data.cover),
    })
  } catch {
    return NextResponse.json({ title: null })
  }
}