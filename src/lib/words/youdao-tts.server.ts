import crypto from 'crypto'

/**
 * 有道智云语音合成(TTS)服务端封装 —— 真人发音替代浏览器 speechSynthesis。
 *
 * 凭据走 env(YOUDAO_APP_KEY / YOUDAO_APP_SECRET),不做用户级配置:
 * 这是全局公共能力,费用靠有道侧配额控制,不值得开表。
 *
 * 签名(v3):sign = sha256(appKey + input + salt + curtime + secret),
 * input 超 20 字符时截头尾各 10 位、中间换成长度数(q 本身不参与 URL encode,签名也不 encode)。
 * 成功返回 mp3 二进制;失败返回 JSON errorCode —— 缺 voiceName 会给未收录的 2016。
 */

const TTS_URL = 'https://openapi.youdao.com/ttsapi'

/** 发音人决定语种(接口无 langType):美音/英音/中文 */
const VOICES = {
  us: 'youxiaomei',
  uk: 'youxiaoying',
  zh: 'youxiaozhi',
} as const

export type TtsLang = keyof typeof VOICES

/** 已知错误码的短文案(有道错误码表;2016=缺必填参数,官方表未收录) */
const ERROR_TEXTS: Record<string, string> = {
  '101': '缺少必填参数',
  '102': '不支持的语言',
  '103': '文本过长',
  '108': '应用ID无效',
  '110': '无有效服务实例',
  '113': '文本为空',
  '201': '签名无效',
  '202': '签名校验失败',
  '206': '时间戳无效',
  '207': '重放请求',
  '401': '账户欠费',
  '2013': '发音人参数错误',
  '2016': '缺少必填参数',
}

function makeSign(q: string, salt: string, curtime: string): string {
  const input = q.length <= 20 ? q : q.slice(0, 10) + String(q.length) + q.slice(-10)
  const raw = process.env.YOUDAO_APP_KEY + input + salt + curtime + process.env.YOUDAO_APP_SECRET
  return crypto.createHash('sha256').update(raw).digest('hex')
}

/** 进程内 LRU 缓存:同一个词反复点不重复计费;键=语种+文本,值=mp3 */
const CACHE_CAP = 300
const cache = new Map<string, Buffer>()

function cacheGet(key: string): Buffer | undefined {
  const hit = cache.get(key)
  if (hit !== undefined) {
    // LRU:命中后挪到队尾
    cache.delete(key)
    cache.set(key, hit)
  }
  return hit
}

function cachePut(key: string, buf: Buffer) {
  if (cache.size >= CACHE_CAP) {
    // 淘汰最旧(Map 迭代序即插入序)
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, buf)
}

/**
 * 合成一段语音。失败抛 Error(message 为给用户看的中文文案)。
 * lang: 'us' | 'uk' | 'zh';slow: 慢速(拼读场景用 0.6 倍速)。
 */
export async function youdaoTts(text: string, lang: TtsLang = 'us', slow = false): Promise<Buffer> {
  const appKey = process.env.YOUDAO_APP_KEY
  const secret = process.env.YOUDAO_APP_SECRET
  if (!appKey || !secret) {
    throw new Error('有道 TTS 未配置(YOUDAO_APP_KEY/SECRET)')
  }

  const key = `${lang}:${slow ? 's' : ''}:${text}`
  const cached = cacheGet(key)
  if (cached) return cached

  const salt = crypto.randomUUID()
  const curtime = String(Math.floor(Date.now() / 1000))
  const body = new URLSearchParams({
    q: text,
    appKey,
    salt,
    signType: 'v3',
    curtime,
    sign: makeSign(text, salt, curtime),
    voiceName: VOICES[lang],
    format: 'mp3',
    ...(slow ? { speed: '0.6' } : {}),
  })

  const res = await fetch(TTS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  })

  const ct = res.headers.get('content-type') || ''
  const buf = Buffer.from(await res.arrayBuffer())
  if (ct.includes('audio')) {
    cachePut(key, buf)
    return buf
  }

  // 失败:JSON { errorCode }
  let code = ''
  try {
    code = (JSON.parse(buf.toString('utf8')) as { errorCode?: string }).errorCode ?? ''
  } catch {
    /* 非 JSON 也当未知错误 */
  }
  console.error(`[youdao-tts] errorCode=${code} lang=${lang} q=${text.slice(0, 40)}`)
  throw new Error(ERROR_TEXTS[code] ? `语音合成失败:${ERROR_TEXTS[code]}` : `语音合成失败(${code || '未知错误'})`)
}
