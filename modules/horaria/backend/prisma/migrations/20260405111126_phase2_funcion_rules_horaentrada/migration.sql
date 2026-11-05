/*
  Warnings:

  - You are about to drop the column `horaFin` on the `schedules` table. All the data in the column will be lost.
  - You are about to drop the column `horaInicio` on the `schedules` table. All the data in the column will be lost.
  - You are about to drop the column `fechaActualizacion` on the `shift_preferences` table. All the data in the column will be lost.
  - You are about to drop the column `flexibilidad` on the `shift_preferences` table. All the data in the column will be lost.
  - You are about to drop the column `maxHorasSemana` on the `shift_preferences` table. All the data in the column will be lost.
  - You are about to drop the `weekly_rules` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `updatedAt` to the `shift_preferences` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "Funcion" AS ENUM ('DEPENDIENTA', 'ELABORACION');

-- DropForeignKey
ALTER TABLE "weekly_rules" DROP CONSTRAINT "weekly_rules_creadoPorId_fkey";

-- DropForeignKey
ALTER TABLE "weekly_rules" DROP CONSTRAINT "weekly_rules_establecimientoId_fkey";

-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "funcion" "Funcion" NOT NULL DEFAULT 'DEPENDIENTA',
ADD COLUMN     "maxHorasSemana" INTEGER NOT NULL DEFAULT 40;

-- AlterTable
ALTER TABLE "schedules" DROP COLUMN "horaFin",
DROP COLUMN "horaInicio",
ADD COLUMN     "horaEntrada" TEXT;

-- AlterTable
ALTER TABLE "shift_preferences" DROP COLUMN "fechaActualizacion",
DROP COLUMN "flexibilidad",
DROP COLUMN "maxHorasSemana",
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- DropTable
DROP TABLE "weekly_rules";

-- DropEnum
DROP TYPE "Flexibilidad";

-- CreateTable
CREATE TABLE "establishment_rules" (
    "id" SERIAL NOT NULL,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "minDependientasManana" INTEGER NOT NULL DEFAULT 1,
    "minDependientasTarde" INTEGER NOT NULL DEFAULT 1,
    "minElaboracionManana" INTEGER NOT NULL DEFAULT 1,
    "minElaboracionTarde" INTEGER NOT NULL DEFAULT 1,
    "minPersonasDescansoPartido" INTEGER NOT NULL DEFAULT 2,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "establecimientoId" INTEGER NOT NULL,

    CONSTRAINT "establishment_rules_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "establishment_rules" ADD CONSTRAINT "establishment_rules_establecimientoId_fkey" FOREIGN KEY ("establecimientoId") REFERENCES "establishments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
