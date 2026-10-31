import { test } from "node:test"
import assert from "node:assert/strict"
import {
  STUDY_COMPLETE_MARKER,
  isStudyComplete,
  looksLikeMidLesson,
  stripStudyMarker,
} from "../../src/lib/study/lesson-flow"

// 学习模式结课判定:标记只是"必要条件",不是"充分条件"。
// 线上事故形态——模型只讲了第一步,结尾写着「要接着看第二步就说下一步」,
// 却仍在回复末尾打了完成标记,导致前端弹出「本题讲解完成」把讲解区整段收走。
// 这里把四道闸的边界全部钉死,防止判定再退回"只看标记在不在"。

const M = STUDY_COMPLETE_MARKER

function reply(body: string): string {
  return `${body}\n\n${M}`
}

// --- 正例:真收尾 ---

test("真收尾(答案已给出 + 标记在末尾)判结课", () => {
  assert.equal(
    isStudyComplete(reply("综上,$b+c=5$,所以周长为 $7$。关键方法是先求角再用余弦定理。"), "stop"),
    true,
  )
})

test("小结里出现「下一步代入求值」这类叙述不算邀请,照常结课", () => {
  assert.equal(
    isStudyComplete(reply("最后一步就是求周长。小结:下一步代入求值的思路可以复用到同类题。"), "stop"),
    true,
  )
})

test("标记后只有空白也算落在末尾", () => {
  assert.equal(isStudyComplete(`${reply("所以 $C=\\frac{\\pi}{3}$。")}\n\n  `, "stop"), true)
})

// --- 反例:中间态 ---

test("本次故障原文:边讲第一步边邀请说下一步,不结课", () => {
  const text = reply(
    "第一步只做代换,把条件式变成 $\\sqrt{2}\\sin A\\cos B=2\\sin C-\\sqrt{3}\\sin B$。要接着看第二步就说“下一步”。",
  )
  assert.equal(isStudyComplete(text, "stop"), false)
  assert.equal(looksLikeMidLesson(text), true)
})

test("「想继续就说一声」变体不结课", () => {
  assert.equal(isStudyComplete(reply("先消化一下。想继续就说一声。"), "stop"), false)
})

test("「需要我接着讲吗」变体不结课", () => {
  assert.equal(isStudyComplete(reply("这里是第一层提示。需要我接着讲吗"), "stop"), false)
})

test("「随时告诉我」变体不结课", () => {
  assert.equal(isStudyComplete(reply("先把角 $B$ 求出来。卡住了随时告诉我。"), "stop"), false)
})

test("标记夹在中间(后面还有内容)不结课", () => {
  assert.equal(isStudyComplete(`${M}\n后面还有第三步没讲。`, "stop"), false)
})

test("正文只有标记不结课", () => {
  assert.equal(isStudyComplete(`\n\n${M}\n`, "stop"), false)
})

test("无标记不结课", () => {
  assert.equal(isStudyComplete("第一步:把边化成角。", "stop"), false)
})

test("截断或工具暂停不结课", () => {
  assert.equal(isStudyComplete(reply("综上,周长为 $7$。"), "length"), false)
  assert.equal(isStudyComplete(reply("综上,周长为 $7$。"), "tool-calls"), false)
  assert.equal(isStudyComplete(reply("综上,周长为 $7$。"), undefined), false)
})

// --- 工具函数 ---

test("stripStudyMarker 抹掉标记与尾随空白", () => {
  assert.equal(stripStudyMarker("正文\n\n<!-- study-complete -->\n\n"), "正文")
})
