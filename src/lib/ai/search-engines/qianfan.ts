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

/** 千帆图片资源（references 中 type==='image' 的条目） */
export interface QianfanImageResult {
  url: string
  /** 搜索结果自带的标题（中文，可直接作内联图注） */
  title?: string
}

interface QianfanReference {
  id: number
  title: string
  url: string
  content: string
  date?: string
  type: string
  website?: string
  image?: { url?: string }
}

interface QianfanRawResponse {
  requestId?: string
  references?: QianfanReference[]
  code?: number
  message?: string
}

/** 图文混排候选图数量：白名单会再截前 6 探体积、最终上屏最多 3 张 */
const IMG_CANDIDATE_K = 8

/**
 * 调用千帆搜索 API 并取回原始 references。
 * withImages 时同请求加 image 资源类型（一次调用拿网页+图片，不多花一次请求）。
 */
async function callQianfan(
  query: string,
  apiKey: string,
  options: { topN: number; siteFilter?: string[]; withImages: boolean }
): Promise<QianfanReference[]> {
  const { topN, siteFilter, withImages } = options
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
        resource_type_filter: [
          { type: "web", top_k: topN },
          ...(withImages ? [{ type: "image", top_k: IMG_CANDIDATE_K }] : []),
        ],
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

  return data.references ?? []
}

function toSearchResult(r: QianfanReference): QianfanSearchResult {
  return {
    title: r.title || "无标题",
    url: r.url || "",
    snippet: r.content || "",
  }
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
  const refs = await callQianfan(query, apiKey, { topN, siteFilter, withImages: false })
  return refs.map(toSearchResult)
}

/**
 * 网页 + 图片一次取回（图文混排用）。
 * 图片 URL 多为 http:// 直链，协议改写与白名单过滤统一在 search.ts 的
 * selectEmbeddableImages 里做（本项目内所有图源走同一条质量门）。
 */
export async function executeQianfanSearchWithImages(
  query: string,
  apiKey: string,
  topN: number = 5,
  siteFilter?: string[]
): Promise<{ results: QianfanSearchResult[]; images: QianfanImageResult[] }> {
  const refs = await callQianfan(query, apiKey, { topN, siteFilter, withImages: true })
  const results = refs.filter((r) => r.type !== "image").map(toSearchResult)
  const images = refs
    .filter((r) => r.type === "image")
    .map((r) => ({ url: r.image?.url || r.url || "", ...(r.title ? { title: r.title } : {}) }))
    .filter((i) => !!i.url)
  return { results, images }
}
