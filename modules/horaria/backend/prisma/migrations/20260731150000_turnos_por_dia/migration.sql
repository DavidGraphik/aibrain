-- Per-day shift restrictions on a weekly preference, e.g. {"MIERCOLES":"TARDE"}.
-- Previously "only afternoon on Wednesday" was stored as prose in
-- notasAdicionales, which the scheduler could not enforce: it assigned PARTIDO
-- (morning + afternoon) and treated the request as satisfied.
ALTER TABLE "shift_preferences" ADD COLUMN IF NOT EXISTS "turnosPorDia" JSONB;
