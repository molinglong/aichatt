-- 记忆矛盾消解：冲突不再靠物理删除，旧条目标 superseded 并记住取代者，用户在设置里可恢复或改判
ALTER TABLE "Memory" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "Memory" ADD COLUMN "supersededBy" TEXT;
ALTER TABLE "Memory" ADD COLUMN "conflictPeers" TEXT;

-- CreateIndex
CREATE INDEX "Memory_userId_status_idx" ON "Memory"("userId", "status");
