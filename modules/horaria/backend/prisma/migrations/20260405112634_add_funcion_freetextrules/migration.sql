-- CreateTable
CREATE TABLE "free_text_rules" (
    "id" SERIAL NOT NULL,
    "texto" TEXT NOT NULL,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "establecimientoId" INTEGER NOT NULL,

    CONSTRAINT "free_text_rules_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "free_text_rules" ADD CONSTRAINT "free_text_rules_establecimientoId_fkey" FOREIGN KEY ("establecimientoId") REFERENCES "establishments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
