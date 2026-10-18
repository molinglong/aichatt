/**
 * Tavily 联网搜索 API。
 * 官方文档: https://docs.tavily.com/documentation/api-reference/endpoint/search
 * 接入方式: POST https://api.tavily.com/search, Auth: Bearer tvly-xxxxx
 */

export interface TavilySearchResult {
  title: string
  url: string
  snippet: string
}

/** 顶层 images 数组条目（include_image_descriptions 开启时 description 为英文图注） */
export interface TavilyImageResult {
  url: string
  title?: string
  description?: string
}

interface TavilyRawResponse {
  results?: Array<{
    title: string
    url: string
    content: string
  }>
  images?: Array<{
    url: string
    title?: string
    description?: string
  }>
  detail?: string
}

interface TavilyCallOptions {
  topN: number
  includeDomains?: string[]
  /** 请求配图（include_images + include_image_descriptions）。只有聊天搜索开，
   *  explore/fact-check/search-test 等调用方不需要图，不多花这个字段 */
  withImages?: boolean
}

async function callTavily(
  query: string,
  apiKey: string,
  { topN, includeDomains, withImages }: TavilyCallOptions
): Promise<TavilyRawResponse> {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: Math.min(Math.max(topN, 0), 20),
      search_depth: "basic",
      ...(withImages ? { include_images: true, include_image_descriptions: true } : {}),
      ...(includeDomains && includeDomains.length > 0
        ? { include_domains: includeDomains }
        : {}),
    }),
  })

  if (!response.ok) {
    const status = response.status
    if (status === 401 || status === 403) {
      throw new Error("Tavily API Key 无效或权限不足，请检查 Key 是否正确")
    }
    throw new Error(`Tavily 搜索请求失败 (HTTP ${status})`)
  }

  const data: TavilyRawResponse = await response.json()

  if (data.detail) {
    throw new Error(`Tavily API 错误: ${data.detail}`)
  }
  return data
}

function toSearchResults(data: TavilyRawResponse): TavilySearchResult[] {
  return (data.results ?? []).map((r) => ({
    title: r.title || "无标题",
    url: r.url || "",
    snippet: r.content || "",
  }))
}

/**
 * 调用 Tavily 搜索 API。
 * @param query  搜索关键词
 * @param apiKey Tavily API Key（Bearer Token，格式 tvly-xxx）
 * @param topN   返回结果数量（默认 5，最大 20）
 * @param includeDomains 站点白名单（平台定向）。空/不传 = 全网。
 *        官方字段 include_domains: string[]，对 search_depth / topic 无前置要求。
 *        回退（平台零结果 → 全网重试）刻意不放在这一层：这里只管一次请求怎么发。
 */
export async function executeTavilySearch(
  query: string,
  apiKey: string,
  topN: number = 5,
  includeDomains?: string[]
): Promise<TavilySearchResult[]> {
  return toSearchResults(await callTavily(query, apiKey, { topN, includeDomains }))
}

/**
 * 搜索 + 配图（图文混排专用）：响应顶层 images: {url,title,description}。
 * 图片只在此处请求；白名单过滤/编号在 search.ts（上屏策略层），本层只管取回原文。
 */
export async function executeTavilySearchWithImages(
  query: string,
  apiKey: string,
  topN: number = 5,
  includeDomains?: string[]
): Promise<{ results: TavilySearchResult[]; images: TavilyImageResult[] }> {
  const data = await callTavily(query, apiKey, { topN, includeDomains, withImages: true })
  return {
    results: toSearchResults(data),
    images: (data.images ?? []).filter((i) => !!i.url),
  }
}
