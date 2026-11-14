/**
 * 验收辅助：用本地 AUTH_SECRET 签一个 authjs.session-token cookie，
 * 供浏览器 UI 验收登录态使用。只输出 cookie 串本身，不输出密钥。
 * 用户信息由调用方先查库传入（prisma 7 生成物是 TS 源码，CJS 侧 require 不了）。
 * 用法: node scripts/mint-session-cookie.cjs <userId> <email> <name> <role>
 */
const path = require('node:path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') })

async function main() {
  const [userId, email, name, role] = process.argv.slice(2)
  if (!userId || !email) {
    console.error('need_userid_and_email')
    process.exit(1)
  }
  const secret = process.env.AUTH_SECRET
  if (!secret) {
    console.error('no_auth_secret')
    process.exit(1)
  }
  const { encode } = require('next-auth/jwt')
  const now = Math.floor(Date.now() / 1000)
  const token = {
    id: userId,
    sub: userId,
    email,
    name: name || null,
    role: role || 'user',
    ephemeral: false,
    iat: now,
    exp: now + 30 * 24 * 60 * 60,
    jti: require('node:crypto').randomUUID(),
  }
  const jwt = await encode({ token, secret, salt: 'authjs.session-token', maxAge: 30 * 24 * 60 * 60 })
  process.stdout.write(jwt)
}
main().catch((e) => { console.error(e.message); process.exit(1) })
