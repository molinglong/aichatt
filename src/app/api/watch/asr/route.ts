import { NextResponse } from "next/server"
import { getUserId } from "@/lib/api-auth"
import { getPublicPoolKey } from "@/lib/quota"

/**
 * 手表端语音识别：接收 WAV，复用百炼 Qwen3-ASR-Flash 转文字。
 *
 * 不再依赖系统/Google 语音服务：手表录 16k 单声道 WAV 上传到这里，
 * 识别结果直接回给手表走 /api/quick-chat。
 *
 * 鉴权：Bearer API Token（同其它 /api/watch/*）。
 */

const MAX_BYTES = 4 * 1024 * 1024
const MODEL = "qwen3-asr-flash"
const ENDPOINT =
  "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
const TIMEOUT_MS = 45_000
const RATE_LIMIT = 10
const RATE_WINDOW_MS = 60_000

// 单实例内存限流：防止令牌被拿去刷识别费用
const buckets = new Map<string, { count: number; resetAt: number }>()

function takeToken(userId: string): boolean {
  const now = Date.now()
  const bucket = buckets.get(userId)
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(userId, { count: 1, resetAt: now + RATE_WINDOW_MS })
    return true
  }
  if (bucket.count >= RATE_LIMIT) return false
  bucket.count += 1
  return true
}

function upstreamError(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: unknown } }
    const message = parsed.error?.message
    if (typeof message === "string" && message.trim()) return message.trim()
  } catch {
    // ignore
  }
  return "语音识别失败"
}

export async function POST(req: Request) {
  const userId = await getUserId(req)
  if (!userId) {
    return NextResponse.json(
      { error: "登录已失效，请检查 API 令牌" },
      { status: 401 },
    )
  }

  if (!takeToken(userId)) {
    return NextResponse.json({ error: "识别太频繁，请稍后再试" }, { status: 429 })
  }

  const form = await req.formData().catch(() => null)
  const file = form?.get("file")
  if (!file || typeof file === "string") {
    return NextResponse.json({ error: "缺少音频文件" }, { status: 400 })
  }
  if (file.size <= 0 || file.size > MAX_BYTES) {
    return NextResponse.json({ error: "音频为空或过大" }, { status: 400 })
  }

  // 优先用公共池里已配置的百炼 Key，其次环境变量兜底
  const poolKey = await getPublicPoolKey("qianwen").catch(() => null)
  const apiKey = (poolKey || process.env.API_KEY_BAILIAN || "")
    .trim()
    .replace(/^"|"$/g, "")
  if (!apiKey) {
    return NextResponse.json(
      { error: "语音识别未配置（缺少百炼 Key）" },
      { status: 503 },
    )
  }

  const mime = file.type || "audio/wav"
  const base64 = Buffer.from(await file.arrayBuffer()).toString("base64")

  let upstream: Response
  try {
    upstream = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "input_audio",
                input_audio: { data: `data:${mime};base64,${base64}` },
              },
            ],
          },
        ],
        stream: false,
        asr_options: { language: "zh", enable_itn: true },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    return NextResponse.json({ error: "语音识别超时，请重试" }, { status: 504 })
  }

  const raw = await upstream.text()
  if (!upstream.ok) {
    return NextResponse.json(
      { error: upstreamError(raw).slice(0, 200) },
      { status: 502 },
    )
  }

  let text = ""
  try {
    const parsed = JSON.parse(raw) as {
      choices?: Array<{ message?: { content?: unknown } }>
    }
    const content = parsed.choices?.[0]?.message?.content
    if (typeof content === "string") text = content.trim()
  } catch {
    // fallthrough
  }

  if (!text) {
    return NextResponse.json({ error: "没有识别到内容" }, { status: 422 })
  }

  return NextResponse.json({ text })
}
