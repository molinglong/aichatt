import { test } from "node:test"
import assert from "node:assert/strict"
import {
  SEARCH_PLATFORMS,
  SEARCH_PLATFORM_IDS,
  UGC_PLATFORMS,
  getSearchPlatform,
  platformDomains,
  toSearchPlatformId,
} from "../../src/lib/ai/search-platforms"
import { createWebSearchTool } from "../../src/lib/ai/search"
import { executeQianfanSearch } from "../../src/lib/ai/search-engines/qianfan"
import { executeTavilySearch } from "../../src/lib/ai/search-engines/tavily"

// 联网搜索「平台定向」第零波契约:
// ① 口径表是唯一域名来源(UI/两引擎共用,改一处不会漏两处)
// ② 用户显式选定 → platform 参数从工具 schema 摘掉(收窄能力面 > 提示词叮嘱)
// ③ 站内零结果必须自动回退全网,且 note 里如实交代来源已变
// 断言全部打在"新行为"上:把 siteFilter 透传删掉、把回退去掉、把 schema 收窄去掉,
// 对应用例一定变红。

type FetchCall = { url: string; body: Record<string, unknown> }

type Behavior = "hit" | "emptyIfFiltered" | "emptyAlways" | "mixedShell" | "allShellIfFiltered"

/** 带过滤请求(站点白名单)与不带过滤请求(全网)的区分靠 body 里是否存在过滤字段 */
function hasSiteFilter(body: Record<string, unknown>): boolean {
  return (
    Array.isArray(body.include_domains) ||
    !!(body.search_filter as { match?: { site?: unknown } } | undefined)?.match?.site
  )
}

/**
 * 装一个假 fetch，命中行为显式参数化：
 * - "hit"                任何请求都命中一条
 * - "emptyIfFiltered"    带站点过滤时空、不带过滤时命中（= 站内无料、全网有料）
 * - "emptyAlways"        一律空（= 真·零结果）
 * - "mixedShell"         命中一条正文 + 一条 Cloudflare 挑战页（= 定向时混进反爬壳）
 * - "allShellIfFiltered" 带过滤时只命中壳页、不带过滤时正常（= 满屏壳页必须回退）
 * 刻意把"什么时候返回空"做成显式参数：上一版用布尔值，"全网请求"被当成"无过滤=命中"，
 * 直接把零结果分支测成了有结果分支。
 * CONTENT 给 720 字：引擎实测站内摘要 550~930 字，太短测不出摘要截断上限。
 */
const LONG_CONTENT = "纳塔版本攻略正文".repeat(120) // 720 字，跨过 700 截断线
const SHELL_TITLE = "Just a moment..."
function itemsFor(behavior: Behavior, filtered: boolean) {
  const hit = { title: "T", url: "https://www.bilibili.com/x", content: LONG_CONTENT }
  const shell = { title: SHELL_TITLE, url: "https://www.bilibili.com/y", content: "Checking browser" }
  switch (behavior) {
    case "emptyAlways":
      return []
    case "emptyIfFiltered":
      return filtered ? [] : [hit]
    case "mixedShell":
      return [hit, shell]
    case "allShellIfFiltered":
      return filtered ? [shell] : [hit]
    default:
      return [hit]
  }
}

function stubFetch(calls: FetchCall[], behavior: Behavior = "hit") {
  const original = globalThis.fetch
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    const opts = init as { method?: string; body?: string }
    const body = JSON.parse(String(opts.body ?? "{}")) as Record<string, unknown>
    calls.push({ url: String(url), body })
    const filtered = hasSiteFilter(body)
    const items = itemsFor(behavior, filtered)
    return {
      ok: true,
      status: 200,
      json: async () => ({ references: items, results: items }),
    }
  }) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

test("口径表: auto/all 无域名,UGC 平台各带白名单", () => {
  assert.equal(platformDomains("auto").length, 0)
  assert.equal(platformDomains("all").length, 0)
  assert.ok(platformDomains("bilibili").includes("bilibili.com"))
  assert.ok(platformDomains("weibo").includes("m.weibo.cn"))
  // auto/all 不进定向白名单,其余全部有域名
  assert.equal(UGC_PLATFORMS.length, SEARCH_PLATFORMS.length - 2)
  for (const p of UGC_PLATFORMS) assert.ok(p.domains.length > 0, `${p.id} 缺域名`)
})

test("外部脏值一律落 auto(默认不干涉模型 = 改造前行为)", () => {
  assert.equal(toSearchPlatformId("zhihu"), "zhihu")
  assert.equal(toSearchPlatformId("all"), "all")
  assert.equal(toSearchPlatformId(undefined), "auto")
  assert.equal(toSearchPlatformId("baidu"), "auto")
  assert.equal(toSearchPlatformId(""), "auto")
  assert.equal(toSearchPlatformId(42), "auto")
  assert.equal(getSearchPlatform("nope" as never).id, "auto")
})

test("id 元组与表同源,且 label 互异(选择器与 zod enum 不会漂移)", () => {
  assert.deepEqual([...SEARCH_PLATFORM_IDS].sort(), SEARCH_PLATFORMS.map((p) => p.id).sort())
  assert.equal(new Set(SEARCH_PLATFORMS.map((p) => p.label)).size, SEARCH_PLATFORMS.length)
})

test("千帆: 传 siteFilter 才出 search_filter.match.site", async () => {
  const calls: FetchCall[] = []
  const restore = stubFetch(calls, "hit")
  try {
    await executeQianfanSearch("q", "k", 5)
    assert.equal(calls[0].body.search_filter, undefined)
    await executeQianfanSearch("q", "k", 5, ["bilibili.com"])
    const filter = calls[1].body.search_filter as { match: { site: string[] } }
    assert.deepEqual(filter.match.site, ["bilibili.com"])
    assert.equal(calls[1].body.search_source, "baidu_search_v2")
  } finally {
    restore()
  }
})

test("Tavily: 传 includeDomains 才出 include_domains", async () => {
  const calls: FetchCall[] = []
  const restore = stubFetch(calls, "hit")
  try {
    await executeTavilySearch("q", "k", 5)
    assert.equal(calls[0].body.include_domains, undefined)
    await executeTavilySearch("q", "k", 5, ["zhihu.com"])
    assert.deepEqual(calls[1].body.include_domains, ["zhihu.com"])
  } finally {
    restore()
  }
})

test("工具默认 auto: schema 暴露可选 platform,不传即全网", async () => {
  const t = createWebSearchTool("qianfan", "k")
  const shape = (t.inputSchema as unknown as { shape: Record<string, unknown> }).shape
  assert.ok(shape.query, "query 参数丢失")
  assert.ok(shape.platform, "auto 口径下必须让模型能传 platform")
  const calls: FetchCall[] = []
  const restore = stubFetch(calls, "hit")
  try {
    const out = await runExecute(t, { query: "q" })
    assert.equal(out.platform, "all")
    assert.equal(hasSiteFilter(calls[0].body), false)
  } finally {
    restore()
  }
})

test("用户强制平台: platform 参数从 schema 摘掉,且模型乱传也不生效", async () => {
  const t = createWebSearchTool("qianfan", "k", "zhihu")
  const shape = (t.inputSchema as unknown as { shape: Record<string, unknown> }).shape
  assert.equal(shape.platform, undefined, "用户已定口径时不该再给模型 platform 参数")
  const calls: FetchCall[] = []
  const restore = stubFetch(calls, "hit")
  try {
    const out = await runExecute(t, { query: "q", platform: "weibo" })
    assert.equal(out.platform, "zhihu")
    assert.deepEqual(
      (calls[0].body.search_filter as { match: { site: string[] } }).match.site,
      ["zhihu.com", "www.zhihu.com", "zhuanlan.zhihu.com"]
    )
  } finally {
    restore()
  }
})

test("站内零结果自动回退全网,note 如实交代来源已变", async () => {
  const t = createWebSearchTool("qianfan", "k", "bilibili")
  const calls: FetchCall[] = []
  const restore = stubFetch(calls, "emptyIfFiltered")
  try {
    const out = await runExecute(t, { query: "q" })
    assert.equal(calls.length, 2, "应恰好重试一次")
    assert.equal(hasSiteFilter(calls[0].body), true, "第一次必须带站点过滤")
    assert.equal(hasSiteFilter(calls[1].body), false, "回退必须撤掉过滤")
    assert.equal(out.fellBack, true)
    assert.equal(out.results.length, 1)
    assert.match(out.note, /已自动回退全网/)
    assert.match(out.note, /并非「B站」站内内容/)
  } finally {
    restore()
  }
})

test("全网零结果不重试,note 走原兜底文案", async () => {
  const t = createWebSearchTool("tavily", "k", "all")
  const calls: FetchCall[] = []
  const restore = stubFetch(calls, "emptyAlways")
  try {
    const out = await runExecute(t, { query: "q" })
    assert.equal(calls.length, 1, "无过滤时零结果不该白烧第二次请求")
    assert.equal(out.fellBack, undefined)
    assert.equal(out.platform, "all")
    assert.match(out.note, /未找到相关结果/)
  } finally {
    restore()
  }
})

test("同一 query 重复调用:回放上次结果,不再打上游", async () => {
  const t = createWebSearchTool("qianfan", "k", "all")
  const calls: FetchCall[] = []
  const restore = stubFetch(calls, "hit")
  try {
    const first = await runExecute(t, { query: "广西 河池 社保" })
    // 空白差异（首尾空格 / 连续空格）视为同一条查询
    const second = await runExecute(t, { query: "  广西   河池 社保 " })
    assert.equal(calls.length, 1, "重复 query 不该再发上游请求")
    assert.equal(second.results.length, first.results.length)
    assert.match(second.note, /已经搜过/)
  } finally {
    restore()
  }
})

test("命中站内结果时 note 声明已限定平台", async () => {
  const t = createWebSearchTool("qianfan", "k", "tieba")
  const calls: FetchCall[] = []
  const restore = stubFetch(calls, "hit")
  try {
    const out = await runExecute(t, { query: "q" })
    assert.equal(calls.length, 1)
    assert.match(out.note, /已限定平台「贴吧」/)
  } finally {
    restore()
  }
})

/** 直接调 AI SDK tool 的 execute（第二参数 v7 未用到，给空壳即可） */
async function runExecute(
  t: ReturnType<typeof createWebSearchTool>,
  input: Record<string, unknown>
): Promise<{
  platform: string
  note: string
  results: { title: string; url?: string; snippet?: string }[]
  fellBack?: boolean
}> {
  const exec = t.execute as unknown as (i: unknown, o: unknown) => Promise<never>
  return await exec(input, { abortSignal: undefined, messages: [] })
}

test("米游社档位: 白名单齐备 + 强制生效 + note 如实声明", async () => {
  assert.ok(platformDomains("miyoushe").includes("miyoushe.com"), "米游社缺域名白名单")
  assert.equal(toSearchPlatformId("miyoushe"), "miyoushe")
  const t = createWebSearchTool("qianfan", "k", "miyoushe")
  const calls: FetchCall[] = []
  const restore = stubFetch(calls, "hit")
  try {
    const out = await runExecute(t, { query: "原神 配队" })
    assert.deepEqual(
      (calls[0].body.search_filter as { match: { site: string[] } }).match.site,
      ["miyoushe.com", "www.miyoushe.com", "bbs.miyoushe.com"]
    )
    assert.match(out.note, /已限定平台「米游社」/)
  } finally {
    restore()
  }
})

test("平台定向请求 8 条、全网仍 5 条(Tavily max_results)", async () => {
  const calls: FetchCall[] = []
  const restore = stubFetch(calls, "hit")
  try {
    await runExecute(createWebSearchTool("tavily", "k", "zhihu"), { query: "q" })
    await runExecute(createWebSearchTool("tavily", "k", "all"), { query: "q2" })
    assert.equal(calls[0].body.max_results, 8, "定向应放到 8 条")
    assert.equal(calls[1].body.max_results, 5, "全网保持 5 条")
  } finally {
    restore()
  }
})

test("摘要上限 700 字:引擎给的长摘要不再被砍成碎片", async () => {
  const calls: FetchCall[] = []
  const restore = stubFetch(calls, "hit")
  try {
    const out = await runExecute(createWebSearchTool("tavily", "k", "all"), { query: "q" })
    assert.equal(out.results.length, 1)
    assert.equal(out.results[0].snippet?.length, 700)
  } finally {
    restore()
  }
})

test("反爬壳页剔除并在 note 交代;满屏壳页视为站内无料、触发全网回退", async () => {
  const calls: FetchCall[] = []
  const restore = stubFetch(calls, "mixedShell")
  try {
    const out = await runExecute(createWebSearchTool("qianfan", "k", "bilibili"), { query: "q" })
    assert.equal(out.results.length, 1, "Just a moment... 那条不该进结果")
    assert.equal(out.results[0].title, "T")
    assert.match(out.note, /反爬\/空壳页/)
  } finally {
    restore()
  }

  const calls2: FetchCall[] = []
  const restore2 = stubFetch(calls2, "allShellIfFiltered")
  try {
    const out2 = await runExecute(createWebSearchTool("qianfan", "k", "douyin"), { query: "q" })
    assert.equal(calls2.length, 2, "站内全是壳页时应恰好回退一次")
    assert.equal(out2.fellBack, true)
    assert.match(out2.note, /已自动回退全网/)
  } finally {
    restore2()
  }
})
