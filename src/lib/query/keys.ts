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
  kb: {
    /** 可翻原文的课本列表(/kb 书架;/study 入口文案用) */
    docs: () => [...queryKeys.all, 'kb', 'docs'] as const,
    /** 单本课本详情(阅读器) */
    doc: (docId: string) => [...queryKeys.all, 'kb', 'doc', docId] as const,
  },
  papers: {
    /** 整卷元数据 + 题号→页码定位(/papers/[slug] 原卷预览页) */
    meta: (slug: string) => [...queryKeys.all, 'papers', 'meta', slug] as const,
    /** 单页原件 html(PaperPage 片段) */
    page: (slug: string, pageNo: number) => [...queryKeys.all, 'papers', 'page', slug, pageNo] as const,
    /** 拟卷完整数据(槽位+原题引用,编辑/换题/移除后整包刷新) */
    composed: (id: string) => [...queryKeys.all, 'papers', 'composed', id] as const,
    /** 本用户拟卷列表(学习台拟卷区块 + /papers/composed 列表页共用) */
    composedList: () => [...queryKeys.all, 'papers', 'composed-list'] as const,
    /** 可读卷库列表(学校考试记录卡的关联卷选择器;/study 页面级拉取) */
    list: () => [...queryKeys.all, 'papers', 'list'] as const,
    /** 单卷逐题投影(题号/大题/分值/考点;勾错题板) */
    questions: (slug: string) => [...queryKeys.all, 'papers', 'questions', slug] as const,
    /** PDF 录题作业(审核台;候选清单状态翻转换视图) */
    pdfImport: (id: string) => [...queryKeys.all, 'papers', 'pdf-import', id] as const,
    /** 在线做题考试场(考试页 + 交卷后报告页共用同一 query,状态翻转换视图) */
    attempt: (id: string) => [...queryKeys.all, 'papers', 'attempt', id] as const,
    /** 卷详情页入口状态(进行中考试 + 最近估分概要) */
    attemptEntry: (slug: string) => [...queryKeys.all, 'papers', 'attempt-entry', slug] as const,
  },
  examRecords: {
    /** 本用户全部成绩(学习台「学校考试」区块 + 全部成绩弹层共用) */
    list: () => [...queryKeys.all, 'exam-records', 'list'] as const,
    /** 单卷历次成绩(附考点丢分;试卷页历史卡,按 slug 键) */
    byPaper: (slug: string) => [...queryKeys.all, 'exam-records', 'paper', slug] as const,
    /** 成绩分析聚合(分析弹层 + 组卷针对我复习第二信号源共用) */
    analysis: () => [...queryKeys.all, 'exam-records', 'analysis'] as const,
    /** AI 成绩报告列表(落库回看) */
    reports: () => [...queryKeys.all, 'exam-records', 'reports'] as const,
  },
  study: {
    /** 打印足迹聚合(拟卷页足迹卡;今日口径与今晚测验同源=客户端本地零点 since) */
    printSummary: () => [...queryKeys.all, 'study', 'print-summary'] as const,
  },
  yellowFish: {
    /** 商品收藏列表(实时价卡片星标 + 设置节收藏池共享同一份缓存) */
    favorites: () => [...queryKeys.all, 'yellowFish', 'favorites'] as const,
  },
} as const

export type QueryKeyOf<T extends readonly unknown[]> = T
