/**
 * PDF 录题 · 分块切题(POST {from, to, modelId?}):
 * 客户端按块驱动(每块几页),本路由跑 AI 切题并追加候选——单请求控制在几十秒内,
 * 前端能按块显示进度、失败可单块重试。continuation(跨块延续)拼进前块末题 stem。
 */
import { NextRequest } from "next/server"
import { readFile } from "fs/promises"
import type { Prisma } from "@/generated/prisma/client"
import { getUserId } from "@/lib/api-auth"
import { prisma } from "@/lib/db"
import {
  buildChunkText,
  importPdfPath,
  loadDupRefs,
  markDuplicates,
  renderPdfPageDataUrl,
  resolveImportModelId,
  runScanSplitPage,
  runTextSplitChunk,
} from "@/lib/papers/pdf-import.server"
import { EMPTY_IMPORT_META, type ImportCandidate, type ImportJobDto, type ImportMeta } from "@/lib/papers/pdf-import"
import { nanoid } from "nanoid"

export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const userId = await getUserId(req)
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 })
  const { id } = await params
  const job = await prisma.paperImport.findFirst({ where: { id, userId } })
  if (!job) return Response.json({ error: "not_found" }, { status: 404 })
  if (job.status === "finished") return Response.json({ error: "finished" }, { status: 409 })

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return Response.json({ error: "bad_body" }, { status: 400 })
  const from = Number(body.from)
  const to = Number(body.to)
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to < from || to > job.pageCount) {
    return Response.json({ error: "bad_range" }, { status: 400 })
  }
  const modelId =
    typeof body.modelId === "string" && body.modelId ? body.modelId : await resolveImportModelId(userId)
  if (!modelId) return Response.json({ error: "no_model" }, { status: 400 })

  const candidates = (Array.isArray(job.candidates) ? job.candidates : []) as unknown as ImportCandidate[]
  const lastNumber = candidates.reduce((m, c) => Math.max(m, c.number), 0)
  const buffer = job.mode === "scan" ? await readFile(importPdfPath(job.id)) : null

  let fresh: ImportCandidate[] = []
  let continuation = ""
  let meta: ImportMeta | null = null
  try {
    if (job.mode === "scan") {
      for (let p = from; p <= to; p++) {
        const dataUrl = await renderPdfPageDataUrl(buffer!, p)
        const r = await runScanSplitPage({ userId, modelId, imageDataUrl: dataUrl, pageNo: p })
        // 扫描版逐页调用:每页新 key;跨页延续交给块间统一的 continuation 合并
        fresh.push(...r.questions.map((c) => ({ ...c, page: p })))
        if (r.continuation && !continuation) continuation = r.continuation
      }
    } else {
      const pageTexts = Array.isArray(job.pageTexts) ? (job.pageTexts as string[]) : []
      const r = await runTextSplitChunk({
        userId,
        modelId,
        text: buildChunkText(pageTexts, from, to),
        from,
        to,
      })
      fresh = r.questions
      continuation = r.continuation
      meta = r.meta
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[pdf-import] split ${job.id} p${from}-${to} failed:`, msg)
    return Response.json({ error: "split_failed", detail: msg }, { status: 502 })
  }

  // 修正块内 page 缺省 + 新 key
  fresh = fresh.map((c) => ({ ...c, key: nanoid(10), page: c.page >= from && c.page <= to ? c.page : from }))

  // 跨块延续:拼进上一块末题(按现存候选末尾找页码在本块之前的最后一条);无前题则并入本块首题
  if (continuation) {
    if (candidates.length) {
      const last = candidates[candidates.length - 1]
      last.stem = `${last.stem} ${continuation}`.replace(/\s+/g, " ").trim()
    } else if (fresh.length) {
      fresh[0] = { ...fresh[0], stem: `${continuation} ${fresh[0].stem}`.replace(/\s+/g, " ").trim() }
    }
  }

  // meta 首次命中落卷头信息(只补空,不覆盖上传表单显式给的 year/examType);无命中则不动库里的 meta
  if (meta) {
    const cur = { ...EMPTY_IMPORT_META, ...((job.meta as ImportMeta | null) ?? {}) }
    meta = {
      title: cur.title ?? meta.title,
      year: cur.year ?? meta.year,
      examType: cur.examType ?? meta.examType,
      totalScore: cur.totalScore ?? meta.totalScore,
      durationMin: cur.durationMin ?? meta.durationMin,
    }
  }

  // 去重:新候选对标「题库已有题(练题池+真题投影)+ 本卷已切候选」
  let dbRefs: Array<{ stem: string; ref: string }> = []
  try {
    dbRefs = await loadDupRefs(prisma, userId, job.subject)
  } catch (err) {
    console.error("[pdf-import] loadDupRefs failed:", err)
  }
  const dupRefs = [...dbRefs, ...candidates.map((c) => ({ stem: c.stem, ref: `本卷第 ${c.number || "?"} 题` }))]
  markDuplicates(fresh, dupRefs)

  const nextCandidates = [...candidates, ...fresh].slice(0, 500)
  const updated = await prisma.paperImport.update({
    where: { id: job.id },
    data: {
      candidates: nextCandidates as unknown as Prisma.InputJsonValue,
      meta: meta ? (meta as unknown as Prisma.InputJsonValue) : undefined,
    },
  })

  const dto: ImportJobDto = {
    id: updated.id,
    status: (updated.status as ImportJobDto["status"]) ?? "ready",
    fileName: updated.fileName,
    subject: updated.subject,
    title: updated.title,
    pageCount: updated.pageCount,
    mode: (updated.mode as ImportJobDto["mode"]) ?? "text",
    meta: { ...EMPTY_IMPORT_META, ...((updated.meta as ImportMeta | null) ?? {}) },
    candidates: (Array.isArray(updated.candidates) ? updated.candidates : []) as unknown as ImportCandidate[],
    error: updated.error,
    paperId: updated.paperId,
    createdAt: updated.createdAt.toISOString(),
  }
  return Response.json({ job: dto, added: fresh.length })
}
