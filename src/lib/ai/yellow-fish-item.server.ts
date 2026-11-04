import { extractJsonLoose, runCli } from './yellow-fish-cookie.server'
import { parsePriceValue } from './yellow-fish-monitor.server'

/**
 * goofish `item get` 桥:单件商品现状检测(收藏池「查现价」/渐进体检共用)。
 *
 * 判定口径 2026-11-04 实测定案(对照 monitor 库真实商品 + 不存在 id):
 * - 在售:exit 0 + stdout JSON(status="在线", status_code=0, price="3088")
 * - 已下架/删除:exit 79 + stdout 错误行 [NotFoundError] FAIL_BIZ_ITEM_DEL_NOT_FOUND
 *   ("您要看的宝贝不存在或已被删除啦!")——下架与删除接口同形,无法进一步区分,如实标"已下架/删除"
 * - 其他失败(超时/风控/输出异常):unknown,不当作下架误标
 * 注意 cookie 失效时 CLI 会先 Playwright 免密刷新(~12s),超时放宽 60s。
 */

const ITEM_GET_TIMEOUT_MS = 60_000

export type ItemCheckResult =
  | { kind: 'onSale'; price: number | null; statusText: string }
  | { kind: 'off'; statusText: string }
  | { kind: 'unknown'; error: string }

/** 非"在线"但接口正常返回的状态(如已售),透传原文给 UI,不硬编码枚举 */
export async function runItemGet(itemId: string): Promise<ItemCheckResult> {
  if (!/^\d{5,20}$/.test(itemId)) {
    return { kind: 'unknown', error: '商品 id 不合法' }
  }
  const r = await runCli(['item', 'get', itemId, '--format', 'json'], ITEM_GET_TIMEOUT_MS)

  if (r.missing) {
    return { kind: 'unknown', error: 'goofish-cli 未安装' }
  }

  // 已下架/删除:exit 79 + FAIL_BIZ_ITEM_DEL_NOT_FOUND(以退出码或错误文本任一命中为准)
  const output = `${r.stderr}\n${r.stdout}`
  if (r.code === 79 || /FAIL_BIZ_ITEM_DEL_NOT_FOUND|不存在或已被删除/.test(output)) {
    return { kind: 'off', statusText: '已下架/删除' }
  }

  if (r.code !== 0) {
    // 登录态失效等:CLI 可能带 Playwright 刷新后重试仍失败;归 unknown,提示去设置节看登录态
    const authFail = looksLikeAuthFailureText(output)
    return { kind: 'unknown', error: authFail ? '登录态失效,去「设置 → YellowFish」修复后重查' : lastErrorLine(output) }
  }

  const parsed = extractJsonLoose(r.stdout)
  if (!parsed) {
    return { kind: 'unknown', error: 'item get 输出无法解析' }
  }

  const status = typeof parsed.status === 'string' ? parsed.status : ''
  const statusCode = typeof parsed.status_code === 'number' ? parsed.status_code : null
  if (status === '在线' && (statusCode === 0 || statusCode === null)) {
    return {
      kind: 'onSale',
      price: parsePriceValue(parsed.price),
      statusText: '在线',
    }
  }

  // 接口正常但商品非在售(已售/下架中/审核等):透传状态原文
  return { kind: 'off', statusText: status || `status_code=${statusCode ?? '?'}` }
}

function looksLikeAuthFailureText(text: string): boolean {
  return /登录态失效|请先登录|FAIL_SYS_SESSION_EXPIRED|FAIL_SYS_TOKEN_(EXOIRED|EMPTY)|AuthRequiredError/i.test(text)
}

/** 取错误输出最后一行非空文本作摘要(stderr 逐行日志很长) */
function lastErrorLine(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  return (lines[lines.length - 1] || '查询失败').slice(0, 160)
}
