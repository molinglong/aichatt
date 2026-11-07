/**
 * 工具卡片堆叠分组:把一条消息里「连续的、已出结果、无需用户操作」的查询型工具卡
 * 合并成一个可折叠的堆叠组(方案 A),避免多次调用竖排一长串独立卡片。
 *
 * 守卫规则:只有查询型且已到终态(success/error)的卡才参与堆叠;
 * 交互卡(澄清/本地文件/面具工坊/模型管理/设置/行程/写作代码文档)与
 * 还在生成参数或执行中的卡一律独立显示——不能把「批准/拒绝」这类按钮藏进折叠里。
 *
 * 工具名字符串与各 *-tool.ts 里的常量保持一致(此处按字面量匹配,避免本模块
 * 被 node 侧测试拉起 React 依赖);改动工具名时同步更新 STACKABLE_TOOL_NAMES。
 */

/** 与 ToolCallCard.ToolCallView 同构的最小视图类型(字段对齐 extractToolCallViews 产出) */
export interface StackableToolCallView {
  tool: string
  toolCallId?: string
  state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error'
  input: unknown
  output: unknown
  errorText?: string
}

/** 堆叠组分类:决定组标题文案与组图标 */
export type ToolStackKind = 'yellowfish' | 'web_search' | 'knowledge'

/** 参与堆叠的查询型工具(闲鱼行情/实时/建监控、联网搜索、查课本/翻目录) */
export const STACKABLE_TOOL_NAMES = [
  'get_yellow_fish_market',
  'get_yellow_fish_live',
  'add_yellow_fish_watch',
  'web_search',
  'search_knowledge',
  'list_knowledge_outline',
] as const

/** 全组同类时的组标题;混合组由调用方退化为「执行了 N 个步骤」 */
export const STACK_GROUP_LABELS: Record<ToolStackKind, string> = {
  yellowfish: '查看闲鱼行情',
  web_search: '联网搜索',
  knowledge: '查询课本知识库',
}

function stackKindOf(tool: string): ToolStackKind | null {
  if (tool === 'get_yellow_fish_market' || tool === 'get_yellow_fish_live' || tool === 'add_yellow_fish_watch') {
    return 'yellowfish'
  }
  if (tool === 'web_search') return 'web_search'
  if (tool === 'search_knowledge' || tool === 'list_knowledge_outline') return 'knowledge'
  return null
}

/** web_search 的结果来源直接内嵌在卡片展开区(无 details 的一行式 ToolRow 收起后无可看内容),不进组 */
function webSearchHasEmbeddedResults(view: StackableToolCallView): boolean {
  const out = view.output as { results?: unknown } | undefined
  return Array.isArray(out?.results) && (out!.results as unknown[]).length > 0
}

/** 该卡是否可参与堆叠;不可(交互卡/进行中/无展开内容的搜索卡)返回 null */
export function stackableInfoOf(view: StackableToolCallView) {
  if (!STACKABLE_TOOL_NAMES.includes(view.tool as (typeof STACKABLE_TOOL_NAMES)[number])) return null
  if (view.state !== 'output-available' && view.state !== 'output-error') return null
  if (view.tool === 'web_search' && !webSearchHasEmbeddedResults(view)) return null
  return { kind: stackKindOf(view.tool) }
}

export type ToolCallSegment =
  | { type: 'standalone'; view: StackableToolCallView }
  | { type: 'stack'; views: StackableToolCallView[]; kind: ToolStackKind | null }

/**
 * 按原始顺序切分渲染段:连续的堆叠卡合并为 stack 段(组内保持原顺序),
 * 其余为 standalone。stack 段内只有 1 个成员时调用方应照常独立渲染(不包壳)。
 */
export function segmentToolCallViews<T extends StackableToolCallView>(views: T[]): ToolCallSegment[] {
  const segments: ToolCallSegment[] = []
  let run: T[] = []
  const flush = () => {
    if (run.length === 1) {
      segments.push({ type: 'standalone', view: run[0] })
    } else if (run.length > 1) {
      const kinds = new Set(run.map((v) => stackKindOf(v.tool)))
      segments.push({
        type: 'stack',
        views: run,
        kind: kinds.size === 1 ? (kinds.values().next().value as ToolStackKind) : null,
      })
    }
    run = []
  }
  for (const v of views) {
    if (stackableInfoOf(v)) run.push(v)
    else {
      flush()
      segments.push({ type: 'standalone', view: v })
    }
  }
  flush()
  return segments
}
