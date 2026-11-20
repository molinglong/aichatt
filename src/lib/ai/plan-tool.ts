import { z } from "zod"

/**
 * 今日计划工具（manage_plan）—— 纯常量模块（isomorphic，客户端可安全 import）
 *
 * 与 manage_todo 同协议：纯 DB 数据，服务端 execute 直接写库（见 plan-tool.server.ts），
 * 前端 ToolCallCard 只负责渲染，无执行器参与。
 *
 * ⚠ 本文件禁止 import prisma/ai 等服务端依赖（ToolCallCard 只需要
 * PLAN_TOOL_NAME，混入会把 pg 打进客户端 bundle 报 fs 错误）。
 *
 * 与 manage_todo 的边界（PROMPT 里同样写明）：
 * - manage_todo = 长期待办存档（Todo 表，无时间轴概念）
 * - manage_plan = 今天的时间轴计划（PlanItem 表：记入/排程/改时间/勾完成）+ 备忘录（PlanMemo）
 * plan 应用并入后，「今天做什么」的动线一律走 manage_plan。
 *
 * 完成/移动/删除按标题模糊匹配（双向 includes，manage_todo 同款）：
 * 命中多条返回 candidates 交由模型向用户澄清，绝不擅自选择。
 *
 * 注入条件：!isGameMask && !isEphemeral && !groupId（与 vault 同档：临时区/群聊/游戏回合不注入）。
 */

export const PLAN_TOOL_NAME = "manage_plan"

export const PLAN_OPERATIONS = [
  "today",
  "add",
  "complete",
  "move",
  "delete",
  "schedule",
  "memo_save",
  "memo_search",
] as const

const HHMM = /^\d{1,2}:\d{2}$/

export const planInputSchema = z.object({
  operation: z.enum(PLAN_OPERATIONS).describe(
    "today=查看今天的时间计划和待安排 add=记入(带时间直接落进时间轴,不带进待安排) complete=勾完成 " +
      "move=改时间或顺延到明天 delete=删除 schedule=触发AI排今天(把待安排排进空档) " +
      "memo_save=存备忘录(长期记住的话) memo_search=搜备忘录"
  ),
  items: z
    .array(
      z.object({
        title: z.string().min(1).max(100).describe("事项名,简洁明确,如「物理作业 电磁感应」"),
        kind: z.enum(["task", "event"]).default("task").describe("task=任务(要预留时间做) event=固定安排(如上课/就诊,时间铁定不动)"),
        estimateMin: z.number().int().min(5).max(480).optional().describe("预估分钟,默认 30;add 不带时间时它决定排程时长"),
        priority: z.number().int().min(0).max(2).optional().describe("0 普通 1 重要 2 重要且紧急,默认 1"),
        startMin: z
          .string()
          .regex(HHMM)
          .optional()
          .describe("开始时间 HH:MM(如 15:00);写了就立即落进今天时间轴"),
        endMin: z.string().regex(HHMM).optional().describe("结束时间 HH:MM;不写则按预估时长推算"),
      })
    )
    .max(5)
    .optional()
    .describe("add 必填:1-5 条;用户一句话要记多件事时拆成多条"),
  match: z.string().max(60).optional().describe("complete/move/delete 用:标题关键词,如「物理作业」"),
  startMin: z.string().regex(HHMM).optional().describe("move 用:新开始时间 HH:MM;保持原时长"),
  postpone: z.boolean().optional().describe("move 用:true=顺延到明天(回待安排,连续顺延会被复盘点名)"),
  memoContent: z.string().min(1).max(20000).optional().describe("memo_save 必填:要长期记住的话"),
  memoTitle: z.string().max(100).optional().describe("memo_save 可选:标题,不填回退正文首行"),
  memoQuery: z.string().max(200).optional().describe("memo_search:关键词,不传返回最近 10 条"),
})

export type PlanToolInput = z.infer<typeof planInputSchema>

export interface PlanToolBlock {
  id: string
  title: string
  /** 当日分钟数;展示层转 HH:MM */
  startMin: number
  endMin: number
  kind: string
  done: boolean
  priority: number
  reason?: string
}

export interface PlanToolInboxItem {
  id: string
  title: string
  estimateMin: number
  priority: number
}

export interface PlanToolAddedItem {
  title: string
  status: "planned" | "inbox"
  time?: string
}

export interface PlanToolMemo {
  id: string
  title: string
  content: string
  pinned: boolean
  updatedAt: string
}

export interface PlanToolOutput {
  ok: boolean
  operation: (typeof PLAN_OPERATIONS)[number]
  date?: string
  /** today / schedule:当天时间块(按开始时间升序) */
  blocks?: PlanToolBlock[]
  /** today / schedule / add / move(postpone):当前待安排 */
  inbox?: PlanToolInboxItem[]
  added?: PlanToolAddedItem[]
  completed?: string[]
  moved?: string[]
  deleted?: string[]
  /** schedule 结果 */
  scheduled?: { added: number; source: "ai" | "local"; note?: string }
  memo?: PlanToolMemo
  memos?: PlanToolMemo[]
  /** 模糊匹配命中多条:交由模型向用户澄清 */
  candidates?: string[]
  message?: string
  error?: string
}

export const PLAN_TOOL_PROMPT = `【今日计划】你已接入 manage_plan 工具,可直接读写用户的「今日计划」(时间轴 + 待安排)和备忘录。
- 触发:用户问「今天有什么安排」「帮我排一下今天」「记一下 3 点开会」「背单词写完了」「把物理作业挪到 4 点」「这事儿顺延到明天」「记一条备忘:买灯泡」「我之前记过什么备忘」时调用
- 边界:今天的安排/时间调整用本工具;长期待办存档(无时间概念)用 manage_todo;两者都合适时优先 manage_plan(有排程能力)
- add:写了 startMin(HH:MM)立即落进时间轴;没写进待安排等排程;一句话多件事拆多条
- complete/move/delete 按标题关键词模糊匹配,命中多条会返回 candidates,必须向用户确认后再操作,绝不擅自选
- schedule:AI 排程会把待安排按优先级/精力塞进今天空档(只排 70% 留缓冲);排完用 blocks 汇报每块的时间与理由
- 纪律:汇报时间块时给出 HH:MM;blocks 为空就如实说今天还是空的,建议用户在弹窗里记两件小事;绝不编造用户没说的事项`
