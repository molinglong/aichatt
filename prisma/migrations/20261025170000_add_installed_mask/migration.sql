-- 面具面板下载记录：用户从「设置→面具管理→面具面板」下载过的内置面具。
-- 只存内置 maskId，面具本体仍在代码里只读；删除记录 = 卸载。
CREATE TABLE IF NOT EXISTS "InstalledMask" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "maskId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InstalledMask_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "InstalledMask_userId_maskId_key" ON "InstalledMask"("userId", "maskId");
CREATE INDEX IF NOT EXISTS "InstalledMask_userId_idx" ON "InstalledMask"("userId");

ALTER TABLE "InstalledMask" ADD CONSTRAINT "InstalledMask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
