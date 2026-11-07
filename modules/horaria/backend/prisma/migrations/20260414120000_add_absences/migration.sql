-- CreateEnum
CREATE TYPE "TipoAusencia" AS ENUM ('VACACIONES', 'BAJA_MEDICA', 'FESTIVO');

-- CreateEnum
CREATE TYPE "EstadoAusencia" AS ENUM ('PENDIENTE', 'APROBADO', 'RECHAZADO');

-- CreateTable
CREATE TABLE "absences" (
    "id" SERIAL NOT NULL,
    "tipo" "TipoAusencia" NOT NULL,
    "fechaInicio" DATE NOT NULL,
    "fechaFin" DATE NOT NULL,
    "estado" "EstadoAusencia" NOT NULL DEFAULT 'APROBADO',
    "notas" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "empleadoId" INTEGER,
    "establecimientoId" INTEGER NOT NULL,

    CONSTRAINT "absences_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "absences" ADD CONSTRAINT "absences_empleadoId_fkey" FOREIGN KEY ("empleadoId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "absences" ADD CONSTRAINT "absences_establecimientoId_fkey" FOREIGN KEY ("establecimientoId") REFERENCES "establishments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
