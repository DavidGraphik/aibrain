-- AlterTable
ALTER TABLE "establishments" ADD COLUMN     "cierraMediodia" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "finCierreMediodia" TEXT,
ADD COLUMN     "horarioApertura" TEXT NOT NULL DEFAULT '08:00',
ADD COLUMN     "horarioCierre" TEXT NOT NULL DEFAULT '21:00',
ADD COLUMN     "inicioCierreMediodia" TEXT;
