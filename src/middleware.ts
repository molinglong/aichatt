import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { getToken } from "next-auth/jwt"

// ── 临时聊天(访客模式):账户管理类端点统一拦截 ──────────────
// 临时模式(访客密码登录,token.ephemeral)下只保留"使用权":
// 模型调用/上传/生图/面具使用可用;一切账户管理写操作一律 403。
// 统一在 middleware 拦截,避免逐 handler 散布守卫造成遗漏。
const EPHEMERAL_DENIED_PREFIXES = [
  "/api/keys", // 模型 API Key 管理(含掩码明文头尾，防泄露；provider 名单用 /api/providers/keys-status 替代)
  "/api/search/keys", // 联网搜索 Key 管理
  "/api/settings", // AI 设置控制/澄清开关
  "/api/image-settings", // 生图设置
  "/api/provider-models", // 模型可见性管理/测试
  "/api/memories", // 长期记忆 CRUD(防删改污染)
  "/api/ephemeral", // 隔离区管理(找回/转正/删除)
  "/api/user/ephemeral-settings", // 访客密码/临时记忆开关
  "/api/study", // 学习功能(错题本/复习状态写入)
  "/api/favorites", // 收藏(长期数据资产,与错题本同口径,防临时模式污染)
  "/api/todos", // 待办(长期数据,防临时模式污染)
  "/api/profiles", // 通用档案:读=暴露本人身份/学段,写=污染账户资产,临时模式整条拦掉
  "/api/write", // 写作画布文档(长期数据资产,防临时模式污染;入口在临时模式下本就隐藏)
  "/api/quota/admin", // 全站额度管理口:暴露池量与其他用户用量,临时模式整条拦掉
  "/api/quota/redeem", // 激活码兑换:临时账户转瞬即逝,兑了浪费,拒之(route 内 isEphemeral 第二道)
  // 注:/api/quota/me 只回本人当日用量,临时访客可读(低档日限展示用),不在拦截列
]

/** 方法敏感类：GET 等读操作放行，写操作拦截 */
const EPHEMERAL_METHOD_GUARDED: Array<[string, string[]]> = [
  ["/api/user/profile", ["PATCH", "POST", "PUT", "DELETE"]], // 改用户名等
  ["/api/masks", ["POST", "PATCH", "PUT", "DELETE"]], // 面具库写操作；GET 放行(选择器要用)
  ["/api/custom-models", ["POST", "PATCH", "PUT", "DELETE"]], // 自定义模型写操作；GET 放行(模型选择器要用，返回不含密钥明文)
  ["/api/images", ["DELETE", "PATCH", "PUT"]], // 图库删除；GET/POST(生图)放行
  // 取证上报:POST 必须放行(访客崩了同样要留证据),但清库只允许账户主人在正式登录态做
  ["/api/client-diagnostics", ["DELETE"]],
]

function isDeniedForEphemeral(pathname: string, method: string): boolean {
  if (
    EPHEMERAL_DENIED_PREFIXES.some(
      (p) => pathname === p || pathname.startsWith(p + "/")
    )
  ) {
    return true
  }
  return EPHEMERAL_METHOD_GUARDED.some(
    ([p, methods]) =>
      (pathname === p || pathname.startsWith(p + "/")) && methods.includes(method)
  )
}

// ── 跨域白名单(Bento 新标签页等本地静态页) ──────────────
// 白名单内 origin 的 /api/* 请求附加 CORS 响应头,OPTIONS 预检直接 204;
// 携带 Authorization: Bearer 的 API 请求无 NextAuth cookie,未登录时放行
// 到 handler(token→userId 校验在 lib/api-auth 的 getUserId 内完成,
// edge runtime 不能查库,middleware 只透传头)。
const API_CORS_ALLOW_ORIGINS = [
  "http://localhost:8090", // bento 起始页(静态 server)
  "http://127.0.0.1:8090",
  "http://localhost:5180", // plan 本地 dev(Vite)
  "http://127.0.0.1:5180",
  "http://localhost:8137", // 主页本地预览(Python http.server)
  "http://127.0.0.1:8137",
  "https://yuban.icu", // 主页线上部署(静态站)
  // 对话搬运「一键推送线上」:本地 dev 实例(3456 标准口/3000 兜底口)跨域推
  // 到线上。只有带 sk- Bearer 令牌的 import 会真正写库,坏 origin 拿不到令牌。
  "http://localhost:3456",
  "http://127.0.0.1:3456",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]

function isAllowedApiOrigin(origin: string | null): origin is string {
  if (!origin) return false
  if (API_CORS_ALLOW_ORIGINS.includes(origin)) return true
  // 浏览器扩展侧边栏/背景页:只谈 Bearer 令牌通道,响应不带 Allow-Credentials,
  // 不会把 cookie 暴露给扩展;扩展侧自带 host_permissions,这里只是兜底。
  return /^(chrome|moz)-extension:\/\//.test(origin)
}

function corsHeaders(res: NextResponse, origin: string | null): NextResponse {
  if (isAllowedApiOrigin(origin)) {
    res.headers.set("Access-Control-Allow-Origin", origin)
    res.headers.set("Vary", "Origin")
    // 扩展读取新会话 id/标题、客户端认亲本次回复的库行 id
    // (普通 CORS 下自定义响应头需显式暴露)
    res.headers.set(
      "Access-Control-Expose-Headers",
      "X-Conversation-Id, X-Conversation-Title, X-Assistant-Message-Id"
    )
  }
  return res
}

export async function middleware(req: NextRequest) {
  // Auth.js v5 按 AUTH_URL 协议决定 session cookie 前缀(HTTPS 部署恒为 __Secure-),
  // 且不随请求协议变化; getToken 默认却按无前缀名(authjs.session-token)查找,
  // 必须显式传 secureCookie, 判定依据与 Auth.js 对齐(先看 AUTH_URL), 请求协议仅兜底。
  // 否则 HTTPS 部署后 middleware 误判未登录, /chat 被 307 弹回 /login(本地 http dev 无前缀,故不触发)
  const authUrl = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? ""
  const isSecure =
    authUrl.startsWith("https://") || req.nextUrl.protocol === "https:"
  const token = await getToken({
    req,
    secret: process.env.AUTH_SECRET,
    secureCookie: isSecure,
  })
  const isLoggedIn = !!token
  const { pathname } = req.nextUrl

  // 跨域相关:仅对 /api/* 生效(页面请求同源,无需 CORS)
  const isApiPath = pathname.startsWith("/api/")
  const origin = req.headers.get("origin")
  const corsOrigin =
    isApiPath && isAllowedApiOrigin(origin) ? origin : null

  // OPTIONS 预检:白名单 origin 直接放行并回预检响应
  if (req.method === "OPTIONS" && corsOrigin) {
    const res = new NextResponse(null, { status: 204 })
    res.headers.set("Access-Control-Allow-Origin", corsOrigin)
    res.headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS")
    res.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type")
    res.headers.set("Access-Control-Max-Age", "86400")
    res.headers.set(
      "Access-Control-Expose-Headers",
      "X-Conversation-Id, X-Conversation-Title, X-Assistant-Message-Id"
    )
    // 扩展访问本机 dev(127.0.0.1/localhost)时 Chrome Private Network Access 预检
    if (req.headers.get("access-control-request-private-network") === "true") {
      res.headers.set("Access-Control-Allow-Private-Network", "true")
    }
    return res
  }

  // API Token 通道:Bearer 请求无 cookie,不走页面鉴权/临时模式拦截,
  // token 有效性由各 handler 内 getUserId 校验(无效时 handler 返 401)
  const bearerToken =
    req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null
  if (isApiPath && bearerToken) {
    return corsHeaders(NextResponse.next(), origin)
  }

  // 临时模式统一拦截:命中账户管理类端点直接 403(与 handler 内守卫构成双保险)
  if (isLoggedIn && token.ephemeral === true && isDeniedForEphemeral(pathname, req.method)) {
    // 监控点:edge runtime 无法写文件,仅 console(dev 终端可见),与 logs/monitor.log 同前缀
    console.log(`[MONITOR] {"event":"ephemeral_denied","method":"${req.method}","path":"${pathname}"}`)
    return NextResponse.json(
      { error: "临时聊天模式下不可修改账户设置" },
      { status: 403 }
    )
  }

  // 临时聊天模式页面级封锁:只允许聊天界面，
  // 手动输 URL 访问生图/探索/学习室页一律重定向回 /chat(API 已由上面的 403 拦截)
  if (isLoggedIn && token.ephemeral === true) {
    const pageDenied =
      pathname === "/images" || pathname.startsWith("/images/") ||
      pathname === "/explore" || pathname.startsWith("/explore/") ||
      // 2026-11-02:/study 独立页下线,学习室改由 /chat?study=1 承载,封锁跟着改判查询参数
      (pathname === "/chat" && req.nextUrl.searchParams.get("study") !== null) ||
      pathname === "/diagnostics" || pathname.startsWith("/diagnostics/")
    if (pageDenied) {
      return NextResponse.redirect(new URL("/chat", req.url))
    }
  }

  // Public routes — always allow
  // /api/v1/* = 对外模型网关(如 ACode),鉴权在路由内部用 x-api-key 令牌完成
  // (机器对机器调用没有会话 cookie,走的是自己的令牌体系,不走 nextauth)
  const isPublic =
    pathname.startsWith("/login") ||
    pathname.startsWith("/register") ||
    pathname.startsWith("/api/auth") ||
    // 扩展用账号密码换 Bearer 令牌：此时还没有任何凭证，必须放行；
    // 限速与密码校验在 route 内完成
    pathname === "/api/extension/login" ||
    // 手表设备码授权：start/poll 在手表未登录时调用，码本身即一次性凭证；
    // approve 仍需登录，不放行
    pathname === "/api/watch/device/start" ||
    pathname === "/api/watch/device/poll" ||
    pathname.startsWith("/api/v1/") ||
    // 桌面小鸡窗(Tauri pet 窗):无账也能站桌面,不依赖账号数据(蛋走本地 localStorage)
    pathname === "/pet" ||
    pathname.startsWith("/pet/") ||
    pathname === "/test-toast"

  if (isPublic) {
    // Keep auth pages reachable so a stale JWT after a database restore can be replaced.
    return NextResponse.next()
  }

  // Protected routes — require auth
  if (!isLoggedIn) {
    // API 请求返回 401 JSON 而非重定向：fetchJson 客户端可识别 AuthorizationError 跳转登录页；
    // SSR/hydration 阶段的 fetch 不会携带 cookie，若重定向会拿到登录页 HTML 导致 JSON 解析失败；
    // 附 CORS 头:白名单页面的跨域请求也需要能读到 401 响应体
    if (pathname.startsWith("/api/")) {
      return corsHeaders(
        NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
        origin
      )
    }
    return NextResponse.redirect(new URL("/login", req.url))
  }

  return NextResponse.next()
}

export const config = {
  // 排除静态资源:uploads(字体/图片)与 fonts(MiSans 子集分片)不走 middleware,
  // 避免每个资源请求都执行 JWT 解码;未登录时字体请求也不会被 307 重定向成 HTML。
  // manifest.json 与 icons(PWA 图标)同理:浏览器请求它们不携带 cookie,
  // 被 307 成登录页 HTML 会导致「添加到主屏幕」的 PWA 安装直接失败。
  // brand(品牌标记图,登录页/侧栏 <img> 引用)同理:登录页本身即未登录态,
  // 被 307 成 HTML 会渲染成破图。
  // uploads 的安全头(X-Content-Type-Options/CSP sandbox)由 next.config.mjs headers() 独立提供,
  // 文件名 nanoid(12)/分片 hash 不可枚举,未登录直访风险可控
  // apk(APK 安装包清单/产物)只在本地 dev 由 next.config.mjs 的 dev-only rewrite 代理到线上;
  // 线上由 nginx 的 location /apk/ 直接吐文件,请求根本到不了 Next,故排除无鉴权面变化。
  matcher: ["/((?!_next/static|_next/image|favicon.ico|uploads|kb-pages|brand|fonts|manifest.json|icons|wallpaper|apk).*)"],
}
