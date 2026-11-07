// Only an unconditional whole-week afternoon rule may provide an implicit
// entry time. A day-specific, conditional, invalid or conflicting time is not
// safe to apply to every shift. Structured horaEntradaTarde takes precedence.
export function fixedAfternoonEntry(conditions) {
  const text = String(conditions || '').trim();
  if (!/^(?:siempre\s+(?:hace\s+)?(?:de\s+)?tardes|sempre\s+(?:fa\s+)?(?:de\s+)?tardes|solo\s+tardes|nom[ée]s\s+tardes)\b/i.test(text)) return null;
  if (/\b(?:si|cuando|quan|dilluns|dimarts|dimecres|dijous|divendres|dissabte|diumenge|lunes|martes|mi[ée]rcoles|jueves|viernes|s[áa]bado|domingo)\b/i.test(text)) return null;
  const entries = [...text.matchAll(/\bde\s+(\d{1,2})(?:(?:[:.](\d{2}))\s*h?|\s*h)\s+(?:hasta|fins)\s+(?:el\s+)?(?:cierre|tancament)\b/gi)];
  if (entries.length !== 1) return null;
  const hour = Number(entries[0][1]);
  const minute = Number(entries[0][2] || 0);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
