import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { youdaoTts, type TtsLang } from '@/lib/words/youdao-tts.server'

/**
 * GET /api/words/tts?q=abandon&lang=us&slow=1 —— 单词/例句真人发音
 *
 * 有道智云 TTS 的服务端代理:密钥不出服务端,顺带进程内 LRU 缓存防重复计费。
 * lang=us|uk|zh(发音人决定语种);slow=1 走 0.6 倍速(拼读场景)。
 * 成功回 mp3 二进制;失败回 JSON { error },客户端据此回落浏览器朗读。
 */
const MAX_LEN = 300
const LANGS: TtsLang[] = ['us', 'uk', 'zh']

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: '登录已失效，请重新登录后再试' }, { status: 401 })
  }

  const q = (req.nextUrl.searchParams.get('q') ?? '').trim()
  const langParam = req.nextUrl.searchParams.get('lang') ?? 'us'
  const lang = (LANGS as string[]).includes(langParam) ? (langParam as TtsLang) : 'us'
  const slow = req.nextUrl.searchParams.get('slow') === '1'

  if (!q) {
    return NextResponse.json({ error: '缺少 q 参数' }, { status: 400 })
  }
  if (q.length > MAX_LEN) {
    return NextResponse.json({ error: '文本过长' }, { status: 400 })
  }

  try {
    const audio = await youdaoTts(q, lang, slow)
    // 交给浏览器缓存:同一词反复点不回源(URL 带 q,逐词独立缓存)
    return new NextResponse(new Uint8Array(audio), {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'private, max-age=86400',
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : '语音合成失败'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
