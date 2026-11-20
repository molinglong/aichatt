/**
 * PDF 录题服务端层(仅 server):
 * - 逐页文本抽取(unpdf,文本版)/ 逐页 PNG 渲染(pdfjs legacy + @napi-rs/canvas,扫描版)
 * - AI 切题:按页块调 generateText 出候选题 JSON(continuation 跨块拼接),扫描版走视觉
 * - 去重:候选与题库已有题(Question,含公共库)做归一化指纹比对
 * - AI 解:缺答案候选就地补答案(answerSource='ai',与真卷 AI 参考答案车道同口径)
 * - 完成建卷:Paper + PaperQuestion(未被跳过的整卷投影)+ Question(state=done 且有答案,练题池)
 */
import { generateText } from 'ai'
import { extractText, getDocumentProxy, getResolvedPDFJS } from 'unpdf'
import { readFile, writeFile } from 'fs/promises'
import { nanoid } from 'nanoid'
import { prisma } from '@/lib/db'
import { resolveChatModel } from '@/lib/ai/model-resolver.server'
import { getEffectiveModels } from '@/lib/ai/registry'
import { libraryScopes } from '@/lib/library-scope'
import {
  EMPTY_IMPORT_META,
  DUP_SIMILAR_THRESHOLD,
  chunkPages,
  normalizeStem,
  stemSimilarity,
  type ImportCandidate,
  type ImportMeta,
} from './pdf-import'
import type { PrismaClient } from '@/generated/prisma/client'

type Db = PrismaClient

/** 上传 PDF 落盘目录:与真题导入器同一 sourceDir 约定(仓库相对路径记 Paper.sourceDir) */
export function importDir(importId: string): string {
  return `${process.cwd()}/data/exam-papers/${importId}`
}

export function importPdfPath(importId: string): string {
  return `${importDir(importId)}/source.pdf`
}

/** 逐页抽取文本;unpdf 不带 mergePages 时 text 为逐页数组 */
export async function extractPdfPages(buffer: Buffer): Promise<{ pageCount: number; pageTexts: string[] }> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer))
  const { totalPages, text } = await extractText(pdf)
  return { pageCount: totalPages, pageTexts: text as string[] }
}

/** 扫描版单页转 PNG dataURL(scale≈2 保证小字清晰,视觉模型吃得动) */

/** 默认模型:沿用用户最近一次对话的模型;不可用则取可见模型列表首个(扫描版优先支持视觉的) */
export async function resolveImportModelId(userId: string, needVision = false): Promise<string | null> {
  const models = await getEffectiveModels(userId)
  if (needVision) return models.find((m) => m.supportsVision)?.id ?? null
  const conv = await prisma.conversation.findFirst({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    select: { model: true },
  })
  if (conv?.model && models.some((m) => m.id === conv.model)) return conv.model
  return models[0]?.id ?? null
}

// ── AI 切题 ──────────────────────────────────────────────────────────────

const SPLIT_SYSTEM =
  '你是试卷切题助手。给你一份试卷某几页的纯文本(带〔第N页〕页码标记),把其中的题目完整切出来。规则:' +
  '1) 题干保留原文,不改写不翻译,数学式/上下标保持原样;' +
  '2) 选择题把每个选项原文拆进 options(去掉「A.」字母前缀),非选择题 options 给空数组 [];' +
  '3) answer 只从文本里实际出现的答案抽(卷内答案区/题后「答案:」),找不到就给空字符串,绝对不要自己解题或编答案;' +
  '4) kind:选择/填选类给 "choice",填空/解答/作图/简答等给 "answer";多项选择 multiple 给 true;' +
  '5) score 从题面「(N分)」抽,抽不到给 0;' +
  '6) topic 给一个 2~8 字考点短语(如「相反数」「一元一次不等式组」),拿不准给空串;' +
  '7) page 给该题起始页码(取自〔第N页〕标记,整数);' +
  '8) 若某段文字开头没有新题号、是上一题的延续,把它并入该题 stem,不要单独成题;' +
  '9) 若本块第一行就是上一块的延续(无题号开头),把这段文字放进输出顶层的 continuation 字段,其余题照常切;' +
  '10) 只输出一个 JSON 对象,不要任何其他文字或代码围栏:' +
  '{"meta":{"title":null,"year":null,"examType":null,"totalScore":null,"durationMin":null},"continuation":"","questions":[{"number":1,"section":"一、选择题","kind":"choice","multiple":false,"score":2,"stem":"…","options":["…"],"answer":"B","topic":"…","page":1}]}' +
  '。meta 只在文本含卷头(标题/满分/考试时间/年份)时填写,抽不到的字段给 null,其余调用一律原样给全 null。'

interface RawSplitResult {
  meta: ImportMeta | null
  continuation: string
  questions: ImportCandidate[]
}

interface SplitChunkParams {
  userId: string
  modelId: string
  /** 带页码标记的块文本 */
  text: string
  /** 本块覆盖页码(1-based,含端点) */
  from: number
  to: number
}

/** 从模型输出抠 JSON 对象(宽容 ``` 围栏/前后杂文) */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const parsed = JSON.parse(m[0])
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const asStr = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/** 模型原始 question 元素 → 规整候选(非法项丢弃;缺 number 顺延;score/kind/page 兜底) */
function normalizeRawQuestions(
  raw: unknown,
  from: number,
  to: number,
  prevLastNumber: number
): ImportCandidate[] {
  const arr = Array.isArray(raw) ? raw : []
  const out: ImportCandidate[] = []
  let last = prevLastNumber
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue
    const o = it as Record<string, unknown>
    const stem = asStr(o.stem)
    if (!stem) continue
    const kind = o.kind === 'choice' ? 'choice' : 'answer'
    const options = Array.isArray(o.options)
      ? o.options.filter((x): x is string => typeof x === 'string' && !!asStr(x)).map((x) => asStr(x))
      : []
    const numberRaw = Number(o.number)
    const number = Number.isFinite(numberRaw) && numberRaw > 0 ? Math.round(numberRaw) : last + 1
    last = number
    const scoreRaw = Number(o.score)
    const pageRaw = Number(o.page)
    out.push({
      key: nanoid(10),
      number,
      section: asStr(o.section).slice(0, 40),
      kind,
      multiple: o.multiple === true,
      score: Number.isFinite(scoreRaw) && scoreRaw > 0 ? Math.round(scoreRaw) : 0,
      stem: stem.replace(/\s+/g, ' ').trim(),
      options,
      answer: asStr(o.answer),
      answerSource: asStr(o.answer) ? 'paper' : '',
      topic: asStr(o.topic).slice(0, 16),
      page: Number.isFinite(pageRaw) && pageRaw >= from && pageRaw <= to ? Math.round(pageRaw) : from,
      state: 'wait',
      dup: '',
    })
  }
  return out
}

/** 文本版:单块切题。返回规整候选 + continuation(跨块拼接由调用方处理) */
export async function runTextSplitChunk(params: SplitChunkParams): Promise<RawSplitResult> {
  const r = await resolveChatModel({ userId: params.userId, modelId: params.modelId, logTag: '[pdf-import]' })
  if (!r.ok) throw new Error('模型不可用:' + (errText(r.response) ?? 'resolve_failed'))
  const { text } = await generateText({
    model: r.provider(r.realModelId),
    system: SPLIT_SYSTEM,
    prompt: `切出下面这页文本(第 ${params.from}~${params.to} 页)里的题目:\n\n${params.text}`,
    temperature: 0.1,
  })
  const obj = extractJsonObject(text)
  if (!obj) throw new Error('切题输出不是合法 JSON')
  const metaRaw = (obj.meta && typeof obj.meta === 'object' ? obj.meta : null) as Record<string, unknown> | null
  const meta: ImportMeta | null = metaRaw
    ? {
        title: asStr(metaRaw.title) || null,
        year: asStr(metaRaw.year) || null,
        examType: asStr(metaRaw.examType) || null,
        totalScore: numOrNull(metaRaw.totalScore),
        durationMin: numOrNull(metaRaw.durationMin),
      }
    : null
  return {
    meta,
    continuation: asStr(obj.continuation),
    questions: normalizeRawQuestions(obj.questions, params.from, params.to, 0),
  }
}

const SCAN_PAGE_SYSTEM =
  '你是试卷切题助手。给你一张试卷页面的图,把这一页里的题目完整切出来。规则:' +
  '1) 题干按图上原文逐字转录,数学式保持原样,不要改写;' +
  '2) 选择题选项拆进 options(去掉「A.」前缀),非选择题 options 给 [] ;' +
  '3) answer 只抽图上实际出现的答案,图上没有就给空串,绝不自己编答案;' +
  '4) kind:选择类 "choice",其余 "answer";5) score 从题面「(N分)」抽,没有给 0;' +
  '6) topic 给 2~8 字考点短语,拿不准给空串;' +
  '7) 本页第一段若无题号开头(上一页题目的延续),把它放进顶层 continuation;' +
  '8) 只输出一个 JSON 对象:{"continuation":"","questions":[{"number":1,"section":"一、选择题","kind":"choice","multiple":false,"score":2,"stem":"…","options":["…"],"answer":"","topic":"…","page":N}]}'

/** 扫描版:单页视觉切题 */
export async function runScanSplitPage(params: {
  userId: string
  modelId: string
  imageDataUrl: string
  pageNo: number
}): Promise<{ continuation: string; questions: ImportCandidate[] }> {
  const r = await resolveChatModel({ userId: params.userId, modelId: params.modelId, logTag: '[pdf-import-scan]' })
  if (!r.ok) throw new Error('模型不可用:' + (errText(r.response) ?? 'resolve_failed'))
  if (!r.modelDef.supportsVision) throw new Error('当前模型不支持看图,请在设置里换一个支持视觉的模型后重试')
  const { text } = await generateText({
    model: r.provider(r.realModelId),
    system: SCAN_PAGE_SYSTEM,
    prompt: [
      {
        role: 'user',
        content: [
          { type: 'text', text: `这是第 ${params.pageNo} 页,切出本页所有题目。page 一律填 ${params.pageNo}。` },
          { type: 'image', image: params.imageDataUrl },
        ],
      },
    ],
    temperature: 0.1,
  })
  const obj = extractJsonObject(text)
  if (!obj) throw new Error('视觉切题输出不是合法 JSON')
  return {
    continuation: asStr(obj.continuation),
    questions: normalizeRawQuestions(obj.questions, params.pageNo, params.pageNo, 0),
  }
}

// ── 去重 ─────────────────────────────────────────────────────────────────

interface DupRef { stem: string; ref: string }

/** 取题库已有题的指纹参照(练题池 Question + 整卷投影 PaperQuestion:自己 + 公共管理员名下;subject 对齐) */
export async function loadDupRefs(db: Db, userId: string, subject: string): Promise<DupRef[]> {
  const scopes = await libraryScopes(userId)
  const [qRows, pqRows] = await Promise.all([
    db.question.findMany({
      where: { subject, userId: { in: scopes } },
      select: { stem: true, sourceRef: true, number: true },
      take: 5000,
    }),
    db.paperQuestion.findMany({
      where: { userId: { in: scopes }, stem: { not: '' }, paper: { subject } },
      select: { stem: true, number: true, paper: { select: { title: true } } },
      take: 5000,
    }),
  ])
  const refs: DupRef[] = qRows.map((r) => ({
    stem: normalizeStem(r.stem),
    ref: r.sourceRef || (r.number ? `题库第 ${r.number} 题` : '题库已有题'),
  }))
  for (const r of pqRows) {
    refs.push({
      stem: normalizeStem(r.stem),
      ref: `${r.paper.title} · 第 ${r.number} 题`,
    })
  }
  return refs
}

/** 给候选标重复(与题库已有题 + 本批内部)。inplace 修改并返回 dup 命中数 */
export function markDuplicates(candidates: ImportCandidate[], refs: DupRef[]): number {
  let hits = 0
  const seen: DupRef[] = []
  for (const c of candidates) {
    const norm = normalizeStem(c.stem)
    if (norm.length < 6) continue
    let best: { ref: string; sim: number } | null = null
    for (const r of [...refs, ...seen]) {
      if (!r.stem) continue
      const sim = r.stem === norm ? 1 : stemSimilarity(norm, r.stem)
      if (sim >= DUP_SIMILAR_THRESHOLD && (!best || sim > best.sim)) best = { ref: r.ref, sim }
    }
    if (best) {
      const pct = Math.round(best.sim * 100)
      c.dup = best.sim >= 0.999 ? `与「${best.ref}」重复` : `相似 ${pct}% · ${best.ref}`
      hits++
    } else {
      c.dup = ''
    }
    seen.push({ stem: norm, ref: `本卷第 ${c.number || '?'} 题` })
  }
  return hits
}

// ── AI 解 ────────────────────────────────────────────────────────────────

/** 缺答案候选就地 AI 解(答案+解析;答案来源标 ai,与真卷 AI 参考车道口径一致) */
export async function aiSolveCandidate(
  userId: string,
  modelId: string,
  subject: string,
  candidate: ImportCandidate
): Promise<string> {
  const r = await resolveChatModel({ userId, modelId, logTag: '[pdf-import-solve]' })
  if (!r.ok) throw new Error('模型不可用:' + (errText(r.response) ?? 'resolve_failed'))
  const kindLabel = candidate.kind === 'choice' ? '选择题' : '解答/填空题'
  const body = [candidate.stem, ...candidate.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`)].join('\n')
  const { text } = await generateText({
    model: r.provider(r.realModelId),
    system:
      '你是解题助手。解出给定题目:选择题输出「答案字母\\n解析:…」,解答/填空题输出完整解答过程与最终答案。只输出答案与解析本身,不要寒暄或复述题目。',
    prompt: `(${kindLabel}${candidate.score ? `,${candidate.score} 分` : ''})\n${body}`,
    temperature: 0.2,
  })
  return text.trim()
}

// ── 完成建卷 ─────────────────────────────────────────────────────────────

export interface FinishResult {
  slug: string
  paperId: string
  paperQuestionCount: number
  questionCount: number
}

/** 选项加「A. 」前缀(Question.stem 内嵌选项 / PaperQuestion.options 的既定格式) */
const lettered = (options: string[]) => options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`)

/**
 * 完成并建卷:
 * - Paper:slug = pdf-<nanoid>,meta 取 AI 卷头抽取(缺省兜底),questionCount = PaperQuestion 数;
 * - PaperQuestion:未被跳过(state !== 'skip')且有题干的候选 → 整卷投影层(真题池/试装/成绩关联);
 *   answer 空 = null(合法,等待补答案);state='wait' 也进卷面层,但不进练题池;
 * - Question(练题池):仅 state='done' 且答案非空的候选(source='exam_import',挂 paperId/number/score/topic)。
 */
export async function finishImport(db: Db, userId: string, importId: string): Promise<FinishResult> {
  const job = await db.paperImport.findFirst({ where: { id: importId, userId } })
  if (!job) throw new Error('作业不存在')
  if (job.status === 'finished' && job.paperId) {
    const p = await db.paper.findUnique({ where: { id: job.paperId } })
    if (p) return { slug: p.slug, paperId: p.id, paperQuestionCount: p.questionCount, questionCount: 0 }
  }
  const candidates = (Array.isArray(job.candidates) ? job.candidates : []) as unknown as ImportCandidate[]
  const meta = { ...EMPTY_IMPORT_META, ...(Array.isArray(job.meta) ? {} : (job.meta as ImportMeta | null) ?? {}) }
  const usable = candidates.filter((c) => c.stem && c.state !== 'skip')
  if (!usable.length) throw new Error('没有可入库的题目(全部被跳过或为空)')

  const totalScore =
    meta.totalScore ?? usable.reduce((s, c) => s + (c.score > 0 ? c.score : 0), 0)
  const slug = `pdf-${nanoid(8).toLowerCase()}`
  const title = (job.title || job.fileName.replace(/\.pdf$/i, '')).slice(0, 80)

  const paperQuestions = usable.map((c) => ({
    userId,
    number: c.number > 0 ? c.number : 0,
    section: c.section || null,
    kind: c.kind,
    multiple: c.multiple,
    score: c.score > 0 ? c.score : 0,
    stem: c.stem,
    options: c.kind === 'choice' ? lettered(c.options) : [],
    images: [] as string[],
    answer: c.answer || null,
    answerSource: c.answer ? (c.answerSource === 'ai' ? 'ai' : 'official') : 'official',
    topics: c.topic ? [c.topic] : [],
  }))
  // number 0 是 AI 拆不出题号的兜底,unique(paperId,number) 只允许一条 0;
  // 去重后行数才是卷卡真实题数(questionCount 曾用 usable.length,题号撞车时会虚高)
  const seenNumbers = new Set<number>()
  const pqRows = paperQuestions.filter((r) => {
    if (seenNumbers.has(r.number)) return false
    seenNumbers.add(r.number)
    return true
  })

  const paper = await db.paper.create({
    data: {
      userId,
      slug,
      title,
      subject: job.subject,
      year: meta.year,
      examType: meta.examType,
      totalScore: totalScore > 0 ? Math.round(totalScore) : 100,
      durationMin: meta.durationMin && meta.durationMin > 0 ? Math.round(meta.durationMin) : 0,
      questionCount: pqRows.length,
      pageCount: job.pageCount,
      sourceDir: `data/exam-papers/${job.id}`,
    },
  })

  await db.paperQuestion.createMany({ data: pqRows.map((r) => ({ ...r, paperId: paper.id })) })

  const poolRows = candidates
    .filter((c) => c.state === 'done' && c.answer && c.stem)
    .map((c) => ({
      userId,
      subject: job.subject,
      topic: c.topic || null,
      kind: c.kind,
      stem: c.kind === 'choice' && c.options.length ? `${c.stem}\n${lettered(c.options).join('\n')}` : c.stem,
      answer: c.answer,
      difficulty: 'medium',
      source: 'exam_import',
      sourceRef: `${title} · 第 ${c.number || '?'} 题`,
      paperId: paper.id,
      number: c.number > 0 ? c.number : null,
      score: c.score > 0 ? c.score : null,
    }))
  if (poolRows.length) {
    // 同卷同题号幂等:重跑完成时先清本卷练题池行再插(与整卷投影层对齐)
    await db.question.deleteMany({ where: { paperId: paper.id, source: 'exam_import' } })
    await db.question.createMany({ data: poolRows })
  }

  await db.paperImport.update({ where: { id: job.id }, data: { status: 'finished', paperId: paper.id } })
  return { slug: paper.slug, paperId: paper.id, paperQuestionCount: pqRows.length, questionCount: poolRows.length }
}

// ── 杂项 ─────────────────────────────────────────────────────────────────

function numOrNull(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

/** resolveChatModel 失败时的用户可读文案(statusText 在 fetch API 里恒空,按状态码映射) */
function errText(res: Response): string | null {
  if (res.status === 401) return '未登录'
  if (res.status === 429) return '公共额度已用完,请换个模型或明天再试'
  if (res.status === 400) return '模型/Key 配置不可用,请在设置里检查'
  return `调用失败(${res.status})`
}

/** 打开 PDF 文档(渲染/页资产共用)。
 *  两个坑都必须绕:
 *  1) pdfjs 必须走 unpdf 的 getResolvedPDFJS:unpdf 会在 globalThis.pdfjsWorker 常驻自己的
 *     WorkerMessageHandler(内置 6.1.200),直接 import pdfjs-dist 的 fake worker 会捡到它,
 *     版本一不同就报 "API version does not match the Worker version"。同一副本则永不错配。
 *  2) unpdf 内联的 pdfjs 被 Next 打包后,内部动态 import('@napi-rs/canvas') 会失败
 *     ("@napi-rs/canvas is not available in this environment"),必须显式注入 canvas 工厂。 */
async function openImportPdfDocument(buffer: Buffer) {
  const [pdfjs, { createIsomorphicCanvasFactory }, canvasMod] = await Promise.all([
    getResolvedPDFJS(),
    import('unpdf'),
    import('@napi-rs/canvas'),
  ])
  const Factory = await createIsomorphicCanvasFactory(() => import('@napi-rs/canvas'))
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    cMapUrl: 'node_modules/pdfjs-dist/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/',
    wasmUrl: 'node_modules/pdfjs-dist/wasm/',
    // 运行时有效(6.1 fake-worker 路径读 params.canvasFactory);类型层尚未声明,断言压掉
    canvasFactory: new Factory(),
  } as Parameters<typeof pdfjs.getDocument>[0]).promise
  return { doc, createCanvas: canvasMod.createCanvas }
}

/** 扫描版单页转 PNG dataURL(scale=2 保证小字清晰,视觉模型吃得动) */
export async function renderPdfPageDataUrl(buffer: Buffer, pageNo: number, scale = 2): Promise<string> {
  const { doc, createCanvas } = await openImportPdfDocument(buffer)
  const page = await doc.getPage(Math.min(Math.max(1, pageNo), doc.numPages))
  const viewport = page.getViewport({ scale })
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
  const ctx = canvas.getContext('2d')
  await page.render({ canvas, canvasContext: ctx, viewport } as unknown as Parameters<typeof page.render>[0]).promise
  const png = await canvas.encode('png')
  page.cleanup()
  return `data:image/png;base64,${png.toString('base64')}`
}

/** 页资产:页图(dataUrl,2x 渲染,落盘缓存)+ 文本项坐标(PDF pt,落库缓存)。
 *  客户端审核台全部基于此(零 pdfjs),扫描版同链路。 */
export async function loadPageAssets(
  db: Db,
  job: { id: string; pageCount: number; pageBoxes: unknown },
  pageNo: number
): Promise<{ dataUrl: string; width: number; height: number; items: Array<{ s: string; x: number; y: number; w: number; h: number }> }> {
  const buffer = await readFile(importPdfPath(job.id))
  // 同 renderPdfPageDataUrl:unpdf 同副本 + 显式 canvas 工厂(见 openImportPdfDocument 注释)
  const { doc, createCanvas } = await openImportPdfDocument(buffer)
  const safePage = Math.min(Math.max(1, pageNo), doc.numPages)
  const page = await doc.getPage(safePage)
  const viewport1 = page.getViewport({ scale: 1 })
  const width = Math.round(viewport1.width)
  const height = Math.round(viewport1.height)

  // 页图:2x 渲染,落盘缓存(幂等)
  const pngFile = `${importDir(job.id)}/page-${String(safePage).padStart(2, '0')}.png`
  let pngBuf: Buffer | null = null
  try {
    pngBuf = await readFile(pngFile)
  } catch {
    pngBuf = null
  }
  if (!pngBuf) {
    const viewport2 = page.getViewport({ scale: 2 })
    const canvas = createCanvas(Math.ceil(viewport2.width), Math.ceil(viewport2.height))
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvas, canvasContext: ctx, viewport: viewport2 } as unknown as Parameters<typeof page.render>[0]).promise
    pngBuf = await canvas.encode('png')
    await writeFile(pngFile, pngBuf).catch(() => {})
  }

  // 文本项坐标:先查 DB 缓存(pageBoxes),缺了现算回填
  const boxesMap = (job.pageBoxes && typeof job.pageBoxes === 'object' && !Array.isArray(job.pageBoxes)
    ? (job.pageBoxes as Record<string, unknown>)
    : {}) as Record<string, { w: number; h: number; items: Array<{ s: string; x: number; y: number; w: number; h: number }> }>
  let layout = boxesMap[String(safePage)]
  if (!layout || !Array.isArray(layout.items)) {
    const tc = await page.getTextContent()
    const items: Array<{ s: string; x: number; y: number; w: number; h: number }> = []
    for (const raw of tc.items) {
      if (!('str' in raw)) continue
      const it = raw as { str: string; transform: number[]; width: number; height: number }
      if (!it.str || typeof it.transform?.[4] !== 'number' || typeof it.transform?.[5] !== 'number') continue
      const h = it.height || 10
      items.push({
        s: it.str,
        x: it.transform[4],
        y: viewport1.height - it.transform[5] - h, // 基线 → 顶部,统一 y 自页顶向下
        w: it.width,
        h: h * 1.35,
      })
    }
    layout = { w: width, h: height, items }
    const next = { ...boxesMap, [String(safePage)]: layout }
    await db.paperImport
      .update({ where: { id: job.id }, data: { pageBoxes: next } })
      .catch(() => {})
  }
  page.cleanup()
  return { dataUrl: `data:image/png;base64,${pngBuf.toString('base64')}`, width, height, items: layout.items }
}
export function planTextChunks(pageTexts: string[]) {
  return chunkPages(pageTexts)
}

// ── 拍照/图片 → PDF(拍照上传管线:与 PDF 上传共用下游切题/页图/审核台) ──

/** 单作业图片页数上限 */
export const MAX_IMPORT_IMAGES = 30

/** 归一化单图:EXIF 自动转正 + 白底压平 + 尺寸收进上限 + JPEG 重编码。
 *  上限口径:宽 1600/高 2400 内——下游页图按 2x 渲染后≈原像素,视觉模型吃得动、体积可控。 */
async function normalizeImageToJpeg(buf: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const sharp = (await import('sharp')).default
  const { data, info } = await sharp(buf, { failOn: 'error' })
    .rotate()
    .flatten({ background: '#ffffff' })
    .resize({ width: 1600, height: 2400, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 86, mozjpeg: true })
    .toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

/** N 张图片 → 单份多页 PDF(每页一图,页序即数组序)。页盒 = 像素 ÷2 pt,
 *  这样审核台 2x 渲染出的页图正好 1:1 原像素,不放大不糊。 */
export async function imagesToPdfBuffer(images: Buffer[]): Promise<Buffer> {
  const { PDFDocument } = await import('pdf-lib')
  const pdf = await PDFDocument.create()
  for (const buf of images) {
    const { data, width, height } = await normalizeImageToJpeg(buf)
    const jpg = await pdf.embedJpg(data)
    const page = pdf.addPage([width / 2, height / 2])
    page.drawImage(jpg, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() })
  }
  return Buffer.from(await pdf.save())
}

/** 块文本拼装:〔第N页〕标记 + 页文本 */
export function buildChunkText(pageTexts: string[], from: number, to: number): string {
  const parts: string[] = []
  for (let p = from; p <= to; p++) {
    const t = (pageTexts[p - 1] ?? '').trim()
    if (t) parts.push(`〔第${p}页〕\n${t}`)
  }
  return parts.join('\n\n')
}
