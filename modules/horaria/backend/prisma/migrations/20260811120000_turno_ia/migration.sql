-- Què va generar la IA, per poder distingir una correcció de debò d'un clic i tornar enrere.
ALTER TABLE "schedules" ADD COLUMN "turnoIa" "TurnoTipo";

-- Reconstrucció de l'històric. Per a les caselles que ningú ha tocat, el que hi
-- ha és el que va posar la IA. Per a les tocades, el valor original és el
-- "turnoAnterior" de la PRIMERA edició d'aquella casella.
UPDATE "schedules" s
SET "turnoIa" = s."turno"
WHERE s."generadoPorIa" = true AND s."ajustadoPorManager" = false;

UPDATE "schedules" s
SET "turnoIa" = e."turnoAnterior"
FROM (
  SELECT DISTINCT ON ("empleadoId", "semana", "dia")
         "empleadoId", "semana", "dia", "turnoAnterior"
  FROM "schedule_edits"
  WHERE "fueGeneradoPorIa" = true
  ORDER BY "empleadoId", "semana", "dia", "createdAt" ASC
) e
WHERE s."empleadoId" = e."empleadoId"
  AND s."semana" = e."semana"
  AND s."dia" = e."dia"
  AND s."generadoPorIa" = true;
