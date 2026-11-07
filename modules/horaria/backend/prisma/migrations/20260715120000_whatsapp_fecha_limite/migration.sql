-- Deadline to submit preferences; after it the chatbot locks the conversation.
ALTER TABLE "whatsapp_conversations" ADD COLUMN IF NOT EXISTS "fechaLimite" TIMESTAMP(3);
