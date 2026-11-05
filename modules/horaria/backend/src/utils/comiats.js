// ─────────────────────────────────────────────
// ELS COMIATS
//
// Un cop la conversa ja està desada, la gent continua escrivint: «gràcies»,
// «ok», «fins aviat», un parell d'emojis. És educació, no informació. Abans no
// passava res perquè en acabar la conversa es bloquejava; des que es pot
// rectificar tota la setmana es queda oberta, i cada «igualment» és una crida
// a la IA i un WhatsApp de resposta. La Núria en va encadenar cinc.
//
// Això ho decideix una llista i no un model: ha de ser barat i previsible.
//
// El criteri és conservador a posta. Davant del dubte, que contesti: silenciar
// algú que volia dir «ah, i el dijous no puc» és molt pitjor que contestar un
// «gràcies» de més.
// ─────────────────────────────────────────────

// Sense lletres ni xifres: només emojis, signes o espais.
const NOMES_SIMBOLS = /^[^\p{L}\p{N}]+$/u;

// Paraules de comiat. Es mira PARAULA PER PARAULA i no la frase sencera,
// perquè la gent els encadena: «Oki, fins aviat», «moltes gràcies i bona
// setmana». Si totes les paraules són d'aquesta llista, no diu res més.
//
// No hi són «sí», «cap» ni «tot», i és una decisió presa tres vegades.
//
// Soles volen dir informació: a «quins dies no pots?» es contesta «cap». Vaig
// provar de deixar-les i tractar el cas d'una sola paraula a part, i llavors
// «cap dia» —que vol dir exactament el mateix— tornava a quedar silenciat,
// perquè «dia» també és aquí. Cada intent de ser llest obria un cas nou.
//
// Ara és simple i es paga el preu a la vista: qualsevol missatge amb «cap» o
// «tot» rep resposta, i per tant «cap problema» i «bon cap de setmana» costen
// una crida. Són quatre cèntims. Silenciar algú que contesta «cap dia» costa
// la seva setmana, i això no es recupera.
const PARAULES = new Set([
  'gracies', 'gracias', 'moltes', 'muchas', 'mil', 'thanks', 'thank', 'you', 'thx',
  'de', 'res', 'nada', 'problema', 'todo', 'i', 'y',
  'ok', 'oki', 'okey', 'okay', 'vale', 'val', 'entesos', 'entendido', 'rebut',
  'perfecte', 'perfecto', 'genial', 'molt', 'muy', 'be', 'bien', 'estupendo',
  'fins', 'aviat', 'hasta', 'luego', 'pronto', 'adeu', 'adios', 'bye',
  'igualment', 'igualmente', 'a', 'tu', 'vosaltres',
  'bon', 'bona', 'buenos', 'buenas', 'dia', 'dias', 'tarda', 'tardes',
  'nit', 'noches', 'setmana', 'semana', 'cap-de-setmana',
]);

/** Treu accents, signes i espais de més per poder comparar. */
function nu(text) {
  return String(text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Si aquest missatge és només un comiat i no diu res que calgui contestar.
 *
 * Només s'ha de fer servir amb converses JA desades: mentre s'estan recollint
 * les preferències, un «sí» pot ser la resposta a una pregunta del bot.
 */
export function esComiat(text) {
  const brut = String(text || '').trim();
  if (!brut) return true;
  // Massa llarg per ser un comiat: qui escriu una frase vol dir alguna cosa.
  if (brut.length > 40) return false;
  if (NOMES_SIMBOLS.test(brut)) return true;
  const net = nu(brut);
  // Buit després de netejar però amb lletres de debò a dins: és un alfabet que
  // no sabem llegir (xinès, ciríl·lic, àrab), no un comiat. `nu()` només deixa
  // a-z0-9, o sigui que aquell text desapareixia i es donava per cortesia.
  if (!net) return !/\p{L}/u.test(brut);
  return net.split(' ').every((paraula) => PARAULES.has(paraula));
}
