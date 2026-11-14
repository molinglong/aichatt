/**
 * 卷面 AI 助手 v2(POST /api/papers/composed/[id]/assistant)——计划范式:
 * AI 不再逐卡执行/自动执行,而是一轮诉求落成一张「变更计划」(propose_plan,无 execute,
 * 本轮在计划处结束);换题必须给 2-3 道候选(search_candidates 考点加权检索)由用户挑,
 * 用户勾选后前端调 POST /apply 批量应用(应用前服务端自动快照,POST /undo 整卷撤销)。
 * 口径红线:助手不生成/不改写题目内容,一切题目只从真题池选真操作;
 * AI 参考答案题入池必须经用户明确同意(set_allow_ai)。
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
  computeReview,
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

/** 工具轮预算:读卷→查诊断→搜候选→落计划需要余量,防失控循环 */
const TOOL_STEP_BUDGET = 16

/** 网络搜索引擎偏好序:取用户配置了 Key 的第一个(chat 同款引擎池) */
const SEARCH_ENGINE_ORDER: SearchEngineId[] = ["qianfan", "tavily", "deepseek"]

export async function POST(req: NextRequest, { params }: Ctx) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })
  const { id } = await params

  let body: { messages?: unknown; modelId?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "bad_json" }, { status: 400 })
  }
  const messages = Array.isArray(body.messages) ? (body.messages as UIMessage[]) : null
  const modelId = typeof body.modelId === "string" && body.modelId.trim() ? body.modelId.trim() : null
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
          paperQuestion: { select: { stem: true, topics: true } },
        },
      },
    },
  })
  if (!paper) return Response.json({ error: "not_found" }, { status: 404 })

  const kindLabel = (kind: string) => (kind === "choice" ? "选择题" : "解答/填空题")
  const slotViews = paper.slots.map((s) => ({
    number: s.position + 1,
    section: s.section,
    kind: s.kind,
    score: s.score,
    stem: s.paperQuestion?.stem ?? null,
    topics: s.paperQuestion?.topics ?? [],
  }))
  const structure = slotViews
    .map(
      (s) =>
        `第${s.number}题 ${s.section ?? "无大题"} · ${kindLabel(s.kind)} · ${s.score}分 · 考点[${s.topics.slice(0, 3).join("/") || "无标签"}] · ${s.stem ? s.stem.replace(/\s+/g, " ").slice(0, 90) : "(无题干)"}`
    )
    .join("\n")

  const system = [
    "你是拟卷卷面的修改助手。用户用自然语言说想怎么改卷子,你负责把诉求落成一张「变更计划」,用户核对勾选后一键应用。你永远不直接改卷面。",
    "",
    "## 当前卷面",
    `卷名:${paper.title}(满分 ${paper.totalScore} 分,共 ${slotViews.length} 题,考试 ${paper.durationMin} 分钟)`,
    `底卷 slug:${paper.baseSlug}(卷子的结构模板与难度定位参考)`,
    structure || "(这张卷子还没有题目)",
    "",
    "## 工作方式(计划范式)",
    "- 一切修改必须通过 propose_plan 落成计划;严禁口头宣称已执行任何修改,卷面只会在用户点「应用」后变",
    "- 计划一次最多 12 条操作;每条操作带 note(给用户看的一句话,写清动哪、为什么)",
    "- 换题/加题一律先 search_candidates 搜真题池;没有合适的就明说,不要硬凑",
    "- 换题(replace)必须在 op.candidates 里给 2-3 道候选(来自 search_candidates 返回,附题干/考点/来源卷),用户会挑一道;paperQuestionId 填你默认推荐的那道",
    "- 加题(insert)用具体 paperQuestionId(必须来自 search_candidates 返回),afterNumber=插到第 N 题后,不传=同大题组末尾",
    "- remove/insert/replace 会让题号前移:计划里的题号一律按「计划生成时的卷面」表述,note 里提醒用户题号会自动重排",
    "- 用户诉求含糊(如「换简单点」没说难度档)时,先用一句话问清(学考/期末/高考)再落计划;来源卷名(paperTitle)就是难度段参考,note 里写明",
    "- 用户诉求和卷面缺口相关时,可调 read_diagnosis 引用具体缺口/薄弱考点,让计划有依据",
    "",
    "## 操作能力",
    "- replace:换掉第 slotNumber 题位置上的题,新题来自 candidates,原题不再保留",
    "- remove:移除第 slotNumber 题,其余题号自动前移",
    "- insert:把真题池里的具体题加进卷子(afterNumber 可选)",
    "- retitle:改卷名;rescore:改第 slotNumber 题分值(总分自动重算);move:移动第 slotNumber 题到第 toNumber 题位;resection:改大题整组名;reduration:改考试时长",
    "- 卷面总分=各题分值之和,自动重算,没有单独改总分的操作",
    "",
    "## 题源与 AI 参考答案闸门",
    "- search_candidates 只返回池内真题;返回里有 poolStats(official=带官方答案的题数,ai=带 AI 参考答案的题数)与 matched(关键词是否有命中)",
    "- 默认只用官方答案题(official)。官方池不够、且 AI 参考答案题可补时,先向用户说明「题目仍出自原卷,答案由 AI 解答,卷面答案页会逐题标注『AI 参考答案(非官方)』」,用户明确同意后才调 set_allow_ai 放行;用户没同意绝不放行",
    "- 用户要求换回纯官方池时再调 set_allow_ai(false)",
    "",
    "## 口径红线",
    "- 你不能生成、改写任何题目内容;计划里的每道题都必须来自真题池(search_candidates/read_paper 返回),这是本功能的硬承诺",
    "- 操作应用前卷面不变;应用后用户可整卷撤销,但你要在 note 里写清后果(如「原题将被换掉」)",
    "",
    "## 风格",
    "- 中文回复,一两句话说完,不写客套;计划的 note 写用户视角的一句话(如「换成更基础的动点题,同样 4 分」)",
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

  /** 候选题对象(propose_plan 的 candidates 与 search_candidates 返回共用同一形状) */
  const candidateSchema = z.object({
    paperQuestionId: z.string().describe("真题 id"),
    stemBrief: z.string().max(200).describe("题干摘要(原样取自 search_candidates)"),
    topics: z.array(z.string().max(30)).max(4).default([]).describe("考点标签"),
    paperTitle: z.string().max(80).describe("来源卷名"),
    answerBrief: z.string().max(100).optional().describe("答案摘要"),
    kind: z.enum(["choice", "answer"]),
    score: z.number().int(),
    answerSource: z.enum(["official", "ai"]),
  })

  const tools = {
    read_paper: tool({
      description: "读取本卷当前完整结构(题号/大题/题型/分值/考点/题干摘要)。对卷面有任何不确定时先调它",
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
          topics: s.topics.slice(0, 4),
          stemBrief: s.stem ? s.stem.replace(/\s+/g, " ").slice(0, 120) : null,
        })),
      }),
    }),
    read_diagnosis: tool({
      description:
        "读取审卷诊断:考点覆盖(本卷已覆盖 vs 本学科高频考点)、缺口清单(高频但卷上没有)、薄弱点(错题本掌握度<0.5 的考点及其是否在卷上)。落「按缺口补题」类计划前先调它",
      inputSchema: z.object({}),
      execute: async () => {
        const review = await computeReview(userId, id)
        if (!review) return { error: "not_found" }
        return review
      },
    }),
    search_candidates: tool({
      description:
        "在试卷库真题池里搜候选题(未拉黑/自检过;默认只搜官方答案题)。考点加权检索:q 给考点词或关键词(空格分词),返回按命中强度排序。为「换更…的题」「加一道…题」找具体题目时调用;q 与 kind 至少给一个。返回含 poolStats(official/ai 池构成)与 matched(关键词是否有命中)",
      inputSchema: z.object({
        q: z.string().max(60).optional().describe("考点/关键词,如「动点」「新闻标题」,可空格分词"),
        kind: z.enum(["choice", "answer"]).optional().describe("题型:choice=选择题,answer=解答/填空题"),
        score: z.number().int().optional().describe("分值"),
      }),
      execute: async ({ q, kind, score }) => {
        if (!q && !kind) return { error: "need_q_or_kind" }
        const res = await listCandidates(userId, id, { q, kind, score })
        if (!res) return { error: "not_found" }
        return {
          poolStats: res.poolStats,
          matched: res.matched,
          candidates: res.candidates.slice(0, 8),
        }
      },
    }),
    propose_plan: tool({
      description:
        "把用户诉求落成一张变更计划(本轮到此结束,等用户勾选应用)。ops 最多 12 条;replace 必须带 candidates(2-3 道,来自 search_candidates);insert 的 paperQuestionId 必须来自 search_candidates 返回",
      inputSchema: z.object({
        ops: z
          .array(
            z.object({
              op: z.enum(["replace", "remove", "insert", "retitle", "rescore", "move", "resection", "reduration"]),
              slotNumber: z.number().int().optional().describe("replace/remove/rescore/move 的目标题号(计划生成时的卷面题号)"),
              paperQuestionId: z.string().optional().describe("insert 的真题 id / replace 默认推荐的真题 id(必须来自 search_candidates)"),
              afterNumber: z.number().int().optional().describe("insert 可选:插到第 N 题后;不传=同大题组末尾"),
              title: z.string().max(60).optional().describe("retitle 的新卷名"),
              score: z.number().int().optional().describe("rescore 的新分值(1-30)"),
              toNumber: z.number().int().optional().describe("move 的目标位置(第几题)"),
              fromSection: z.string().max(30).optional().describe("resection 的原大题名(当前卷面上的)"),
              toSection: z.string().max(30).optional().describe("resection 的新大题名"),
              durationMin: z.number().int().optional().describe("reduration 的新时长(分钟)"),
              note: z.string().max(120).describe("给用户看的一句话:动哪、为什么、后果"),
              candidates: z.array(candidateSchema).max(3).optional().describe("replace 的候选题(用户挑一道)"),
            })
          )
          .min(1)
          .max(12),
      }),
      // 无 execute:AI SDK 不会自动续跑,本轮在计划处结束,前端渲染计划卡
    }),
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
            ? "已放行 AI 参考答案题:后续计划里的候选会纳入 AI 参考答案题,卷面答案页逐题标注"
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
    "## 上下文工具(查证优先走库,联网是最后手段)",
    ...(knowledgeTool
      ? ["- search_knowledge:课本知识库检索。判断考点、引用教材原文时用;凡涉及具体知识点,无论多有把握都先查"]
      : []),
    ...(paperSearchTool
      ? ["- search_papers:试卷库真题检索。判断考点是不是高频(考了几次)时用"]
      : []),
    ...(notesTool
      ? ["- search_notes:错题本检索。落补弱计划前,先查这个考点用户错过什么(掌握度/遗忘次数)"]
      : []),
    ...(webSearchTool
      ? ["- web_search:课本和试卷库都覆盖不到的外部信息才联网;能查库就不要搜网"]
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
