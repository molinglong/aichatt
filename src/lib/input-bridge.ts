/**
 * 输入框桥接 —— 让 props 链够不着的深层组件(如 MarkdownRenderer 里的代码块)
 * 把文本注入聊天输入框,而不必层层透传回调(会触碰 MessageBubble 等组件的
 * 自定义 memo 比较函数,风险高)。
 *
 * ChatInput 监听同名事件把文本追加到输入框;草稿持久化由其既有 effect 自动完成。
 */
export const INPUT_INSERT_EVENT = 'aichatt:insert-to-input'

export function insertTextToInput(text: string) {
  if (typeof window === 'undefined' || !text) return
  window.dispatchEvent(new CustomEvent(INPUT_INSERT_EVENT, { detail: { text } }))
}

/**
 * 直接发送桥 —— 深层组件(游戏面板的行动按钮)一键把文本当作 user 消息发出,
 * 复用 ChatPanel 的 handleSend 全链路(落库/排队/token 统计),无需层层透传回调。
 * 与 insert 桥的区别: insert 只填进输入框等用户按发送, send 立即发出。
 * ChatPanel 监听同名事件调用 handleSend;非聊天页无人监听,点击静默无副作用。
 */
export const INPUT_SEND_EVENT = 'aichatt:send-as-user'

export function sendTextAsUser(text: string) {
  if (typeof window === 'undefined' || !text) return
  window.dispatchEvent(new CustomEvent(INPUT_SEND_EVENT, { detail: { text } }))
}
