/**
 * TanStack Query 中央化 query keys + 常用 staleTime 预设。
 *
 * 集中管理的目的:
 * 1) 避免散落在各页面里的字符串拼写不一致导致缓存失效(bug 难查)
 * 2) 改 key 形式时一处改、全部生效
 * 3) 配合 invalidate / setQueryData 时,可以做到精细控制——例如
 *    拉单条会话后,只让列表里的这一条 refetch,而不是整个列表
 *
 * 这个文件被 .client.ts / .server.ts 双向引用,因此保持纯 ES module,
 * 不加 'use client' 指令——具体 provider 放在 QueryProvider.tsx 里。
 */

/** 生图历史列表分页大小:生图页与 TopBar 预热共用,保证 query key 一致 */
export const IMAGES_PAGE_SIZE = 24

export const STALE = {
  /** 模型/服务商列表:变化不频繁,缓存 5 分钟 */
  providers: 5 * 60 * 1000,
  /** 自定义模型:同 providers */
  customModels: 5 * 60 * 1000,
  /** 会话详情:用户当前会话的"新鲜度",切回时立刻显示,后台静默刷新 */
  conversation: 10 * 1000,
  /** 会话列表 */
  conversationList: 30 * 1000,
  /** 生图列表 */
  images: 60 * 1000,
  /** 图片设置 */
  imageSettings: 5 * 60 * 1000,
  /** 自定义面具列表 */
  masks: 30 * 1000,
} as const

export const queryKeys = {
  all: ['app'] as const,

  providers: () => [...queryKeys.all, 'providers'] as const,
  customModels: () => [...queryKeys.all, 'customModels'] as const,
  /**
   * 服务商模型管理（覆盖记录 + 内置目录，GET /api/provider-models）。
   * 不复用 providers 键：那个键在不同页面挂了不同形态的数据（扁平模型数组），
   * 结构不一致会互相污染缓存。
   */
  providerModels: () => [...queryKeys.all, 'providerModels'] as const,

  conversations: {
    list: (limit: number, offset: number) =>
      [...queryKeys.all, 'conversations', 'list', { limit, offset }] as const,
    detail: (id: string) =>
      [...queryKeys.all, 'conversations', 'detail', id] as const,
    messages: (id: string, limit: number) =>
      [...queryKeys.all, 'conversations', id, 'messages', { limit }] as const,
  },

  explore: {
    topics: () => [...queryKeys.all, 'explore', 'topics'] as const,
  },
  masks: {
    list: () => [...queryKeys.all, 'masks', 'list'] as const,
    /** 面具面板已下载的内置面具 id 列表 */
    installed: () => [...queryKeys.all, 'masks', 'installed'] as const,
    /** 各面具的对话使用数(搜索筛选折叠排序用) */
    usage: () => [...queryKeys.all, 'masks', 'usage'] as const,
  },
  images: {
    list: (limit: number, offset: number) =>
      [...queryKeys.all, 'images', 'list', { limit, offset }] as const,
    settings: () => [...queryKeys.all, 'image-settings'] as const,
  },
  search: {
    keys: () => [...queryKeys.all, 'search', 'keys'] as const,
  },
  mcp: {
    /** 用户配置的 MCP server 列表(设置页与聊天输入框开关共享缓存) */
    servers: () => [...queryKeys.all, 'mcp', 'servers'] as const,
    /** 各 server 工具清单(输入框下拉菜单用,连接拉取,短缓存) */
    tools: () => [...queryKeys.all, 'mcp', 'tools'] as const,
  },
  write: {
    /** 写作文档列表(/write 左栏);编辑器保存后用 setQueryData 局部回写 */
    list: () => [...queryKeys.all, 'write', 'list'] as const,
    /** 写作作品列表(设定集左栏作品选择器) */
    works: () => [...queryKeys.all, 'write', 'works'] as const,
    /** 单个作品的设定条目列表(按 workId 分键,切换作品互不污染) */
    settings: (workId: string) => [...queryKeys.all, 'write', 'settings', workId] as const,
  },
  code: {
    /** 当前会话的代码文档列表(代码编辑器面板左栏);编辑器保存后用 setQueryData 局部回写。
     *  conversationId=null(新对话未落库)时仅作 key 占位,查询 enabled=false 不发请求。 */
    list: (conversationId: string | null) =>
      [...queryKeys.all, 'code', 'list', { conversationId }] as const,
  },
} as const

export type QueryKeyOf<T extends readonly unknown[]> = T
