-- El municipio de cada tienda, para importar sus dos fiestas locales del
-- calendario oficial de la Generalitat. No se deduce del nombre: S'Agaró no es
-- un municipio, pertenece a Castell-Platja d'Aro.
ALTER TABLE "establishments" ADD COLUMN "municipiCodi" TEXT;
ALTER TABLE "establishments" ADD COLUMN "municipiNom" TEXT;
