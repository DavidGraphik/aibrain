-- Weekly intensity per establishment: % of contracted hours expected that week.
CREATE TABLE IF NOT EXISTS "semana_intensidad" (
  "id" SERIAL NOT NULL,
  "establecimientoId" INTEGER NOT NULL,
  "semana" TEXT NOT NULL,
  "porcentaje" INTEGER NOT NULL DEFAULT 100,
  "nota" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "semana_intensidad_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "semana_intensidad_est_semana_key" ON "semana_intensidad"("establecimientoId", "semana");
