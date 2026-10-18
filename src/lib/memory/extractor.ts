import { generateText, type LanguageModel } from "ai"
import { parseMemoryArray, type ExtractedMemoryItem } from "./parser"
import { upsertMemories } from "./dedupe"
import { listMemoryContents } from "./store"

/** 记忆提取提示词：只收长期事实，矛盾以 remove 字段回传 */
const EXTRACTION_PROMPT = `你是记忆提取助手。根据以下对话内容，提取关于用户的新的、长期有效的事实信息。

规则：
1. 只提取用户明确表达的、长期有效的信息（如身份、职业、偏好、习惯、项目、技能、目标）
2. 不要提取临时性、一次性的信息（如"今天想吃什么"）
3. 每条内容用第三人称简明表述，例如"用户喜欢使用 TypeScript 开发"
4. 与"已有记忆"语义重复、同主题或包含的内容不要提取，同一主题的信息合并为一条
5. 没有值得记忆的新信息时返回空数组
6. 如果新信息与"已有记忆"中的某条矛盾（以用户最新表述为准），在 remove 字段中**逐字原样复制**该条旧记忆的原文（或其连续片段），不要改写成你自己的说法，以便替换它。年龄、学段、城市、身份这类信息发生变化时，必须把对应的旧记忆原文放进 remove
7. 忽略用户消息中与事实无关的标记、序号、测试说明等文字，只提取事实本身

category 可选值：user_info（身份信息）、preference（偏好）、habit（习惯）、project（项目）、skill（技能）、other（其他）

输出格式：只输出一个 JSON 数组本身，不要输出任何其他文字或代码块标记。例如：
[{"category": "preference", "content": "用户喜欢简洁的设计", "remove": ["用户喜欢花哨的设计"]}]
remove 为可选字段，其内容必须原样取自"已有记忆"列表中的文字；没有需要替换的旧记忆时省略`

/**
 * 调用 LLM 从一轮对话中提取新记忆
 */
async function extractMemoriesWithLLM(options: {
  model: LanguageModel
  userText: string
  assistantText: string
  existingContents: string[]
}): Promise<ExtractedMemoryItem[]> {
  const { model, userText, assistantText, existingContents } = options

  const existingSection =
    existingContents.length > 0 ? existingContents.map((c) => `- ${c}`).join("\n") : "（暂无）"

  const result = await generateText({
    model,
    temperature: 0,
    maxOutputTokens: 500,
    prompt: `${EXTRACTION_PROMPT}

已有记忆：
${existingSection}

对话内容：
用户：${userText.slice(0, 2000)}

AI：${assistantText.slice(0, 2000)}`,
  })

  const items = parseMemoryArray(result.text)
  // 模型明确回了内容却解析出 0 条 = 输出格式跑偏，以前静默丢弃，现在留痕
  if (!items.length && result.text.trim()) {
    console.warn(
      `[memory] 提取输出解析为空(格式跑偏或被 200 字上限截断),原始输出: ${result.text
        .slice(0, 300)
        .replace(/\s+/g, " ")}`
    )
  }
  return items
}

/**
 * 完整流程：从一轮对话提取记忆并保存（供 onFinish 与网关写提取调用，失败不抛出）。
 * 返回写入计数；null 表示本轮跳过（文本为空/过短）或提取失败。
 */
export async function extractAndSaveMemories(options: {
  userId: string
  model: LanguageModel
  userText: string
  assistantText: string
}): Promise<{ created: number; replaced: number } | null> {
  const { userId, model, userText, assistantText } = options
  try {
    if (!userText.trim() || !assistantText.trim()) return null
    // 极短消息(如"你好""Hi")几乎不会产生新记忆,跳过提取以省去一次后台 LLM 调用的 token 开销
    if (userText.trim().length < 4) return null

    const existingContents = await listMemoryContents(userId)

    const items = await extractMemoriesWithLLM({
      model,
      userText,
      assistantText,
      existingContents,
    })

    if (!items.length) return { created: 0, replaced: 0 }

    console.log(`[memory] extracted: ${JSON.stringify(items)}`)
    const { created, superseded } = await upsertMemories(userId, items, { source: "auto" })
    if (superseded > 0) {
      console.log(`[memory] replaced ${superseded} old memories for user ${userId}`)
    }
    if (created > 0) {
      console.log(`[memory] saved ${created} new memories for user ${userId}`)
    }
    return { created, replaced: superseded }
  } catch (error) {
    // 记忆提取失败不影响聊天主流程
    console.error("[memory] extraction failed:", error)
    return null
  }
}
