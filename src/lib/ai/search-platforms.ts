/**
 * 联网搜索「平台定向」映射表（第零波）。
 *
 * 定案背景（2026-10-06）：影响体感的是「能不能只查 B站/小红书这类 UGC 站」，
 * 而不是「搜得更深」。本表是唯一的域名口径来源，前端选择器与服务端分流共用，
 * 避免同一份清单在 UI 与两个引擎里各写一遍（改一处漏两处的经典熵增）。
 *
 * 两引擎的过滤能力（官方文档已核实）：
 * - Tavily：`include_domains: string[]`（无 search_depth / topic 前置要求）
 *   https://docs.tavily.com/documentation/api-reference/endpoint/search
 * - 百度千帆 baidu_search_v2：`search_filter.match.site: string[]` 白名单
 *   （另有 block_websites 黑名单，本波不用）
 *   https://cloud.baidu.com/doc/qianfan-api/s/Wmbq4z7e5
 *
 * 三态口径（务必分清，别当成两态）：
 * - 'auto' 自动：不干涉模型，模型可按 query 自行传 platform（默认值，行为与改造前一致）
 * - 'all'  全网：强制不加平台过滤，且提示词告知模型别再传 platform
 * - 具体平台 id：强制按本表 domains 过滤，模型传什么都以用户选择为准
 *
 * 纯数据、零依赖，client/server 通用。
 *
 * 2026-10-10 真实 Key 实测（千帆 + Tavily 各跑站内白名单，结论按引擎分列）：
 * - 千帆：B站/知乎/抖音/微博 均 5/5 命中站内；**小红书 0 命中**（该引擎对 xiaohongshu
 *   站内索引缺失，正好由 execute 层的全网回退接住）。
 * - Tavily：B站/知乎/抖音/微博 5/5 命中站内；小红书虽有 5 条，但落在
 *   beian./openaccount./fevh5app. 这类备案与开放平台子域，不是笔记正文——
 *   「定向小红书找笔记」在两引擎上目前都拿不到理想结果，别当卖点。
 */

export type SearchPlatformId =
  | 'auto'
  | 'all'
  | 'bilibili'
  | 'xiaohongshu'
  | 'zhihu'
  | 'douyin'
  | 'weibo'
  | 'tieba'
  | 'douban'

export interface SearchPlatformDef {
  id: SearchPlatformId
  /** 选择器与提示词里显示的名称 */
  label: string
  /**
   * 站点白名单。同时列裸域与常见子域：两家引擎对「裸域是否覆盖子域」的口径
   * 未获官方明示，宁可各写一遍——多写子域只会更准，不会漏。
   */
  domains: string[]
  /** 给模型的场景提示：什么内容在这个站上 */
  tip: string
}

export const SEARCH_PLATFORMS: readonly SearchPlatformDef[] = [
  {
    id: 'auto',
    label: '自动',
    domains: [],
    tip: '由模型按问题自行判断是否需要限定平台',
  },
  {
    id: 'all',
    label: '全网',
    domains: [],
    tip: '不限定站点，返回全网网页摘要',
  },
  {
    id: 'bilibili',
    label: 'B站',
    domains: ['bilibili.com', 'www.bilibili.com', 'm.bilibili.com', 'space.bilibili.com'],
    tip: 'B 站的视频简介、UP 主专栏、评论区话题',
  },
  {
    id: 'xiaohongshu',
    label: '小红书',
    domains: ['xiaohongshu.com', 'www.xiaohongshu.com', 'xhslink.com'],
    tip: '小红书笔记与经验分享贴（该站对外索引稀薄，站内常查不到，会自动回退全网）',
  },
  {
    id: 'zhihu',
    label: '知乎',
    domains: ['zhihu.com', 'www.zhihu.com', 'zhuanlan.zhihu.com'],
    tip: '知乎问答与专栏长文',
  },
  {
    id: 'douyin',
    label: '抖音',
    domains: ['douyin.com', 'www.douyin.com'],
    tip: '抖音的视频页与话题页',
  },
  {
    id: 'weibo',
    label: '微博',
    domains: ['weibo.com', 's.weibo.com', 'm.weibo.cn'],
    tip: '微博正文、话题与热搜',
  },
  {
    id: 'tieba',
    label: '贴吧',
    domains: ['tieba.baidu.com'],
    tip: '百度贴吧的帖子与楼中楼讨论',
  },
  {
    id: 'douban',
    label: '豆瓣',
    domains: ['douban.com', 'movie.douban.com', 'book.douban.com'],
    tip: '豆瓣的影视/图书条目、影评与小组',
  },
]

/** 供 zod enum 用的 id 元组（顺序即选择器展示顺序） */
export const SEARCH_PLATFORM_IDS = SEARCH_PLATFORMS.map((p) => p.id) as [
  SearchPlatformId,
  ...SearchPlatformId[],
]

const BY_ID = new Map<SearchPlatformId, SearchPlatformDef>(
  SEARCH_PLATFORMS.map((p) => [p.id, p]),
)

/** 外部输入（请求体 / localStorage）→ 合法平台 id，非法值一律落 'auto' */
export function toSearchPlatformId(value: unknown): SearchPlatformId {
  return typeof value === 'string' && BY_ID.has(value as SearchPlatformId)
    ? (value as SearchPlatformId)
    : 'auto'
}

export function getSearchPlatform(id: SearchPlatformId): SearchPlatformDef {
  return BY_ID.get(id) ?? BY_ID.get('auto')!
}

/** 该选择是否产生站点白名单：'auto' 与 'all' 都不加过滤 */
export function platformDomains(id: SearchPlatformId): string[] {
  return id === 'auto' || id === 'all' ? [] : getSearchPlatform(id).domains
}

/** 具体平台（用户可强制定向的那些），供选择器与提示词列举 */
export const UGC_PLATFORMS: readonly SearchPlatformDef[] = SEARCH_PLATFORMS.filter(
  (p) => p.id !== 'auto' && p.id !== 'all',
)
