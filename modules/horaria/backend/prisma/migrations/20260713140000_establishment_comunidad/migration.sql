-- Autonomous community in ISO 3166-2 code (e.g. "ES-CT") for automatic holiday import.
ALTER TABLE "establishments" ADD COLUMN IF NOT EXISTS "comunidadAutonoma" TEXT;
