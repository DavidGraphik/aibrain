-- Els errors que passen al navegador de la gent.
--
-- Tot el que hem muntat per assabentar-nos que alguna cosa falla mira el
-- servidor: el 503 dels crons, el vigilant, les alertes. El navegador no el
-- mirava ningú. Si a la Dolors se li queda la pantalla en blanc un dimarts,
-- l'única manera d'assabentar-se'n és que ella truqui — i llavors ja no hi ha
-- manera de saber què va passar, perquè no en queda rastre enlloc.
--
-- Sense clau forana cap a l'empleat a posta: això és un registre de diagnòstic,
-- i no ha de poder impedir esborrar ningú ni desaparèixer quan es faci.
CREATE TABLE "client_errors" (
    "id" SERIAL NOT NULL,
    "missatge" TEXT NOT NULL,
    "pila" TEXT,
    "pantalla" TEXT,
    "navegador" TEXT,
    "empleadoId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_errors_pkey" PRIMARY KEY ("id")
);

-- Es consulta sempre per data (els d'aquesta setmana) i es purga per data.
CREATE INDEX "client_errors_createdAt_idx" ON "client_errors"("createdAt");
