-- CreateTable
CREATE TABLE "schedule_edits" (
    "id" SERIAL NOT NULL,
    "semana" TEXT NOT NULL,
    "dia" "DiaSemana" NOT NULL,
    "turnoAnterior" "TurnoTipo" NOT NULL,
    "turnoNuevo" "TurnoTipo" NOT NULL,
    "fueGeneradoPorIa" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "empleadoId" INTEGER NOT NULL,
    "establecimientoId" INTEGER NOT NULL,
    "editadoPorId" INTEGER,

    CONSTRAINT "schedule_edits_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "schedule_edits" ADD CONSTRAINT "schedule_edits_empleadoId_fkey" FOREIGN KEY ("empleadoId") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_edits" ADD CONSTRAINT "schedule_edits_establecimientoId_fkey" FOREIGN KEY ("establecimientoId") REFERENCES "establishments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_edits" ADD CONSTRAINT "schedule_edits_editadoPorId_fkey" FOREIGN KEY ("editadoPorId") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;
