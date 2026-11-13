/**
 * 卷面 AI 助手(POST /api/papers/composed/[id]/assistant):
 * 自然语言下达卷面修改意图。两种模式(请求 body.autoExecute 决定):
 * - true(自动执行):挂 exec_op(带 execute,服务端直接调 compose 引擎真执行),
 *   AI 说改就改,连续多步批量修改,每步执行结果回流模型上下文;前端凭工具输出刷新卷面。
 * - false(手动):挂 propose_op(无 execute),只生成操作卡,用户点「执行」才走既有 PATCH。
 * 口径红线(两模式同守):助手不生成/不改写题目内容,一切修改只从真题池选真操作;
 * 卷面「全部题目与答案出自原卷」;AI 参考答案题入池必须经用户明确同意(set_allow_ai)。
 * 流协议 = UIMessage(useChat 直连);模型解析/公共额度闸与 chat 管线同口径(resolveChatModel)。
 */
import { NextRequest } from "next/server"
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
  tool,
  type UIMessage,
} from "ai"
import { z } from "zod"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"
import {
  listCandidates,
  loadPoolStats,
  replaceSlot,
  removeSlot,
  insertSlot,
  retitlePaper,
  retitleSection,
  updateSlotScore,
  moveSlot,
  updateDuration,
  setAllowAi,
} from "@/lib/papers/compose"
import { resolveChatModel } from "@/lib/ai/model-resolver.server"
import { createKnowledgeTool, hasKnowledgeChunks } from "@/lib/ai/knowledge-tool-server"
import { KNOWLEDGE_TOOL_NAME } from "@/lib/ai/knowledge-tool"
import { createPaperSearchTool, hasPaperQuestions } from "@/lib/ai/paper-tool-server"
import { PAPER_SEARCH_TOOL_NAME } from "@/lib/ai/paper-tool"
import { createStudyNotesTool, STUDY_NOTES_TOOL_NAME } from "@/lib/ai/study-notes-tool.server"
import { createWebSearchTool } from "@/lib/ai/search"
import type { SearchEngineId } from "@/lib/ai/search-engines"
import { decrypt } from "@/lib/crypto"
import { monitor } from "@/lib/monitor"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ id: string }> }

/** 工具轮预算:批量修改(读卷→搜候选→连续多步 exec_op)需要余量,防失控循环 */
const TOOL_STEP_BUDGET = 16

/** 同卷 exec_op 串行锁:AI SDK 可能并发执行同一轮的多个工具调用,
 *  乱序会让重算总分/回执摘要读陈旧状态(实测 rescore 未写回时 retitle 的 brief 已读到旧值) */
const execLocks = new Map<string, Promise<unknown>>()
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = execLocks.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  execLocks.set(key, next)
  void next.catch(() => {}).finally(() => {
    if (execLocks.get(key) === next) execLocks.delete(key)
  })
  return next
}

/** 网络搜索引擎偏好序:取用户配置了 Key 的第一个(chat 同款引擎池) */
const SEARCH_ENGINE_ORDER: SearchEngineId[] = ["qianfan", "tavily", "deepseek"]

/** 引擎失败码 → 给模型看的人话提示(如实转告用,别让模型猜) */
const REASON_HINTS: Record<string, string> = {
  not_found: "卷子不存在",
  slot_not_found: "卷面上没有这个题号",
  no_candidate: "真题池里没有合适的候选题",
  not_in_pool: "该题不在候选池内(可能缺答案/已拉黑/不属于本卷学科)",
  empty_title: "新卷名为空",
  bad_title: "卷名不合法",
  bad_score: "分值无效(需 1-30 的整数)",
  bad_duration: "时长无效(需 5-300 的整数分钟)",
  bad_section: "大题名无效",
  section_not_found: "卷面上没有这个大题名",
  bad_order: "移动位置无效",
  no_pool: "该学科真题池为空",
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })
  const { id } = await params

  let body: { messages?: unknown; modelId?: unknown; autoExecute?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 })
  }
  const messages = Array.isArray(body.messages) ? (body.messages as UIMessage[]) : null
  const modelId = typeof body.modelId === "string" && body.modelId.trim() ? body.modelId.trim() : null
  const autoExecute = body.autoExecute === true
  if (!messages || !modelId) return Response.json({ error: "need_messages_and_model" }, { status: 400 })

  // 本卷结构(归属校验含 userId);每次请求现读,模型永远看到最新卷面。
  // 槽位无 number 字段:题号 = position+1(渲染层同口径);stem 在 paperQuestion 上
  const paper = await prisma.composedPaper.findFirst({
    where: { id, userId },
    include: {
      slots: {
        orderBy: { position: "asc" },
        select: {
          id: true,
          position: true,
          section: true,
          kind: true,
          score: true,
          paperQuestion: { select: { stem: true } },
        },
      },
    },
  })
  if (!paper) return Response.json({ error: "not_found" }, { status: 404 })

  const kindLabel = (kind: string) => (kind === "choice" ? "选择题" : "解答/填空题")
  const slotViews = paper.slots.map((s) => ({
    slotId: s.id,
    number: s.position + 1,
    section: s.section,
    kind: s.kind,
    score: s.score,
    stem: s.paperQuestion?.stem ?? null,
  }))
  const structure = slotViews
    .map(
      (s) =>
        `第${s.number}题 ${s.section ?? "无大题"} · ${kindLabel(s.kind)} · ${s.score}分 · ${s.stem ? s.stem.replace(/\s+/g, " ").slice(0, 60) : "(无题干)"}`
    )
    .join("\n")

  // 执行后卷面摘要:AI 每步 exec_op 后看到最新状态,连续批量时不再需要额外 read_paper
  const paperBrief = async () => {
    const fresh = await prisma.composedPaper.findFirst({
      where: { id, userId },
      select: { title: true, totalScore: true, durationMin: true, _count: { select: { slots: true } } },
    })
    if (!fresh) return "(卷子不存在)"
    return `卷名「${fresh.title}」· ${fresh._count.slots} 题 · 满分 ${fresh.totalScore} 分 · ${fresh.durationMin} 分钟`
  }
  // 卷面题号 → slotId(题号 = position+1)
  const slotIdOf = (n?: number) => {
    if (!n) return null
    const s = paper.slots.find((x) => x.position + 1 === n)
    return s?.id ?? null
  }

  const modePolicy = autoExecute
    ? [
        "## 工具政策(自动执行模式)",
        "- exec_op 是真执行:调用即生效、不可撤销。调用前想清楚,note 写给用户看的一句话(如「换成更基础的语言运用题,同样 4 分」)",
        "- 多步修改(用户一次说好几件事)按顺序连续调用 exec_op,每步看返回结果再继续;全部完成后用一段话汇总每步结果与最新卷面状态",
        "- remove/replace 类会换掉/删掉题目的操作,只执行用户明确提到题号或明确诉求的;用户没让删就别删",
        "- 返回 ok=false 时把 REASON 提示如实转告用户,不要换参数盲目重试超过一次",
        "- 没有合适候选、或用户诉求超出能力(如改题目文字、生成新题)时,直接说明做不到与原因,不要硬凑",
      ]
    : [
        "## 工具政策(手动模式)",
        "- 对卷面结构不确定时先调 read_paper;要找具体题目(换更简单的/加某类题)先用 search_candidates 搜索真题池",
        "- 一切修改必须通过 propose_op 生成操作卡,由用户点「执行」才生效;严禁口头宣称已执行任何修改",
        "- propose_op 一次只提一个操作;replace = 同桶随机换题(不能指定具体题);要把某个具体题加进卷子用 insert(paperQuestionId 必须来自 search_candidates 的返回)",
        "- 没有合适候选、或用户诉求超出现有操作(如改题目文字、生成新题)时,直接说明做不到与原因,不要硬凑操作卡",
      ]

  const system = [
    "你是拟卷卷面的修改助手。用户用自然语言说想改哪里,你负责把它落成卷面操作。",
    "",
    "## 当前卷面",
    `卷名:${paper.title}(满分 ${paper.totalScore} 分,共 ${slotViews.length} 题,考试 ${paper.durationMin} 分钟)`,
    `底卷 slug:${paper.baseSlug}(卷子的结构模板与难度定位参考)`,
    structure || "(这张卷子还没有题目)",
    "",
    ...modePolicy,
    "",
    "## 操作能力",
    "- replace:某题换成同题型同分值的另一道(随机,不能指定具体题;原题不再保留)",
    "- remove:移除某题,其余题号自动前移",
    "- insert:把真题池里的具体题加进卷子(paperQuestionId 必须来自 search_candidates 返回;afterNumber=插到第 N 题后,不传=大题组末尾)",
    "- retitle:改卷名;rescore:改某题分值(总分自动重算);move:移动某题到新位置;resection:改某大题整组名;reduration:改考试时长",
    "- 卷面总分=各题分值之和,自动重算,没有单独改总分的操作",
    "",
    "## 题源与 AI 参考答案闸门",
    "- search_candidates 只返回池内真题;返回里有 poolStats(official=带官方答案的题数,ai=带 AI 参考答案的题数)",
    "- 默认只用官方答案题(official)。官方池不够、且 AI 参考答案题可补时,先向用户说明「题目仍出自原卷,答案由 AI 解答,卷面答案页会逐题标注『AI 参考答案(非官方)』」,用户明确同意后才调 set_allow_ai 放行;用户没同意绝不放行",
    "- 用户要求换回纯官方池时再调 set_allow_ai(false)",
    "",
    "## 难度定位(硬性纪律)",
    "- 学考/期末考/高考难度差异极大,不许默认。用户说「换简单点/难一点/出套X难度的」而没说清档位时,先用一句话问清(学考/期末/高考),对齐后再操作",
    "- search_candidates 结果里的 paperTitle 是来源卷名,据此判断题的难度段;note 里写明来源卷,让用户自己核对难度",
    "- 真题池里没有用户要的难度段时如实说明,不要拿别的难度硬凑",
    "",
    "## 口径红线",
    "- 你不能生成、改写任何题目内容;卷面所有题目与答案都出自原卷真题,这是本功能的硬承诺",
    autoExecute ? "- 自动执行不可撤销;每个已执行操作在回复里如实汇报" : "- 操作不可撤销;replace 类会换掉题目的操作,在 note 里说清楚后果",
    "",
    "## 风格",
    "- 中文回复,一两句话说完,不写客套;操作卡的 note 写用户视角的一句话(如「换成更基础的语言运用题,同样 4 分」)",
  ].join("\n")

  // ── 四路上下文工具(只读;与 chat 管线同闸门:名下有数据才挂) ──
  let knowledgeTool: ReturnType<typeof createKnowledgeTool> | null = null
  let paperSearchTool: ReturnType<typeof createPaperSearchTool> | null = null
  let notesTool: ReturnType<typeof createStudyNotesTool> | null = null
  let webSearchTool: ReturnType<typeof createWebSearchTool> | null = null
  try {
    if (await hasKnowledgeChunks(userId)) knowledgeTool = createKnowledgeTool(userId, paper.subject)
    if (await hasPaperQuestions(userId)) paperSearchTool = createPaperSearchTool(userId)
    if ((await prisma.studyNote.count({ where: { userId } })) > 0)
      notesTool = createStudyNotesTool(userId, paper.subject)
    for (const engine of SEARCH_ENGINE_ORDER) {
      const keyRecord = await prisma.searchApiKey.findUnique({
        where: { userId_engine: { userId, engine } },
      })
      if (keyRecord) {
        webSearchTool = createWebSearchTool(engine, decrypt(keyRecord.encryptedKey))
        break
      }
    }
  } catch (err) {
    console.error("[paper-assistant] Failed to attach context tools:", err)
  }

  const tools = {
    read_paper: tool({
      description: "读取本卷当前完整结构(题号/大题/题型/分值/题干摘要)。对卷面有任何不确定时先调它",
      inputSchema: z.object({}),
      execute: async () => ({
        title: paper.title,
        totalScore: paper.totalScore,
        durationMin: paper.durationMin,
        slots: slotViews.map((s) => ({
          number: s.number,
          section: s.section,
          kind: s.kind,
          score: s.score,
          stemBrief: s.stem ? s.stem.replace(/\s+/g, " ").slice(0, 80) : null,
        })),
      }),
    }),
    search_candidates: tool({
      description:
        "在试卷库真题池里搜候选题(未拉黑/自检过;默认只搜官方答案题)。为「换更…的题」「加一道…题」找具体题目时调用;q 与 kind 至少给一个。返回含 poolStats(official/ai 池构成)",
      inputSchema: z.object({
        q: z.string().max(60).optional().describe("题干/选项关键词,如「新闻标题」「动点」"),
        kind: z.enum(["choice", "answer"]).optional().describe("题型:choice=选择题,answer=解答/填空题"),
        score: z.number().int().optional().describe("分值"),
      }),
      execute: async ({ q, kind, score }) => {
        if (!q && !kind) return { error: "need_q_or_kind" }
        const res = await listCandidates(userId, id, { q, kind, score })
        if (!res) return { error: "not_found" }
        return {
          poolStats: res.poolStats,
          candidates: res.candidates.slice(0, 6).map((c) => ({
            id: c.id,
            stemBrief: c.stem.replace(/\s+/g, " ").slice(0, 80),
            paperTitle: c.paperTitle,
            number: c.number,
            kind: c.kind,
            score: c.score,
            answerSource: c.answerSource,
          })),
        }
      },
    }),
    ...(autoExecute
      ? {
          exec_op: tool({
            description:
              "执行一个卷面修改操作,立即生效不可撤销。op 取值:replace=同桶随机换题(slotNumber);remove=移除(slotNumber);insert=加题(paperQuestionId 必须来自 search_candidates,可选 afterNumber);retitle=改卷名(title);rescore=改某题分值(slotNumber,score);move=移动某题到第 toNumber 题位(slotNumber,toNumber);resection=改大题整组名(fromSection,toSection);reduration=改考试时长(durationMin)",
            inputSchema: z.object({
              op: z.enum(["replace", "remove", "insert", "retitle", "rescore", "move", "resection", "reduration"]),
              slotNumber: z.number().int().optional().describe("replace/remove/rescore/move 的目标题号(卷面题号=顺序号)"),
              paperQuestionId: z.string().optional().describe("insert 的真题 id(必须来自 search_candidates 返回)"),
              afterNumber: z.number().int().optional().describe("insert 可选:插到第 N 题后;不传=大题组末尾"),
              title: z.string().max(60).optional().describe("retitle 的新卷名"),
              score: z.number().int().optional().describe("rescore 的新分值(1-30)"),
              toNumber: z.number().int().optional().describe("move 的目标位置(第几题)"),
              fromSection: z.string().max(30).optional().describe("resection 的原大题名(当前卷面上的)"),
              toSection: z.string().max(30).optional().describe("resection 的新大题名"),
              durationMin: z.number().int().optional().describe("reduration 的新时长(分钟)"),
              note: z.string().max(120).describe("给用户看的一句话说明,写清后果"),
            }),
            execute: ({ op, slotNumber, paperQuestionId, afterNumber, title, score, toNumber, fromSection, toSection, durationMin, note }) =>
              withLock(id, async () => {
                const slotId = slotIdOf(slotNumber)
                const afterSlotId = slotIdOf(afterNumber)
                let r: { ok: boolean; reason?: string; [k: string]: unknown } | null = null
                switch (op) {
                  case "replace":
                    r = slotId ? await replaceSlot(userId, id, slotId) : { ok: false, reason: "slot_not_found" }
                    break
                  case "remove":
                    r = slotId ? await removeSlot(userId, id, slotId) : { ok: false, reason: "slot_not_found" }
                    break
                  case "insert":
                    r = paperQuestionId
                      ? await insertSlot(userId, id, paperQuestionId, afterSlotId ?? undefined)
                      : { ok: false, reason: "need_paperQuestionId" }
                    break
                  case "retitle":
                    r = await retitlePaper(userId, id, title ?? "")
                    break
                  case "rescore":
                    r = slotId && score ? await updateSlotScore(userId, id, slotId, score) : { ok: false, reason: "bad_score" }
                    break
                  case "move":
                    r = slotId && toNumber ? await moveSlot(userId, id, slotId, toNumber) : { ok: false, reason: "bad_order" }
                    break
                  case "resection":
                    r = fromSection && toSection ? await retitleSection(userId, id, fromSection, toSection) : { ok: false, reason: "bad_section" }
                    break
                  case "reduration":
                    r = durationMin ? await updateDuration(userId, id, durationMin) : { ok: false, reason: "bad_duration" }
                    break
                }
                if (!r || !r.ok) {
                  const reason = r?.reason ?? "op_failed"
                  return { ok: false as const, reason, hint: REASON_HINTS[reason] ?? "操作失败", note }
                }
                return {
                  ok: true as const,
                  op,
                  detail: r.pickedId ? "已换入新题" : op === "resection" ? `已改名 ${r.renamed ?? 0} 个槽位` : "",
                  paper: await paperBrief(),
                  note,
                }
              }),
          }),
        }
      : {
          propose_op: tool({
            description:
              "提出一个卷面修改操作卡,生成后本轮结束,等用户确认才执行。op 取值:replace=同桶随机换题(需 slotNumber),remove=移除(需 slotNumber),insert=把真题池里的具体题加进卷子(需 paperQuestionId),retitle=改卷名(需 title),rescore=改某题分值(需 slotNumber,score),move=移动某题(需 slotNumber,toNumber),resection=改大题整组名(需 fromSection,toSection),reduration=改考试时长(需 durationMin)",
            inputSchema: z.object({
              op: z.enum(["replace", "remove", "insert", "retitle", "rescore", "move", "resection", "reduration"]),
              slotNumber: z.number().int().optional().describe("replace/remove/rescore/move 的目标题号"),
              paperQuestionId: z.string().optional().describe("insert 的真题 id(必须来自 search_candidates 返回)"),
              title: z.string().max(60).optional().describe("retitle 的新卷名"),
              score: z.number().int().optional().describe("rescore 的新分值(1-30)"),
              toNumber: z.number().int().optional().describe("move 的目标位置(第几题)"),
              fromSection: z.string().max(30).optional().describe("resection 的原大题名(当前卷面上的)"),
              toSection: z.string().max(30).optional().describe("resection 的新大题名"),
              durationMin: z.number().int().optional().describe("reduration 的新时长(分钟)"),
              note: z.string().max(120).describe("给用户看的一句话说明,写清后果"),
            }),
            // 无 execute:AI SDK 不会自动续跑,本轮在操作卡处结束(同 ask_clarification 模式),前端渲染操作卡
          }),
        }),
    // 题源闸门两模式都直挂:调用前提就是用户已明确同意(等效已确认),执行后回执进模型上下文
    set_allow_ai: tool({
      description:
        "切换本卷是否放行 AI 参考答案题入池(answerSource=ai)。硬性前提:官方池不够用、且用户已明确同意「题目出自原卷但答案由 AI 解答,答案页逐题标注」后才能传 true;用户未同意绝不调用。传 false 切回纯官方池",
      inputSchema: z.object({
        allow: z.boolean().describe("true=放行 AI 参考答案题;false=切回纯官方池"),
      }),
      execute: async ({ allow }) => {
        const r = await setAllowAi(userId, id, allow)
        if (!r.ok) return { ok: false as const, reason: r.reason ?? "op_failed" }
        const stats = await loadPoolStats(userId, paper.subject)
        return {
          ok: true as const,
          allow,
          poolStats: stats,
          note: allow
            ? "已放行 AI 参考答案题:后续换题/加题/重摇都会纳入 AI 参考答案题,卷面答案页逐题标注"
            : "已切回纯官方池",
        }
      },
    }),
    ...(knowledgeTool ? { [KNOWLEDGE_TOOL_NAME]: knowledgeTool } : {}),
    ...(paperSearchTool ? { [PAPER_SEARCH_TOOL_NAME]: paperSearchTool } : {}),
    ...(notesTool ? { [STUDY_NOTES_TOOL_NAME]: notesTool } : {}),
    ...(webSearchTool ? { web_search: webSearchTool } : {}),
  }

  // 上下文工具能力段:挂了哪些说哪些,给使用纪律
  const contextSection = [
    "## 上下文工具(讲评与查证优先走库,联网是最后手段)",
    ...(knowledgeTool
      ? ["- search_knowledge:课本知识库检索。判断考点、引用教材原文、解释概念/公式时,第一个动作就是查课本——凡涉及具体知识点,无论多有把握都先查"]
      : []),
    ...(paperSearchTool
      ? ["- search_papers:试卷库真题检索。找同类真题例题、判断考点是不是高频(考了几次)时用"]
      : []),
    ...(notesTool
      ? ["- search_notes:错题本检索。出变式题/讲薄弱考点前,先查这个考点用户错过什么(掌握度/遗忘次数),让建议和候选题针对性补弱"]
      : []),
    ...(webSearchTool
      ? ["- web_search:课本和试卷库都覆盖不到的外部信息(考纲变化、真题背景)才联网;能查库就不要搜网"]
      : []),
  ].join("\n")

  const systemFull = `${system}\n\n${contextSection}`

  const resolved = await resolveChatModel({ userId, modelId, logTag: "[paper-assistant]" })
  if (!resolved.ok) return resolved.response
  const { provider, realModelId, usesServerBilledKey, quotaBaseLimit } = resolved

  const result = streamText({
    model: provider(realModelId),
    system: systemFull,
    messages: await convertToModelMessages(messages),
    tools,
    abortSignal: req.signal,
    stopWhen: ({ steps }) => steps.length >= TOOL_STEP_BUDGET,
    onFinish: ({ usage }) => {
      if (usesServerBilledKey) {
        void import("@/lib/quota")
          .then(({ settleQuota }) =>
            settleQuota({
              userId,
              modelId: realModelId,
              inputTokens: usage?.inputTokens ?? undefined,
              outputTokens: usage?.outputTokens ?? undefined,
              baseLimit: quotaBaseLimit,
            })
          )
          .catch(() => {})
      }
      monitor("paper_assistant_done", {})
    },
  })

  return createUIMessageStreamResponse({ stream: result.toUIMessageStream() })
}
