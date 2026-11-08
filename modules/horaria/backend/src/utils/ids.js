// ─────────────────────────────────────────────
// UN ID O RES
//
// `parseInt` és més tolerant del que sembla: "12abc" dona 12, "1e3" dona 1 (no
// 1000), i ["12","x"] també dona 12 perquè converteix l'array a text abans de
// llegir-lo. Amb aquests valors no es rebutjava la petició — es buscava un
// treballador amb un id diferent del que el client creia enviar.
//
// No obria cap forat, perquè el control d'accés s'aplica igualment sobre l'id
// que en surti. Però «no és un número» ha de voler dir que no, no que agafem
// el tros del davant.
// ─────────────────────────────────────────────

/** L'enter positiu que hi ha, o null si el que arriba no ho és exactament. */
export function idNumeric(valor) {
  if (typeof valor === 'number') {
    return Number.isInteger(valor) && valor > 0 ? valor : null;
  }
  if (typeof valor !== 'string') return null;
  const net = valor.trim();
  if (!/^[0-9]+$/.test(net)) return null;
  const n = Number(net);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
