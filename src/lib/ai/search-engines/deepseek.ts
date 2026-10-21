/**
 * DeepSeek 联网搜索 API（自研搜索引擎）。
 * 官方文档：https://api-docs.deepseek.com/zh-cn/guides/search/
 *
 * 与千帆/Tavily 的三处关键差异（2026-10-19 文档核实）：
 * - 站点定向只有 query 语法 `site:` / `-site:`，**没有**域名数组字段；
 * - query 限 128 个 Unicode 字符（语法算在内），所以平台白名单必须收敛；
 * - 计费只认成功请求：results 非空才收费，空结果 / 失败 / 超时不计费。
 *
 * 返回里 summary（600-800 字）比 snippet（100-200 字）信息量大得多，直接给模型
 * 读；search.ts 统一截 300 字上屏，长度仍优于另两家的短摘要。
 */

const DEEPSEEK_SEARCH_ENDPOINT = "https://api.deepseek.com/v1/tools/search"

/** query 字段官方上限（含 site: 语法） */
const QUERY_MAX_CHARS = 128

export interface DeepseekSearchResult {
  title: string
  url: string
  snippet: string
}

interface DeepseekRawItem {
  rerank_score?: number
  title?: string
  url?: string
  snippet?: string
  summary?: string
  content?: string
  site_name?: string | null
  date?: string | null
  authority?: number
}

interface DeepseekRawResponse {
  results?: DeepseekRawItem[]
  error?: { message?: string; type?: string; code?: string }
}

/**
 * 把平台白名单收敛成 `site:` 语法。
 *
 * search-platforms.ts 的数组约定「主域在前」，这里只取第一个：多域名 OR 拼接
 * 必然撞 128 字符上限（B站 4 个域名光拼语法就接近 100 字符）。裸域能否覆盖
 * 子域官方未明示，由实测兜底；命中不了会走 search.ts 的「零结果回退全网」。
 */
function withSiteFilter(query: string, siteFilter?: string[]): string {
  const host = siteFilter?.[0]
  if (!host) return query.slice(0, QUERY_MAX_CHARS)
  const suffix = ` site:${host}`
  const budget = QUERY_MAX_CHARS - suffix.length
  if (budget <= 0) return `site:${host}`.slice(0, QUERY_MAX_CHARS)
  return `${query.slice(0, budget).trimEnd()}${suffix}`
}

/**
 * 调用 DeepSeek 搜索 API。
 * @param query      搜索关键词
 * @param apiKey     DeepSeek API Key（Bearer，与模型 Key 同一体系）
 * @param topN       返回条数（官方 1~50，按次计费与条数无关）
 * @param siteFilter 站点白名单（平台定向）。空/不传 = 全网。
 *                   只取数组首个主域拼 site:，见 withSiteFilter 注释。
 */
export async function executeDeepseekSearch(
  query: string,
  apiKey: string,
  topN: number = 5,
  siteFilter?: string[]
): Promise<DeepseekSearchResult[]> {
  const response = await fetch(DEEPSEEK_SEARCH_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query: withSiteFilter(query, siteFilter),
      count: Math.min(Math.max(topN, 1), 50),
    }),
  })

  const data: DeepseekRawResponse | null = await response.json().catch(() => null)

  if (!response.ok) {
    const detail = data?.error?.message
    if (response.status === 401) {
      throw new Error("DeepSeek API Key 无效，请检查 Key 是否正确")
    }
    if (response.status === 402) {
      throw new Error("DeepSeek 账户余额不足，请充值后重试")
    }
    if (response.status === 429) {
      throw new Error("DeepSeek 搜索触发限速（5 QPS），请稍后重试")
    }
    throw new Error(
      `DeepSeek 搜索请求失败 (HTTP ${response.status}${detail ? `: ${detail}` : ""})`
    )
  }

  return (data?.results ?? [])
    .filter((r) => !!r.url)
    .map((r) => ({
      title: r.title || "无标题",
      url: r.url || "",
      snippet: r.summary || r.snippet || r.content || "",
    }))
}
