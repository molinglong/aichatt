/**
 * 记忆矛盾消解 —— 真库 smoke（不启 dev server，直接跑路由用的同一批函数）
 *
 * 用法：npx tsx --env-file=.env scripts/smoke-memory-conflict.ts
 * 全程只用一个临时账号（跑完连记忆一起级联删除），不碰任何真实用户数据。
 */
import { prisma } from "@/lib/db"
import { upsertMemories } from "@/lib/memory/dedupe"
import { detectConflictGroups } from "@/lib/memory/conflict"
import { getRelevantMemories } from "@/lib/memory/relevance"
import {
  deleteMemory,
  listMemoryFacts,
  markKeptBoth,
  restoreMemory,
  MEMORY_STATUS_ACTIVE,
  MEMORY_STATUS_SUPERSEDED,
} from "@/lib/memory/store"

let failures = 0
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`)
  if (!ok) failures++
}

async function main() {
  const email = `zz-memory-conflict-smoke@local.test`
  await prisma.user.deleteMany({ where: { email } })
  const user = await prisma.user.create({ data: { email, name: "冲突smoke" } })
  console.log(`临时账号 ${user.id}`)

  try {
    // 1) 先记「27岁」，再记「高中生」——第二条应把第一条挤成 superseded
    const first = await upsertMemories(
      user.id,
      [{ category: "user_info", content: "林小夏，27岁，杭州人" }],
      { source: "manual" }
    )
    check("首次写入创建 1 条", first.created === 1)
    const firstId = first.createdRows[0]?.id

    const second = await upsertMemories(
      user.id,
      [{ category: "user_info", content: "林小夏，高中生" }],
      { source: "manual" }
    )
    check("第二条也落库", second.created === 1)
    check("第二条取代了第一条", second.superseded === 1, JSON.stringify(second.supersededDetails))

    const rows = await prisma.memory.findMany({ where: { userId: user.id } })
    const oldRow = rows.find((r) => r.id === firstId)
    const newRow = rows.find((r) => r.id === second.createdRows[0]?.id)
    check("旧条 status=superseded", oldRow?.status === MEMORY_STATUS_SUPERSEDED)
    check("旧条记住胜者 id", oldRow?.supersededBy === newRow?.id)
    check("胜者 status=active", newRow?.status === MEMORY_STATUS_ACTIVE)

    // 2) 注入端：只应看到高中生
    const facts = await listMemoryFacts(user.id)
    const injectable = facts.map((f) => ({
      id: f.id,
      content: f.content,
      category: f.category,
      source: "manual",
      status: f.status,
      updatedAt: f.updatedAt,
    }))
    const relevant = getRelevantMemories(injectable, "帮我讲讲牛顿第二定律")
    check(
      "注入集合里没有 27岁",
      !relevant.some((m) => m.content.includes("27岁")),
      relevant.map((m) => m.content).join(" / ")
    )

    // 3) 冲突提示：胜者唯一时不该再有冲突组
    check("取代后无待裁决冲突组", detectConflictGroups(injectable).length === 0)

    // 4) 反悔：恢复「27岁」应反向把「高中生」挤下去
    if (firstId) {
      const restored = await restoreMemory(user.id, firstId)
      check("恢复成功", restored.ok)
      const after = await prisma.memory.findMany({ where: { userId: user.id } })
      check(
        "恢复后 27岁 生效",
        after.find((r) => r.id === firstId)?.status === MEMORY_STATUS_ACTIVE
      )
      check(
        "恢复后 高中生 被取代",
        after.find((r) => r.id === newRow?.id)?.status === MEMORY_STATUS_SUPERSEDED
      )
    }

    // 5) 都保留：两条同时 active 且不再提示冲突
    await prisma.memory.updateMany({
      where: { userId: user.id },
      data: { status: MEMORY_STATUS_ACTIVE, supersededBy: null },
    })
    const bothActive = await prisma.memory.findMany({ where: { userId: user.id } })
    const groups = detectConflictGroups(
      bothActive.map((m) => ({
        id: m.id,
        content: m.content,
        category: m.category,
        updatedAt: m.updatedAt,
        conflictPeers: m.conflictPeers,
      }))
    )
    check("两条都 active 时能组出冲突组", groups.length === 1, `ids=${groups[0]?.ids.join(",")}`)
    if (groups[0]) {
      await markKeptBoth(user.id, groups[0].ids)
      const afterKeep = await prisma.memory.findMany({ where: { userId: user.id } })
      const groups2 = detectConflictGroups(
        afterKeep.map((m) => ({
          id: m.id,
          content: m.content,
          category: m.category,
          updatedAt: m.updatedAt,
          conflictPeers: m.conflictPeers,
        }))
      )
      check("裁决「都保留」后不再重复提示", groups2.length === 0)
    }

    // 6) 删掉胜者不应留下孤儿：单独造一对（现居上海 → 现居北京 取代它），再删胜者
    await prisma.memory.deleteMany({ where: { userId: user.id } })
    await upsertMemories(
      user.id,
      [
        { category: "user_info", content: "用户现居上海" },
        { category: "user_info", content: "用户现居北京" },
      ],
      { source: "manual" }
    )
    const pair = await prisma.memory.findMany({ where: { userId: user.id } })
    const loser = pair.find((m) => m.status === MEMORY_STATUS_SUPERSEDED)
    const winner = pair.find((m) => m.status === MEMORY_STATUS_ACTIVE)
    check("同槽位城市互斥也能取代", !!loser && !!winner, `loser=${loser?.content}`)
    if (winner) {
      const del = await deleteMemory(user.id, winner.id)
      check("删除胜者返回成功", del.ok)
      check("删除胜者救回 1 条被取代记忆", del.revived === 1)
      const left = await prisma.memory.findMany({ where: { userId: user.id } })
      check(
        "救回的那条回到生效态且无悬挂 supersededBy",
        left.length === 1 &&
          left[0].status === MEMORY_STATUS_ACTIVE &&
          left[0].supersededBy === null
      )
    }
    // 7) 删除不存在的 id 要如实返回失败（归属校验）
    const missing = await deleteMemory(user.id, "no-such-id")
    check("删除他人/不存在条目返回失败", missing.ok === false)
  } finally {
    await prisma.user.delete({ where: { id: user.id } })
    const left = await prisma.memory.count({ where: { userId: user.id } })
    console.log(`清理临时账号，残留记忆条数 = ${left}`)
    if (left !== 0) failures++
  }

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} 项 FAIL`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error("smoke 异常:", err)
  process.exit(1)
})
