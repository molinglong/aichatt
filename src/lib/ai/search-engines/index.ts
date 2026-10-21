/**
 * 支持的联网搜索引擎配置。
 * 与模型 Key 体系独立，需单独申请。
 */
export const SEARCH_ENGINES = {
  qianfan: {
    id: "qianfan",
    name: "百度千帆",
    description: "百度千帆搜索 API，需单独申请，与模型服务商 Key 无关",
    docsUrl: "https://cloud.baidu.com/doc/QIANFAN/s/3l6bavkfm",
  },
  tavily: {
    id: "tavily",
    name: "Tavily",
    description: "Tavily Search API，支持英文及多语言搜索，免费额度可用",
    docsUrl: "https://docs.tavily.com/documentation/api-reference/endpoint/search",
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    description: "DeepSeek 自研搜索，成功请求才计费（5 元/千次），与模型 Key 同一体系",
    docsUrl: "https://api-docs.deepseek.com/zh-cn/guides/search/",
  },
} as const

export type SearchEngineId = keyof typeof SEARCH_ENGINES
