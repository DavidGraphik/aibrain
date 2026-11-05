-- Report of a schedule generation, for the manager to review.
CREATE TABLE IF NOT EXISTS "horario_informes" (
  "id" SERIAL NOT NULL,
  "establecimientoId" INTEGER NOT NULL,
  "semana" TEXT NOT NULL,
  "resumen" TEXT,
  "conflictos" TEXT,
  "informeCanvis" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "horario_informes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "horario_informes_est_semana_key" ON "horario_informes"("establecimientoId", "semana");
