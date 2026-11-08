-- La reconstrucció anterior atribuïa a la generació actual edicions que són
-- d'una generació anterior de la mateixa setmana: regenerar esborra les files i
-- en crea de noves, però el registre d'edicions es queda. A l'Aleix li sortia
-- una correcció del dilluns de la W32 que ell mateix ja havia desfet i que,
-- a més, era d'un horari que ja no existeix.
--
-- Només val una edició posterior a la fila que està corregint.
UPDATE "schedules" s SET "turnoIa" = s."turno" WHERE s."generadoPorIa" = true;

UPDATE "schedules" s
SET "turnoIa" = (
  SELECT e."turnoAnterior" FROM "schedule_edits" e
  WHERE e."empleadoId" = s."empleadoId" AND e."semana" = s."semana" AND e."dia" = s."dia"
    AND e."createdAt" > s."createdAt"
  ORDER BY e."createdAt" ASC LIMIT 1
)
WHERE s."generadoPorIa" = true
  AND EXISTS (
    SELECT 1 FROM "schedule_edits" e
    WHERE e."empleadoId" = s."empleadoId" AND e."semana" = s."semana" AND e."dia" = s."dia"
      AND e."createdAt" > s."createdAt"
  );
