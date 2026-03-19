-- AlterTable: Add spot pricing fields to warm_pool_config
ALTER TABLE "warm_pool_config" ADD COLUMN "basePriceCents" INTEGER NOT NULL DEFAULT 55;
ALTER TABLE "warm_pool_config" ADD COLUMN "currentSpotPriceCents" INTEGER NOT NULL DEFAULT 55;
ALTER TABLE "warm_pool_config" ADD COLUMN "lastPriceUpdateAt" DATETIME;
ALTER TABLE "warm_pool_config" ADD COLUMN "lastRentalAt" DATETIME;

-- AlterTable: Add spot pricing fields to gpu_skus
ALTER TABLE "gpu_skus" ADD COLUMN "spotPriceCents" INTEGER;
ALTER TABLE "gpu_skus" ADD COLUMN "spotMultiplier" REAL NOT NULL DEFAULT 1.0;
