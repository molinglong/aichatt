import { test } from "node:test"
import assert from "node:assert/strict"
import {
  stackableInfoOf,
  segmentToolCallViews,
  STACK_GROUP_LABELS,
  type StackableToolCallView,
} from "../../src/lib/ai/tool-call-stack"

// 工具卡堆叠分组(方案 A)的守卫规则回归:
// 堆叠只允许"查询型 + 已终态"的卡进组,交互卡与进行中卡必须独立显示——
// 把「批准/拒绝」按钮藏进折叠组里是不可接受的回归,这条测试就是钉死它的。

const view = (
  tool: string,
  state: StackableToolCallView['state'] = 'output-available',
  output: unknown = {},
): StackableToolCallView => ({ tool, state, input: null, output })

test("查询型且已出结果才可堆叠;进行中/参数生成中一律排除", () => {
  assert.ok(stackableInfoOf(view('get_yellow_fish_market')))
  assert.ok(stackableInfoOf(view('get_yellow_fish_live')))
  assert.equal(stackableInfoOf(view('get_yellow_fish_live', 'input-available')), null)
  assert.equal(stackableInfoOf(view('get_yellow_fish_market', 'input-streaming')), null)
})

test("error 终态仍参与堆叠(组行头有警号提示,状态不丢)", () => {
  assert.ok(stackableInfoOf(view('get_yellow_fish_live', 'output-error')))
})

test("交互卡与副作用卡永不进组", () => {
  for (const tool of [
    'ask_clarification', 'local_file', 'generate_mask', 'update_settings',
    'add_memory', 'manage_todo', 'plan_trip', 'write_document', 'write_code',
    'update_provider_model', 'mcp_amap_maps_text_search',
  ]) {
    assert.equal(stackableInfoOf(view(tool)), null, `${tool} 不应可堆叠`)
  }
})

test("web_search 需带来源结果才进组(空结果卡维持自动展开的单卡形态)", () => {
  assert.equal(stackableInfoOf(view('web_search', 'output-available', { results: [] })), null)
  assert.equal(stackableInfoOf(view('web_search', 'output-available', undefined)), null)
  assert.ok(stackableInfoOf(view('web_search', 'output-available', { results: [{ title: 'x' }] })))
})

test("课本检索/目录参与堆叠且归为同一 knowledge 组", () => {
  assert.equal(stackableInfoOf(view('search_knowledge'))?.kind, 'knowledge')
  assert.equal(stackableInfoOf(view('list_knowledge_outline'))?.kind, 'knowledge')
})

test("连续同类合并为一组,标题取类名 + 步数", () => {
  const segs = segmentToolCallViews([
    view('get_yellow_fish_market', 'output-available', { keyword: 'iPhone13' }),
    view('get_yellow_fish_live', 'output-available', { keyword: 'iPhone13 128G' }),
  ])
  assert.equal(segs.length, 1)
  assert.equal(segs[0].type, 'stack')
  const stack = segs[0] as Extract<(typeof segs)[number], { type: 'stack' }>
  assert.equal(stack.kind, 'yellowfish')
  assert.equal(STACK_GROUP_LABELS[stack.kind!] + ` ${stack.views.length} 步`, '查看闲鱼行情 2 步')
  // 组内保持原始顺序
  assert.deepEqual(stack.views.map((v) => v.tool), ['get_yellow_fish_market', 'get_yellow_fish_live'])
})

test("混合组 kind 为 null(调用方退化为「执行了 N 步」)", () => {
  const segs = segmentToolCallViews([
    view('get_yellow_fish_market'),
    view('web_search', 'output-available', { results: [{ title: 'x' }] }),
  ])
  const stack = segs[0] as Extract<(typeof segs)[number], { type: 'stack' }>
  assert.equal(segs.length, 1)
  assert.equal(stack.kind, null)
})

test("不可堆叠卡把连续段切断,各自独立渲染", () => {
  const segs = segmentToolCallViews([
    view('get_yellow_fish_market'),
    view('get_yellow_fish_live'),
    view('local_file'),
    view('search_knowledge'),
    view('list_knowledge_outline'),
  ])
  assert.deepEqual(segs.map((s) => [s.type, s.type === 'stack' ? s.views.length : 1]), [
    ['stack', 2],
    ['standalone', 1],
    ['stack', 2],
  ])
})

test("孤立的可堆叠卡不包壳,退化回 standalone(单卡维持原形态)", () => {
  const segs = segmentToolCallViews([view('local_file'), view('get_yellow_fish_market')])
  assert.equal(segs.length, 2)
  assert.ok(segs.every((s) => s.type === 'standalone'))
})
