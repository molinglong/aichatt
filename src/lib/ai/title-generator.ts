import { generateText, type LanguageModel } from 'ai'

/**
 * 使用 AI 根据用户的第一条消息生成简洁的对话标题。
 * 异步执行，失败时自动降级为截断原文。
 */
export async function generateConversationTitle(
  userMessage: string,
  model: LanguageModel
): Promise<string> {
  try {
    const { text } = await generateText({
      model,
      system:
        'Generate a short, concise title (3-8 words) for a chat conversation that starts with the following message. ' +
        'Reply with ONLY the title text — no quotes, no prefixes, no extra text, no punctuation at the end.',
      prompt: `User message: "${userMessage.slice(0, 500)}"\n\nTitle:`,
      temperature: 0.3,
    })
    // 部分推理模型会把思考过程塞进正文(含未闭合的  thinking 标记),标题里不能带出来:
    // 先剥成对 / 未闭合的思考块,再取标题;剥完全空则回落到用户原文截断。
    const title = text
      .replace(/<\s*think(?:ing)?\s*>[\s\S]*?<\s*\/\s*think(?:ing)?\s*>/gi, '')
      .replace(/<\s*think(?:ing)?\s*>[\s\S]*$/i, '')
      .trim()
      .replace(/^["'""'']+|["'""'']+$/g, '')
      .replace(/^Title:\s*/i, '')
      .slice(0, 50)
    return title || fallbackTitle(userMessage)
  } catch {
    return fallbackTitle(userMessage)
  }
}

function fallbackTitle(userMessage: string): string {
  return userMessage.slice(0, 30) || '新对话'
}