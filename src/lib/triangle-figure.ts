/**
 * 三角形图示解析工具
 *
 * AI 在讲解几何/解三角形题时输出 ```triangle 围栏块（JSON），这里把参数解成完整三角形，
 * 供 TriangleFigure 用纯 SVG 渲染。与 ```chart 同款策略：解析/校验失败一律返回 null，
 * 调用方降级回普通代码块，绝不吞掉模型输出的原文。
 *
 * 输入只需「能唯一确定一个三角形的三个独立量」，不必 6 个量齐全：
 *   三边         {"a":1.15,"b":1.25,"c":1}                → SSS
 *   两边夹一角   {"A":60,"b":1.25,"c":1}                  → SAS（最常用：可拖动角）
 *   两角夹一边   {"A":60,"B":70.9,"c":1}                  → ASA/AAS
 * 模型偶尔会多给（6 个量都写），此时以边长为准解出角度，忽略自相矛盾的角度值。
 */

export type TriVertex = 'A' | 'B' | 'C'
export type TriSide = 'a' | 'b' | 'c'
export type TriMark = TriVertex | TriSide

/** 辅助线类型：高线 / 中线 / 角平分线，都是从某个顶点引到对边 */
export type TriAuxKind = 'altitude' | 'median' | 'bisector'

export interface TriAux {
  kind: TriAuxKind
  /** 从哪个顶点引出 */
  from: TriVertex
  /** 落点字母；缺省由渲染层按 D/E/F 顺序补 */
  label?: string
}

export interface TriangleFigureModel {
  /** 三个内角（度） */
  angles: Record<TriVertex, number>
  /** 三条边（题目原始单位） */
  sides: Record<TriSide, number>
  /** 可拖动的角：保持两条邻边不变，拖动时重解三角形 */
  drag: TriVertex
  /** 需要强调的边/角 */
  highlight: TriMark[]
  /** 辅助线（求面积/求高/证明用），最多三条 */
  extra: TriAux[]
  /** 图下方的一行说明（可选） */
  caption?: string
}

export interface TriangleFigureOptions {
  drag: TriVertex
  highlight: TriMark[]
  caption?: string
}

const VERTICES: TriVertex[] = ['A', 'B', 'C']
const SIDES: TriSide[] = ['a', 'b', 'c']
/** 每个角的两条邻边与对边 */
export const TRI_OPPOSITE: Record<TriVertex, TriSide> = { A: 'a', B: 'b', C: 'c' }
export const TRI_ADJACENT: Record<TriVertex, [TriSide, TriSide]> = {
  A: ['b', 'c'],
  B: ['a', 'c'],
  C: ['a', 'b'],
}
const OPPOSITE = TRI_OPPOSITE
const ADJACENT = TRI_ADJACENT

const DEG = 180 / Math.PI
const EPS = 1e-9

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  // 允许模型写 "60°" / "1.25 cm" 这类带单位的值
  const m = value.replace(/[，,]/g, '.').match(/-?\d+(?:\.\d+)?/)
  if (!m) return null
  const n = Number(m[0])
  return Number.isFinite(n) ? n : null
}

function clampCos(v: number): number {
  return Math.max(-1, Math.min(1, v))
}

interface Known {
  angles: Partial<Record<TriVertex, number>>
  sides: Partial<Record<TriSide, number>>
}

/** 从顶层键与 angles/sides 子对象里收集已知量（容忍两种写法） */
function collectKnown(raw: Record<string, unknown>): Known {
  const known: Known = { angles: {}, sides: {} }
  const take = (key: string, value: unknown) => {
    const k = key.trim()
    // 先认小写边名，再认大写角名：'b' 不能因为 toUpperCase 之后变成 'B' 就被当成角
    if (SIDES.includes(k as TriSide)) {
      const n = num(value)
      if (n !== null) known.sides[k as TriSide] = n
      return
    }
    if (VERTICES.includes(k as TriVertex)) {
      const n = num(value)
      if (n !== null) known.angles[k as TriVertex] = n
    }
  }
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'angles' && value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) take(k, v)
    } else if (key === 'sides' && value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) take(k, v)
    } else {
      take(key, value)
    }
  }
  return known
}

/** 三边求三角（余弦定理）；不满足三角不等式返回 null */
export function solveSSS(a: number, b: number, c: number): { angles: Record<TriVertex, number>; sides: Record<TriSide, number> } | null {
  if (![a, b, c].every((v) => Number.isFinite(v) && v > EPS)) return null
  if (a + b <= c + EPS || b + c <= a + EPS || a + c <= b + EPS) return null
  const A = Math.acos(clampCos((b * b + c * c - a * a) / (2 * b * c))) * DEG
  const B = Math.acos(clampCos((a * a + c * c - b * b) / (2 * a * c))) * DEG
  const C = 180 - A - B
  if (![A, B, C].every((v) => v > 0.05 && v < 179.95)) return null
  return { angles: { A, B, C }, sides: { a, b, c } }
}

/** 两边夹一角（SAAS 的 SAS）：角 v 的两条邻边已知，求对边 */
export function solveSAS(v: TriVertex, side1: number, side2: number, angleDeg: number): { angles: Record<TriVertex, number>; sides: Record<TriSide, number> } | null {
  if (!(angleDeg > 0.05 && angleDeg < 179.95)) return null
  if (!(side1 > EPS) || !(side2 > EPS)) return null
  const rad = angleDeg / DEG
  const opposite = Math.sqrt(side1 * side1 + side2 * side2 - 2 * side1 * side2 * Math.cos(rad))
  if (!(opposite > EPS)) return null
  const [s1, s2] = ADJACENT[v]
  const sides = { a: 0, b: 0, c: 0 } as Record<TriSide, number>
  sides[s1] = side1
  sides[s2] = side2
  sides[OPPOSITE[v]] = opposite
  const solved = solveSSS(sides.a, sides.b, sides.c)
  if (!solved) return null
  // 夹角是题目给定的，优先保留原值，避免浮点回算让 60° 显示成 59.999
  solved.angles[v] = angleDeg
  return solved
}

/** 两角（或三角）+ 至少一边：正弦定理 */
export function solveAAS(angles: Partial<Record<TriVertex, number>>, sides: Partial<Record<TriSide, number>>): { angles: Record<TriVertex, number>; sides: Record<TriSide, number> } | null {
  const given = VERTICES.filter((v) => angles[v] !== undefined).map((v) => angles[v] as number)
  const knownSides = SIDES.filter((s) => sides[s] !== undefined)
  if (knownSides.length === 0) return null
  if (given.length < 2) return null
  if (given.some((v) => !(v > 0.05 && v < 179.95))) return null

  const full = { A: 0, B: 0, C: 0 } as Record<TriVertex, number>
  let missing: TriVertex | null = null
  for (const v of VERTICES) {
    const value = angles[v]
    if (value === undefined) missing = v
    else full[v] = value
  }
  if (missing) full[missing] = 180 - (full.A + full.B + full.C - 0)
  // 上面减法在 missing 未赋值（0）时正确：180 - 其余两角之和
  const sum = full.A + full.B + full.C
  if (Math.abs(sum - 180) > 1.5) return null

  // 找一条「已知边 + 已知对角」来确定比例
  let scale: number | null = null
  for (const s of knownSides) {
    const v = (Object.keys(OPPOSITE) as TriVertex[]).find((k) => OPPOSITE[k] === s) as TriVertex
    const sv = Math.sin(full[v] / DEG)
    if (sv > EPS) scale = (sides[s] as number) / sv
    if (scale !== null) break
  }
  if (!scale || !(scale > EPS)) return null

  const resolved = { a: 0, b: 0, c: 0 } as Record<TriSide, number>
  for (const v of VERTICES) {
    const s = OPPOSITE[v]
    const fromModel = sides[s]
    resolved[s] = fromModel !== undefined && fromModel > EPS ? fromModel : scale * Math.sin(full[v] / DEG)
  }
  if (!SIDES.every((s) => resolved[s] > EPS)) return null
  return { angles: full, sides: resolved }
}

/** 兼容入口：按 SSS → SAS → AAS 的优先级求解 */
export function solveTriangle(known: Known): { angles: Record<TriVertex, number>; sides: Record<TriSide, number> } | null {
  const { angles, sides } = known
  const hasAllSides = SIDES.every((s) => (sides[s] as number | undefined) !== undefined)

  // 1) 三边齐全：最直观，也允许模型同时给了角度（以边为准）
  if (hasAllSides) {
    const solved = solveSSS(sides.a as number, sides.b as number, sides.c as number)
    if (solved) return solved
  }

  // 2) 两边 + 夹角
  for (const v of VERTICES) {
    const angle = angles[v]
    if (angle === undefined) continue
    const [s1, s2] = ADJACENT[v]
    const v1 = sides[s1]
    const v2 = sides[s2]
    if (v1 !== undefined && v2 !== undefined) {
      const solved = solveSAS(v, v1, v2, angle)
      if (solved) return solved
    }
  }

  // 3) 两角 + 任意一边
  const solvedAAS = solveAAS(angles, sides)
  if (solvedAAS) return solvedAAS

  return null
}

/* ── 卷面摆放 ──────────────────────────────────────────────
 * 底边 BC 水平、A 在上，三种角共用一套公式：先按余弦定理量出 A 在底边上的
 * 投影位置 xA，再由 AB=c 反推高度。旧做法是「把角 A 的平分线竖起来」，
 * 于是 b≠c 时 BC 是斜的（60°/b=2/c=3 斜了 19°），看着像画歪了。
 *
 * 坐标单位与边长一致（未缩放），缩放/居中由渲染层负责。钝角时 xA 会落在
 * [0, a] 之外——这正是钝角的特征，包围盒会把它兜住，不要去裁。
 */
export interface TriPoint { x: number; y: number }

export function layoutTriangle(sides: Record<TriSide, number>): Record<TriVertex, TriPoint> {
  const { a, b, c } = sides
  const xA = (c * c + a * a - b * b) / (2 * a)
  const yA = -Math.sqrt(Math.max(0, c * c - xA * xA))
  return {
    A: { x: xA, y: yA },
    B: { x: 0, y: 0 },
    C: { x: a, y: 0 },
  }
}

export interface TriAuxFoot {
  /** 落点坐标（与 layoutTriangle 同一坐标系，未缩放） */
  p: TriPoint
  /** 沿 Q→R 的参数：<0 或 >1 说明落到底边延长线上（钝角作高的情形） */
  t: number
}

/**
 * 辅助线与对边的交点。
 *   高线     —— 顶点在底边上的正交投影，t 可越界（垂足落在线段外）
 *   中线     —— 底边中点
 *   角平分线 —— 角平分线定理 BD/DC = AB/AC，即 t = |AB| / (|AB| + |AC|)
 * 单位与边长一致、缩放交给渲染层：落点是仿射不变量，缩放后比例不变。
 */
export function auxFoot(kind: TriAuxKind, from: TriVertex, pts: Record<TriVertex, TriPoint>): TriAuxFoot {
  const [q, r] = VERTICES.filter((v) => v !== from)
  const V = pts[from]
  const Q = pts[q]
  const R = pts[r]
  const dx = R.x - Q.x
  const dy = R.y - Q.y
  const base = dx * dx + dy * dy
  let t = 0.5
  if (kind === 'bisector') {
    const m = Math.hypot(V.x - Q.x, V.y - Q.y)
    const n = Math.hypot(V.x - R.x, V.y - R.y)
    if (m + n > EPS) t = m / (m + n)
  } else if (kind === 'altitude') {
    if (base > EPS) t = ((V.x - Q.x) * dx + (V.y - Q.y) * dy) / base
  }
  return { p: { x: Q.x + dx * t, y: Q.y + dy * t }, t }
}

const AUX_ALIASES: Record<string, TriAuxKind> = {
  altitude: 'altitude', height: 'altitude', perpendicular: 'altitude',
  高: 'altitude', 高线: 'altitude', 垂线: 'altitude', 垂足: 'altitude',
  median: 'median', midpoint: 'median',
  中线: 'median', 中点: 'median',
  bisector: 'bisector', anglebisector: 'bisector',
  角平分线: 'bisector', 平分线: 'bisector',
}

function normalizeAuxKind(value: unknown): TriAuxKind | null {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (!raw) return null
  return AUX_ALIASES[raw.toLowerCase()] ?? AUX_ALIASES[raw.replace(/[\s_-]/g, '').toLowerCase()] ?? AUX_ALIASES[raw] ?? null
}

function normalizeVertex(value: unknown): TriVertex | null {
  if (typeof value !== 'string') return null
  const up = value.trim().replace(/^[∠点]/, '').toUpperCase()
  return up.length === 1 && VERTICES.includes(up as TriVertex) ? (up as TriVertex) : null
}

/** 单项辅助线：容忍 {"type":"altitude","from":"A"} 与 "altitude:A" 两种写法 */
function parseAuxItem(item: unknown, index: number): TriAux | null {
  if (typeof item === 'string') {
    const parts = item.trim().split(/[:：\s]+/).filter(Boolean)
    const kind = normalizeAuxKind(parts[0])
    if (!kind) return null
    return { kind, from: (parts[1] && normalizeVertex(parts[1])) || 'A', label: parts[2] || undefined }
  }
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const obj = item as Record<string, unknown>
  const kind = normalizeAuxKind(obj.type ?? obj.kind ?? obj.name)
  if (!kind) return null
  const fromRaw = obj.from ?? obj.vertex ?? obj.at ?? obj.start
  const from = fromRaw === undefined ? VERTICES[index % 3] : normalizeVertex(fromRaw)
  if (!from) return null
  const label = typeof obj.label === 'string' ? obj.label.trim().slice(0, 3) : ''
  return { kind, from, label: label || undefined }
}

function normalizeMark(value: unknown): TriMark | null {
  if (typeof value !== 'string') return null
  const t = value.trim()
  if (!t) return null
  // "∠A" / "边a" 这类写法都收；小写优先判为边，避免 'b' 被 toUpperCase 之后误判成角 B
  const stripped = t.replace(/^[∠边]/, '').trim()
  if (stripped.length === 1) {
    if (SIDES.includes(stripped as TriSide)) return stripped as TriSide
    const up = stripped.toUpperCase()
    if (VERTICES.includes(up as TriVertex)) return up as TriVertex
  }
  const last = t.slice(-1)
  if (SIDES.includes(last as TriSide)) return last as TriSide
  if (VERTICES.includes(last.toUpperCase() as TriVertex)) return last.toUpperCase() as TriVertex
  return null
}

function normalizeDrag(value: unknown): TriVertex {
  const mark = normalizeMark(value)
  if (!mark) return 'A'
  if (mark === 'a') return 'A'
  if (mark === 'b') return 'B'
  if (mark === 'c') return 'C'
  return mark
}

/**
 * 解析 ```triangle 围栏内容。任何不合法（JSON 坏、量不足、三角不等式不成立）都返回 null。
 * 选择 null 而不是抛错：渲染层据此退回代码块，用户至少看到原文。
 */
export function parseTriangleFigure(source: string): TriangleFigureModel | null {
  const text = source.trim()
  if (!text) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>

  const known = collectKnown(obj)
  const solved = solveTriangle(known)
  if (!solved) return null

  const { angles, sides } = solved
  if (!VERTICES.every((v) => Number.isFinite(angles[v]) && angles[v] > 0.05 && angles[v] < 179.95)) return null
  if (!SIDES.every((s) => Number.isFinite(sides[s]) && sides[s] > EPS)) return null

  const highlightRaw = obj.highlight ?? obj.marks
  const highlight: TriMark[] = []
  if (Array.isArray(highlightRaw)) {
    for (const item of highlightRaw) {
      const m = normalizeMark(item)
      if (m && !highlight.includes(m)) highlight.push(m)
    }
  }

  // 辅助线：非法项静默跳过 —— 它只是装饰，不该因为一条写错就让整张图退化成代码块
  const extraRaw = obj.extra ?? obj.aux ?? obj.auxiliary
  const extra: TriAux[] = []
  if (extraRaw) {
    const list = Array.isArray(extraRaw) ? extraRaw : [extraRaw]
    for (let i = 0; i < list.length && extra.length < 3; i++) {
      const aux = parseAuxItem(list[i], i)
      if (!aux) continue
      if (extra.some((e) => e.kind === aux.kind && e.from === aux.from)) continue
      extra.push(aux)
    }
  }

  const caption = typeof obj.caption === 'string' ? obj.caption.trim().slice(0, 160) : undefined

  return {
    angles,
    sides,
    drag: normalizeDrag(obj.drag ?? obj.track),
    highlight,
    extra,
    caption: caption || undefined,
  }
}
