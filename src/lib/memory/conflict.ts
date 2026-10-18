/**
 * 记忆矛盾判定内核（零 LLM、纯函数、isomorphic —— 禁止 import prisma / ai）
 *
 * 要解决的问题：库里同时存在「林小夏，27岁，杭州人」和「林小夏，高中生」这类互斥条目时，
 * 旧管线只有 LLM 回传 remove 原文这一条替换通道（见 extractor / dedupe），模型改写措辞或
 * 根本没走提取（add_memory、手动添加、导入三个写入口完全不判矛盾），冲突条目就静默共存，
 * 一起进 system prompt 让模型自行猜哪条是真的。
 *
 * 判定手段：不做语义推理，只做**同槽位取值互斥 + 少量常识区间互斥**：
 *  1) 从两条文本各抽一组「槽位→取值」(年龄/学段/身份/户籍地/现居地)；
 *  2) 同一槽位都抽到值且取值不等 → 矛盾（杭州人 vs 北京人、27岁 vs 19岁）；
 *  3) 跨槽位按常识区间互斥 → 矛盾（高中生 ↔ 27岁，学生身份 ↔ 在职）；
 *  4) 两条各自抽到姓名且不等 → 判为不同主体，直接否决（不视为矛盾）。
 *
 * 已知边界（如实交代，留给第二波 LLM 体检）：偏好类语义对立（"不吃辣" vs "喜欢辣"）
 * 字面几乎不重叠，本地判不出；这里宁可漏判也不误判，因为误判会让用户少记忆。
 *
 * 槽位设计上的两个刻意拆分，都是为压误判率：
 *  - 户籍地(X人/来自X) 与 现居地(在X/坐标X) 是两个槽位，"杭州人 + 在上海工作" 不算矛盾；
 *  - 城市名一律过黑名单，剥掉"外地/本地/家里/网上"这类泛指，避免把虚指当城市。
 */

/** 抽到一个槽位的取值时的置信来源标记，仅用于日志/调试可读 */
export type SlotKey = "name" | "age" | "stage" | "role" | "hometown" | "curCity"

const SLOT_LABELS: Record<SlotKey, string> = {
  name: "姓名",
  age: "年龄",
  stage: "学段",
  role: "身份",
  hometown: "户籍地",
  curCity: "现居地",
}

export function getSlotLabel(slot: SlotKey): string {
  return SLOT_LABELS[slot]
}

/** 归一化后的记忆条目形状（避免本模块绑死 Prisma 类型，测试可传字面量） */
export interface ConflictCandidate {
  id: string
  content: string
  category?: string
  updatedAt?: Date | string
  /** 已裁决「都保留」记录的对端 id，逗号分隔（不再重复提示） */
  conflictPeers?: string | null
}

/** 一处矛盾：a 与 b 两条记忆互斥，命中原因可解释（UI 与日志都要用） */
export interface ConflictHit {
  aId: string
  bId: string
  /** 冲突槽位（同槽位取值互斥时给出；跨槽位常识互斥时为两侧槽位中更具体的那个） */
  slot: SlotKey
  /** slot=同槽位互斥 | age_stage=年龄与学段常识区间互斥 | role_stage=身份与学段互斥 */
  kind: "slot" | "age_stage" | "role_stage"
  /** 面向用户的一句话说明，如「年龄 27岁 与 学段 高中 不相符」 */
  reason: string
}

/** 一组互相矛盾的记忆（≥2 条），winner 为 updatedAt 最新者（「以新为准」的默认胜者） */
export interface ConflictGroup {
  ids: string[]
  winnerId: string
  hits: ConflictHit[]
}

// ────────────────────────────────────────────────────────────────
// 槽位词表与抽取
// ────────────────────────────────────────────────────────────────

/** 泛指"城市位置"但不是具体城市，绝不能进 curCity/hometown */
const CITY_STOPWORDS = new Set([
  "外地", "本地", "外地人", "本地人", "家里", "老家", "这儿", "那里", "这里", "那边",
  "线上", "网上", "国外", "国内", "海外", "农村", "城市", "县城", "镇上", "学校", "公司",
  "单位", "家", "北京上海", "某个", "某地", "中国", "国内某",
])

/** 学段归一化：只保留粗粒度档位，避免"大一"与"本科"互相打架 */
const STAGE_RULES: Array<[RegExp, string]> = [
  [/幼儿园|幼稚园/, "学前"],
  [/小学生?/, "小学"],
  [/初中生?/, "初中"],
  [/高中生?|高三|高二|高一/, "高中"],
  [/博士生?|读博|博士/, "博士"],
  [/硕士生?|研究生|读研|考研/, "研究生"],
  [/大学生?|本科生?|大一|大二|大三|大四|本科/, "大学"],
]

/** 身份归一化：只收彼此明确互斥的档位（学生 vs 在职），宽泛职业名不纳入判定 */
const ROLE_RULES: Array<[RegExp, string]> = [
  [/在职|已工作|上班|上班族|打工人|全职工作|工作了/, "在职"],
  [/待业|失业|无业/, "待业"],
  [/退休/, "退休"],
  [/自由职业/, "自由职业"],
  [/创业|自己开公司|老板/, "创业"],
  // 学生放最后：「在职大学生」这类表述应先判在职
  [/在校学生|学生/, "学生"],
]

/** 学段的合理年龄区间（含边界）；超出即判 age_stage 互斥。上限放宽以容纳复读/晚学等少数情况 */
const STAGE_AGE_RANGE: Record<string, [number, number]> = {
  学前: [2, 8],
  小学: [5, 13],
  初中: [11, 17],
  高中: [13, 20],
  大学: [16, 26],
  研究生: [20, 32],
  博士: [22, 40],
}

/** 与"在校中小学段"互斥的身份 */
const ROLE_STAGE_CONFLICT: Record<string, string[]> = {
  在职: ["学前", "小学", "初中", "高中"],
  退休: ["学前", "小学", "初中", "高中", "大学"],
}

function stripPunct(text: string): string {
  return text.replace(/[\r\n]+/g, "，").trim()
}

/** 城市候选清洗：剥尾缀、限长、挡泛指 */
function normalizeCity(raw: string): string | null {
  let c = raw.trim().replace(/^(是|在|来自|为)/, "")
  // 剥掉"市/区/县"之外的动作尾缀（在上学/在工作/居住…）
  c = c.replace(/(市|区|县)$/, "").replace(/(上学|读书|工作|生活|居住|定居|上班|待)+$/, "")
  if (c.length < 2 || c.length > 8) return null
  if (CITY_STOPWORDS.has(c)) return null
  if (/[0-9a-zA-Z]/.test(c)) return null // 混进拉丁/数字的多半不是中文城市名
  return c
}

/**
 * 抽取一条记忆文本里的槽位取值。
 * 抽不到任何槽位返回空数组 —— 调用方据此快速排除（绝大多数偏好类记忆走这条路，不参与判定）。
 */
export function extractSlots(content: string): Array<{ slot: SlotKey; value: string }> {
  const text = stripPunct(content || "")
  if (!text) return []

  const out: Array<{ slot: SlotKey; value: string }> = []

  // 年龄：只认 "N岁"，"二十多岁" 这类模糊表述不纳入（无法比区间）
  const ageMatch = text.match(/(\d{1,3})\s*岁/)
  if (ageMatch) {
    const n = Number(ageMatch[1])
    if (n >= 2 && n <= 100) out.push({ slot: "age", value: `${n}岁` })
  }

  // 学段
  for (const [re, stage] of STAGE_RULES) {
    if (re.test(text)) {
      out.push({ slot: "stage", value: stage })
      break
    }
  }

  // 身份
  for (const [re, role] of ROLE_RULES) {
    if (re.test(text)) {
      out.push({ slot: "role", value: role })
      break
    }
  }

  // 户籍/来源地：两种写法各管一路
  //  A) 带前缀词：老家/籍贯/祖籍/家在/来自 + 地名
  //  B) 「X人」句式：杭州人 / 是杭州人 —— 必须有人称或判断词/分隔符做左边界，
  //     否则「用户是北京人」会把「户是北京」整段当成地名。
  const home = text.match(/(?:户籍(?:所在地)?|老家|籍贯|祖籍|家在|来自)(?:在|是|为)?([\u4e00-\u9fa5]{2,8})/)
  if (home) {
    const city = normalizeCity(home[1])
    if (city) out.push({ slot: "hometown", value: city })
  } else {
    const ren = text.match(
      /(?:^|[，,、。；;：:\s]|是|在|来自|为)([\u4e00-\u9fa5]{2,4})人(?:$|[，,、。；;：:\s])/
    )
    if (ren) {
      const city = normalizeCity(ren[1])
      if (city) out.push({ slot: "hometown", value: city })
    }
  }

  // 现居地：两条路各管一种表述，刻意不放开裸「在」——
  // 「在图书馆自习」「在使用某工具」里的处所词会被误抽成城市，造成假矛盾。
  const curExplicit = text.match(/(?:现居|定居|长居|坐标|目前在|住在|搬到|搬去|来到|返回)([\u4e00-\u9fa5]{2,8})/)
  const curContextual = text.match(
    /在([\u4e00-\u9fa5]{2,6}?)(?:市|区|县)?(?:上学|读书|工作|生活|居住|定居|上班|发展|待)/
  )
  const curCity = curExplicit?.[1] ?? curContextual?.[1]
  if (curCity) {
    const city = normalizeCity(curCity)
    if (city) out.push({ slot: "curCity", value: city })
  }

  return out
}

/**
 * 抽取主体姓名（弱信号，仅用于"不同主体否决"）：
 *  - 显式表述：我叫/名字是/称呼为 X
 *  - 导入画像的常见开头："林小夏，27岁，杭州人"
 * 抓不准就返回 null —— 返回 null 时不参与否决，判定退化为"都是关于用户的"。
 */
export function extractSubjectName(content: string): string | null {
  const text = stripPunct(content || "")
  if (!text) return null

  const explicit = text.match(
    /(?:我叫|我的名字(?:是|叫)|名字(?:是|叫)|姓名(?:是|叫)|称呼(?:为|是)?|备注(?:是|叫))\s*([\u4e00-\u9fa5]{2,4})/
  )
  if (explicit) return explicit[1]

  // 前导人名：以 2-4 个汉字开头，紧跟逗号/顿号/冒号/空格
  const leading = text.match(/^([\u4e00-\u9fa5]{2,4})[，,、：:\s]/)
  if (!leading) return null
  const name = leading[1]
  // 挡掉最常见的人名前缀词，避免把"用户""关于"当名字
  if (NON_NAME_PREFIXES.has(name) || /^(用户|该用户|本人|关于|另外|此外|例如|比如)/.test(name)) {
    return null
  }
  return name
}

const NON_NAME_PREFIXES = new Set(["用户", "本人", "该生", "对方", "朋友", "同学", "老师"])

/**
 * 同槽位取首个值后摊平成数组（项目 tsconfig 默认 target 不支持 for-of 遍历 Map，
 * 且数组形态在下面的交叉判定里读起来更直白）。
 */
function slotEntries(content: string): Array<{ slot: SlotKey; value: string }> {
  const seen = new Set<SlotKey>()
  const out: Array<{ slot: SlotKey; value: string }> = []
  for (const entry of extractSlots(content)) {
    if (seen.has(entry.slot)) continue
    seen.add(entry.slot)
    out.push(entry)
  }
  return out
}

function pickSlot(entries: Array<{ slot: SlotKey; value: string }>, slot: SlotKey): string | undefined {
  const hit = entries.filter((e) => e.slot === slot)[0]
  return hit ? hit.value : undefined
}

function toTime(value?: Date | string): number {
  if (!value) return 0
  const t = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isNaN(t) ? 0 : t
}

// ────────────────────────────────────────────────────────────────
// 两条记忆是否互斥
// ────────────────────────────────────────────────────────────────

/**
 * 判定两条记忆是否本地可判矛盾。返回 null 表示"判不出/不矛盾"。
 *
 * 判定顺序刻意先否决后确认：姓名不同 → 直接放过（不同主体），
 * 同槽位取值不等 → 矛盾，跨槽位常识越界 → 矛盾。
 */
export function findPairConflict(
  a: Pick<ConflictCandidate, "id" | "content">,
  b: Pick<ConflictCandidate, "id" | "content">
): ConflictHit | null {
  const nameA = extractSubjectName(a.content)
  const nameB = extractSubjectName(b.content)
  if (nameA && nameB && nameA !== nameB) return null

  const slotsA = slotEntries(a.content)
  const slotsB = slotEntries(b.content)
  if (slotsA.length === 0 || slotsB.length === 0) return null

  // 1) 同槽位取值互斥
  for (const entryA of slotsA) {
    const slot = entryA.slot
    if (slot === "name") continue // 姓名已由上面否决
    const valueB = pickSlot(slotsB, slot)
    if (valueB === undefined) continue
    if (entryA.value !== valueB) {
      return {
        aId: a.id,
        bId: b.id,
        slot,
        kind: "slot",
        reason: `${SLOT_LABELS[slot]}不相符：「${entryA.value}」与「${valueB}」`,
      }
    }
  }

  // 2) 年龄 ↔ 学段 常识区间互斥
  const stageA = pickSlot(slotsA, "stage")
  const stageB = pickSlot(slotsB, "stage")
  const ageA = pickSlot(slotsA, "age")
  const ageB = pickSlot(slotsB, "age")
  const cross: Array<{ stage?: string; age?: string }> = [
    { stage: stageA, age: ageB },
    { stage: stageB, age: ageA },
  ]
  for (const pair of cross) {
    if (!pair.stage || !pair.age) continue
    const range = STAGE_AGE_RANGE[pair.stage]
    if (!range) continue
    const n = Number(pair.age.replace(/[^0-9]/g, ""))
    if (Number.isNaN(n)) continue
    if (n < range[0] || n > range[1]) {
      return {
        aId: a.id,
        bId: b.id,
        slot: "age",
        kind: "age_stage",
        reason: `年龄「${pair.age}」与学段「${pair.stage}」不相符（${pair.stage}一般 ${range[0]}–${range[1]} 岁）`,
      }
    }
  }

  // 3) 身份 ↔ 学段 互斥（在职却读高中 / 退休还在读书）
  const roleA = pickSlot(slotsA, "role")
  const roleB = pickSlot(slotsB, "role")
  const roleCross: Array<{ role?: string; stage?: string }> = [
    { role: roleA, stage: stageB },
    { role: roleB, stage: stageA },
  ]
  for (const pair of roleCross) {
    if (!pair.role || !pair.stage) continue
    const blocked = ROLE_STAGE_CONFLICT[pair.role]
    if (blocked && blocked.includes(pair.stage)) {
      return {
        aId: a.id,
        bId: b.id,
        slot: "role",
        kind: "role_stage",
        reason: `身份「${pair.role}」与学段「${pair.stage}」不相符`,
      }
    }
  }

  return null
}

/**
 * 新条目 vs 已有记忆：返回所有与它矛盾的已有条目（写入管线据此标记取代）。
 * existingIdsToSkip 用于排除本轮刚写入的条目。
 */
export function findConflicts(
  candidate: Pick<ConflictCandidate, "id" | "content">,
  existing: Array<Pick<ConflictCandidate, "id" | "content">>
): ConflictHit[] {
  const hits: ConflictHit[] = []
  for (const e of existing) {
    if (e.id === candidate.id) continue
    const hit = findPairConflict(candidate, e)
    if (hit) hits.push(hit)
  }
  return hits
}

/** 该条是否已与该对端裁决过「都保留」（裁决后不再重复提示） */
function isResolvedPeer(m: ConflictCandidate, peerId: string): boolean {
  if (!m.conflictPeers) return false
  return m.conflictPeers.split(",").includes(peerId)
}

/**
 * 全库冲突分组（供 GET /api/memories 计算冲突提示区 + 注入前抑制）。
 *
 * 只比较参与判定的条目（能抽出槽位的），并对已裁决「都保留」的对子跳过。
 * 分组用简单并查集式扩展：A↔B、B↔C 归为同一组，UI 上一组一张卡片。
 * 复杂度 O(n²)，n 为抽出槽位的条目数（受 200 字/条与记忆条数量级约束，实测远小于阈值）。
 */
export function detectConflictGroups(memories: ConflictCandidate[]): ConflictGroup[] {
  const relevant = memories.filter((m) => extractSlots(m.content).length > 0)
  if (relevant.length < 2) return []

  const hits: ConflictHit[] = []
  for (let i = 0; i < relevant.length; i++) {
    for (let j = i + 1; j < relevant.length; j++) {
      const a = relevant[i]
      const b = relevant[j]
      if (isResolvedPeer(a, b.id) || isResolvedPeer(b, a.id)) continue
      const hit = findPairConflict(a, b)
      if (hit) hits.push(hit)
    }
  }
  if (!hits.length) return []

  // 按 id 聚组
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    let cur = id
    while (parent.get(cur) && parent.get(cur) !== cur) cur = parent.get(cur) as string
    return cur
  }
  const union = (x: string, y: string) => {
    if (!parent.has(x)) parent.set(x, x)
    if (!parent.has(y)) parent.set(y, y)
    const rx = find(x)
    const ry = find(y)
    if (rx !== ry) parent.set(ry, rx)
  }
  for (const hit of hits) union(hit.aId, hit.bId)

  const buckets = new Map<string, string[]>()
  for (const hit of hits) {
    const root = find(hit.aId)
    const list = buckets.get(root) ?? []
    for (const id of [hit.aId, hit.bId]) {
      if (!list.includes(id)) list.push(id)
    }
    buckets.set(root, list)
  }

  const byId = new Map(memories.map((m) => [m.id, m]))
  const groups: ConflictGroup[] = []
  buckets.forEach((ids) => {
    const members = ids.map((id) => byId.get(id)).filter((m): m is ConflictCandidate => !!m)
    if (members.length < 2) return
    const winner = members.slice().sort((x, y) => toTime(y.updatedAt) - toTime(x.updatedAt))[0]
    groups.push({
      ids: members.map((m) => m.id),
      winnerId: winner.id,
      hits: hits.filter((h) => ids.includes(h.aId) && ids.includes(h.bId)),
    })
  })

  // 组内条数多的排前，卡片信息量更大
  return groups.sort((a, b) => b.ids.length - a.ids.length)
}

/**
 * 注入前的冲突抑制：在一批待注入条目里，把每组矛盾中除最新一条以外的其余条目剔除。
 *
 * 只影响"这次请求注入了什么"，不改数据库 —— 误判可由用户在设置里裁决并回滚。
 * updatedAtOf 由调用方提供（不同读取层的 Memory 形状时间字段一致，但要显式传以免
 * 默认按传入顺序判胜，那样抑制结果不确定）。
 */
export function suppressConflicting<T extends Pick<ConflictCandidate, "id" | "content">>(
  items: T[],
  updatedAtOf: (item: T) => Date | string | undefined
): { kept: T[]; suppressedIds: Set<string> } {
  if (items.length < 2) return { kept: items, suppressedIds: new Set() }

  const candidates: ConflictCandidate[] = items.map((item) => ({
    ...item,
    updatedAt: updatedAtOf(item),
  }))
  const groups = detectConflictGroups(candidates)
  if (!groups.length) return { kept: items, suppressedIds: new Set() }

  const suppressedIds = new Set<string>()
  for (const group of groups) {
    for (const id of group.ids) {
      if (id !== group.winnerId) suppressedIds.add(id)
    }
  }
  const kept = items.filter((item) => !suppressedIds.has(item.id))
  return { kept, suppressedIds }
}
