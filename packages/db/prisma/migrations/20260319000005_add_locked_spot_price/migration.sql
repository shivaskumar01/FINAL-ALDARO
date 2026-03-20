-- AlterTable: Add lockedSpotPriceCents to workspaces
-- Captures the spot price at the moment of launch so cold-booted workspaces
-- are billed at the price the user saw at checkout, not whatever the spot
-- pricing algorithm sets during the boot window.
ALTER TABLE "workspaces" ADD COLUMN "lockedSpotPriceCents" INTEGER;
