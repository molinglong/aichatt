'use client'

import { memo, useMemo } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { auxFoot, layoutTriangle, parseTriangleFigure, type TriAux, type TriMark, type TriSide, type TriVertex } from '@/lib/triangle-figure'

/**
 * 三角形图示卡：```triangle 围栏块 → 纯 SVG（零依赖，与 GameGauge 同路线）。
 *
 * 定位是「题目主图」:渲染层把首张图固定提到消息最顶,图在上、题干在下
 * (教材/卷面版式),标好边角与已知量。
 * 不做拖动/滑块 —— 交互版另开一轮,届时复用解析器已保留的 drag 字段。
 * 解析失败一律退回原始代码块（tri-raw），绝不吞模型输出。
 *
 * 尺寸策略(2026-10-27 重做):坐标系 W=400 固定不紧裁(跨题字号不漂),
 * 卡片外框却随屏幕变窄 —— 于是所有「该有多大」的量先写成屏幕像素目标,
 * 再除以画布→像素比 k(卡片内宽/400)塞进画布单位:卡片收窄时图形等比缩小,
 * 字/线/弧/圆点在屏幕上大小不变。手机端因此不再需要一套媒体查询补偿值。
 * 注意 s(图形→画布)与 k(画布→像素)是两件事:字号只跟 k 有关,
 * 曾经误用 s 反补,结果字号被缩到 0.14px。
 *
 * 卷面姿态(见 layoutTriangle):底边 BC 水平、A 在上;直角改画 ∟ 并省掉度数,
 * 角弧半径受邻边与对边高双重约束(窄角不甩出边外)。
 *
 * 辅助线(extra):高线/中线/角平分线,虚线从顶点引到对边。高线在垂足补 ∟、
 * 垂足落到线段外时补底边延伸虚线;中线在底边画等分杠。交点数学在 lib.auxFoot,
 * 这里只做缩放映射与 D/E/F 字母分配(已有辅助线时画布底部多留 26px 放字母)。
 */

const VERTICES: TriVertex[] = ['A', 'B', 'C']
const SIDES: TriSide[] = ['a', 'b', 'c']

/** 以下是「屏幕像素」目标值;组件内一律 /k 换算进画布单位(k 见下) */
const TEXT_PX = { vertex: 17.5, side: 15, angle: 13.5, aux: 15 }
const HALO_PX = 3
const EDGE_W_PX = { idle: 1.9, on: 2.8 }
const ARC_W_PX = { idle: 1.4, on: 1.6 }
const DOT_R_PX = 3.3
const ARC_R_PX = 24
const RIGHT_MARK_PX = 12
const VERTEX_LABEL_PX = 22
const SIDE_LABEL_PX = 18
const ANGLE_GAP_PX = 8
/** 辅助线：虚线节奏、线宽、交点圆点、落点字母距离，单位都是屏幕像素 */
const AUX_W_PX = 1.5
const AUX_DASH_PX: [number, number] = [5, 4]
const AUX_DOT_R_PX = 2.9
const AUX_LABEL_PX = 42
const AUX_TICK_PX = 5
/** 有辅助线时底部多留的高度：落点字母比边名再外一层，避免和 a/b/c 叠在一起 */
const AUX_BOTTOM_PAD = 40
/** 落点与顶点距离小于这个屏幕像素时视为重合（直角边作高），不再另标字母 */
const AUX_COINCIDE_PX = 14
const AUX_DEFAULT_LABELS = ['D', 'E', 'F']
/**
 * 卡片内宽(px) = globals.css 的 .tri-figure max-width 320 − 左右 padding 0.9rem×2 ≈ 291。
 * 画布恒 400 宽,所以「画布单位 → 屏幕像素」= 291/400 = 0.728,与三角形形状无关。
 * 改 CSS 的卡片宽度要同步这里 —— 这是唯一一处跨文件耦合,两边注释互相指向。
 */
const CARD_INNER_PX = 291
/** 直角判定容差:余弦定理回算 90° 会有浮点尾巴 */
const RIGHT_TOL = 0.6

const fmtAngle = (v: number) => `${v.toFixed(1)}°`

const HIGHLIGHT_ON = 'var(--tri-hi)'
const EDGE_IDLE = 'var(--tri-edge)'

interface FigureGeom {
  angles: Record<TriVertex, number>
  sides: Record<TriSide, number>
}

interface Pt { x: number; y: number }

const dist = (p: Pt, q: Pt) => Math.hypot(q.x - p.x, q.y - p.y)

function unit(p: Pt, q: Pt): Pt {
  const l = dist(p, q) || 1
  return { x: (q.x - p.x) / l, y: (q.y - p.y) / l }
}

/** 沿角平分线取点:d>0 向三角形内侧,负值即往角外侧翻出去 */
function bisector(V: Pt, P1: Pt, P2: Pt, d: number): Pt {
  const u = unit(V, P1)
  const v = unit(V, P2)
  const l = Math.hypot(u.x + v.x, u.y + v.y) || 1
  return { x: V.x + ((u.x + v.x) / l) * d, y: V.y + ((u.y + v.y) / l) * d }
}

function TriangleSvg({ geom, highlight, extra }: { geom: FigureGeom; highlight: TriMark[]; extra: TriAux[] }) {
  // 画布宽固定 W(不紧裁):缩放比只由卡片内宽决定,跨题字号不漂;
  // 高度按图形实际高宽比收紧(扁三角形不留上下大片空白),上下限兜住极端情形
  const W = 400
  const pad = 40
  const H_MAX = 400
  const H_MIN = 150
  const LX = 38
  // 顶部再留 10px:最高顶点字母沿重心方向外移后只剩几像素余量,换字体就会被裁
  const VB_TOP = -10

  const pts = useMemo(() => layoutTriangle(geom.sides), [geom.sides])

  const minX = Math.min(pts.A.x, pts.B.x, pts.C.x)
  const maxX = Math.max(pts.A.x, pts.B.x, pts.C.x)
  const minY = Math.min(pts.A.y, pts.B.y, pts.C.y)
  const maxY = Math.max(pts.A.y, pts.B.y, pts.C.y)
  const w = Math.max(1e-6, maxX - minX)
  const h = Math.max(1e-6, maxY - minY)
  const s = Math.min((W - pad * 2) / w, (H_MAX - LX * 2) / h)
  /** 画布单位 → 屏幕像素:只由卡片内宽决定(画布恒 400 宽),与 s 无关 ——
   *  所以同一条边在不同形状的题里占的比例不同,但标签在屏幕上永远一样大 */
  const k = CARD_INNER_PX / W
  // 辅助线要在底边外侧标落点字母（D/E/F），比边名再外一层 —— 只延长画布底部，
  // 图形本身位置不动（oy 表达式与无辅助线时一致），无辅助线的题尺寸不受影响
  const AX_PAD = extra.length ? AUX_BOTTOM_PAD : 0
  const H = Math.max(H_MIN, Math.min(H_MAX, h * s + LX * 2 + AX_PAD))
  const ox = (W - w * s) / 2 - minX * s
  const oy = (H - AX_PAD - h * s) / 2 - minY * s
  const P = (p: Pt): Pt => ({ x: p.x * s + ox, y: p.y * s + oy })

  const pA = P(pts.A), pB = P(pts.B), pC = P(pts.C)
  const G = { x: (pA.x + pB.x + pC.x) / 3, y: (pA.y + pB.y + pC.y) / 3 }
  /** 2S(叉积绝对值):拿去算「顶点到对边的高」= 2S / 对边 */
  const area2 = Math.abs((pB.x - pA.x) * (pC.y - pA.y) - (pC.x - pA.x) * (pB.y - pA.y))
  const heightOf = (V: Pt, Q: Pt, R: Pt) => area2 / (dist(Q, R) || 1)

  const arcPts: Record<TriVertex, { v: Pt; p: Pt; q: Pt }> = {
    A: { v: pA, p: pB, q: pC },
    B: { v: pB, p: pA, q: pC },
    C: { v: pC, p: pA, q: pB },
  }

  /** 角弧半径:视觉 24px 为目标,但不超过邻边 13%、也不穿出对边——窄角/极小图形自动收 */
  const arcR = (V: Pt, Q: Pt, R: Pt) =>
    Math.max(9, Math.min(ARC_R_PX / k, Math.min(dist(V, Q), dist(V, R)) * 0.13, heightOf(V, Q, R) * 0.5))
  const rOf: Record<TriVertex, number> = {
    A: arcR(arcPts.A.v, arcPts.A.p, arcPts.A.q),
    B: arcR(arcPts.B.v, arcPts.B.p, arcPts.B.q),
    C: arcR(arcPts.C.v, arcPts.C.p, arcPts.C.q),
  }

  // 直角改画 ∟ 方块(课本惯例,不叠弧);三种角走同一套坐标,只是标记不同
  const rightAt = VERTICES.find((v) => Math.abs(geom.angles[v] - 90) <= RIGHT_TOL) ?? null
  /** 直角框:沿两条边各取 d,第三点取 u+v 的交点,三点折线 */
  const rightPath = (V: Pt, Q: Pt, R: Pt) => {
    const u = unit(V, Q)
    const v = unit(V, R)
    const d = Math.min(RIGHT_MARK_PX / k, Math.min(dist(V, Q), dist(V, R)) * 0.3)
    return `M ${V.x + u.x * d} ${V.y + u.y * d} L ${V.x + (u.x + v.x) * d} ${V.y + (u.y + v.y) * d} L ${V.x + v.x * d} ${V.y + v.y * d}`
  }

  const arcPath = (V: Pt, Q: Pt, R: Pt, r: number) => {
    const d1 = Math.atan2(Q.y - V.y, Q.x - V.x)
    const d2 = Math.atan2(R.y - V.y, R.x - V.x)
    const a1 = { x: V.x + r * Math.cos(d1), y: V.y + r * Math.sin(d1) }
    const a2 = { x: V.x + r * Math.cos(d2), y: V.y + r * Math.sin(d2) }
    let delta = d2 - d1
    while (delta > Math.PI) delta -= Math.PI * 2
    while (delta < -Math.PI) delta += Math.PI * 2
    const sweep = delta > 0 ? 1 : 0
    return `M ${V.x} ${V.y} L ${a1.x} ${a1.y} A ${r} ${r} 0 0 ${sweep} ${a2.x} ${a2.y} Z`
  }

  /** 标注位置不许出画布:尖角外标 + 最外侧顶点都可能顶到边 */
  const clampInCanvas = (p: Pt): Pt => ({
    x: Math.max(14, Math.min(W - 14, p.x)),
    y: Math.max(14, Math.min(H - 14, p.y)),
  })

  /** 度数位置:统一贴弧内侧。早先窄角改标外侧,结果和顶点字母撞在一起
   *  (尖角三角形的顶点就在画布顶端,外标方向与顶点字母同向);改由 CSS 的
   *  paint-order 白描边兜住压线可读性 */
  const anglePos = (v: TriVertex): Pt => {
    const { v: V, p: Q, q: R } = arcPts[v]
    return clampInCanvas(bisector(V, Q, R, rOf[v] + (12 + ANGLE_GAP_PX) / k))
  }

  /** 顶点字母:沿「重心 → 顶点」方向外移,离顶点固定视觉距离 */
  const vertexLabel = (p: Pt): Pt => {
    const dx = p.x - G.x
    const dy = p.y - G.y
    const l = Math.hypot(dx, dy) || 1
    return clampInCanvas({ x: p.x + (dx / l) * (VERTEX_LABEL_PX / k), y: p.y + (dy / l) * (VERTEX_LABEL_PX / k) })
  }

  /** 边名:贴三角形外侧法线,固定视觉距离(与外心方向比符号,保证往外) */
  const sideLabel = (p: Pt, q: Pt): Pt => {
    const mx = (p.x + q.x) / 2
    const my = (p.y + q.y) / 2
    let nx = -(q.y - p.y)
    let ny = q.x - p.x
    const l = Math.hypot(nx, ny) || 1
    nx /= l
    ny /= l
    if ((mx - G.x) * nx + (my - G.y) * ny < 0) {
      nx = -nx
      ny = -ny
    }
    return clampInCanvas({ x: mx + nx * (SIDE_LABEL_PX / k), y: my + ny * (SIDE_LABEL_PX / k) })
  }

  const isHi = (m: TriMark) => highlight.includes(m)
  const hasHi = highlight.length > 0
  const edgePaint = (side: TriSide) => ({
    stroke: isHi(side) ? HIGHLIGHT_ON : EDGE_IDLE,
    width: (isHi(side) ? EDGE_W_PX.on : EDGE_W_PX.idle) / k,
    opacity: hasHi && !isHi(side) ? 0.85 : 1,
  })

  // 度数只标 highlight 角（默认 A）；直角用 ∟ 表达，度数省掉，
  // 否则会和 ∟ 折线、边名挤在同一个角里
  const markedAngles = VERTICES.filter((v) => isHi(v))
  const angleTextSet = (markedAngles.length ? markedAngles : (['A'] as TriVertex[])).filter((v) => v !== rightAt)

  const lab = {
    A: vertexLabel(pA), B: vertexLabel(pB), C: vertexLabel(pC),
    a: sideLabel(pB, pC), b: sideLabel(pC, pA), c: sideLabel(pA, pB),
  }

  /** 辅助线落点字母:沿「底边外法线」往外推,比边名再远一层(a 在 18px、D 在 42px)。
   *  不用「重心→落点」方向:重心在图形内侧,会把底边上的字母斜着推向右下,
   *  正好撞到那个角上的顶点字母(C 附近作高时实测叠字) */
  const auxLabelPos = (Q: Pt, R: Pt, F: Pt): Pt => {
    let nx = -(R.y - Q.y)
    let ny = R.x - Q.x
    const l = Math.hypot(nx, ny) || 1
    nx /= l
    ny /= l
    const mx = (Q.x + R.x) / 2
    const my = (Q.y + R.y) / 2
    if ((mx - G.x) * nx + (my - G.y) * ny < 0) {
      nx = -nx
      ny = -ny
    }
    return clampInCanvas({ x: F.x + nx * (AUX_LABEL_PX / k), y: F.y + ny * (AUX_LABEL_PX / k) })
  }

  /** 等分杠:跨边一小段,垂直于底边(中线的惯用标记) */
  const auxTick = (center: Pt, along: Pt) => {
    const n = { x: -along.y, y: along.x }
    const h = AUX_TICK_PX / k
    return `M ${center.x - n.x * h} ${center.y - n.y * h} L ${center.x + n.x * h} ${center.y + n.y * h}`
  }

  // 落点数学交给 lib(可单测),这里只做缩放映射与字母分配
  const usedAuxLabels = new Set(extra.map((a) => a.label).filter((v): v is string => !!v))
  const auxList = extra.map((item) => {
    const foot = auxFoot(item.kind, item.from, pts)
    let label = item.label
    if (!label) label = AUX_DEFAULT_LABELS.find((c) => !usedAuxLabels.has(c)) ?? 'D'
    usedAuxLabels.add(label)
    const [q, r] = VERTICES.filter((v) => v !== item.from)
    const F = P(foot.p)
    // 垂足正好压在某个顶点上(直角边作高时垂足就是 C):不另标字母,否则和顶点字母摞在一起
    const coincide = VERTICES.some((v) => v !== item.from && dist(F, P(pts[v])) < AUX_COINCIDE_PX / k)
    return { ...item, label, F, V: P(pts[item.from]), Q: P(pts[q]), R: P(pts[r]), t: foot.t, coincide }
  })

  /** 字号与线宽都按 1/k 换算回画布单位:CSS 只给兜底默认值,尺寸由这里统一定 */
  const cssVars = {
    '--tri-fs-vertex': `${TEXT_PX.vertex / k}px`,
    '--tri-fs-side': `${TEXT_PX.side / k}px`,
    '--tri-fs-angle': `${TEXT_PX.angle / k}px`,
    '--tri-fs-aux': `${TEXT_PX.aux / k}px`,
    '--tri-halo-w': `${HALO_PX / k}px`,
    '--tri-arc-w': `${ARC_W_PX.idle / k}px`,
    '--tri-arc-on-w': `${ARC_W_PX.on / k}px`,
    '--tri-aux-w': `${AUX_W_PX / k}px`,
    '--tri-aux-dash': `${AUX_DASH_PX[0] / k} ${AUX_DASH_PX[1] / k}`,
  } as CSSProperties

  return (
    <svg
      viewBox={`0 ${VB_TOP} ${W} ${H - VB_TOP}`}
      className="tri-figure-svg"
      style={cssVars}
      role="img"
      aria-label={`三角形 ABC，A ${fmtAngle(geom.angles.A)}，B ${fmtAngle(geom.angles.B)}，C ${fmtAngle(geom.angles.C)}`}
    >
      <path d={`M ${pA.x} ${pA.y} L ${pB.x} ${pB.y} L ${pC.x} ${pC.y} Z`} className="tri-fill" />
      <line x1={pA.x} y1={pA.y} x2={pB.x} y2={pB.y} stroke={edgePaint('c').stroke} strokeWidth={edgePaint('c').width} strokeOpacity={edgePaint('c').opacity} strokeLinecap="round" />
      <line x1={pA.x} y1={pA.y} x2={pC.x} y2={pC.y} stroke={edgePaint('b').stroke} strokeWidth={edgePaint('b').width} strokeOpacity={edgePaint('b').opacity} strokeLinecap="round" />
      <line x1={pB.x} y1={pB.y} x2={pC.x} y2={pC.y} stroke={edgePaint('a').stroke} strokeWidth={edgePaint('a').width} strokeOpacity={edgePaint('a').opacity} strokeLinecap="round" />

      {auxList.map((a, i) => {
        // 垂足落到底边延长线上（钝角作高）：补一小段延伸虚线，否则垂足看着悬空
        const outside = a.t < -0.001 || a.t > 1.001
        const extFrom = a.t < 0 ? a.Q : a.R
        // ∟ 与等分杠都贴着底边：取离落点近的那一端定方向；落在线段外时朝线段所在侧
        const near = a.t < 0 ? a.R : a.t > 1 ? a.Q : dist(a.F, a.Q) <= dist(a.F, a.R) ? a.Q : a.R
        const along = unit(a.Q, a.R)
        return (
          <g key={`aux-${i}`}>
            {outside && <line className="tri-aux tri-aux-ext" x1={extFrom.x} y1={extFrom.y} x2={a.F.x} y2={a.F.y} />}
            <line className="tri-aux" x1={a.V.x} y1={a.V.y} x2={a.F.x} y2={a.F.y} />
            {a.kind === 'altitude' && <path className="tri-aux-right" d={rightPath(a.F, a.V, near)} />}
            {a.kind === 'median' && (
              <path
                className="tri-aux-tick"
                d={[
                  auxTick({ x: (a.Q.x + a.F.x) / 2, y: (a.Q.y + a.F.y) / 2 }, along),
                  auxTick({ x: (a.F.x + a.R.x) / 2, y: (a.F.y + a.R.y) / 2 }, along),
                ].join(' ')}
              />
            )}
          </g>
        )
      })}

      {VERTICES.map((v) =>
        v === rightAt ? (
          <path
            key={`right-${v}`}
            d={rightPath(arcPts[v].v, arcPts[v].p, arcPts[v].q)}
            className={isHi(v) ? 'tri-right-mark tri-right-mark-on' : 'tri-right-mark'}
          />
        ) : (
          <path
            key={`arc-${v}`}
            d={arcPath(arcPts[v].v, arcPts[v].p, arcPts[v].q, rOf[v])}
            className={isHi(v) ? 'tri-angle-arc tri-angle-arc-on' : 'tri-angle-arc'}
          />
        ),
      )}

      {angleTextSet.map((v) => (
        <text key={`ang-${v}`} x={anglePos(v).x} y={anglePos(v).y} textAnchor="middle" dominantBaseline="middle" className="tri-angle-txt tri-angle-txt-on">
          {fmtAngle(geom.angles[v])}
        </text>
      ))}

      {[{ p: pA, k: 'A' as TriVertex }, { p: pB, k: 'B' as TriVertex }, { p: pC, k: 'C' as TriVertex }].map(({ p, k: vert }) => (
        <g key={vert}>
          <circle cx={p.x} cy={p.y} r={DOT_R_PX / k} className="tri-dot" />
          <text x={lab[vert].x} y={lab[vert].y} textAnchor="middle" dominantBaseline="middle" className="tri-vertex-txt">{vert}</text>
        </g>
      ))}

      {SIDES.map((side) => (
        <text key={side} x={lab[side].x} y={lab[side].y} textAnchor="middle" dominantBaseline="middle" className={isHi(side) ? 'tri-side-txt tri-side-txt-on' : 'tri-side-txt'}>{side}</text>
      ))}

      {auxList.map((a, i) => {
        if (a.coincide) return null
        const pos = auxLabelPos(a.Q, a.R, a.F)
        return (
          <g key={`aux-lab-${i}`}>
            <circle cx={a.F.x} cy={a.F.y} r={AUX_DOT_R_PX / k} className="tri-aux-dot" />
            <text x={pos.x} y={pos.y} textAnchor="middle" dominantBaseline="middle" className="tri-aux-txt">{a.label}</text>
          </g>
        )
      })}
    </svg>
  )
}

export const TriangleFigure = memo(function TriangleFigure({
  source,
  rawChildren,
}: {
  source: string
  /** 解析失败时渲染层把原始代码块交回来，保证不吞内容 */
  rawChildren?: ReactNode
}) {
  const model = useMemo(() => parseTriangleFigure(source), [source])

  if (!model) {
    return <pre className="tri-raw">{rawChildren}</pre>
  }

  const { angles, sides, highlight, extra, caption } = model

  return (
    <div className="tri-figure">
      <div className="tri-figure-head">
        <span className="tri-figure-tag">图形</span>
        <span className="tri-figure-meta">△ABC</span>
      </div>
      <TriangleSvg geom={{ angles, sides }} highlight={highlight} extra={extra} />
      {caption && <div className="tri-caption">{caption}</div>}
    </div>
  )
})
