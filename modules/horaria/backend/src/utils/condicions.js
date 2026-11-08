// ─────────────────────────────────────────────
// LES CONDICIONS FIXES, COM A DADES
//
// Fins ara una condició era una frase: «Màxim 3 tardes per setmana, i un
// PARTIDO ja compta com una tarda». La frase anava al prompt i prou. El motor
// segueix el principi de «la IA proposa, el codi determinista garanteix», i hi
// ha passades per a les absències, els dies tancats, la disponibilitat i els
// torns demanats — però per a les condicions no n'hi havia cap. O sigui que
// eren l'única restricció que el `repairSchedule`, que corre després, podia
// desfer sense saber que existia.
//
// Aquí hi ha la forma que pot prendre una condició quan deixa de ser prosa.
// Res més: ni la tradueix, ni la fa complir. Només diu què es pot dir i
// comprova que el que arriba sigui deible — perquè la traducció la farà una
// IA, i una IA que inventa un camp o hi posa un número on va una llista ha de
// petar aquí i no tres passes més enllà, dins del motor.
//
// Els camps surten de les 12 condicions que hi ha escrites a les fitxes de
// Girona i Torre Valentina, no d'imaginar-se-les. Són quinze camps agrupats en
// nou maneres de dir les coses; el que compta és que cadascun el faci servir
// algú de veritat, i una prova ho comprova.
//
// El que l'esquema encara no sàpiga dir NO es pot perdre: va a `noGarantit`.
// Una traducció a mitges que sembli sencera és pitjor que no traduir-la, perquè
// el responsable la valida creient que hi és tota.
// ─────────────────────────────────────────────

export const DIES = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];
export const TORNS = ['MANANA', 'TARDE', 'PARTIDO'];

/**
 * L'ordre en què manen les coses quan es contradiuen.
 *
 * No existia escrit enlloc, i sense això les passades no es poden ni escriure:
 * quan la condició de l'Eva diu «3 matins i 3 tardes» i aquesta setmana ella en
 * demana quatre, algú ha de manar.
 *
 * Mana ella. Ho va decidir el Roger el 21 d'agost, i és coherent amb el que ja
 * fèiem: quan el full de paper i el WhatsApp es contradiuen també guanya el que
 * ha dit la persona aquesta setmana. Una condició és com sol anar-li bé; una
 * petició és què li passa aquesta setmana.
 */
export const PRECEDENCIA = [
  'absencies',            // de baixa o de vacances: no hi és
  'diesTancats',          // la botiga no obre
  'disponibilitatFixa',   // els dies i mitges jornades que té barrats a la fitxa
  'peticionsSetmanals',   // el que ha demanat per aquesta setmana
  'condicionsFixes',      // això d'aquí
  'minimsCobertura',      // que hi hagi prou gent cada dia
  'objectiuHores',        // acostar-se al contracte
];

/**
 * Les famílies. Cada entrada diu com validar-la i qui la va fer falta.
 *
 * `exemple` no és decoració: és la frase real d'una fitxa. Quan algú hi afegeixi
 * una família nova, ha de poder dir de qui és.
 */
export const FAMILIES = {
  tornsPermesos: {
    tipus: 'llista-de-torns',
    exemple: 'Núria Bachs: «Tot matins» · Sandra Corominas: «Nunca días ni mañanas»',
  },
  maxTardes: { tipus: 'numero', exemple: 'Gemma Casanovas: «Màxim 3 tardes per setmana»' },
  tardesIdeal: { tipus: 'numero', exemple: 'Gemma Casanovas: «i l\'ideal són 2»' },
  matinsExactes: { tipus: 'numero', exemple: 'Eva Mademont: «3 MATINS i 3 TARDES»' },
  tardesExactes: { tipus: 'numero', exemple: 'Eva Mademont: «3 MATINS i 3 TARDES»' },
  // `partidosExactes` és «n'ha de fer tants»; `maxPartidos` és «com a molt
  // tants». La Gemma diu «pot fer 1 PARTIDO» (sostre) i l'Antònia «vol fer 1
  // PARTIDO, prioritza-l'hi» (obligació): frases quasi iguals que volen dir
  // coses diferents, i per això a l'una hi va un camp i a l'altra dos.
  partidosExactes: { tipus: 'numero', exemple: 'Victor Sanchez: «Fa 2 torns PARTIDO per setmana»' },
  maxPartidos: { tipus: 'numero', exemple: 'David Castillo: «No fa mai torns PARTIDO» (0)' },
  partidosNoConsecutius: { tipus: 'boolea', exemple: 'Victor Sanchez: «que NO poden ser en dies consecutius»' },
  partidoCompta: {
    tipus: 'com-compta',
    exemple: 'Gemma: «un PARTIDO ja compta com una tarda» · Eva: «compta alhora com un matí i com una tarda»',
  },
  minDiesFesta: { tipus: 'numero', exemple: 'Montse Surroca: «1 dia més de festa entre setmana»' },
  capFestaEntreSetmana: { tipus: 'boolea', exemple: 'Jordi Defaus: «No fa festa entre setmana»' },
  tornFixe: { tipus: 'dia-torn', exemple: 'Victor Sanchez: «El dilluns sempre MATÍ»' },
  condicionals: {
    tipus: 'llista-de-condicionals',
    exemple: 'Esther Rabert: «Si fa PARTIDO el dissabte, el divendres ha de fer MATÍ»',
  },
  sincronitzatAmb: {
    tipus: 'sincronitzacio',
    exemple: 'Jordi Defaus: «Ha de fer els mateixos MATINS que Nuria Bachs»',
  },
  jaALaFitxa: {
    tipus: 'text',
    // Frases que només repeteixen dades que ja tenen el seu camp: l'hora
    // d'entrada, les hores per torn, el contracte. Sense un lloc on posar-les,
    // o embrutaven el «no garantit» o desapareixien — el «de 16h hasta el
    // cierre» de la Sandra es va perdre sense deixar rastre.
    exemple: 'Sandra Corominas: «de 16h hasta el cierre» · David Castillo: «4h per torn»',
  },
  noGarantit: {
    tipus: 'text',
    // El que el traductor no sàpiga dir es queda aquí i es marca a la pantalla.
    // Amagar-ho faria pensar que està garantit quan només és una suggerència a
    // la IA — que és exactament la confusió que aquest fitxer ha d'acabar.
    exemple: 'Neus Sala: «És encarregada de la botiga» (no diu res de torns)',
  },
};

const esEnter = (v, min = 0) => Number.isInteger(v) && v >= min && v <= 7;

function validaValor(camp, v, errors) {
  const { tipus } = FAMILIES[camp];
  switch (tipus) {
    case 'numero':
      if (!esEnter(v)) errors.push(`${camp}: ha de ser un número enter de 0 a 7, i és ${JSON.stringify(v)}`);
      break;
    case 'boolea':
      if (typeof v !== 'boolean') errors.push(`${camp}: ha de ser cert o fals, i és ${JSON.stringify(v)}`);
      break;
    case 'text':
      if (typeof v !== 'string' || !v.trim()) errors.push(`${camp}: ha de ser text amb contingut`);
      break;
    case 'llista-de-torns':
      if (!Array.isArray(v) || v.length === 0) { errors.push(`${camp}: ha de ser una llista de torns`); break; }
      for (const t of v) if (!TORNS.includes(t)) errors.push(`${camp}: «${t}» no és un torn`);
      break;
    case 'com-compta':
      if (v !== 'TARDA' && v !== 'MATI_I_TARDA') {
        errors.push(`${camp}: només pot ser TARDA o MATI_I_TARDA, i és ${JSON.stringify(v)}`);
      }
      break;
    case 'dia-torn':
      if (!v || typeof v !== 'object' || Array.isArray(v)) { errors.push(`${camp}: ha de ser un objecte dia→torn`); break; }
      for (const [dia, torn] of Object.entries(v)) {
        if (!DIES.includes(dia)) errors.push(`${camp}: «${dia}» no és un dia`);
        if (!TORNS.includes(torn)) errors.push(`${camp}: «${torn}» no és un torn`);
      }
      break;
    case 'llista-de-condicionals':
      if (!Array.isArray(v) || v.length === 0) { errors.push(`${camp}: ha de ser una llista`); break; }
      v.forEach((c, i) => {
        for (const part of ['si', 'llavors']) {
          const p = c?.[part];
          if (!p || !DIES.includes(p.dia) || !TORNS.includes(p.torn)) {
            errors.push(`${camp}[${i}].${part}: cal { dia, torn } vàlids`);
          }
        }
      });
      break;
    case 'sincronitzacio':
      if (!v || !Number.isInteger(v.empleadoId)) {
        // Diu la forma i no només que falla: el reintent li ensenya aquest text
        // i amb «cal l'id de l'altra persona» no en tenia prou per arreglar-ho.
        errors.push(`${camp}: cal { "empleadoId": <número>, "que": "MATINS" }`);
      }
      if (v && v.que !== 'MATINS') errors.push(`${camp}.que: de moment només MATINS`);
      break;
    default:
      errors.push(`${camp}: tipus «${tipus}» sense validació`);
  }
}

/**
 * Comprova que unes condicions estructurades siguin deibles.
 *
 * Estricta a posta: un camp que no consti a FAMILIES es rebutja en comptes
 * d'ignorar-se. Les escriurà una IA traduint una frase, i un camp inventat que
 * passés en silenci seria una condició que el responsable creu posada i que no
 * la fa complir ningú — pitjor que no tenir-la.
 */
export function validaCondicions(obj) {
  const errors = [];
  if (obj === null || obj === undefined) return { ok: true, errors, net: null };
  if (typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['les condicions han de ser un objecte'], net: null };
  }

  const net = {};
  for (const [camp, v] of Object.entries(obj)) {
    if (!(camp in FAMILIES)) { errors.push(`«${camp}» no és cap condició que sapiguem expressar`); continue; }
    if (v === null || v === undefined) continue;   // no dita: no és un error
    const abans = errors.length;
    validaValor(camp, v, errors);
    if (errors.length === abans) net[camp] = v;
  }

  // Coherències entre camps: cadascuna ve d'una manera real d'equivocar-se en
  // traduir una frase, no d'imaginar-se casos.
  if (net.tardesIdeal !== undefined && net.maxTardes !== undefined && net.tardesIdeal > net.maxTardes) {
    errors.push(`tardesIdeal (${net.tardesIdeal}) no pot passar de maxTardes (${net.maxTardes})`);
  }
  if (net.maxPartidos !== undefined && net.partidosExactes !== undefined
      && net.partidosExactes > net.maxPartidos) {
    errors.push(`partidosExactes (${net.partidosExactes}) no pot passar de maxPartidos (${net.maxPartidos})`);
  }
  if (net.tornsPermesos && net.tornFixe) {
    for (const [dia, torn] of Object.entries(net.tornFixe)) {
      if (!net.tornsPermesos.includes(torn)) {
        errors.push(`tornFixe diu ${torn} el ${dia}, i tornsPermesos no el deixa`);
      }
    }
  }
  if (net.tornsPermesos && net.maxPartidos === 0 && net.tornsPermesos.includes('PARTIDO')) {
    errors.push('maxPartidos és 0 i tornsPermesos encara hi deixa PARTIDO');
  }
  // I al revés, que és la manera fàcil d'equivocar-se traduint: demanar-li
  // PARTIDO sense haver-l'hi deixat als torns permesos. Passava en silenci.
  if (net.tornsPermesos && !net.tornsPermesos.includes('PARTIDO')) {
    for (const camp of ['partidosExactes', 'maxPartidos']) {
      if (net[camp] > 0) errors.push(`${camp} és ${net[camp]} i tornsPermesos no hi deixa PARTIDO`);
    }
  }
  // Sis dies oberts com a molt: demanar-ne set entre matins i tardes no cap.
  if (net.matinsExactes !== undefined && net.tardesExactes !== undefined
      && net.matinsExactes + net.tardesExactes > 7) {
    errors.push(`matinsExactes + tardesExactes fan ${net.matinsExactes + net.tardesExactes}, i la setmana té 7 dies`);
  }

  return { ok: errors.length === 0, errors, net: errors.length === 0 ? net : null };
}

/**
 * Les famílies que les passades deterministes fan complir de debò.
 *
 * Viu aquí i no a `passadesCondicions.js` perquè aquell fitxer ja importa
 * d'aquest i s'hi faria una rotonda. Les passades la fan servir per no dir que
 * garanteixen el que no toquen.
 *
 * `sincronitzatAmb` la fa `sincronitzaMatins`, que va a part perquè necessita
 * mirar dues persones alhora.
 */
/**
 * Camps que no són una regla per ells mateixos.
 *
 * `partidoCompta` diu COM es compten les altres —si un dia partit val com una
 * tarda o com les dues coses— i les passades ja el fan servir. `tardesIdeal`
 * és una preferència, no un límit: la IA hi apunta i ningú l'obliga.
 *
 * Van a part perquè la pantalla no digui «això no ho fa complir ningú» d'una
 * cosa que o bé no és cap regla, o bé és un desig i no una norma. Dir-ho seria
 * confondre qui la valida.
 */
export const MODIFICADORS = ['partidoCompta'];
export const PREFERENCIES = ['tardesIdeal'];

export const FAMILIES_QUE_ES_GARANTEIXEN = [
  'tornsPermesos', 'maxTardes', 'tardesExactes', 'matinsExactes',
  'maxPartidos', 'partidosExactes', 'partidosNoConsecutius', 'tornFixe', 'condicionals',
  'sincronitzatAmb', 'capFestaEntreSetmana',
];

/**
 * Quines d'aquestes condicions garantirà el codi, i quines no.
 *
 * `jaALaFitxa` no compta com a garantida per aquí: ho garanteix el camp de la
 * fitxa (l'hora d'entrada, les hores per torn), no aquesta condició.
 * Comptar-la diria dues vegades el mateix i amagaria qui ho fa complir de debò.
 */
export function resumDeGarantia(obj) {
  const { net } = validaCondicions(obj);
  const camps = Object.keys(net || {});
  const informatius = ['noGarantit', 'jaALaFitxa', ...MODIFICADORS, ...PREFERENCIES];
  return {
    garantides: camps.filter((c) => FAMILIES_QUE_ES_GARANTEIXEN.includes(c)),
    preferencies: camps.filter((c) => PREFERENCIES.includes(c)),
    // Camps vàlids que encara no fa complir cap passada. Comptar-los com a
    // garantits diria al responsable que es compleixen quan no els mira ningú.
    encaraNo: camps.filter((c) => !informatius.includes(c) && !FAMILIES_QUE_ES_GARANTEIXEN.includes(c)),
    jaALaFitxa: net?.jaALaFitxa || null,
    noGarantit: net?.noGarantit || null,
  };
}
