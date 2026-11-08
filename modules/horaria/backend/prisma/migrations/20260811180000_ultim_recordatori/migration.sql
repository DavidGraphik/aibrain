-- Quan se li va enviar l'últim recordatori, per no repetir-l'hi si el cron es
-- dispara dues vegades. El broadcast ja estava protegit; això no.
ALTER TABLE "whatsapp_conversations" ADD COLUMN "ultimoRecordatorio" TIMESTAMP(3);
