const aliases = { LUNES: ['DILLUNS', 'LUNES'], MARTES: ['DIMARTS', 'MARTES'], MIERCOLES: ['DIMECRES', 'MIERCOLES'], JUEVES: ['DIJOUS', 'JUEVES'], VIERNES: ['DIVENDRES', 'VIERNES'], SABADO: ['DISSABTE', 'SABADO'], DOMINGO: ['DIUMENGE', 'DOMINGO'] };
export function ruleDays(rule) {
  if (rule.diasAplica) {
    let days;
    try { days = JSON.parse(rule.diasAplica); } catch { throw new Error('Días de cobertura mal configurados.'); }
    if (!Array.isArray(days) || days.some(d => !Object.hasOwn(aliases, d))) throw new Error('Días de cobertura mal configurados.');
    return days;
  }
  // Legacy rows may name their weekday but lack diasAplica (e.g. DIVENDRES,
  // DISSABTE). Never apply Friday's rule to Saturday merely because it is first.
  const words = String(rule.nombre || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().split(/[^A-Z]+/).filter(Boolean);
  const weekdayWords = new Set([...Object.values(aliases).flat(), 'I', 'Y']);
  if (!words.length || !words.every(word => weekdayWords.has(word))) return null;
  const days = Object.entries(aliases).filter(([, names]) => names.some(n => words.includes(n))).map(([d]) => d);
  return days.length ? days : null;
}
export function ruleForDay(rules, day) {
  if (!rules?.length) return null;
  const classified = rules.map(rule => ({ rule, days: ruleDays(rule) }));
  return classified.find(r => r.days?.includes(day))?.rule || classified.find(r => r.days === null)?.rule || null;
}
