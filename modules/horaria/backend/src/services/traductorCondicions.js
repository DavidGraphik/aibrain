import { createAiClient } from '../integration/providers.js';
import { validaCondicions, FAMILIES, DIES, TORNS } from '../utils/condicions.js';

// ─────────────────────────────────────────────
// DE LA FRASE A LES DADES
//
// Les condicions d'un treballador estan escrites com les diria una persona:
// «Màxim 3 tardes per setmana, i un PARTIDO ja compta com una tarda». Això va
// al prompt i prou, o sigui que és una suggerència a la IA i no una garantia
// del codi — i el `repairSchedule`, que corre després, pot desfer-la sense
// saber que existia.
//
// Aquí es tradueix una vegada, en desar la fitxa, i la traducció la valida una
// persona abans de guardar-se. La frase original NO es toca: si la traducció
// és dolenta, s'esmena la frase i es torna a provar.
//
// Tres decisions que val la pena explicar:
//
// El que no sàpiga dir va a `noGarantit` i s'ha de veure a la pantalla. Una
// traducció a mitges que sembli sencera és pitjor que no traduir-la, perquè es
// valida creient que hi és tota — i llavors el responsable creu garantit una
// cosa que no ho està.
//
// El resultat passa pel validador i, si no cola, es torna a demanar UNA vegada
// dient-li què estava malament. Una IA que s'inventa un camp sol encertar-lo
// quan se li ensenya l'error; insistir més seria fer-li endevinar.
//
// I no desa res. Qui la crida decideix què en fa.
// ─────────────────────────────────────────────

const client = createAiClient();
const MODEL = process.env.ANTHROPIC_CONDICIONS_MODEL || 'claude-opus-4-8';

function prompt(text, { companys = [], jaALaFitxa = {} } = {}) {
  const camps = Object.entries(FAMILIES)
    .map(([nom, { tipus, exemple }]) => `- ${nom} (${tipus}) — ex: ${exemple}`)
    .join('\n');

  // Sense la llista, `sincronitzatAmb` demana un id que la IA no pot saber i
  // se l'inventa: la primera passada va contestar "personaId": "nuria_bachs".
  const equip = companys.length
    ? `\nCOMPAÑEROS (usa el número, no el nombre):\n${companys.map((c) => `- ${c.id}: ${c.nombre} ${c.apellidos}`).join('\n')}\n`
    : '';

  // Aquestes dades ja tenen el seu camp a la fitxa. Sense dir-ho, una frase que
  // les repeteix o embruta `noGarantit` o —pitjor— desapareix: el «de 16h hasta
  // el cierre» de la Sandra es va perdre sense deixar rastre.
  const jaHiSon = Object.entries(jaALaFitxa).filter(([, v]) => v !== null && v !== undefined);
  const registrat = jaHiSon.length
    ? `\nYA REGISTRADO EN OTROS CAMPOS DE LA FICHA (no los traduzcas). SOLO si el texto los menciona, copia LA FRASE DEL TEXTO en "jaALaFitxa" — la frase tal cual, nunca el nombre del campo. Si el texto no habla de ellos, deja "jaALaFitxa" fuera:\n${jaHiSon.map(([k, v]) => `- ${k}: ${v}`).join('\n')}\n`
    : '';

  return `Traduce las condiciones fijas de un trabajador de una carnicería a un objeto JSON.

TEXTO A TRADUCIR:
"""
${text}
"""

CAMPOS DISPONIBLES (no hay otros):
${camps}
${equip}${registrat}
FORMA EXACTA de los campos que no son un número o una lista simple:
- tornFixe: { "SABADO": "MANANA" }
- condicionals: [ { "si": {"dia":"SABADO","torn":"PARTIDO"}, "llavors": {"dia":"VIERNES","torn":"MANANA"} } ]
- sincronitzatAmb: { "empleadoId": 113, "que": "MATINS" }     ← "empleadoId", no otro nombre
- noGarantit / jaALaFitxa: una cadena de texto

DÍAS: ${DIES.join(', ')}
TURNOS: ${TORNS.join(', ')}   (PARTIDO = jornada partida, cubre mañana Y tarde)

REGLAS:
1. Usa SOLO los campos de la lista. No inventes ninguno.
2. NO SE PIERDE NADA. Cada frase del texto tiene que acabar en algún sitio: en
   un campo, en "jaALaFitxa" (si solo repite datos ya registrados), o en
   "noGarantit" copiada literalmente. Si una frase no cabe en ningún campo,
   NO la descartes: va a "noGarantit".
3. Si el texto no dice nada sobre turnos ni días (por ejemplo "És encarregada de
   la botiga"), todo va a "noGarantit".
4. No añadas condiciones que el texto no diga.
5. "PARTIDO cuenta como una tarde" → partidoCompta: "TARDA". "Cuenta a la vez
   como mañana y como tarde" → partidoCompta: "MATI_I_TARDA".
6. Distingue el techo de la obligación:
   - "puede hacer 1 PARTIDO" → maxPartidos: 1
   - "hace 2 PARTIDO por semana" → partidosExactes: 2
   - "quiere hacer 1 PARTIDO, priorízaselo" → partidosExactes: 1 Y maxPartidos: 1
7. "El resto de días siempre MAÑANA" NO va a "noGarantit": es tornsPermesos.
   Incluye en la lista todos los turnos que sí puede hacer. Ejemplo: "Hace 2
   PARTIDO y el resto siempre MAÑANA" → tornsPermesos: ["MANANA","PARTIDO"].
8. "PUEDE hacer X" no es una obligación. Y una frase que solo reformula la
   regla anterior con otras palabras ("y a la inversa: si...") NO es una regla
   nueva: no crees un segundo condicional. Si aporta algo que no sabes
   expresar, va a "noGarantit".

Responde SOLO con el JSON, sin explicaciones ni markdown.`;
}

/**
 * El validador de forma, més el que només es pot saber amb l'equip a la mà.
 *
 * `validaCondicions` comprova que `sincronitzatAmb` porti un número, però no
 * que aquell número sigui d'algú: un id inventat que per casualitat caigui en
 * una persona real sincronitzaria els torns amb qui no toca, i no ho sabria
 * ningú fins a veure l'horari.
 */
function comprova(obj, companys) {
  const v = validaCondicions(obj);
  const id = v.net?.sincronitzatAmb?.empleadoId;
  if (v.ok && id !== undefined && companys.length && !companys.some((c) => c.id === id)) {
    return { ok: false, errors: [`sincronitzatAmb: la persona ${id} no és de l'equip`], net: null };
  }
  return v;
}

function extreuJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function demanaAClaude(missatges) {
  const r = await client.messages.create({ model: MODEL, max_tokens: 1500, messages: missatges });
  return r.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

/**
 * @param crida  qui pregunta a la IA. Es pot canviar per provar el reintent
 *               sense xarxa: és la part que més fàcil és escriure malament i
 *               la que no es veu fallar fins que falla de debò.
 * @returns { ok, condicions, errors, crua, intents }
 *   `crua` és el que va contestar la IA, per poder mirar què va entendre quan
 *   la traducció no cola.
 */
export async function tradueixCondicions(text, opcions = {}) {
  const { crida = demanaAClaude, companys = [], jaALaFitxa = {} } = opcions;
  const context = { companys, jaALaFitxa };
  const net = (text || '').trim();
  if (!net) return { ok: true, condicions: null, errors: [], crua: null, intents: 0 };

  const primera = await crida([{ role: 'user', content: prompt(net, context) }]);
  let obj = extreuJson(primera);
  let v = comprova(obj, companys);
  if (v.ok && obj) return { ok: true, condicions: v.net, errors: [], crua: primera, intents: 1 };

  // Una segona i última, dient-li què estava malament.
  const queHiFalla = obj ? v.errors.join('; ') : 'no has contestat un JSON vàlid';
  const segona = await crida([
    { role: 'user', content: prompt(net, context) },
    { role: 'assistant', content: primera },
    { role: 'user', content: `Eso no vale: ${queHiFalla}. Corrígelo y responde SOLO con el JSON.` },
  ]);
  obj = extreuJson(segona);
  v = comprova(obj, companys);
  return { ok: v.ok && !!obj, condicions: v.net, errors: v.errors, crua: segona, intents: 2 };
}

/**
 * La traducció dita en paraules, per ensenyar-la a qui l'ha de validar.
 *
 * Ningú ha de validar un JSON: es valida llegint què vol dir. Els textos són en
 * català perquè és qui ho mira, i van aquí i no a les traduccions de pantalla
 * perquè descriuen l'esquema i no la interfície.
 */
export function enParaules(cond) {
  if (!cond) return [];
  const T = { MANANA: 'matí', TARDE: 'tarda', PARTIDO: 'dia partit' };
  const D = {
    LUNES: 'dilluns', MARTES: 'dimarts', MIERCOLES: 'dimecres', JUEVES: 'dijous',
    VIERNES: 'divendres', SABADO: 'dissabte', DOMINGO: 'diumenge',
  };
  // «Com a molt 1 dies partits» es llegia malament, i això ho ha de llegir algú
  // per decidir si la traducció és bona: si costa de llegir, es llegeix per
  // sobre.
  const n = (q, un, molts) => `${q} ${q === 1 ? un : molts}`;
  const l = [];
  if (cond.tornsPermesos) l.push(`Només pot fer: ${cond.tornsPermesos.map((x) => T[x]).join(', ')}`);
  if (cond.maxTardes !== undefined) l.push(`Com a molt ${n(cond.maxTardes, 'tarda', 'tardes')} per setmana`);
  // Amb prefix, com el «no garantit»: és un desig i no un límit, i a la
  // pantalla ha de veure's diferent d'una regla que el codi imposa. Sense el
  // prefix sortia amb el mateix ✓ verd que «com a molt 3 tardes», i qui valida
  // la traducció no podia distingir el que es garanteix del que s'intenta.
  if (cond.tardesIdeal !== undefined) l.push(`(preferència) L'ideal ${cond.tardesIdeal === 1 ? 'és 1 tarda' : `són ${cond.tardesIdeal} tardes`}`);
  if (cond.matinsExactes !== undefined) l.push(`Exactament ${n(cond.matinsExactes, 'matí', 'matins')}`);
  if (cond.tardesExactes !== undefined) l.push(`Exactament ${n(cond.tardesExactes, 'tarda', 'tardes')}`);
  if (cond.partidosExactes !== undefined) l.push(`Exactament ${n(cond.partidosExactes, 'dia partit', 'dies partits')}`);
  if (cond.maxPartidos !== undefined) l.push(`Com a molt ${n(cond.maxPartidos, 'dia partit', 'dies partits')}`);
  if (cond.partidosNoConsecutius) l.push('Els dies partits no poden ser seguits');
  if (cond.partidoCompta === 'TARDA') l.push('Un dia partit compta com una tarda');
  if (cond.partidoCompta === 'MATI_I_TARDA') l.push('Un dia partit compta alhora com un matí i com una tarda');
  if (cond.minDiesFesta !== undefined) l.push(`Com a mínim ${n(cond.minDiesFesta, 'dia de festa', 'dies de festa')}`);
  if (cond.capFestaEntreSetmana) l.push('No fa festa entre setmana');
  for (const [dia, torn] of Object.entries(cond.tornFixe || {})) l.push(`El ${D[dia]} sempre ${T[torn]}`);
  for (const c of cond.condicionals || []) {
    l.push(`Si el ${D[c.si.dia]} fa ${T[c.si.torn]}, el ${D[c.llavors.dia]} ha de fer ${T[c.llavors.torn]}`);
  }
  if (cond.sincronitzatAmb) l.push(`Fa els mateixos matins que la persona #${cond.sincronitzatAmb.empleadoId}`);
  // Els dos últims NO són condicions garantides, i per això es diuen amb un
  // prefix que ho digui. Que `enParaules` no els ensenyés era el forat gros:
  // qui validava la traducció no veia justament el que NO es garanteix.
  if (cond.jaALaFitxa) l.push(`(ja consta a la fitxa) ${cond.jaALaFitxa}`);
  if (cond.noGarantit) l.push(`(NO garantit) ${cond.noGarantit}`);
  return l;
}
