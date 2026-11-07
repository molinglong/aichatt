/**
 * 学习会话核心流式端点:POST /api/study/[id]/stream
 * body {action: start|continue|easier|solution|followup, text?, rate?: {idx, rating}}
 *
 * 一次调用 = 讲义流里的一张新卡(StudyStep):
 * - 工具白名单:search_knowledge(引用捕获 → SSE refs 事件)+ finish_study(结构化结课)
 * - 草稿行:创建 streaming=true 的 StudyStep,600ms 节流快照,异常/超时定格
 * - SSE 轻协议:data: {type: delta|refs|done|error, ...}
 * - 后台续跑:客户端断开不中止(serverDrain 语义等价——本路由直接消费 fullStream),
 *   10 分钟兜底超时;同时若有其他流式步,409 拒绝并发
 */
import { NextRequest } from "next/server"
import { streamText, tool, type ModelMessage } from "ai"
import type { SharedV4ProviderOptions } from "@ai-sdk/provider"
import { z } from "zod"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"
import type { Prisma } from "@/generated/prisma/client"
import { resolveChatModel } from "@/lib/ai/model-resolver.server"
import { createKnowledgeTool } from "@/lib/ai/knowledge-tool-server"
import {
  STUDY_FINISH_TOOL_NAME,
  STUDY_MASTERY_TOOL_NAME,
  studyFinishToolSchema,
  studyMasteryToolSchema,
  buildStudySystemPrompt,
  buildStudyContextLines,
  isStudyAction,
  isStudyStartLevel,
  type StudyActionType,
} from "@/lib/study/prompts"
import { archiveStudySession } from "@/lib/study/archive-session"
import { scheduleReview } from "@/lib/study/fsrs"
import { registerActiveChatRun, releaseActiveChatRun } from "@/lib/ai/active-chat-runs.server"
import { monitor } from "@/lib/monitor"

export const dynamic = "force-dynamic"
export const maxDuration = 300

/** 单次生成的工具步数预算(检索链路 2~4 步 + 作答) */
const STUDY_STEP_BUDGET = 8
/** 孤儿草稿判定:并发守卫只拦「新鲜」的 streaming 步 */
const FRESH_STREAMING_MS = 60 * 1000

interface KnowledgeRef {
  doc: string
  chapter: string | null
  section: string | null
  heading: string
  content: string
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })

  let body: { action?: unknown; text?: unknown; rate?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 })
  }
  if (!isStudyAction(body.action)) return Response.json({ error: "invalid_action" }, { status: 400 })
  const action = body.action as StudyActionType
  const followupText = action === "followup" && typeof body.text === "string" ? body.text.trim().slice(0, 10000) : null
  if (action === "followup" && !followupText) return Response.json({ error: "text_required" }, { status: 400 })

  const session = await prisma.studySession.findFirst({ where: { id, userId } })
  if (!session) return Response.json({ error: "not_found" }, { status: 404 })
  // 结课后的会话允许 quiz(变式练习)/followup(追问),讲解类动作仍拒绝
  const explainingActions: StudyActionType[] = ["start", "continue", "easier", "solution"]
  if (session.status === "completed" && explainingActions.includes(action)) {
    return Response.json({ error: "already_completed" }, { status: 409 })
  }

  // 并发守卫:已有「新鲜」的生成中步 → 409(孤儿步由 GET 兜底定格)
  const freshCutoff = new Date(Date.now() - FRESH_STREAMING_MS)
  const running = await prisma.studyStep.findFirst({
    where: { sessionId: session.id, streaming: true, createdAt: { gte: freshCutoff } },
  })
  if (running) return Response.json({ error: "generation_running" }, { status: 409 })

  // 过程自评(可选):随本次动作一起落库
  const rate = body.rate as { idx?: unknown; rating?: unknown } | undefined
  if (rate && typeof rate.idx === "number" && (rate.rating === "good" || rate.rating === "again")) {
    await prisma.studyStep
      .updateMany({ where: { sessionId: session.id, idx: rate.idx }, data: { selfRating: rate.rating } })
      .catch(() => {})
  }

  const priorSteps = await prisma.studyStep.findMany({ where: { sessionId: session.id }, orderBy: { idx: "asc" } })
  const nextIdx = priorSteps.length

  // 模型解析(公共额度闸与 chat 管线同口径)
  const resolved = await resolveChatModel({ userId, modelId: session.modelId, logTag: "[study]" })
  if (!resolved.ok) return resolved.response
  const { modelDef, provider, realModelId, usesServerBilledKey, cmSupportsReasoning, cmBaseURL, quotaBaseLimit } = resolved

  // 草稿行
  const stepRow = await prisma.studyStep.create({
    data: {
      sessionId: session.id,
      idx: nextIdx,
      action,
      followupText,
      streaming: true,
    },
  })

  // 消息组装:题目(+图)→ 思路备注(若有,每次生成都注入,导师始终看得见用户的过程)→ 历史步 → 本步指令(user)
  const origin = new URL(req.url).origin
  const abs = (u: string) => (u.startsWith("http") ? u : `${origin}${u}`)
  const questionText = session.notes?.trim()
    ? `${session.question}

【我的思路 / 已做的过程】
${session.notes.trim()}`
    : session.question
  const messages: ModelMessage[] = []
  messages.push({
    role: "user",
    content: [
      { type: "text", text: questionText },
      ...session.images.map((u) => ({ type: "image" as const, image: abs(u) })),
    ],
  })
  for (const s of priorSteps) {
    if (s.content.trim()) messages.push({ role: "assistant", content: s.content })
  }
  const ACTION_USER_TEXT: Record<StudyActionType, string> = {
    start: "请开始讲解第一步。",
    continue: "继续,讲下一步。",
    easier: "没懂,换一种更通俗的说法再讲一遍。",
    solution: "直接给出完整解法和答案,讲完就结束。",
    followup: followupText ?? "",
    quiz: "请出一道考察同一知识点的变式题。",
    drill: "请出一道同考点变式练习题,开始举一反三巩固。",
  }
  messages.push({ role: "user", content: ACTION_USER_TEXT[action] })

  // 学情回灌
  let studyContext: string | null = null
  try {
    const now = new Date()
    const [dueCount, weakNotes] = await Promise.all([
      prisma.studyNote.count({ where: { userId, OR: [{ dueAt: { lte: now } }, { dueAt: null }] } }),
      prisma.studyNote.findMany({
        where: { userId, OR: [{ lapses: { gte: 1 } }, { mastery: { lt: 0.3 } }] },
        orderBy: { createdAt: "desc" },
        take: 6,
        select: { topic: true, title: true, lapses: true, mastery: true },
      }),
    ])
    studyContext = buildStudyContextLines(dueCount, weakNotes)
  } catch {
    studyContext = null
  }

  const startLevel = isStudyStartLevel(session.startLevel) ? session.startLevel : "beginner"
  const systemPrompt = buildStudySystemPrompt({ startLevel, action, studyContext })

  // 工具白名单:课本检索 + 结构化结课 + 掌握度上报(变式判分)
  let collectedRefs: KnowledgeRef[] = []
  let finishSummary: string | null = null
  const knowledgeTool = createKnowledgeTool(userId)
  const tools = {
    search_knowledge: {
      ...knowledgeTool,
      execute: async (
        input: Parameters<typeof knowledgeTool.execute>[0],
        opts: Parameters<typeof knowledgeTool.execute>[1]
      ) => {
        const out = (await knowledgeTool.execute(input, opts)) as {
          results?: Array<{ doc: string; chapter: string | null; section: string | null; heading: string; content: string }>
        }
        if (Array.isArray(out?.results) && out.results.length) {
          collectedRefs = out.results.slice(0, 5).map((r) => ({
            doc: r.doc,
            chapter: r.chapter,
            section: r.section,
            heading: r.heading,
            content: r.content,
          }))
        }
        return out
      },
    },
    [STUDY_FINISH_TOOL_NAME]: tool({
      description:
        "本题讲解完成时调用。summary 传给用户的要点总结(3 条以内,每条一句)。调用后立即结束回复,不要再输出其他内容。",
      inputSchema: studyFinishToolSchema,
      execute: async ({ summary }: z.infer<typeof studyFinishToolSchema>) => {
        // 模型偶发把换行转义成字面 \n 传入,还原成真换行(结课卡按行渲染)
        finishSummary = summary.replace(/\\n/g, "\n")
        return { ok: true }
      },
    }),
    [STUDY_MASTERY_TOOL_NAME]: tool({
      description:
        "用户提交作答(变式题/练习的答案)判分后调用。答对 rating=good,答错 rating=again;用于更新该考点的复习排期。",
      inputSchema: studyMasteryToolSchema,
      execute: async ({ rating }: z.infer<typeof studyMasteryToolSchema>) => {
        try {
          const note = await prisma.studyNote.findFirst({
            where: { userId, sourceMessageId: `study:${session.id}` },
          })
          if (note) {
            const next = scheduleReview(
              {
                mastery: note.mastery,
                stability: note.stability,
                difficulty: note.difficulty,
                state: note.state,
                dueAt: note.dueAt,
                lastReviewAt: note.lastReviewAt,
                reps: note.reps,
                lapses: note.lapses,
              },
              rating
            )
            await prisma.studyNote.update({
              where: { id: note.id },
              data: {
                mastery: next.mastery,
                stability: next.stability,
                difficulty: next.difficulty,
                state: next.state,
                dueAt: next.dueAt,
                reps: next.reps,
                lapses: next.lapses,
                lastReviewAt: new Date(),
              },
            })
          }
        } catch (err) {
          console.error("[study] update_mastery failed:", err)
        }
        return { ok: true }
      },
    }),
  }

  // deepThink 恒开:讲解质量优先;档位按 provider 注入(与 chat 管线同款降级口径)
  let providerOptions: SharedV4ProviderOptions | undefined
  if (modelDef.provider === "deepseek") {
    providerOptions = { deepseek: { thinking: { type: "enabled" }, reasoningEffort: "high" } }
  } else if (cmSupportsReasoning || modelDef.provider === "qianwen") {
    providerOptions = { openai: { reasoningEffort: "medium" } }
  }

  // 生成生命周期:客户端断开不中止,10 分钟兜底
  const runAbort = new AbortController()
  const runKey = `study:${session.id}`
  registerActiveChatRun(runKey, runAbort)
  const backstop = setTimeout(() => {
    if (!runAbort.signal.aborted) runAbort.abort("background-timeout")
  }, 10 * 60 * 1000)
  ;(backstop as unknown as { unref?: () => void }).unref?.()

  // 草稿节流快照
  let snapText = ""
  let snapReasoning = ""
  let lastSnapAt = 0
  let snapChain: Promise<void> = Promise.resolve()
  let snapStopped = false
  const scheduleSnap = (final: { content?: string; reasoning?: string | null } = {}) => {
    if (snapStopped) return
    snapChain = snapChain
      .then(async () => {
        await prisma.studyStep.update({
          where: { id: stepRow.id },
          data: {
            content: final.content ?? snapText,
            reasoning: final.reasoning !== undefined ? final.reasoning : snapReasoning || null,
            ...(Object.keys(final).length ? { streaming: false } : {}),
          },
        })
      })
      .catch(() => {})
  }
  const throttledSnap = () => {
    if (Date.now() - lastSnapAt > 600) {
      lastSnapAt = Date.now()
      scheduleSnap()
    }
  }

  const encoder = new TextEncoder()
  const sse = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const send = (obj: unknown) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))
        } catch {
          closed = true
        }
      }
      let finishReason = "unknown"
      let usage: { promptTokens?: number; completionTokens?: number } | null = null
      let errored = false
      try {
        const result = streamText({
          model: provider(realModelId),
          system: systemPrompt,
          messages,
          tools,
          abortSignal: runAbort.signal,
          providerOptions,
          stopWhen: ({ steps }) => {
            const last = steps[steps.length - 1]
            const finishCalled = !!last?.content?.some(
              (p) => (p as { type?: string; toolName?: string }).type === "tool-call" &&
                (p as { toolName?: string }).toolName === STUDY_FINISH_TOOL_NAME
            )
            return finishCalled || steps.length >= STUDY_STEP_BUDGET
          },
        })

        for await (const chunk of result.fullStream) {
          if (chunk.type === "text-delta" && typeof chunk.text === "string") {
            snapText += chunk.text
            send({ type: "delta", text: chunk.text })
            throttledSnap()
          } else if (chunk.type === "reasoning-delta" && typeof chunk.text === "string") {
            snapReasoning += chunk.text
            send({ type: "thinking", text: chunk.text })
          } else if (chunk.type === "tool-result") {
            const tr = chunk as { toolName?: string; output?: unknown }
            if (tr.toolName === "search_knowledge") {
              send({ type: "refs", refs: collectedRefs })
            }
          } else if (chunk.type === "error") {
            errored = true
            const message = (chunk as { error?: { message?: string } }).error?.message ?? "生成出错"
            console.error(`[study] stream error: ${message}`)
            send({ type: "error", message })
          } else if (chunk.type === "finish") {
            finishReason = (chunk as { finishReason?: string }).finishReason ?? "unknown"
            usage = (chunk as { usage?: { promptTokens?: number; completionTokens?: number } }).usage ?? null
          }
        }

        // 收尾:预算耗尽补提示(与 chat 口径一致)
        snapStopped = true
        let content = snapText
        let note: string | null = null
        if (finishReason === "tool-calls") {
          note = "本轮讲解预算已到上限,点「懂了,继续」我接着讲。"
          content = content.trim() ? `${content}\n\n(本轮讲解预算到上限,点「懂了,继续」我接着讲。)` : "(本轮讲解预算到上限,点「懂了,继续」我接着讲。)"
        }
        const completed = !!finishSummary
        await snapChain
        await prisma.studyStep
          .update({
            where: { id: stepRow.id },
            data: {
              content: errored && !content.trim() ? (note ?? "(生成失败)") : content,
              reasoning: snapReasoning || null,
              refs: collectedRefs.length ? (collectedRefs as unknown as Prisma.InputJsonValue) : undefined,
              streaming: false,
              promptTokens: usage?.promptTokens ?? null,
              completionTokens: usage?.completionTokens ?? null,
            },
          })
          .catch(() => {})
        if (completed) {
          await prisma.studySession
            .update({ where: { id: session.id }, data: { status: "completed", summary: finishSummary } })
            .catch(() => {})
          void archiveStudySession(userId, session.id).catch((err) =>
            console.error("[study] archive failed:", err)
          )
        }
        if (usesServerBilledKey) {
          const { settleQuota } = await import("@/lib/quota")
          void settleQuota({
            userId,
            modelId: realModelId,
            inputTokens: usage?.promptTokens,
            outputTokens: usage?.completionTokens,
            fallbackText: `${snapText}${snapReasoning}`,
            baseLimit: quotaBaseLimit,
          }).catch(() => {})
        }
        monitor("study_stream_done", { action, completed, finishReason, errored })
        send({ type: "done", stepId: stepRow.id, completed, note })
      } catch (err) {
        console.error("[study] stream failed:", err)
        errored = true
        snapStopped = true
        await snapChain
        await prisma.studyStep
          .update({ where: { id: stepRow.id }, data: { streaming: false } })
          .catch(() => {})
        send({ type: "error", message: err instanceof Error ? err.message : "生成失败" })
      } finally {
        clearTimeout(backstop)
        releaseActiveChatRun(runKey, runAbort)
        if (!closed) {
          try {
            controller.close()
          } catch {
            /* 已关闭 */
          }
        }
      }
    },
  })

  return new Response(sse, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}
