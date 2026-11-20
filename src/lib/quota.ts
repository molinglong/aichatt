import { prisma } from "@/lib/db"

// ── 公共额度内核 ──────────────────────────────────────────────
// 只对「服务端出钱」的调用计费：用户未配置该 provider 的 Key、走环境变量兜底
// Key 的内置模型。用户自带 Key 的调用、custom: 模型、标题生成/记忆提取/上下文
// 压缩等后台辅助调用一律不在计费范围。表结构与边界说明见 prisma/schema.prisma
// 的 QuotaPool / QuotaLedger 注释。

/**
 * 参与公共额度计费的内置模型（走「用户 key 缺失 → 服务端兜底」路径的名单）。
 * 与 chat 路由的服务端兜底分支共用同一判定：兜底 Key 只对名单内模型开放
 * （名单外的模型没配 Key 就报 config_missing）。公共池门面模型（PublicPoolModel
 * 表）不在此列——它们由 publicPool 分支直接置 usesServerBilledKey 计费，且可被
 * 管理员动态增删；本名单只剩静态的 deepseek-flash。
 */
const QUOTA_BILLED_MODEL_IDS = new Set(["deepseek-flash"])

const POOL_ID = "global"
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/** 北京时间 yyyy-MM-dd。与 /api/usage 统计接口同口径，个人日限按此翻页 */
export function quotaDayKeyOf(d: Date = new Date()): string {
  return new Date(d.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10)
}

export function isQuotaBilledModel(modelId: string): boolean {
  return QUOTA_BILLED_MODEL_IDS.has(modelId)
}

/**
 * 无 usage 返回时的估算：中文约 1 字 1 token、英文约 4 字符 1 token，
 * 混合取 2.5 字符/token。宁可多计不少计——估算只发生在上游没报数的场景，
 * 偏保守才能守住防刷底线。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 2.5)
}

export type QuotaDenyReason = "pool_exhausted" | "user_daily"

export interface QuotaCheckResult {
  ok: boolean
  reason?: QuotaDenyReason
  /** 当日个人基础日限(池行不存在时缺省)。结算处判定附加余额扣减要用同一档位 */
  baseLimit?: number
}

/**
 * 请求前检查：池剩余 > 0，且该用户今日已耗 < 个人日限。
 * 惰性日补给也在这里触发：跨天后首个请求把 dailyRefillTokens 一次性加进
 * 总池并翻 dayKey（条件更新保证并发下只补一次），无需 cron。
 * 管理员豁免个人日限（role 按 DB 实时值，JWT 里的可能过期失真）——池闸照卡，
 * 模型级 capTokens 也照卡（免费额度纪律对管理员同样成立）；不返回 baseLimit，
 * 结算处即不会触发附加余额扣减。
 * 一日卡（QuotaDayPass，opts.modelId 供 scope 匹配）与 admin 同口径：仅免个人
 * 日限，池闸与模型 cap 照卡；scope 非空时仅名单内模型享受。
 * 池行不存在（迁移未跑）时放行——闸门故障不能阻塞业务主链路。
 */
export async function checkQuota(
  userId: string,
  isEphemeral: boolean,
  opts?: { modelId?: string }
): Promise<QuotaCheckResult> {
  const pool = await prisma.quotaPool.findUnique({ where: { id: POOL_ID } })
  if (!pool) return { ok: true }

  let poolRefill = 0
  const today = quotaDayKeyOf()
  if (pool.dayKey !== today) {
    const flipped = await prisma.quotaPool.updateMany({
      where: { id: POOL_ID, dayKey: pool.dayKey },
      data: { totalTokens: { increment: pool.dailyRefillTokens }, dayKey: today },
    })
    if (flipped.count === 1) poolRefill = pool.dailyRefillTokens
  }

  if (pool.usedTokens >= pool.totalTokens + poolRefill) {
    return { ok: false, reason: "pool_exhausted" }
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  })
  if (user?.role === "admin") return { ok: true }

  // 一日卡(QuotaDayPass):命中当天即豁免个人日限,且不返回 baseLimit——结算处
  // 不会触发附加余额扣减,与 admin 豁免同口径。scope 逗号分隔门面模型 id,
  // 空 = 不限模型;非空时仅名单内模型享受(未传 modelId 从严视为不在名单)。
  // 查表失败(表未建等)按无卡处理,不阻塞主链路。
  try {
    const pass = await prisma.quotaDayPass.findUnique({
      where: { userId_dayKey: { userId, dayKey: today } },
      select: { scope: true },
    })
    if (pass) {
      const scope = pass.scope.split(",").map((s) => s.trim()).filter(Boolean)
      if (!scope.length || (opts?.modelId && scope.includes(opts.modelId))) {
        return { ok: true }
      }
    }
  } catch (err) {
    console.error("[quota] day pass lookup failed, treat as no pass:", err)
  }

  const limit = isEphemeral ? pool.ephemeralPerUserDailyTokens : pool.perUserDailyTokens
  const used = await sumUserDayConsumed(userId, today)
  if (used >= limit) {
    // 日限触顶后放行烧「附加余额」(激活码到账,跨天存续):余额见底才真正拒绝。
    // 允许最后一笔烧穿余额,与池同哲学——闸在请求前,小幅超支可接受。
    const bonus = await getBonusRemaining(userId)
    if (bonus <= 0) return { ok: false, reason: "user_daily" }
  }
  return { ok: true, baseLimit: limit }
}

/** 当日真实消耗:只算 chat 流水(redeem/bonus_spend 是余额收支,不是消耗) */
async function sumUserDayConsumed(userId: string, dayKey: string): Promise<number> {
  const agg = await prisma.quotaLedger.aggregate({
    where: { userId, dayKey, kind: "chat" },
    _sum: { tokens: true },
  })
  return agg._sum.tokens ?? 0
}

/** 附加余额 = 激活码到账累计 − 日限触顶后烧掉的累计。跨天存续,全时段不筛 dayKey */
export async function getBonusRemaining(userId: string): Promise<number> {
  const rows = await prisma.quotaLedger.groupBy({
    by: ["kind"],
    where: { userId, kind: { in: ["redeem", "bonus_spend"] } },
    _sum: { tokens: true },
  })
  const earned = rows.find((r) => r.kind === "redeem")?._sum.tokens ?? 0
  const spent = rows.find((r) => r.kind === "bonus_spend")?._sum.tokens ?? 0
  return earned - spent
}

/**
 * 各模型的全站累计消耗（Σchat 落账，×倍率后口径，全时段不按天）。
 * 门面模型预算 capTokens 的判定真相源；bonus_spend 行不带 model，天然不计入单模型。
 */
export async function getModelTotalConsumed(): Promise<Map<string, number>> {
  const rows = await prisma.quotaLedger.groupBy({
    by: ["model"],
    where: { kind: "chat" },
    _sum: { tokens: true },
  })
  return new Map<string, number>(rows.map((r) => [r.model ?? "", r._sum.tokens ?? 0]))
}

/**
 * 公共池服务端 Key（PublicPoolKey 表按 provider 一把）：门面模型发上游时从这里取。
 * deepseek 无 DB 行时回退环境变量 API_KEY_DEEPSEEK（初始接入路径，VPS 部署待办里
 * 那个变量仍是兜底）；其他 provider 没配就返回 null，chat route 报 config_missing。
 */
export async function getPublicPoolKey(provider: string): Promise<string | null> {
  const row = await prisma.publicPoolKey.findUnique({ where: { provider } })
  if (row?.apiKey) return row.apiKey
  if (provider === "deepseek") return process.env.API_KEY_DEEPSEEK ?? null
  return null
}

/**
 * 结算：真实 usage 优先；缺失时按已生成文本估算（含断流场景——上游成本
 * 已发生）。门面模型按 weight 倍率折算后落账（ledger 是唯一真相源，池扣减/
 * 个人日限/me 口吃同一条流水，口径自动一致）；查不到行（内置兜底模型等）
 * 按 1。baseLimit 传当日基础日限：本笔起消耗越过日限则整笔同时记 bonus_spend
 * （从激活码附加余额扣，简化不拆分；并发窗口可能多扣/少扣一笔，同「允许小幅
 * 超支」哲学）。流水与池扣减同一事务；失败不抛（不阻塞对话收尾）但必须留日志。
 * usedTokens 无条件递增：允许池小幅超支，闸在请求前拦截后续请求。
 */
export async function settleQuota(params: {
  userId: string
  modelId: string
  inputTokens?: number | null
  outputTokens?: number | null
  fallbackText?: string
  baseLimit?: number | null
}): Promise<number> {
  const raw = (params.inputTokens ?? 0) + (params.outputTokens ?? 0)
  const base = raw > 0 ? raw : estimateTokens(params.fallbackText ?? "")
  if (base <= 0) return 0

  let weight = 1
  try {
    const pm = await prisma.publicPoolModel.findUnique({
      where: { id: params.modelId },
      select: { weight: true },
    })
    if (pm?.weight && Number.isFinite(pm.weight) && pm.weight > 0) weight = pm.weight
  } catch (err) {
    console.error("[quota] weight lookup failed, fallback to 1:", err)
  }
  const total = Math.round(base * weight)

  // 本笔是否从附加余额扣:结算前消耗已触限,或本笔消耗跨过限(整笔算余额,不拆分)
  let spendFromBonus = false
  if (params.baseLimit && params.baseLimit > 0) {
    try {
      const consumed = await sumUserDayConsumed(params.userId, quotaDayKeyOf())
      if (consumed >= params.baseLimit || consumed + total > params.baseLimit) spendFromBonus = true
    } catch (err) {
      console.error("[quota] bonus check failed, treat as base-quota:", err)
    }
  }

  try {
    await prisma.$transaction([
      prisma.quotaLedger.create({
        data: {
          userId: params.userId,
          dayKey: quotaDayKeyOf(),
          tokens: total,
          kind: "chat",
          model: params.modelId,
        },
      }),
      ...(spendFromBonus
        ? [
            prisma.quotaLedger.create({
              data: {
                userId: params.userId,
                dayKey: quotaDayKeyOf(),
                tokens: total,
                kind: "bonus_spend",
              },
            }),
          ]
        : []),
      prisma.quotaPool.updateMany({
        where: { id: POOL_ID },
        data: { usedTokens: { increment: total } },
      }),
    ])
  } catch (err) {
    console.error("[quota] settle failed:", err)
  }
  return total
}

/**
 * 激活码兑换：事务里「占用码 + 到账流水」原子完成;码不存在/停用/已兑换都拒绝。
 * 到账 = ledger 写 kind='redeem' 一行,余额由 getBonusRemaining 流水推导。
 */
export async function redeemCode(
  userId: string,
  rawCode: string
): Promise<{ ok: true; tokens: number } | { ok: false; error: string }> {
  const code = rawCode.trim().toUpperCase()
  if (!code) return { ok: false, error: "请输入激活码" }
  try {
    const tokens = await prisma.$transaction(async (tx) => {
      const row = await tx.quotaRedeemCode.findUnique({ where: { code } })
      if (!row) throw new Error("激活码不存在，请核对后重试")
      if (!row.enabled) throw new Error("该激活码已被停用")
      if (row.redeemedBy) throw new Error("该激活码已被使用")
      await tx.quotaRedeemCode.update({
        where: { code },
        data: { redeemedBy: userId, redeemedAt: new Date() },
      })
      await tx.quotaLedger.create({
        data: { userId, dayKey: quotaDayKeyOf(), tokens: row.tokens, kind: "redeem" },
      })
      return row.tokens
    })
    return { ok: true, tokens }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "兑换失败，请稍后重试"
    // 事务内的业务拒绝(码不存在/停用/已兑)直接给文案;真异常不留内部细节
    if (/激活码/.test(msg)) return { ok: false, error: msg }
    console.error("[quota] redeem failed:", err)
    return { ok: false, error: "兑换失败，请稍后重试" }
  }
}
