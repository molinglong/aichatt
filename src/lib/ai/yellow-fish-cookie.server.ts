import { execFile } from 'child_process'
import { YELLOW_FISH_LIVE_CLI_PATH_DEFAULT } from './yellow-fish-live-tool'

/**
 * goofish-cli 登录态桥 —— 闲鱼实时价(get_yellow_fish_live)的 cookie 健康检查与一键修复。
 *
 * CLI 契约(0.6.3 实测,2026-11-04):
 * - `auth status --format json`: stdout 纯 JSON {unb,tracknick,nick,valid,error?};失效也 exit 0;
 *   检测到失效会先试 Playwright「快速进入」免密刷新(实测 ~12s),救不回才返回 valid:false —— 所以超时要放宽。
 * - `auth login --qr --qr-timeout 600 --format json`: 唯一修复路径——弹独立 Playwright 窗口等扫码或账密
 *   (Chrome/Edge 127+ 应用绑定加密让 browser_cookie3 浏览器导入全灭，实测逐浏览器 RequiresAdminError，
 *   2026-11-04 定案删除浏览器导入路径)；成功输出 {source:"qr",path,unb,tracknick,cookies_count};
 *   失败非 0 退出,stderr 带要点。窗口 10 分钟有效，扫码或输账密均可。
 *
 * 边界:CLI 只在本机存在;VPS 部署上 available=false,设置区块据此整体降级隐藏,绝不假装可修。
 */

export function goofishCliPath(): string {
  return (process.env.YELLOW_FISH_LIVE_CLI_PATH || YELLOW_FISH_LIVE_CLI_PATH_DEFAULT).trim() ||
    YELLOW_FISH_LIVE_CLI_PATH_DEFAULT
}

export interface GoofishAuthStatus {
  /** CLI 可执行(未安装=false,设置页据此整体降级) */
  available: boolean
  /** null = 跑了但结果不可判(超时/输出解析失败) */
  valid: boolean | null
  unb?: string
  tracknick?: string
  nick?: string
  error?: string
  checkedAt: number
}

export interface GoofishLoginResult {
  ok: boolean
  source?: string
  unb?: string
  tracknick?: string
  cookiesCount?: number
  error?: string
  /** 修复失败时给用户的人工兜底思路 */
  hint?: string
}

/** status 自带浏览器刷新尝试(~12s),设置页反复开关不能每次真跑 → 60s 缓存 */
const STATUS_TTL_MS = 60_000
const STATUS_TIMEOUT_MS = 60_000
/** 扫码窗口 10 分钟(--qr-timeout 600) + Playwright 冷启动与身份确认余量 */
const LOGIN_TIMEOUT_MS = 660_000

let statusCache: { value: GoofishAuthStatus; expiresAt: number } | null = null

interface CliRun {
  /** true = 可执行文件不存在 */
  missing: boolean
  /** 退出码;进程没起来(null)或被信号杀掉时为 null */
  code: number | null
  stdout: string
  stderr: string
}

/** 跑一次 goofish CLI;保留退出码(item get 用 exit 79 区分"商品不存在/已删除") */
export function runCli(args: string[], timeoutMs: number): Promise<CliRun> {
  return new Promise((resolve) => {
    execFile(
      goofishCliPath(),
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, PYTHONUTF8: '1' },
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ missing: false, code: 0, stdout: stdout.toString(), stderr: stderr.toString() })
          return
        }
        const e = err as NodeJS.ErrnoException & { code?: string | number }
        resolve({
          missing: e.code === 'ENOENT',
          code: typeof e.code === 'number' ? e.code : null,
          stdout: stdout.toString(),
          stderr: (stderr || e.message || '').toString(),
        })
      },
    )
  })
}

/** stdout 首选整体 JSON;被日志污染时兜底取最外层 {...} 块(item get 的 loguru 日志会混进 stdout) */
export function extractJsonLoose(text: string): Record<string, unknown> | null {
  const t = text.trim()
  try {
    const v = JSON.parse(t)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    /* fallthrough */
  }
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const v = JSON.parse(t.slice(start, end + 1))
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  return null
}

/** 识别「登录态失效」类错误文本(search 失败 → cookieExpired 映射共用) */
export function looksLikeAuthFailure(text: string): boolean {
  return /登录态失效|请先登录|要求登录|cookies?\s*(可能)?失效|FAIL_SYS_SESSION_EXPIRED|FAIL_SYS_TOKEN_(EXOIRED|EMPTY)|AuthRequiredError/i.test(
    text,
  )
}

export async function getGoofishAuthStatus(force = false): Promise<GoofishAuthStatus> {
  if (!force && statusCache && Date.now() < statusCache.expiresAt) return statusCache.value
  const r = await runCli(['auth', 'status', '--format', 'json'], STATUS_TIMEOUT_MS)
  let value: GoofishAuthStatus
  if (r.missing) {
    value = { available: false, valid: null, error: 'goofish-cli 未安装', checkedAt: Date.now() }
  } else {
    const parsed = extractJsonLoose(r.stdout)
    if (parsed && typeof parsed.valid === 'boolean') {
      value = {
        available: true,
        valid: parsed.valid,
        unb: typeof parsed.unb === 'string' ? parsed.unb : undefined,
        tracknick: typeof parsed.tracknick === 'string' ? parsed.tracknick : undefined,
        nick: typeof parsed.nick === 'string' ? parsed.nick : undefined,
        error: typeof parsed.error === 'string' ? parsed.error : undefined,
        checkedAt: Date.now(),
      }
    } else {
      value = {
        available: true,
        valid: null,
        error: (r.stderr || 'status 输出无法解析').slice(0, 200),
        checkedAt: Date.now(),
      }
    }
  }
  statusCache = { value, expiresAt: Date.now() + STATUS_TTL_MS }
  return value
}

export async function runGoofishLogin(): Promise<GoofishLoginResult> {
  // 修复路径 = 弹窗扫码/账密(见文件头契约注释)。浏览器导入路径已删：Chrome/Edge 127+
  // 应用绑定加密让 browser_cookie3 全灭(实测逐浏览器 RequiresAdminError)。
  const r = await runCli(
    ['auth', 'login', '--qr', '--qr-timeout', '600', '--format', 'json'],
    LOGIN_TIMEOUT_MS,
  )
  if (r.missing) {
    return { ok: false, error: 'goofish-cli 未安装', hint: '本机没有 goofish-cli,无法自动修复。' }
  }
  const parsed = extractJsonLoose(r.stdout)
  if (r.code === 0 && parsed && typeof parsed.source === 'string') {
    statusCache = null // 修复成功,作废缓存,下一次 status 强制真查
    return {
      ok: true,
      source: parsed.source,
      unb: typeof parsed.unb === 'string' ? parsed.unb : undefined,
      tracknick: typeof parsed.tracknick === 'string' ? parsed.tracknick : undefined,
      cookiesCount: typeof parsed.cookies_count === 'number' ? parsed.cookies_count : undefined,
    }
  }
  // 失败:stderr 里是 AuthRequiredError 全文(含 CLI 自带的 4 条兜底方案),取尾部要点
  const brief = (r.stderr || r.stdout)
    .trim()
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('2026-'))
    .slice(-6)
    .join('\n')
    .slice(0, 400)
  return {
    ok: false,
    error: brief || '登录窗口扫码/登录未完成',
    hint:
      '登录窗口（10 分钟有效）可能被其他窗口挡住或超时了。再点一次修复按钮，弹出窗口后用闲鱼 App 扫码、或直接输账号密码均可。',
  }
}
