-- Fixed weekly availability grid (JSON) + free-text recurring conditions per employee.
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "disponibilidad" TEXT;
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "condicionesFijas" TEXT;
