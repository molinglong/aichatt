import { Fragment } from 'react'
import { auth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { WordSheetToolbar, type SheetListOption } from '@/components/english/WordSheetToolbar'
import { PaperBrandSeal } from '@/components/papers/PaperBrandSeal'
import {
  SHEET_MODE_META,
  pickColls,
  pickSeeded,
  pruneForPrint,
  shuffleWithSeed,
  splitPages,
  type PrintWord,
  type SheetMode,
} from '@/lib/words/sheet'
import { passageKey, resolvePassageWords } from '@/lib/words/passage.server'
import { PRINT_BASE_CSS, PRINT_SHELL_UNCHAIN_CSS, printPageCss } from '@/lib/print/print-css'

/**
 * /papers/words —— 背词卷（可打印的 A4 背诵单）
 *
 * 定位：拟卷体系里的「另一种卷」——不是做题，是带去学校背的一张纸。
 * 打印走的是和拟卷同一套浏览器原生分页：本页注入 @media print 规则，
 * 解除根壳的 h-screen 裁剪链、隐藏侧栏/顶栏/工具条，只输出 A4 卷面。
 *
 * 参数（全部可收藏/可分享）：
 *   src=new|review|mix 词源  list=词单 slug  from=起始词号  to=结束词号  mode=A|B|C|D  mn=1|0 是否印助记
 *   sh=1 打乱词序(仅 B/D)  psg=1|0 附 AI 短文  dlg=1 附对话  dhl=none|first|zh 挖空提示  dseed=对话抽词种子
 * 智能选词（2026-11-16）：URL 里不带 list/from/to 时，新词卷自动按背词计划选取
 * （先取「我的词」里还没背过的，不够再从计划游标往后补，跳过已有词）；
 * 显式给了 list 或 from/to 就完全按手动来。src=review 印「今日到期复习词」。
 * 混合卷（2026-11-18）：src=mix 印「今日任务」——今日到期复习词在前 + 今日计划新词在后，
 * 序号连续，与 App 今日队列同构，一张纸覆盖今天全部任务；挂了计划才可用，
 * 词单/词号不适用。分节式：词表内两个小节头（与短文/对话节头同款）分开两段，
 * 一节跨页只在节首出现一次；一边为 0 就整卷退化（不画节头）。
 * 短文/对话取缓存里那篇（App 里生成过的同一篇）；没有就到工具条里现场生成。
 * 全拼页（2026-11-16 定案）：词表/短文/对话/答案全部连排，块级 break-inside: avoid
 * 让浏览器自动把「剩余空间」用起来——空间够就拼在同一张纸，不够就整节推到下一页。
 */
export const dynamic = 'force-dynamic'

const WS_CSS = `
@media print {
  /* 公共骨架(@page/html,body 解锁/壳豁免链)收敛在 @/lib/print/print-css,
     纪律与坑清单见其文件头;14mm 15mm = 原 .ws-page padding(2026-11-18 修「第二页起头部太靠上」) */
  ${printPageCss()}
  ${PRINT_BASE_CSS}
  ${PRINT_SHELL_UNCHAIN_CSS}
  .ws-noprint { display: none !important; }
  /* 卷头给钤印让位(与 PassageDialog 同口径 84px):@page margin 后 .ws-page padding 归零,
     钤印从「卷头上方 padding 区」落到卷头行内,不左移姓名栏会与「姓名____」文字重叠
     (2026-11-18 pdf 几何探针实测:姓名 x=477..555 / 钤印框 x=496..555 双重叠)。 */
  .ws-head { padding-right: 84px; }
  /* Next dev 报错浮标（chunk 失效 toast）是 body 直挂元素，不挡会印进卷面 */
  nextjs-portal { display: none !important; }
  /* 屏幕上的滚动容器在打印时必须解锁，否则只会输出第一页 */
  .ws-scroll { height: auto !important; max-height: none !important; overflow: visible !important; }
  /* 屏显容器的 px/py 在打印时归零：外层 padding 会把每张卷面整体下顶，
     恰好满页高的卷面被挤出一条到下一页 → 每张卷面后面跟一页幻影空白
     （2026-11-15 修「背词卷打印多出白页/页数翻倍」之一）。 */
  .ws-sheetwrap { padding: 0 !important; max-width: none !important; margin: 0 !important; }
  /* 全拼页（2026-11-16 定案「纸最少」）：卷面不再一张 section 一张物理页，
     词表/短文/对话/答案全部连排进一个容器，分页点交给浏览器的 break-inside: avoid
     （每个块都小于一页 → 永远整块移动、永不截断半块，剩余空间够就拼、不够就推下页）。
     容器打印时 min-height 必须归零：内容连排后 296mm 会把尾页撑出幻影白页（坑之二的同源）。 */
  .ws-page {
    margin: 0 !important; box-shadow: none !important;
    min-height: 0 !important; display: block !important;
    /* 边距已上交 @page:自身 padding 归零(否则第一页双倍顶距),宽度改 auto
       (定宽 210mm > @page 后内容区 180mm,会横向溢出被裁掉右缘) */
    padding: 0 !important; width: auto !important;
  }
}
.ws-page {
  width: 210mm; max-width: 100%; min-height: 297mm; padding: 14mm 15mm; margin: 0 auto 16px; background: #fff;
  color: #000; display: block;
  position: relative; /* 品牌钤印 PaperBrandSeal 定位锚(每页右上角 padding 区) */
  font-family: "Songti SC", "SimSun", "Noto Serif SC", -apple-system, "Microsoft YaHei", serif;
  box-shadow: 0 1px 3px rgb(0 0 0 / .12);
}
@media print { .ws-page { max-width: none !important; } }
.ws-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 10mm;
  border-bottom: 1.5px solid #000; padding-bottom: 5px; }
.ws-title { font-size: 13.5pt; font-weight: 700; letter-spacing: .02em; }
/* 打印禁灰阶（2026-11-17 升级）：11-16 只把浅灰提到深灰，用户实测仍发虚——
   这台打印机对灰字一概发虚，与拟卷 ComposedPaper / 品牌钤印同纪律：
   文字一律纯黑 #000，层次靠字号/字重/斜体区分；
   浅色只留给分隔线/虚线/默写横线等非文字元素。 */
.ws-sub { font-size: 8.5pt; color: #000; }
.ws-name { font-size: 9pt; color: #000; white-space: nowrap; }
.ws-body { margin-top: 5mm; }
.ws-cols { display: grid; grid-template-columns: repeat(var(--cols, 1), 1fr); column-gap: 10mm; }
.ws-row { display: flex; align-items: baseline; gap: 5px; padding: 2.6mm 0; border-bottom: 1px dotted #dcdcdc; }
.ws-no { flex: 0 0 16px; text-align: right; font-size: 7.5pt; color: #000; font-variant-numeric: tabular-nums; }
.ws-main { flex: 1; min-width: 0; }
.ws-line { display: flex; align-items: baseline; gap: 6px; }
.ws-en { flex: 0 0 auto; max-width: 45%; font-size: 11.5pt; font-weight: 700; line-height: 1.25;
  font-family: "Times New Roman", "Songti SC", serif; }
.ws-en.phr { text-decoration: underline dotted #6f6f78; text-underline-offset: 2px; }
/* 音标上卷（2026-11-17 用户点单）：A 对照单词旁印 IPA（B 默写纸不印——音标会泄漏拼写提示） */
.ws-ipa { flex: 0 0 auto; font-size: 8.5pt; font-family: -apple-system, "Microsoft YaHei", sans-serif; }
.ws-zh { flex: 1; min-width: 0; font-size: 9.5pt; color: #000; line-height: 1.5; }
.ws-pos { font-style: italic; color: #000; margin-right: 2px; font-size: 8.5pt; }
.ws-mn { margin-top: 1mm; padding-left: 1px; font-size: 8.5pt; color: #000; line-height: 1.55;
  border-left: 2px solid #d6d6dc; padding-left: 2mm; }
.ws-mn b { color: #000; font-weight: 600; margin-right: 2px; }
/* 搭配短语（2026-11-17 用户点单）：A/D 词行下方的考点搭配，core 优先限量 2 条 */
.ws-colls { display: block; margin-top: .8mm; font-size: 8.5pt; line-height: 1.55; color: #000; }
.ws-coll + .ws-coll::before { content: '·'; color: #8a8a90; margin: 0 4px; } /* 分隔点也是分隔线纪律:要能看清,用中灰 */
.ws-collen { color: #000; font-family: "Times New Roman", serif; margin-right: 2px; }
.ws-blank { flex: 0 0 132px; border-bottom: 1px solid #8a8a90; height: 1px; align-self: center; }
/* 全拼页块结构：块高都 < 一页，avoid 保证整块移动；屏显/打印共用同一套间距 */
.ws-block { page-break-inside: avoid; break-inside: avoid; }
.ws-bsec { margin-top: 9mm; }
/* 小节头：附卷内容不再占整页卷头，降级为一行分节标题 */
.ws-sechead { display: flex; align-items: baseline; justify-content: space-between; gap: 6mm;
  border-bottom: 1px solid #000; padding-bottom: 2mm; margin-bottom: 3mm; }
.ws-sechead b { font-size: 11pt; letter-spacing: .02em; }
.ws-sechead span { font-size: 8.5pt; color: #000; }
/* 混合卷词表节头（2026-11-18）：与短文/对话节头同款，插在节首；页首那个不另加顶距。
   右注用短文案（先复习，后学新 / 按计划选取）——半宽（双栏页/C 折叠列）也放得下。 */
.ws-mixhead { margin-top: 5mm; }
.ws-body > .ws-mixhead:first-child { margin-top: 0; }
/* 答案区：粗分隔线 + 遮挡提示（全拼页后答案紧贴对话，必须一眼能认出「这里是答案」） */
.ws-anshead { border-top: 1.5px solid #000; padding-top: 2.5mm; margin-top: 10mm; margin-bottom: 2.5mm;
  font-size: 9.5pt; font-weight: 700; color: #000; display: flex; justify-content: space-between; align-items: baseline; }
.ws-anshead span { font-weight: 400; font-size: 8.5pt; color: #000; }

/* 短文页（词单后面的续页） */
.ws-pbody { margin-top: 5mm; font-size: 11.5pt; line-height: 1.95; white-space: pre-wrap; }
.ws-pw { background: #ececec; font-weight: 700; padding: 0 2px; border-radius: 2px; }
.ws-pzh { margin-top: 6mm; border-top: 1px solid #dcdcdc; padding-top: 3mm;
  font-size: 9.5pt; line-height: 1.85; color: #000; white-space: pre-wrap; }
.ws-ph { font-size: 8.5pt; color: #000; margin-bottom: 2mm; }

/* C 折叠单（2026-11-18 重构为成对行）：旧版左右两列各自堆叠，词行(11pt+音标)与
   释义行(9pt/助记/折行)行高不同 → 每行漂 4px 逐行累积（实测第 14 行偏差 52px），
   第 n 个词和第 n 条释义对不上（用户打印反馈）。
   改为每词一行跨两半的 grid（.ws-fpair），行高取左右较大者，对齐由结构保证；
   中缝对折虚线仍用绝对定位 divider（贯穿全长，行间不断线）。 */
.ws-fold { position: relative; min-height: 220mm; }
.ws-fold-divider { position: absolute; top: 0; bottom: 0; left: 50%; border-left: 1px dashed #c4c4ca; }
.ws-fpair { display: grid; grid-template-columns: 1fr 1fr; }
.ws-fold > .ws-fpair:first-child .ws-mixhead { margin-top: 0; }
.ws-fleft { display: flex; align-items: baseline; gap: 5px; padding: 2.4mm 6mm 2.4mm 0;
  border-bottom: 1px dotted #dcdcdc; }
.ws-fright { display: flex; align-items: flex-start; gap: 5px; padding: 2.4mm 0 2.4mm 8mm;
  border-bottom: 1px dotted #dcdcdc; }
.ws-fheadcell { padding-right: 6mm; }
.ws-fheadcell.right { padding-left: 8mm; }
.ws-fen { flex: 0 0 auto; font-size: 11pt; font-weight: 700; font-family: "Times New Roman", "Songti SC", serif; }
/* C 折叠单左列音标：紧跟单词（词典习惯），不右对齐 */
.ws-fipa { font-size: 8pt; font-family: -apple-system, "Microsoft YaHei", sans-serif; }
.ws-fzh { display: block; font-size: 9pt; color: #000; }
.ws-fmain { flex: 1; min-width: 0; }
.ws-fmn { display: block; font-size: 8pt; color: #000; margin-top: .6mm; line-height: 1.45; }
.ws-empty { padding: 30mm 0; text-align: center; color: #000; font-size: 11pt; }

/* D 英译中：序号 + 英文 + 音标 + 词性 + 写中文的横线（2026-11-16 用户点单） */
.ws-drow { display: flex; align-items: baseline; gap: 5px; padding: 2.6mm 0; border-bottom: 1px dotted #dcdcdc; }
.ws-dno { flex: 0 0 16px; text-align: right; font-size: 7.5pt; color: #000; font-variant-numeric: tabular-nums; }
.ws-den { flex: 0 0 auto; max-width: 45%; font-size: 11.5pt; font-weight: 700; line-height: 1.25;
  font-family: "Times New Roman", "Songti SC", serif; }
.ws-den.phr { text-decoration: underline dotted #6f6f78; text-underline-offset: 2px; }
.ws-dipa { flex: 0 0 auto; font-size: 8.5pt; color: #000; font-family: -apple-system, "Microsoft YaHei", sans-serif; }
.ws-dpos { flex: 0 0 auto; font-style: italic; color: #000; font-size: 8.5pt; margin-right: 1mm; }
.ws-dblank { flex: 1; border-bottom: 1px solid #8a8a90; height: 1px; align-self: center; }

/* 附对话页（随机抽词的日常对话，目标词挖空让用户写；答案独立一页） */
.ws-dlgw { font-size: 8.5pt; color: #000; margin-bottom: 4mm; }
.ws-dlgw b { color: #000; font-weight: 600; }
.ws-dlgline { margin-bottom: 3.4mm; font-size: 11pt; line-height: 1.9; }
.ws-dlgwho { font-weight: 700; margin-right: 2mm; }
.ws-dlgblank { display: inline-block; min-width: 24mm; padding: 0 2px; border-bottom: 1px solid #8a8a90;
  text-align: center; font-family: "Times New Roman", serif; font-size: 10.5pt; color: #000; line-height: 1.25; }
.ws-dlgfirst { font-weight: 700; color: #000; letter-spacing: .04em; }
.ws-dlgzh { font-family: -apple-system, "Microsoft YaHei", sans-serif; font-size: 8.5pt; }
/* 答案页：按挖空出现顺序编号 */
.ws-ans { margin-top: 4mm; display: grid; grid-template-columns: 1fr 1fr; column-gap: 10mm; }
.ws-ansrow { padding: 2mm 0; border-bottom: 1px dotted #dcdcdc; font-size: 10.5pt;
  font-family: "Times New Roman", serif; }
.ws-ansno { font-style: normal; font-family: -apple-system, "Microsoft YaHei", sans-serif;
  font-size: 8.5pt; color: #000; margin-right: 2.5mm; }
.ws-anslemma { font-family: -apple-system, "Microsoft YaHei", sans-serif; font-size: 8.5pt;
  color: #000; margin-left: 1.5mm; }
`

function toNum(v: string | string[] | undefined, fallback: number) {
  const s = Array.isArray(v) ? v[0] : v
  const n = Number(s)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function todayLabel() {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/* ── 附对话页（2026-11-16 用户点单：随机抽词串日常对话，挖空自测） ── */

/** 对话句子里被 **双星号** 标出的目标词 → 挖空；zh 是这空对应的中文提示（原形释义首段） */
interface DlgSeg {
  text: string
  bold: boolean
  zh?: string
}

interface DlgLine {
  who: string
  segs: DlgSeg[]
}

/** 把 "… **took** …" 切成普通文本 / 加粗目标词两段 */
function splitBold(text: string): { text: string; bold: boolean }[] {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .filter((p) => p !== '')
    .map((p) =>
      p.startsWith('**') && p.endsWith('**') && p.length > 4
        ? { text: p.slice(2, -2), bold: true }
        : { text: p, bold: false },
    )
}

/* ── 取词助手（2026-11-18 混合卷抽出共用）：复习卷/混合卷、智能新词卷/混合卷各一份 ── */

/** 今日到期复习词（复习卷 / 混合卷复习节共用）：口径与 buildQueue 复习桶一致——
 *  dueAt<=now、未暂停、学过至少一遍（reps>0），按到期时间升序，上限每日复习配额。
 *  词源是「我的词」词集而非词单区间（unit 留空，页眉不标 Word List）；
 *  自由词（entryId 空）用 UserWord 释义快照兜底。只读，不写 FSRS 状态。 */
async function pickDueReviewWords(userId: string, cap: number, pruneMax: number): Promise<PrintWord[]> {
  const rows = await prisma.userWord.findMany({
    where: { userId, suspended: false, dueAt: { lte: new Date() }, reps: { gt: 0 } },
    orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
    take: cap,
    include: { entry: true },
  })
  return rows.map((r) => ({
    no: 0,
    headword: r.entry?.headword ?? r.headword,
    phonetic: (r.entry?.phoneticUk ?? r.entry?.phoneticUs ?? '').trim(),
    pos: r.entry?.pos ?? '',
    trans: pruneForPrint(r.entry?.trans ?? r.trans, pruneMax),
    mnemonic: r.entry?.mnemonic?.trim() ?? '',
    colls: pickColls(r.entry?.collocations),
    isPhrase: r.entry?.isPhrase ?? /\s/.test(r.headword),
    unit: '',
    origin: 'review' as const,
  }))
}

/** 按计划选今日新词（智能新词卷 / 混合卷新词节共用）：与 App 今日队列新词桶同口径——
 *  ① 先取「我的词」里还没背过的（reps=0，含划词/试卷来源）；
 *  ② 不够配额再从计划游标往后补词单里的词，跳过已在「我的词」的 lemma（跨词单去重）。
 *  只读：不建 UserWord、不推游标——打印不消耗计划，推进只发生在 App 里。 */
async function pickPlannedNewWords(
  userId: string,
  plan: { listId: string; cursor: number; dailyNew: number },
  quota: number,
  pruneMax: number,
): Promise<PrintWord[]> {
  const pending = await prisma.userWord.findMany({
    where: { userId, suspended: false, reps: 0 },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: quota,
    include: { entry: true },
  })
  const raw: PrintWord[] = pending.map((r) => ({
    no: 0,
    headword: r.entry?.headword ?? r.headword,
    phonetic: (r.entry?.phoneticUk ?? r.entry?.phoneticUs ?? '').trim(),
    pos: r.entry?.pos ?? '',
    trans: pruneForPrint(r.entry?.trans ?? r.trans, pruneMax),
    mnemonic: r.entry?.mnemonic?.trim() ?? '',
    colls: pickColls(r.entry?.collocations),
    isPhrase: r.entry?.isPhrase ?? /\s/.test(r.headword),
    unit: '',
  }))
  if (pending.length < quota) {
    const owned = new Set(
      (await prisma.userWord.findMany({ where: { userId }, select: { lemma: true } })).map((r) => r.lemma),
    )
    const candidates = await prisma.dictListItem.findMany({
      where: { listId: plan.listId, position: { gte: plan.cursor } },
      orderBy: [{ position: 'asc' }, { entryId: 'asc' }],
      take: Math.max(quota * 4, 40),
      include: { entry: true },
    })
    for (const c of candidates) {
      if (raw.length >= quota) break
      if (owned.has(c.entry.lemma)) continue
      raw.push({
        no: 0,
        headword: c.entry.headword,
        phonetic: (c.entry.phoneticUk ?? c.entry.phoneticUs ?? '').trim(),
        pos: c.entry.pos ?? '',
        trans: pruneForPrint(c.entry.trans, pruneMax),
        mnemonic: c.entry.mnemonic?.trim() ?? '',
        colls: pickColls(c.entry.collocations),
        isPhrase: c.entry.isPhrase,
        unit: '',
      })
    }
  }
  return raw
}

export default async function WordSheetPage({
  searchParams,
}: {
  searchParams: { [key: string]: string | string[] | undefined }
}) {
  const session = await auth()
  const userId = session?.user?.id ?? ''

  // 默认词单跟随背词计划（2026-11-16「统一从高频词开始」）：计划挂哪本默认打哪本，
  // 其余词单按导入先后排（频级分册的书高频册先导，兜底顺序也是高频在前）。
  // 原来按 createdAt 倒序取默认，中频词后导入就成了默认选中——App 里背的是高频词，
  // 打开背词卷却出的是中频词开头，两边没对齐。
  const now = new Date()
  const [allLists, activePlan, dueRaw] = await Promise.all([
    prisma.dictList.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true, slug: true, name: true, wordCount: true },
    }),
    userId
      ? prisma.wordPlan.findFirst({
          where: { userId, active: true },
          orderBy: { startedAt: 'desc' },
          select: { listId: true, cursor: true, dailyNew: true, dailyReview: true },
        })
      : Promise.resolve(null),
    // 今日到期词数：工具条「复习」角标 / 复习态徽章（口径与复习卷取词一致）
    userId
      ? prisma.userWord.count({
          where: { userId, suspended: false, dueAt: { lte: now }, reps: { gt: 0 } },
        })
      : Promise.resolve(0),
  ])
  const dueCount = Math.min(dueRaw, activePlan?.dailyReview ?? 100)
  const lists = activePlan?.listId
    ? [
        ...allLists.filter((l) => l.id === activePlan.listId),
        ...allLists.filter((l) => l.id !== activePlan.listId),
      ]
    : allLists
  const options: SheetListOption[] = lists.map((l) => ({ slug: l.slug, name: l.name, wordCount: l.wordCount }))

  const slug = (Array.isArray(searchParams.list) ? searchParams.list[0] : searchParams.list) || lists[0]?.slug || ''
  const list = lists.find((l) => l.slug === slug) ?? lists[0] ?? null
  const from = toNum(searchParams.from, 1)
  const to = Math.min(toNum(searchParams.to, from + 14), from + 499)
  // 词源（2026-11-16 智能选词）：new=新词卷（默认）| review=今日复习卷 | mix=今日任务混合卷（2026-11-18）。
  // 智能默认只在「什么都没填」时生效：URL 显式给了 list 或 from/to 就完全按手动来——
  // 否则分享出去的 ?list=xxx 链接会被偷换成计划词单，行为不可预期。
  // mix 是显式选择，优先级最高：到期词集跨词单，list/from/to 对它没有意义。
  const srcRaw = Array.isArray(searchParams.src) ? searchParams.src[0] : searchParams.src
  const source: 'new' | 'review' | 'mix' =
    srcRaw === 'review' ? 'review' : srcRaw === 'mix' ? 'mix' : 'new'
  const rawList = Array.isArray(searchParams.list) ? searchParams.list[0] : searchParams.list
  const rawFrom = Array.isArray(searchParams.from) ? searchParams.from[0] : searchParams.from
  const rawTo = Array.isArray(searchParams.to) ? searchParams.to[0] : searchParams.to
  const modeRaw = Array.isArray(searchParams.mode) ? searchParams.mode[0] : searchParams.mode
  const mode: SheetMode = modeRaw === 'B' || modeRaw === 'C' || modeRaw === 'D' ? modeRaw : 'A'
  const showMnemonic = (Array.isArray(searchParams.mn) ? searchParams.mn[0] : searchParams.mn) !== '0'
  // 印搭配短语（col=1 默认开，2026-11-17 用户点单）：词库 collocations（考点搭配，core 优先 2 条）。
  // 只对 A/D 生效——B 短语英文里含目标词会漏答案，C 折叠行预算塞不下。
  const showColls = (Array.isArray(searchParams.col) ? searchParams.col[0] : searchParams.col) !== '0'
  const collsOn = showColls && (mode === 'A' || mode === 'D')
  // 打乱词序（sh=1，2026-11-16 用户点单）：只对 B/D 默写类版式生效——防止「背位置不背词」；
  // 每次渲染重新洗牌（同一张纸多打几份就是多份不同顺序），序号跟着重排成 1..n。
  const shuffleOn =
    (Array.isArray(searchParams.sh) ? searchParams.sh[0] : searchParams.sh) === '1' && (mode === 'B' || mode === 'D')
  const meta = SHEET_MODE_META[mode]

  let words: PrintWord[] = []
  /** 非 null = 新词按计划自动选取（智能态，工具条出徽章）；null = 手动选段 */
  let smartCount: number | null = null
  /** 混合卷（src=mix）两节的实际词数与计划可用性；非混合卷恒 null */
  let mixInfo: { review: number; fresh: number; hasPlan: boolean } | null = null
  if (source === 'review') {
    // 复习卷（2026-11-16）：今日到期词集，序号重排 1..n。取词口径见 pickDueReviewWords。
    const cap = activePlan?.dailyReview ?? 100
    words = userId ? await pickDueReviewWords(userId, cap, mode === 'C' ? 26 : 22) : []
    words = words.map((w, i) => ({ ...w, no: i + 1 }))
  } else if (source === 'mix') {
    // 混合卷（2026-11-18）：「今日任务」——今日到期复习词在前 + 今日计划新词在后，序号连续 1..N，
    // 与 App 今日队列同构（复习先、学新后），一张纸覆盖今天全部任务。
    // 词源是到期词集+计划新词（跨词单），list/from/to 不适用；挂了计划才可用。
    // 退化：一边为 0 就整卷退化为纯复习/纯新词卷（渲染层节头自动省略）。
    const cap = activePlan?.dailyReview ?? 100
    const quota = activePlan && activePlan.dailyNew > 0 ? activePlan.dailyNew : 15
    const reviewWords = userId ? await pickDueReviewWords(userId, cap, mode === 'C' ? 26 : 22) : []
    const freshWords =
      userId && activePlan?.listId
        ? (
            await pickPlannedNewWords(
              userId,
              { listId: activePlan.listId, cursor: activePlan.cursor, dailyNew: activePlan.dailyNew },
              quota,
              mode === 'C' ? 26 : 22,
            )
          ).map((w) => ({ ...w, origin: 'new' as const })) // 节属只在混合卷打标（纯新词卷不标）
        : []
    words = [...reviewWords, ...freshWords].map((w, i) => ({ ...w, no: i + 1 }))
    mixInfo = { review: reviewWords.length, fresh: freshWords.length, hasPlan: !!activePlan?.listId }
  } else if (!rawList && !rawFrom && !rawTo && !!userId && !!activePlan?.listId) {
    // 智能选词（2026-11-16）：打开什么都不填 = 印「今天该背的新词」，与 App 今日队列同口径
    // （取词口径见 pickPlannedNewWords；① 我的词里没背过的 ② 不够从计划游标往后补）。
    const quota = activePlan.dailyNew > 0 ? activePlan.dailyNew : 15
    words = (
      await pickPlannedNewWords(
        userId,
        { listId: activePlan.listId, cursor: activePlan.cursor, dailyNew: activePlan.dailyNew },
        quota,
        mode === 'C' ? 26 : 22,
      )
    ).map((w, i) => ({ ...w, no: i + 1 }))
    smartCount = words.length
  } else if (list) {
    // 手动选段（现状口径）：词单 + 起止词号
    // 用 skip/take 而不是 position 区间：历史导入可能把 position 撞成重复值
    // （同一本书先后导入不同文件，序号都从 0 起），区间取会多取。
    const take = Math.max(1, Math.min(to - from + 1, 500))
    const rows = await prisma.dictListItem.findMany({
      where: { listId: list.id },
      orderBy: [{ position: 'asc' }, { entryId: 'asc' }],
      skip: from - 1,
      take,
      include: { entry: true },
    })
    words = rows.map((r, i) => ({
      no: from + i,
      headword: r.entry.headword,
      phonetic: (r.entry.phoneticUk ?? r.entry.phoneticUs ?? '').trim(),
      pos: r.entry.pos ?? '',
      trans: pruneForPrint(r.entry.trans, mode === 'C' ? 26 : 22),
      mnemonic: r.entry.mnemonic?.trim() ?? '',
      colls: pickColls(r.entry.collocations),
      isPhrase: r.entry.isPhrase,
      unit: r.unit ?? '',
    }))
  }

  // 打乱后的正式词表（后续分页/短文/对话/工具条全用它）；乱序时序号重排成 1..n。
  // 混合卷（2026-11-18）只在各节内部洗牌——复习节/新词节的前后顺序不混，分节式才成立；
  // 其余卷整表洗。
  const sheetWords: PrintWord[] = (() => {
    if (!shuffleOn) return words
    const seed = Date.now()
    if (source !== 'mix') return shuffleWithSeed(words, seed).map((w, i) => ({ ...w, no: i + 1 }))
    const review = shuffleWithSeed(words.filter((w) => w.origin === 'review'), seed)
    const fresh = shuffleWithSeed(words.filter((w) => w.origin === 'new'), seed + 1)
    return [...review, ...fresh].map((w, i) => ({ ...w, no: i + 1 }))
  })()

  // 印搭配短语时 A/D 降档每页词数（短语行挤占行高，见 sheet.ts collPerPage）；
  // 混合卷再降 2（2026-11-18）：分节头占行，最坏一页同时出现两个节头——宁空不溢。
  const pageSize = Math.max(
    1,
    (collsOn ? (meta.collPerPage ?? meta.perPage) : meta.perPage) - (source === 'mix' ? 2 : 0),
  )
  const pages = splitPages(sheetWords, pageSize)
  const dateLabel = todayLabel()
  // 混合卷节头：全局词序号 → 节名，节首各出现一次；一边为 0（退化成纯卷）就整体不画。
  const mixReviewCount = source === 'mix' ? sheetWords.filter((w) => w.origin === 'review').length : 0
  const mixFreshCount = source === 'mix' ? sheetWords.filter((w) => w.origin === 'new').length : 0
  const mixHeads =
    source === 'mix' && mixReviewCount > 0 && mixFreshCount > 0
      ? new Map<number, 'review' | 'new'>([
          [0, 'review'],
          [mixReviewCount, 'new'],
        ])
      : new Map<number, 'review' | 'new'>()
  // 复习卷的词源是到期词集（跨词单），标题用「今日复习」；混合卷标题「今日任务」；
  // 新词/手动卷仍标词单名
  const title =
    source === 'review' ? '今日复习' : source === 'mix' ? '今日任务' : (list?.name ?? '背词卷')

  // 附短文：取缓存里那篇（与 App 弹层共用同一组词、同一个 key）；没有就提示现场生成
  const includePassage = (Array.isArray(searchParams.psg) ? searchParams.psg[0] : searchParams.psg) !== '0'
  let passage: {
    title: string
    titleZh: string | null
    body: string
    translation: string | null
  } | null = null
  let passageMissing = false
  if (includePassage && userId && sheetWords.length) {
    // 与 App 弹层同口径:短文只围绕这批词本身(0 掺复习/0 掺预习),缓存 key 才对得上
    const resolved = await resolvePassageWords(userId, sheetWords.map((w) => w.headword), 0, 0)
    const hit = await prisma.wordPassage.findUnique({
      where: { userId_key: { userId, key: resolved.key } },
      select: { title: true, titleZh: true, body: true, translation: true },
    })
    passage = hit
    passageMissing = !hit
  }

  // 附对话（dlg=1）：随机抽 5 个词串成日常对话，目标词挖空自测，答案独立一页。
  // 抽词必须与工具条「生成对话」同 seed 同口径（pickSeeded 内部先排序消除顺序影响，
  // 打乱词序也不影响），dseed 缺 0 视为还没生成过——直接按 missing 处理。
  const includeDialogue = (Array.isArray(searchParams.dlg) ? searchParams.dlg[0] : searchParams.dlg) === '1'
  const dhlRaw = Array.isArray(searchParams.dhl) ? searchParams.dhl[0] : searchParams.dhl
  const dhl: 'none' | 'first' | 'zh' = dhlRaw === 'none' || dhlRaw === 'zh' ? dhlRaw : 'first'
  const dseed = Math.max(
    0,
    Math.floor(Number(Array.isArray(searchParams.dseed) ? searchParams.dseed[0] : searchParams.dseed) || 0),
  )
  let dialogue: { picked: string[]; lines: DlgLine[]; answers: { form: string; lemma: string }[] } | null = null
  if (includeDialogue && userId && sheetWords.length >= 3 && dseed > 0) {
    const pick = pickSeeded(sheetWords.map((w) => w.headword), 5, dseed)
    const key = passageKey(['__dlg__', ...pick.map((w) => w.toLowerCase())])
    const row = await prisma.wordPassage.findUnique({
      where: { userId_key: { userId, key } },
      select: { body: true, usedWords: true },
    })
    if (row) {
      let rawLines: { who: string; en: string }[] = []
      try {
        const parsed = JSON.parse(row.body) as { lines?: { who?: unknown; en?: unknown }[] }
        if (Array.isArray(parsed?.lines)) {
          rawLines = parsed.lines
            .filter((l): l is { who?: unknown; en: string } => !!l && typeof l.en === 'string' && l.en.trim().length > 0)
            .map((l) => ({
              who: typeof l.who === 'string' && l.who.trim() ? l.who.trim().slice(0, 12) : 'A',
              en: l.en,
            }))
        }
      } catch {
        rawLines = []
      }
      if (rawLines.length) {
        // form → 原形（AI 的 words 列表），原形 → 释义首段（本页词条，中文提示档用）
        const lemmaByForm = new Map<string, string>()
        if (Array.isArray(row.usedWords)) {
          for (const u of row.usedWords as unknown[]) {
            const o = u as { w?: unknown; form?: unknown }
            if (o && typeof o.form === 'string' && typeof o.w === 'string' && o.w && !lemmaByForm.has(o.form)) {
              lemmaByForm.set(o.form, o.w)
            }
          }
        }
        const zhByLemma = new Map(
          sheetWords.map((w) => [
            w.headword.toLowerCase(),
            // 中文提示只留一个干净的意思：取释义首段，再去掉义项号/连接动词标记等残留
            // （trans 已过 pruneForPrint，但首段仍可能有「①」「link.」这类碎片，如 get）
            (w.trans || '')
              .split(/[；;、，,]/)[0]
              ?.replace(/[①②③④⑤⑥⑦⑧⑨⑩]/g, '')
              .replace(/link\./gi, '')
              .replace(/\s+/g, ' ')
              .trim() || '',
          ]),
        )
        const lines: DlgLine[] = rawLines.map((l) => ({
          who: l.who,
          segs: splitBold(l.en).map((part) => {
            if (!part.bold) return part
            const lemma = (lemmaByForm.get(part.text) ?? '').toLowerCase()
            const zh = lemma ? zhByLemma.get(lemma) : undefined
            return zh ? { ...part, zh } : part
          }),
        }))
        const answers: { form: string; lemma: string }[] = []
        for (const l of lines) {
          for (const seg of l.segs) {
            if (seg.bold && !answers.some((a) => a.form === seg.text)) {
              answers.push({ form: seg.text, lemma: lemmaByForm.get(seg.text) ?? '' })
            }
          }
        }
        dialogue = { picked: pick, lines, answers }
      }
    }
  }

  const plain = (s: string) => s.replace(/\*\*/g, '')
  const passageParts = passage ? passage.body.split(/(\*\*[^*]+\*\*)/g) : []

  return (
    <div className="ws-scroll h-full min-h-0 overflow-y-auto bg-surface-muted">
      <style dangerouslySetInnerHTML={{ __html: WS_CSS }} />
      <WordSheetToolbar
        lists={options}
        source={source}
        smartCount={smartCount}
        mixInfo={mixInfo}
        dueCount={dueCount}
        mode={mode}
        from={from}
        to={to}
        showMnemonic={showMnemonic}
        showColls={showColls}
        includePassage={includePassage}
        passageState={passage ? 'ready' : 'missing'}
        showShuffle={mode === 'B' || mode === 'D'}
        shuffled={shuffleOn}
        includeDialogue={includeDialogue}
        dialogueHint={dhl}
        dialogueState={dialogue ? 'ready' : 'missing'}
        baseWords={sheetWords.map((w) => w.headword)}
      />

      <div className="ws-sheetwrap mx-auto max-w-[900px] px-4 py-5">
        {!sheetWords.length ? (
          <div className="ws-page">
            <div className="ws-empty">
              {source === 'review'
                ? '今天没有到期的复习词，休息一下或切回「新词」'
                : source === 'mix'
                  ? mixInfo?.hasPlan
                    ? '今天没有到期复习词，也没有要背的新词，休息一下'
                    : '混合模式需要背词计划（学习台里建一个），或先切「新词 / 复习」'
                  : smartCount === 0
                    ? '计划里暂时没有要背的新词（只复习模式或已推进到底），可点「手动选段」'
                    : list
                      ? `第 ${from}–${to} 词超出词单范围（共 ${list.wordCount} 词）`
                      : '字典里还没有词单，先导入一份'}
            </div>
          </div>
        ) : (
          <>
          <section className="ws-page">
            <PaperBrandSeal />
            {pages.map((pageWords, pi) => {
            const unitSet = Array.from(new Set(pageWords.map((w) => w.unit).filter(Boolean)))
            const unitLabel =
              unitSet.length === 1 ? unitSet[0] : unitSet.length > 1 ? `${unitSet[0]} – ${unitSet[unitSet.length - 1]}` : ''
            // 混合卷分节（2026-11-18）：一页词按节切连续段，段首落在节首（全局序号命中 mixHeads）
            // 就带节头；非混合卷整页一段、无节头。C 折叠两列共用同一组段，左右节头天然对齐。
            const runs: { head: 'review' | 'new' | null; words: PrintWord[] }[] = []
            pageWords.forEach((w, li) => {
              const head = mixHeads.get(pi * pageSize + li) ?? null
              const last = runs[runs.length - 1]
              if (!last || head || (!!w.origin && !!last.words[0]?.origin && w.origin !== last.words[0].origin)) {
                runs.push({ head, words: [w] })
              } else {
                last.words.push(w)
              }
            })
            const mixHeadEl = (head: 'review' | 'new') => (
              <div className="ws-sechead ws-mixhead">
                <b>
                  {head === 'review' ? '今日复习' : '今日新词'} ·{' '}
                  {(head === 'review' ? mixReviewCount : mixFreshCount)} 词
                </b>
                <span>{head === 'review' ? '先复习，后学新' : '按计划选取'}</span>
              </div>
            )
            return (
            <div key={pi} className={pi > 0 ? 'ws-block ws-bsec' : 'ws-block'}>
              <div className="ws-head">
                <div>
                  <div className="ws-title">{title}</div>
                  <div className="ws-sub">
                    {unitLabel ? `${unitLabel} · ` : ''}
                    {meta.label} · 第 {pageWords[0]?.no}–{pageWords[pageWords.length - 1]?.no} 词 · {dateLabel}
                    {mode === 'C' ? ' · 沿中间虚线对折' : ''}
                  </div>
                </div>
                <div className="ws-name">姓名 ____________</div>
              </div>

              {mode === 'C' ? (
                <div className="ws-body">
                  <div className="ws-fold">
                    <div className="ws-fold-divider" />
                    {runs.map((run, ri) => (
                      <Fragment key={ri}>
                        {run.head && (
                          <div className="ws-fpair">
                            <div className="ws-fheadcell">{mixHeadEl(run.head)}</div>
                            <div className="ws-fheadcell right">{mixHeadEl(run.head)}</div>
                          </div>
                        )}
                        {run.words.map((w) => (
                          <div key={w.no} className="ws-fpair">
                            <div className="ws-fleft">
                              <span className="ws-no">{w.no}</span>
                              <span className={`ws-fen${w.isPhrase ? ' phr' : ''}`}>{w.headword}</span>
                              {w.phonetic && <span className="ws-fipa">{w.phonetic}</span>}
                            </div>
                            <div className="ws-fright">
                              <span className="ws-no">{w.no}</span>
                              <span className="ws-fmain">
                                <span className="ws-fzh">
                                  {w.pos && <span className="ws-pos">{w.pos}.</span>}
                                  {w.trans}
                                </span>
                                {showMnemonic && w.mnemonic && <span className="ws-fmn">{w.mnemonic}</span>}
                              </span>
                            </div>
                          </div>
                        ))}
                      </Fragment>
                    ))}
                  </div>
                </div>
              ) : mode === 'D' ? (
                <div className="ws-body" style={{ ['--cols' as string]: pageWords.length <= 15 ? 1 : 2 }}>
                  {runs.map((run, ri) => (
                    <Fragment key={ri}>
                      {run.head && mixHeadEl(run.head)}
                      <div className="ws-cols">
                        {run.words.map((w) => (
                          <div key={w.no} className="ws-drow">
                            <span className="ws-dno">{w.no}</span>
                            <span className="ws-main">
                              <span className="ws-line">
                                <span className={`ws-den${w.isPhrase ? ' phr' : ''}`}>{w.headword}</span>
                                {w.phonetic && <span className="ws-dipa">{w.phonetic}</span>}
                                {w.pos && <span className="ws-dpos">{w.pos}.</span>}
                                <span className="ws-dblank" />
                              </span>
                              {showMnemonic && w.mnemonic && (
                                <span className="ws-mn">
                                  <b>助记</b>
                                  {w.mnemonic}
                                </span>
                              )}
                              {collsOn && w.colls.length > 0 && (
                                <span className="ws-colls">
                                  {w.colls.map((c, ci) => (
                                    <span key={ci} className="ws-coll">
                                      <span className="ws-collen">{c.en}</span>
                                      {c.zh}
                                    </span>
                                  ))}
                                </span>
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                    </Fragment>
                  ))}
                </div>
              ) : (
                <div className="ws-body" style={{ ['--cols' as string]: pageWords.length <= 15 ? 1 : 2 }}>
                  {runs.map((run, ri) => (
                    <Fragment key={ri}>
                      {run.head && mixHeadEl(run.head)}
                      <div className="ws-cols">
                        {run.words.map((w) => (
                          <div key={w.no} className="ws-row">
                            <span className="ws-no">{w.no}</span>
                            <span className="ws-main">
                              <span className="ws-line">
                                {mode !== 'B' && (
                                  <span className={`ws-en${w.isPhrase ? ' phr' : ''}`}>{w.headword}</span>
                                )}
                                {mode === 'A' && w.phonetic && (
                                  <span className="ws-ipa">{w.phonetic}</span>
                                )}
                                <span className="ws-zh">
                                  {w.pos && <span className="ws-pos">{w.pos}.</span>}
                                  {w.trans}
                                </span>
                                {mode === 'B' && <span className="ws-blank" />}
                              </span>
                              {mode === 'A' && showMnemonic && w.mnemonic && (
                                <span className="ws-mn">
                                  <b>助记</b>
                                  {w.mnemonic}
                                </span>
                              )}
                              {mode === 'A' && collsOn && w.colls.length > 0 && (
                                <span className="ws-colls">
                                  {w.colls.map((c, ci) => (
                                    <span key={ci} className="ws-coll">
                                      <span className="ws-collen">{c.en}</span>
                                      {c.zh}
                                    </span>
                                  ))}
                                </span>
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                    </Fragment>
                  ))}
                </div>
              )}
            </div>
            )
          })}

          {/* 短文：不再独占一张纸，按剩余空间接在词表后面 */}
          {passage && (
            <div className="ws-block ws-bsec">
              <div className="ws-sechead">
                <b>今日短文 · {passage.title}</b>
                <span>{passage.titleZh ? `${passage.titleZh} · ` : ''}与 App 里同一篇 · {dateLabel}</span>
              </div>

              <div className="ws-pbody">
                {passageParts.map((p, i) =>
                  p.startsWith('**') && p.endsWith('**') ? (
                    <mark key={i} className="ws-pw">
                      {p.slice(2, -2)}
                    </mark>
                  ) : (
                    <span key={i}>{p}</span>
                  ),
                )}
              </div>

              {passage.translation && (
                <div className="ws-pzh">
                  <div className="ws-ph">中文译文</div>
                  {plain(passage.translation)}
                </div>
              )}
            </div>
          )}

          {/* 附对话：挖空节 + 参考答案节（答案紧随其后，粗分隔线可遮挡；空间不够时整节推到下一页） */}
          {dialogue && (
            <>
              <div className="ws-block ws-bsec">
                <div className="ws-sechead">
                  <b>今日对话 · 填词</b>
                  <span>
                    {dhl === 'none' ? '没有提示' : dhl === 'zh' ? '括号里有中文提示' : '给了首字母提示'} · {dateLabel}
                  </span>
                </div>

                <div className="ws-pbody">
                  <div className="ws-dlgw">
                    本页用到的词：<b>{dialogue.picked.join(' · ')}</b>（答案见下方）
                  </div>
                  {dialogue.lines.map((line, li) => (
                    <div key={li} className="ws-dlgline">
                      <span className="ws-dlgwho">{line.who}:</span>
                      {line.segs.map((seg, si) =>
                        seg.bold ? (
                          <span key={si} className="ws-dlgblank">
                            {dhl === 'first' && /^[A-Za-z]/.test(seg.text) && (
                              <span className="ws-dlgfirst">{seg.text[0]}</span>
                            )}
                            {dhl === 'first' && /^[A-Za-z]/.test(seg.text) &&
                              '_'.repeat(Math.min(seg.text.length - 1, 8))}
                            {dhl === 'zh' && seg.zh && <span className="ws-dlgzh">（{seg.zh}）</span>}
                          </span>
                        ) : (
                          <span key={si}>{seg.text}</span>
                        ),
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="ws-block">
                <div className="ws-anshead">
                  参考答案
                  <span>折起或用手遮住这一段再核对</span>
                </div>
                <div className="ws-ans">
                  {dialogue.answers.map((a, ai) => (
                    <div key={ai} className="ws-ansrow">
                      <span className="ws-ansno">（{ai + 1}）</span>
                      {a.form}
                      {a.lemma && a.lemma.toLowerCase() !== a.form.toLowerCase() && (
                        <span className="ws-anslemma">（原形 {a.lemma}）</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
          </section>
          </>
        )}

        <div className="ws-noprint mx-auto max-w-[760px] pb-6 pt-1 text-center text-[11.5px] leading-relaxed text-content-muted">
          A4 · 全拼页排版：短文/对话/答案按剩余空间接排，空间不够自动整节另起一页，纸最省
          {source === 'review'
            ? ' · 今日复习：词源是今天到期的词集（上限每日复习配额）'
            : source === 'mix'
              ? ' · 今日任务：复习在前、新词在后，序号连续；打乱词序只在各节内部洗'
              : smartCount != null
                ? ' · 新词按计划自动选取，与 App 今日队列同口径'
                : ''}
          {mode === 'B' ? ' · 默写纸不印助记/音标（会漏答案）' : showMnemonic ? ' · 助记印在释义下方' : ' · 助记已关'}
          {collsOn
            ? ' · 搭配短语印在词行下方（核心搭配优先 2 条，每页词数降为 20）'
            : mode === 'A' || mode === 'D'
              ? ' · 搭配短语已关（⚙ 面板可开）'
              : ''}
          {includePassage
            ? passage
              ? ' · 今日短文已拼进卷面（与 App 里同一篇）'
              : ' · 短文还没生成过，点上方「生成短文」'
            : ' · 未附短文'}
          {includeDialogue
            ? dialogue
              ? ' · 今日对话已拼进卷面，答案在对话下方（粗线分隔）'
              : ' · 对话还没生成过，点上方「生成对话」'
            : ' · 未附对话'}
        </div>
      </div>
    </div>
  )
}
