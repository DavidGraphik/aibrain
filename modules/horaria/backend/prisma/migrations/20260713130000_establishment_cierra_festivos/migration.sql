-- Whether the establishment closes on holidays (FESTIVO). Default true = current behavior.
ALTER TABLE "establishments" ADD COLUMN IF NOT EXISTS "cierraFestivos" BOOLEAN NOT NULL DEFAULT true;
