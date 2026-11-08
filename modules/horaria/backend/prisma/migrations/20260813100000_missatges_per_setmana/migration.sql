-- Els missatges es queden i porten la seva setmana.
--
-- Fins ara una conversa era una per telèfon i el broadcast de la setmana nova
-- esborrava els missatges de l'anterior. Amb l'enviament automàtic això passava
-- cada diumenge, en silenci: la conversa que llegies dimarts ja no hi era.
ALTER TABLE "whatsapp_messages" ADD COLUMN "semana" TEXT;

-- Els que hi ha ara són tots de la setmana que la seva conversa té oberta.
UPDATE "whatsapp_messages" m
SET "semana" = c."semana"
FROM "whatsapp_conversations" c
WHERE m."conversacionId" = c."id";

CREATE INDEX "whatsapp_messages_conversacionId_semana_idx" ON "whatsapp_messages"("conversacionId", "semana");
