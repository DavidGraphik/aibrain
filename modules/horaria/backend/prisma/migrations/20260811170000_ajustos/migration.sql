-- Configuració que fins ara vivia en variables del Render i en constants del codi.
-- establecimientoId NULL = ajust global de l'empresa.
CREATE TABLE "ajustes" (
    "id" SERIAL NOT NULL,
    "clave" TEXT NOT NULL,
    "valor" TEXT NOT NULL,
    "establecimientoId" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ajustes_pkey" PRIMARY KEY ("id")
);

-- Un índex únic normal deixaria passar files globals duplicades, perquè a
-- Postgres dos NULL no es consideren iguals.
CREATE UNIQUE INDEX "ajustes_est_clave_key" ON "ajustes"("establecimientoId", "clave") WHERE "establecimientoId" IS NOT NULL;
CREATE UNIQUE INDEX "ajustes_global_clave_key" ON "ajustes"("clave") WHERE "establecimientoId" IS NULL;

ALTER TABLE "ajustes" ADD CONSTRAINT "ajustes_establecimientoId_fkey" FOREIGN KEY ("establecimientoId") REFERENCES "establishments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
