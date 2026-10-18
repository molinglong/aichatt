/**
 * 百度千帆联网搜索 API（web_search 模式）。
 * 与 src/lib/ai/search.ts 中的同名函数保持同步：被 chat/route.ts 的
 * createWebSearchTool（AI 工具调用）和 /api/search/test（手动测试）共用。
 *
 * 官方文档：https://cloud.baidu.com/doc/qianfan-api/s/Wmbq4z7e5
 */

export interface QianfanSearchResult {
  title: string
  url: string
  snippet: string
}

interface QianfanReference {
  id: number
  title: string
  url: string
  content: string
  date?: string
  type: string
  website?: string
}

interface QianfanRawResponse {
  requestId?: string
  references?: QianfanReference[]
  code?: number
  message?: string
}

/**
 * 调用百度千帆搜索 API。
 * @param query  搜索关键词
 * @param apiKey 千帆 AppBuilder API Key（Bearer Token）
 * @param topN   返回网页结果数量（默认 5）
 * @param siteFilter 站点白名单（平台定向，官方字段 search_filter.match.site）。
 *        空/不传 = 不加过滤。注意 top_k 与站点白名单叠加后，命中数可能少于 topN。
 */
export async function executeQianfanSearch(
  query: string,
  apiKey: string,
  topN: number = 5,
  siteFilter?: string[]
): Promise<QianfanSearchResult[]> {
  const response = await fetch(
    "https://qianfan.baidubce.com/v2/ai_search/web_search",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Appbuilder-Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: query }],
        search_source: "baidu_search_v2",
        resource_type_filter: [{ type: "web", top_k: topN }],
        ...(siteFilter && siteFilter.length > 0
          ? { search_filter: { match: { site: siteFilter } } }
          : {}),
      }),
    }
  )

  if (!response.ok) {
    throw new Error(`百度搜索请求失败 (HTTP ${response.status})`)
  }

  const data: QianfanRawResponse = await response.json()

  if (data.code !== undefined && data.code !== 0) {
    throw new Error(
      `百度搜索 API 错误: ${data.message || "未知错误"} (code: ${data.code})`
    )
  }

  const refs = data.references ?? []

  return refs.map((r) => ({
    title: r.title || "无标题",
    url: r.url || "",
    snippet: r.content || "",
  }))
}
