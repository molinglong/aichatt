/**
 * PDF 录题 · 单作业读写:
 * - GET   拉作业 DTO(候选清单+状态;不回传 pageTexts)
 * - PATCH 人工操作:save(候选整包回写/改卷名) / ready(切题齐备) / aiSolve(就地 AI 解一题) / resplit(重切一页)
 */
import { NextRequest } from "next/server"
import type { Prisma } from "@/generated/prisma/client"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"
import {
  aiSolveCandidate,
  buildChunkText,
  loadDupRefs,
  markDuplicates,
  planTextChunks,
  resolveImportModelId,
  renderPdfPageDataUrl,
  runScanSplitPage,
  runTextSplitChunk,
  importPdfPath,
} from "@/lib/papers/pdf-import.server"
import { EMPTY_IMPORT_META, type ImportCandidate, type ImportMeta, type ImportJobDto } from "@/lib/papers/pdf-import"
import { readFile } from "fs/promises"
import { nanoid } from "nanoid"

export const dynamic = "force-dynamic"

async function loadOwnedJob(id: string, userId: string) {
  const job = await prisma.paperImport.findFirst({ where: { id, userId } })
  return job
}

function toDto(job: NonNullable<Awaited<ReturnType<typeof loadOwnedJob>>>): ImportJobDto {
  const pageTexts = Array.isArray(job.pageTexts) ? (job.pageTexts as string[]) : []
  const base: ImportJobDto = {
    id: job.id,
    status: (job.status as ImportJobDto["status"]) ?? "ready",
    fileName: job.fileName,
    subject: job.subject,
    title: job.title,
    pageCount: job.pageCount,
    mode: (job.mode as ImportJobDto["mode"]) ?? "text",
    meta: { ...EMPTY_IMPORT_META, ...((job.meta as ImportMeta | null) ?? {}) },
    candidates: (Array.isArray(job.candidates) ? job.candidates : []) as unknown as ImportCandidate[],
    error: job.error,
    paperId: job.paperId,
    createdAt: job.createdAt.toISOString(),
  }
  // 切题中附带分块计划(文本版按页聚合;扫描版逐页一块),客户端按序驱动
  if (job.status === "splitting") {
    base.chunks =
      job.mode === "scan"
        ? Array.from({ length: job.pageCount }, (_, i) => ({ from: i + 1, to: i + 1 }))
        : planTextChunks(pageTexts)
  }
  return base
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })
  const { id } = await params
  const job = await loadOwnedJob(id, userId)
  if (!job) return Response.json({ error: "not_found" }, { status: 404 })
  return Response.json({ job: toDto(job) })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })
  const { id } = await params
  const job = await loadOwnedJob(id, userId)
  if (!job) return Response.json({ error: "not_found" }, { status: 404 })
  if (job.status === "finished") return Response.json({ error: "finished" }, { status: 409 })

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return Response.json({ error: "bad_body" }, { status: 400 })
  const op = String(body.op ?? "")
  const candidates = (Array.isArray(job.candidates) ? job.candidates : []) as unknown as ImportCandidate[]

  if (op === "save") {
    // 候选整包回写(客户端是真源:状态/编辑都在前端改好后落库);卷名顺带可改
    const next = Array.isArray(body.candidates) ? (body.candidates as ImportCandidate[]) : candidates
    const data: Record<string, unknown> = {
      candidates: next.slice(0, 500),
    }
    if (typeof body.title === "string" && body.title.trim()) data.title = body.title.trim().slice(0, 80)
    const updated = await prisma.paperImport.update({ where: { id: job.id }, data })
    return Response.json({ job: toDto(updated) })
  }

  if (op === "ready") {
    const updated = await prisma.paperImport.update({
      where: { id: job.id },
      data: { status: "ready" },
    })
    return Response.json({ job: toDto(updated) })
  }

  if (op === "aiSolve") {
    const key = String(body.key ?? "")
    const target = candidates.find((c) => c.key === key)
    if (!target) return Response.json({ error: "candidate_not_found" }, { status: 404 })
    const modelId = typeof body.modelId === "string" && body.modelId ? body.modelId : await resolveImportModelId(userId)
    if (!modelId) return Response.json({ error: "no_model" }, { status: 400 })
    try {
      const answer = await aiSolveCandidate(userId, modelId, job.subject, target)
      target.answer = answer
      target.answerSource = "ai"
      const updated = await prisma.paperImport.update({
        where: { id: job.id },
        data: { candidates: candidates as unknown as Prisma.InputJsonValue },
      })
      return Response.json({ job: toDto(updated) })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return Response.json({ error: "solve_failed", detail: msg }, { status: 502 })
    }
  }

  if (op === "resplit") {
    // 重切一页:替换该页上仍处 wait 的候选(done/skip 保留,不覆盖人工结论)
    const pageNo = Number(body.page)
    if (!Number.isFinite(pageNo) || pageNo < 1 || pageNo > job.pageCount) {
      return Response.json({ error: "bad_page" }, { status: 400 })
    }
    const modelId = typeof body.modelId === "string" && body.modelId ? body.modelId : await resolveImportModelId(userId)
    if (!modelId) return Response.json({ error: "no_model" }, { status: 400 })

    const buffer = await readFile(importPdfPath(job.id))
    const keep = candidates.filter((c) => !(c.page === pageNo && c.state === "wait"))
    let fresh: ImportCandidate[] = []
    let continuation = ""
    try {
      if (job.mode === "scan") {
        const dataUrl = await renderPdfPageDataUrl(buffer, pageNo)
        const r = await runScanSplitPage({ userId, modelId, imageDataUrl: dataUrl, pageNo })
        fresh = r.questions
        continuation = r.continuation
      } else {
        const pageTexts = Array.isArray(job.pageTexts) ? (job.pageTexts as string[]) : []
        const r = await runTextSplitChunk({
          userId,
          modelId,
          text: buildChunkText(pageTexts, pageNo, pageNo),
          from: pageNo,
          to: pageNo,
        })
        fresh = r.questions
        continuation = r.continuation
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return Response.json({ error: "split_failed", detail: msg }, { status: 502 })
    }
    // 重切块没有前文:跨页延续文本拼到本页第一题 stem 前,防丢文
    if (continuation) {
      if (fresh.length) fresh[0] = { ...fresh[0], stem: `${continuation} ${fresh[0].stem}`.trim() }
      else {
        const prev = [...keep].reverse().find((c) => c.page === pageNo - 1 && c.state === "wait")
        if (prev) prev.stem = `${prev.stem} ${continuation}`.trim()
      }
    }
    fresh = fresh.map((c) => ({ ...c, key: nanoid(10) }))
    let dbRefs: Array<{ stem: string; ref: string }> = []
    try {
      dbRefs = await loadDupRefs(prisma, userId, job.subject)
    } catch (err) {
      console.error("[pdf-import] loadDupRefs failed:", err)
    }
    const refs = [...dbRefs, ...keep.map((c) => ({ stem: c.stem, ref: `本卷第 ${c.number || "?"} 题` }))]
    markDuplicates(fresh, refs)
    const nextCandidates = [...keep, ...fresh].slice(0, 500)
    const updated = await prisma.paperImport.update({
      where: { id: job.id },
      data: { candidates: nextCandidates as unknown as Prisma.InputJsonValue },
    })
    return Response.json({ job: toDto(updated), added: fresh.length })
  }

  return Response.json({ error: "bad_op" }, { status: 400 })
}
