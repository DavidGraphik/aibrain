-- Reduced working day: a fixed shift length for part-time staff (e.g. 4h from
-- 8:00 to 12:00 on a 20h contract). Null keeps the standard 7h/6h/10h shifts.
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "horasPorTurno" INTEGER;
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "horaEntradaManana" TEXT;
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "horaEntradaTarde" TEXT;
