-- Days of the week the establishment opens (JSON array string, e.g. '["LUNES",...,"SABADO"]').
-- NULL = open every day. Days not listed are closed (everyone LIBRE).
ALTER TABLE "establishments" ADD COLUMN IF NOT EXISTS "diasApertura" TEXT;
