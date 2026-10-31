-- 同一条消息只允许一张错题卡(自动归档与手动存入共用唯一键)
-- 前置检查:库里应无重复 (userId, sourceMessageId);重复会令本迁移失败。
CREATE UNIQUE INDEX "StudyNote_userId_sourceMessageId_key" ON "StudyNote"("userId", "sourceMessageId");
