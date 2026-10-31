-- 手表设备码授权：短码 + 一次性 Token 中转
CREATE TABLE "DeviceAuthCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "userId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "plainToken" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceAuthCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DeviceAuthCode_code_key" ON "DeviceAuthCode"("code");
CREATE INDEX "DeviceAuthCode_expiresAt_idx" ON "DeviceAuthCode"("expiresAt");
