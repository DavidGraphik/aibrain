-- Drop existing FK and recreate with ON DELETE CASCADE
ALTER TABLE "whatsapp_messages" DROP CONSTRAINT IF EXISTS "whatsapp_messages_conversacionId_fkey";

ALTER TABLE "whatsapp_messages"
  ADD CONSTRAINT "whatsapp_messages_conversacionId_fkey"
  FOREIGN KEY ("conversacionId")
  REFERENCES "whatsapp_conversations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
