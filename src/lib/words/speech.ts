'use client'

/**
 * 词汇发音客户端封装 —— 有道真人发音优先(走 /api/words/tts 服务端代理),
 * 失败/离线时回落浏览器 speechSynthesis(免费兜底,不能不响)。
 *
 * 播放为 fire-and-forget:调用方不用 await;重复点击会打断上一段音频。
 */

let currentAudio: HTMLAudioElement | null = null

/** 浏览器自带 TTS 兜底(en-US 优先) */
function fallbackSpeak(text: string, lang: 'us' | 'uk' | 'zh') {
  if (typeof window === 'undefined' || !window.speechSynthesis) return
  try {
    window.speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.lang = lang === 'zh' ? 'zh-CN' : 'en-US'
    u.rate = 0.9
    window.speechSynthesis.speak(u)
  } catch {
    /* 朗读失败不影响答题 */
  }
}

export async function speakWord(text: string, opts?: { lang?: 'us' | 'uk' | 'zh'; slow?: boolean }) {
  const lang = opts?.lang ?? 'us'
  // 先掐掉可能还在播的上一段(浏览器兜底 + 有道音频两条线都要掐)
  try {
    window.speechSynthesis?.cancel()
  } catch {
    /* noop */
  }
  if (currentAudio) {
    currentAudio.pause()
    currentAudio = null
  }

  try {
    const params = new URLSearchParams({ q: text, lang })
    if (opts?.slow) params.set('slow', '1')
    const res = await fetch(`/api/words/tts?${params.toString()}`)
    if (!res.ok) throw new Error(`tts ${res.status}`)
    const blob = await res.blob()
    if (!blob.type.includes('audio')) throw new Error('not audio')
    const audio = new Audio(URL.createObjectURL(blob))
    currentAudio = audio
    audio.onended = () => {
      if (currentAudio === audio) currentAudio = null
    }
    await audio.play()
  } catch {
    // 有道不可达/未配置/欠费 —— 静默回落浏览器朗读,卡片交互不中断
    fallbackSpeak(text, lang)
  }
}

/* ── 可等待播放:磨耳朵连播用(2026-11-17) ──
 * 与 speakWord 的区别:resolve = 本段播完(或兜底超时),调用方串链推进下一个词。
 * audio 元素由调用方持有并常驻(听音模式用它挂 MediaSession,锁屏不中断);
 * 有道失败/播放被拦 → 浏览器朗读兜底;都失败也按超时放行,连播节奏不断。 */

function fallbackSpeakAwait(text: string, lang: 'us' | 'uk' | 'zh'): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return resolve()
    try {
      const u = new SpeechSynthesisUtterance(text)
      u.lang = lang === 'zh' ? 'zh-CN' : 'en-US'
      u.rate = lang === 'zh' ? 1 : 0.9
      let settled = false
      const done = () => {
        if (!settled) {
          settled = true
          resolve()
        }
      }
      u.onend = done
      u.onerror = done
      window.speechSynthesis.speak(u)
      // 个别内核不触发 onend,按文本长度估上界
      window.setTimeout(done, Math.max(1400, text.length * 130 + 1200))
    } catch {
      resolve()
    }
  })
}

export function speakAwait(
  audio: HTMLAudioElement,
  text: string,
  opts?: { lang?: 'us' | 'uk' | 'zh'; slow?: boolean; timeoutMs?: number },
): Promise<void> {
  const lang = opts?.lang ?? 'us'
  const params = new URLSearchParams({ q: text, lang })
  if (opts?.slow) params.set('slow', '1')
  return new Promise((resolve) => {
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      audio.onended = null
      audio.onerror = null
      resolve()
    }
    try {
      window.speechSynthesis?.cancel()
    } catch {
      /* noop */
    }
    audio.onended = done
    audio.onerror = () => {
      // 有道不可达/未配置/欠费 —— 落浏览器朗读,连播不中断
      void fallbackSpeakAwait(text, lang).then(done)
    }
    audio.src = `/api/words/tts?${params.toString()}`
    void audio.play().catch(() => {
      // 播放被拦(无手势)/加载失败 —— 落浏览器朗读
      void fallbackSpeakAwait(text, lang).then(done)
    })
    // 网络停滞兜底:超时也放行
    window.setTimeout(done, opts?.timeoutMs ?? 15000)
  })
}
