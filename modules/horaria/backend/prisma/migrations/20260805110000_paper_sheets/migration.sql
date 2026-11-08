-- The photo of a weekly preference sheet, kept alongside the preferences it
-- produced. The model reads handwriting off an image, and its mistakes there are
-- the quiet kind — a mark read one column across, a row skipped — which nothing
-- downstream can catch, because the output is structurally perfect either way.
-- Without the image there is no original to check against.
CREATE TABLE IF NOT EXISTS "paper_sheets" (
    "id" SERIAL NOT NULL,
    "establecimientoId" INTEGER NOT NULL,
    "semana" TEXT NOT NULL,
    "enviadoPorId" INTEGER,
    "telefono" TEXT,
    "mimeType" TEXT NOT NULL,
    "imagen" BYTEA NOT NULL,
    "lectura" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "paper_sheets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "paper_sheets_establecimientoId_semana_idx"
    ON "paper_sheets"("establecimientoId", "semana");
