import test from 'node:test'
import assert from 'node:assert/strict'
import { auxFoot, layoutTriangle, parseTriangleFigure } from '../../src/lib/triangle-figure'

/**
 * 卷面摆放（layoutTriangle）的回归口径：
 *   ① 底边 BC 永远水平、A 永远在上 —— 锐角/直角/钝角同一套公式，不许歪图
 *   ② 坐标单位就是边长，缩放层不参与，画歪了立刻能被这里抓到
 *   ③ 极端角（尖角 10°、钝角 120°、近退化 175°）不许出 NaN
 */

const near = (x: number, y: number, eps = 1e-6) => Math.abs(x - y) <= eps
const len = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(q.x - p.x, q.y - p.y)

function layoutOf(raw: Record<string, unknown>) {
  const model = parseTriangleFigure(JSON.stringify(raw))
  assert.ok(model, `解析失败：${JSON.stringify(raw)}`)
  return { model, p: layoutTriangle(model.sides) }
}

test('锐角 SAS(60°/b=2/c=3)：底边水平、A 在上、边长自洽', () => {
  const { model, p } = layoutOf({ A: 60, b: 2, c: 3 })
  assert.ok(near(p.B.y, 0) && near(p.C.y, 0), 'BC 必须水平')
  assert.ok(p.A.y < 0, 'A 必须在底边上方')
  assert.ok(near(p.C.x - p.B.x, model.sides.a), 'BC 长度应等于 a')
  assert.ok(near(len(p.A, p.B), model.sides.c), 'AB 长度应等于 c')
  assert.ok(near(len(p.A, p.C), model.sides.b), 'AC 长度应等于 b')
  // 钝角/锐角都不改公式，但 A 的投影要落在底边内（角 A 是锐角）
  assert.ok(p.A.x > p.B.x && p.A.x < p.C.x)
})

test('直角三角形(3-4-5，C=90°)：BC 水平，直角落在 C 且 A 在 C 正上方', () => {
  const { model, p } = layoutOf({ a: 3, b: 4, c: 5 })
  assert.ok(near(model.angles.C, 90, 1e-6), '3-4-5 的直角应在 C')
  assert.ok(near(p.B.y, 0) && near(p.C.y, 0))
  assert.ok(p.A.y < 0)
  // AC ⟂ BC：A 的 x 与 C 重合，说明直角边 CA 保持竖直
  assert.ok(near(p.A.x, p.C.x))
  assert.ok(near(len(p.A, p.B), 5) && near(len(p.A, p.C), 4))
})

test('钝角三角形(A=120°,b=c=1)：底边水平、A 在上，图形明显扁平', () => {
  const { model, p } = layoutOf({ A: 120, b: 1, c: 1 })
  assert.ok(near(model.angles.A, 120))
  assert.ok(near(p.B.y, 0) && near(p.C.y, 0))
  assert.ok(p.A.y < 0)
  const h = Math.abs(p.A.y)
  const w = p.C.x - p.B.x
  assert.ok(h < w * 0.4, `钝角应扁平，实际 高${h.toFixed(3)}/宽${w.toFixed(3)}`)
})

test('尖角三角形(A=10°,b=c=1)：仍然可摆，高度接近腰长', () => {
  const { p } = layoutOf({ A: 10, b: 1, c: 1 })
  assert.ok(near(p.B.y, 0) && near(p.C.y, 0))
  assert.ok(p.A.y < 0)
  assert.ok(near(Math.abs(p.A.y), Math.cos((10 / 2) * (Math.PI / 180)), 1e-6), '高应为 cos(A/2)')
  assert.ok(p.C.x - p.B.x < 0.2, '底气应该很短')
})

test('等边三角形：A 落在底边中点的正上方', () => {
  const { p } = layoutOf({ a: 1, b: 1, c: 1 })
  assert.ok(near(p.A.x, 0.5), '等边时 A 应在 BC 中点')
  assert.ok(near(Math.abs(p.A.y), Math.sqrt(3) / 2, 1e-6))
})

test('B 为钝角时 A 的垂足落到 B 之外（钝角特征，不做裁切）', () => {
  // b² > a² + c² ⇒ ∠B 是钝角 ⇒ xA = (c²+a²-b²)/2a < 0
  const { p } = layoutOf({ A: 20, b: 3, c: 1 })
  assert.ok(p.A.x < p.B.x, `xA 应落到底边左端之外，实际 ${p.A.x.toFixed(3)}`)
  assert.ok(p.A.y < 0)
})

test('SSS 与 SAS 给同一组量时布局一致', () => {
  const sas = layoutOf({ A: 60, b: 2, c: 3 }).p
  const sssModel = parseTriangleFigure(JSON.stringify({ A: 60, b: 2, c: 3 }))
  assert.ok(sssModel)
  const sss = layoutTriangle({ a: sssModel.sides.a, b: sssModel.sides.b, c: sssModel.sides.c })
  assert.ok(near(sas.A.x, sss.A.x, 1e-9) && near(sas.A.y, sss.A.y, 1e-9))
  assert.ok(near(sas.C.x, sss.C.x, 1e-9))
})

test('退化三角形(1,1,3)解析即拒，不进入布局', () => {
  assert.equal(parseTriangleFigure(JSON.stringify({ a: 1, b: 1, c: 3 })), null)
})

test('5°~175° 全角度扫一遍：底边恒水平、A 恒在上、无 NaN', () => {
  for (let deg = 5; deg <= 175; deg += 5) {
    const { p } = layoutOf({ A: deg, b: 1, c: 1 })
    assert.ok(near(p.B.y, 0) && near(p.C.y, 0), `${deg}° 底边不水平`)
    assert.ok(Number.isFinite(p.A.x) && Number.isFinite(p.A.y), `${deg}° 出现 NaN`)
    assert.ok(p.A.y < 0, `${deg}° A 掉到底边下方`)
    assert.ok(near(p.A.x, 0.5 * (p.C.x - p.B.x), 1e-6), `${deg}° 等腰时 A 应在中点`)
  }
})

/* ── 辅助线(extra)────────────────────────────────────────────
 * 口径：落点算错 = 图画错(垂足不在垂线上、角平分线不按定理分底边)，
 * 所以把数学放到 lib 里由这里直接量，不靠肉眼。
 */

test('extra 解析：对象、字符串简写、中文别名都收', () => {
  const model = parseTriangleFigure(
    JSON.stringify({ a: 3, b: 4, c: 5, extra: [{ type: 'altitude', from: 'A' }, 'median:B', '角平分线:C'] }),
  )
  assert.ok(model)
  assert.deepEqual(model.extra, [
    { kind: 'altitude', from: 'A', label: undefined },
    { kind: 'median', from: 'B', label: undefined },
    { kind: 'bisector', from: 'C', label: undefined },
  ])
})

test('extra 容错：认不出的类型、非顶点、重复项一律丢弃，不影响成图', () => {
  const model = parseTriangleFigure(
    JSON.stringify({
      a: 3,
      b: 4,
      c: 5,
      extra: ['diagonal:A', { type: 'altitude', from: 'D' }, { type: 'altitude', from: 'A' }, { type: 'altitude', from: 'A' }, '中线', 'bisector'],
    }),
  )
  assert.ok(model, '辅助线写坏不该让整张图退化成代码块')
  assert.deepEqual(
    model.extra.map((a) => `${a.kind}:${a.from}`),
    ['altitude:A', 'median:A', 'bisector:A'],
  )
})

test('extra 缺省字母交给渲染层，模型可指定 label', () => {
  const model = parseTriangleFigure(JSON.stringify({ a: 3, b: 4, c: 5, extra: [{ type: 'median', from: 'A', label: 'M' }] }))
  assert.ok(model)
  assert.equal(model.extra[0].label, 'M')
})

test('auxFoot：垂足、中点、角平分线分底边都按几何定义落在位上', () => {
  const pts = layoutTriangle({ a: 3, b: 4, c: 5 }) // 3-4-5，∠C=90
  // 从 A 作高：AC ⟂ BC，垂足正好是 C（t=1）
  const alt = auxFoot('altitude', 'A', pts)
  assert.ok(near(alt.p.x, pts.C.x) && near(alt.p.y, pts.C.y), `垂足应为 C，实际 ${alt.p.x},${alt.p.y}`)
  assert.ok(near(alt.t, 1))
  // 中线：底边中点
  const med = auxFoot('median', 'A', pts)
  assert.ok(near(med.p.x, (pts.B.x + pts.C.x) / 2) && near(med.t, 0.5))
  // 角平分线：BD/DC = AB/AC = 5/4
  const bis = auxFoot('bisector', 'A', pts)
  const bd = Math.hypot(bis.p.x - pts.B.x, bis.p.y - pts.B.y)
  const dc = Math.hypot(bis.p.x - pts.C.x, bis.p.y - pts.C.y)
  assert.ok(near(bd / dc, 5 / 4, 1e-9), `BD/DC 应为 5/4，实际 ${(bd / dc).toFixed(6)}`)
})

test('auxFoot：钝角作高时垂足落到底边延长线上（t<0），渲染层据此补延长虚线', () => {
  const solved = parseTriangleFigure(JSON.stringify({ A: 20, b: 3, c: 1 }))
  assert.ok(solved)
  const alt = auxFoot('altitude', 'A', layoutTriangle(solved.sides))
  assert.ok(alt.t < 0, `垂足应落在线段外，实际 t=${alt.t.toFixed(3)}`)
})
