-- 学习模式会话标记:历史列表点开学习会话时回到 /study 学习室,而不是普通聊天。
-- 回填历史数据:学习室首条消息固定以「请帮我理解这道题。」开头,
-- 且发送时带 studyAction metadata(见 ChatPanel.handleSend),两条命中其一即可。

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "studyMode" BOOLEAN NOT NULL DEFAULT false;

-- 历史学习会话回填
UPDATE "Conversation" c SET "studyMode" = true
WHERE EXISTS (
  SELECT 1 FROM "Message" m
  WHERE m."conversationId" = c.id
    AND m.role = 'user'
    AND (m.content LIKE '请帮我理解这道题。%' OR m.metadata LIKE '%"studyAction"%')
);
