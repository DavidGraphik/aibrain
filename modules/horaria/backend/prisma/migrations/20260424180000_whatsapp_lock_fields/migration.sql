-- Add anti-troll counter, lock flag, and completion timestamp for the 10-min edit window
ALTER TABLE "whatsapp_conversations"
  ADD COLUMN IF NOT EXISTS "intentosIrrelevantes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "bloqueada" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3);
