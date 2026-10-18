import { test } from "node:test"
import assert from "node:assert/strict"
import {
  detectConflictGroups,
  extractSlots,
  extractSubjectName,
  findConflicts,
  findPairConflict,
  suppressConflicting,
} from "../../src/lib/memory/conflict"

const T = (iso: string) => new Date(iso)

/** 典型画像冲突：年龄与学段跨槽位互斥（用户在设置里举的原例） */
test("conflict: 27岁 与 高中生 判为 age_stage 互斥", () => {
  const a = { id: "m1", content: "林小夏，27岁，杭州人" }
  const b = { id: "m2", content: "林小夏，高中生" }
  const hit = findPairConflict(a, b)
  assert.ok(hit, "应判出矛盾")
  assert.equal(hit.kind, "age_stage")
  assert.match(hit.reason, /27岁/)
  assert.match(hit.reason, /高中/)
})

test("conflict: 同一户籍槽位取值不等判 slot 冲突，姓名相同不否决", () => {
  const hit = findPairConflict(
    { id: "m1", content: "用户是杭州人" },
    { id: "m2", content: "用户是北京人" }
  )
  assert.ok(hit)
  assert.equal(hit.kind, "slot")
  assert.equal(hit.slot, "hometown")
})

test("conflict: 户籍地与现居地是两个槽位，不算矛盾", () => {
  const hit = findPairConflict(
    { id: "m1", content: "用户是杭州人" },
    { id: "m2", content: "用户现居上海工作" }
  )
  assert.equal(hit, null)
})

test("conflict: 年龄相符的学段不判矛盾（高中生 17 岁）", () => {
  const hit = findPairConflict(
    { id: "m1", content: "用户是高中生" },
    { id: "m2", content: "用户今年17岁" }
  )
  assert.equal(hit, null)
})

test("conflict: 身份「学生」与学段「高中」相容，不判矛盾", () => {
  const hit = findPairConflict(
    { id: "m1", content: "用户是在校学生" },
    { id: "m2", content: "用户读高中" }
  )
  assert.equal(hit, null)
})

test("conflict: 在职与中小学段互斥，判 role_stage", () => {
  const hit = findPairConflict(
    { id: "m1", content: "用户已工作三年" },
    { id: "m2", content: "用户是初中生" }
  )
  assert.ok(hit)
  assert.equal(hit.kind, "role_stage")
})

test("conflict: 姓名不同视为不同主体，直接否决", () => {
  const hit = findPairConflict(
    { id: "m1", content: "张三，27岁" },
    { id: "m2", content: "李四，高中生" }
  )
  assert.equal(hit, null)
})

test("conflict: 处所词不误抽成城市（在图书馆 vs 在教室）", () => {
  assert.equal(extractSlots("用户常在图书馆自习").length, 0)
  const hit = findPairConflict(
    { id: "m1", content: "用户常在图书馆自习" },
    { id: "m2", content: "用户在教室自习" }
  )
  assert.equal(hit, null)
})

test("conflict: 无槽位的偏好对立本地判不出（已知边界，不误判）", () => {
  const hit = findPairConflict(
    { id: "m1", content: "用户偏好深色主题" },
    { id: "m2", content: "用户偏好浅色主题" }
  )
  assert.equal(hit, null)
})

test("conflict: 显式姓名与导入了名前缀都能抽出主体", () => {
  assert.equal(extractSubjectName("林小夏，27岁，杭州人"), "林小夏")
  assert.equal(extractSubjectName("用户喜欢简洁的设计"), null)
  assert.equal(extractSubjectName("我叫张小满"), "张小满")
})

test("findConflicts: 一条新记忆可同时取代多条旧记忆", () => {
  const existing = [
    { id: "old1", content: "用户是杭州人" },
    { id: "old2", content: "用户现居上海" },
    { id: "old3", content: "用户是高中生" },
  ]
  const hits = findConflicts({ id: "new", content: "用户是北京人" }, existing)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].bId, "old1")
})

test("detectConflictGroups: 传递性归组，胜者取 updatedAt 最新", () => {
  const memories = [
    { id: "a", content: "用户是杭州人", updatedAt: T("2026-01-01") },
    { id: "b", content: "用户是北京人", updatedAt: T("2026-02-01") },
    { id: "c", content: "用户是广州人", updatedAt: T("2026-03-01") },
    { id: "d", content: "用户偏好简洁设计", updatedAt: T("2026-04-01") },
  ]
  const groups = detectConflictGroups(memories)
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].ids.slice().sort(), ["a", "b", "c"])
  assert.equal(groups[0].winnerId, "c")
})

test("detectConflictGroups: 已裁决「都保留」的对子不再重复提示", () => {
  const memories = [
    { id: "a", content: "用户是杭州人", conflictPeers: "b" },
    { id: "b", content: "用户是北京人", conflictPeers: "a" },
  ]
  assert.equal(detectConflictGroups(memories).length, 0)
})

test("suppressConflicting: 同组矛盾只注入最新一条，其余抑制", () => {
  const items = [
    { id: "a", content: "用户是杭州人", updatedAt: T("2026-01-01") },
    { id: "b", content: "用户是北京人", updatedAt: T("2026-05-01") },
    { id: "c", content: "用户喜欢 TypeScript", updatedAt: T("2026-02-01") },
  ]
  const { kept, suppressedIds } = suppressConflicting(items, (m) => m.updatedAt)
  assert.deepEqual(kept.map((m) => m.id).sort(), ["b", "c"])
  assert.equal(suppressedIds.has("a"), true)
})

test("suppressConflicting: 无矛盾时原样返回，顺序不变", () => {
  const items = [
    { id: "a", content: "用户喜欢 TypeScript", updatedAt: T("2026-01-01") },
    { id: "b", content: "用户是杭州人", updatedAt: T("2026-02-01") },
  ]
  const { kept, suppressedIds } = suppressConflicting(items, (m) => m.updatedAt)
  assert.deepEqual(kept.map((m) => m.id), ["a", "b"])
  assert.equal(suppressedIds.size, 0)
})

/** ── 注入端（第零波）：superseded 不注入 + 冲突组只注入最新一条 ── */
test("relevance: status=superseded 的记忆一律不注入", async () => {
  const { getRelevantMemories } = await import("../../src/lib/memory/relevance")
  const memories = [
    { id: "a", content: "用户是杭州人", category: "user_info", source: "auto", status: "superseded", updatedAt: T("2026-01-01") },
    { id: "b", content: "用户是北京人", category: "user_info", source: "auto", status: "active", updatedAt: T("2026-05-01") },
  ]
  const out = getRelevantMemories(memories, "我住哪儿")
  assert.deepEqual(out.map((m) => m.id), ["b"])
})

test("relevance: 同组互斥记忆只注入最新那条，旧的本次不注入", async () => {
  const { getRelevantMemories } = await import("../../src/lib/memory/relevance")
  // 两条都还是 active（存量脏数据没被取代过），注入时按 updatedAt 抑制旧的
  const memories = [
    { id: "old", content: "用户27岁", category: "user_info", source: "auto", status: "active", updatedAt: T("2026-01-01") },
    { id: "new", content: "用户是高中生", category: "user_info", source: "auto", status: "active", updatedAt: T("2026-06-01") },
  ]
  const out = getRelevantMemories(memories, "帮我讲讲受力分析")
  assert.deepEqual(out.map((m) => m.id), ["new"])
})

test("relevance: status 字段缺失（老调用点/老查询）按 active 处理", async () => {
  const { getRelevantMemories } = await import("../../src/lib/memory/relevance")
  const memories = [
    { id: "a", content: "用户喜欢 TypeScript", category: "skill", source: "auto", updatedAt: T("2026-01-01") },
  ]
  const out = getRelevantMemories(memories, "TypeScript 类型怎么标")
  assert.deepEqual(out.map((m) => m.id), ["a"])
})
