-- 商品收藏(YellowFish 在售商品快照):与消息收藏(Favorite)彻底分家。
-- 只存商品链接+价格快照,不自动爬价、不参与监控回报;商品下架后本表仍可查看。
CREATE TABLE IF NOT EXISTS "FavoriteItem" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "price" DOUBLE PRECISION,
    "priceDisplay" TEXT,
    "url" TEXT NOT NULL,
    "pic" TEXT,
    "location" TEXT,
    "seller" TEXT,
    "keyword" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FavoriteItem_pkey" PRIMARY KEY ("id")
);

-- 同一件商品幂等收藏
CREATE UNIQUE INDEX IF NOT EXISTS "FavoriteItem_userId_itemId_key" ON "FavoriteItem"("userId", "itemId");
CREATE INDEX IF NOT EXISTS "FavoriteItem_userId_createdAt_idx" ON "FavoriteItem"("userId", "createdAt");

ALTER TABLE "FavoriteItem" ADD CONSTRAINT "FavoriteItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
