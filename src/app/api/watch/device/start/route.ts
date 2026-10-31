import { NextResponse } from "next/server"
import { randomInt } from "crypto"
import { prisma } from "@/lib/db"

/**
 * 手表设备码授权 - 第一步：生成 6 位短码。
 * 无鉴权（码本身即一次性凭证），5 分钟有效；同一码只允许一次 approve。
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// 去掉 O/0/I/1 等易混字符
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const TTL_MS = 5 * 60 * 1000

function makeCode(): string {
  let out = ""
  for (let i = 0; i < 6; i += 1) out += ALPHABET[randomInt(ALPHABET.length)]
  return out
}

export async function POST() {
  const now = new Date()
  await prisma.deviceAuthCode
    .deleteMany({ where: { expiresAt: { lt: now } } })
    .catch(() => {})

  // unique 冲突时重试；6 位 32 进制空间足够大
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = makeCode()
    try {
      await prisma.deviceAuthCode.create({
        data: { code, expiresAt: new Date(now.getTime() + TTL_MS) },
      })
      return NextResponse.json({ code, expiresIn: TTL_MS / 1000 })
    } catch {
      // 唯一键冲突，换一个码重试
    }
  }

  return NextResponse.json({ error: "生成授权码失败，请重试" }, { status: 500 })
}
