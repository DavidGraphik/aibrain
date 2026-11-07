-- Per què el responsable va corregir el que havíem generat.
CREATE TABLE "correccion_motivos" (
    "id" SERIAL NOT NULL,
    "semana" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "dia" "DiaSemana",
    "diaOrigen" "DiaSemana",
    "turnoIa" "TurnoTipo",
    "turnoManager" "TurnoTipo",
    "motivo" TEXT NOT NULL,
    "nota" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "empleadoId" INTEGER NOT NULL,
    "establecimientoId" INTEGER NOT NULL,
    "registradoPorId" INTEGER,

    CONSTRAINT "correccion_motivos_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "correccion_motivos_establecimientoId_semana_idx" ON "correccion_motivos"("establecimientoId", "semana");

ALTER TABLE "correccion_motivos" ADD CONSTRAINT "correccion_motivos_empleadoId_fkey" FOREIGN KEY ("empleadoId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "correccion_motivos" ADD CONSTRAINT "correccion_motivos_establecimientoId_fkey" FOREIGN KEY ("establecimientoId") REFERENCES "establishments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "correccion_motivos" ADD CONSTRAINT "correccion_motivos_registradoPorId_fkey" FOREIGN KEY ("registradoPorId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
