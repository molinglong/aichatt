import NextAuth, { CredentialsSignin } from "next-auth"
import Credentials from "next-auth/providers/credentials"
import { verifyCredentials } from "./credentials"
import { prisma } from "./db"
import { verifyHomeCode } from "./home-sso"

// ── 临时聊天(访客模式)常量 ──────────────────────────────
/** 临时会话(访客密码登录)的 JWT 有效期:12 小时,公共电脑场景自动过期 */
const EPHEMERAL_SESSION_MAX_AGE_S = 12 * 60 * 60

/** 临时登录入口收到主密码时抛出的专属错误:前端据 code 显示定向提示 */
class GuestPasswordRequiredError extends CredentialsSignin {
  code = "EPHEMERAL_ENTRY_MAIN_PASSWORD"
}

/** 登录限速触发时抛出的错误:前端据 code 提示稍后再试 */
class RateLimitedError extends CredentialsSignin {
  code = "RATE_LIMITED"
}

/** home 身份有效，但 aichatt 里没有同邮箱账号 */
class HomeAccountMissingError extends CredentialsSignin {
  code = "HOME_ACCOUNT_MISSING"
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  pages: {
    signIn: "/login",
  },
  providers: [
    // home 作为身份源：只接受它签发的 60 秒一次性 code，按邮箱认领已有用户。
    // 找不到同邮箱账号直接拒绝、不自动建号——home 注册暂不验证邮箱，
    // 自动建号会让任何人用他人邮箱接管账号；aichatt 账号一律走自己的注册页。
    Credentials({
      id: "home",
      name: "home",
      credentials: {
        code: { label: "Code", type: "text" },
      },
      async authorize(credentials) {
        const payload = verifyHomeCode(
          typeof credentials?.code === "string" ? credentials.code : undefined
        )
        if (!payload) return null

        const user = await prisma.user.findFirst({
          where: { email: { equals: payload.email, mode: "insensitive" } },
          select: { id: true, email: true, name: true, role: true },
        })
        if (!user) throw new HomeAccountMissingError()

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: null,
          role: user.role,
          ephemeral: false,
        }
      },
    }),
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        // 临时登录入口(/login/ephemeral)传入:该入口只认访客密码,拒绝主密码
        ephemeralEntry: { label: "Ephemeral Entry", type: "text" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null

        const identifier = credentials.email as string
        const password = credentials.password as string
        // 临时入口标志:仅 /login/ephemeral 提交时为真
        const ephemeralEntry =
          credentials.ephemeralEntry === "1" || credentials.ephemeralEntry === "true"

        // 校验/限速/密码通道规则统一在 lib/credentials 内，与扩展登录共用
        const result = await verifyCredentials(
          identifier,
          password,
          ephemeralEntry ? "ephemeral" : "web"
        )

        if (result.status === "rate_limited") throw new RateLimitedError()
        if (result.status === "main_password_on_ephemeral") {
          throw new GuestPasswordRequiredError()
        }
        if (result.status !== "ok") return null

        return {
          ...result.user,
          ephemeral: result.ephemeral,
        }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger, session }) {
      if (user) {
        token.id = user.id
        token.sub = user.id  // explicitly set sub for reliability
        // 角色入 JWT:仅供设置页 UI 显隐;服务端 API 验权一律按 DB 实时值
        token.role = user.role
        // 临时模式标记:访客密码登录产生;同时把临时会话有效期压到 12h
        token.ephemeral = (user as { ephemeral?: boolean }).ephemeral === true
        if (token.ephemeral) {
          token.exp = Math.floor(Date.now() / 1000) + EPHEMERAL_SESSION_MAX_AGE_S
          // 透出给前端的真实过期时间(毫秒):session.expires 是全局 maxAge(30 天),
          // 不反映临时会话的 12h 压缩有效期
          token.sessionEndsAt = token.exp * 1000
        }
      }
      // 客户端 useSession().update({ name }) 时把新用户名写入 token,
      // 否则 JWT 策略下侧边栏等处会一直显示登录时固化的旧资料
      if (trigger === 'update' && session?.name) {
        token.name = session.name
      }
      return token
    },
    async session({ session, token }) {
      const userId = (token.sub ?? token.id) as string | undefined
      if (!userId || !session.user) return session

      session.user.id = userId
      if (token.role) session.user.role = token.role
      // 透出临时模式标记:服务端 API 隔离与前端 UI 均以此为准
      session.ephemeral = token.ephemeral === true
      if (typeof token.sessionEndsAt === 'number') {
        session.sessionEndsAt = token.sessionEndsAt
      }
      return session
    },
  },
})
