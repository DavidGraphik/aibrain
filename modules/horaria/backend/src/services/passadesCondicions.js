import { PRECEDENCIA, FAMILIES_QUE_ES_GARANTEIXEN, TORNS } from '../utils/condicions.js';

// ─────────────────────────────────────────────
// FER COMPLIR LES CONDICIONS, NO NOMÉS DEMANAR-HO
//
// Les condicions ja són dades i ja estan traduïdes a les fitxes. Fins aquí
// seguien sent una frase al prompt: la IA les mirava i el `repairSchedule` que
// corre després les desfeia sense saber que existien.
//
// ─── PER QUÈ UNA PUNTUACIÓ I NO SIS REGLES SEGUIDES ───
// La primera versió tenia una passada per família, una darrere l'altra. Es
// desfeien entre elles: amb l'Eva —«3 matins i 3 tardes», i un DIA compta com
// les dues coses— la passada dels matins desmuntava la de les tardes i el
// resultat final en tenia SIS. Complia cada regla pel seu compte i incomplia
// el conjunt, que és el que la persona havia demanat.
//
// Ara es compta quant incompleix el conjunt i es busca el canvi que més ho
// baixi, fins que cap canvi millori. Una condició no és una llista de regles
// independents: és un tot.
//
// ─── QUÈ NO ES TOCA ───
//   absències · dies tancats · disponibilitat fixa · PETICIONS DE LA SETMANA
//
// Les peticions per davant de les condicions costa d'acceptar i és a posta: una
// condició és com sol anar-li bé a algú; una petició és què li passa aquesta
// setmana.
//
// I un canvi que deixés un torn sense prou gent no es fa. El Roger ho va
// decidir el 21 d'agost veient el preu: complir les condicions d'aquella
// setmana deixava tres tardes per sota del mínim. Quan no hi ha marge, la
// condició es queda sense complir i es diu — com ja fem amb el dissabte.
//
// ─── QUÈ NO FA ───
// No afegeix torns per quadrar un RECOMPTE: no posa ningú a treballar un dia
// que tenia lliure perquè li falta un matí. Quedar-se curt ja surt avisat al
// panell, i afegir feina a algú per fer quadrar un número és el que li va donar
// 41h sobre un contracte de 14.
//
// Sí que n'afegeix per a `capFestaEntreSetmana`, i la diferència és real:
// treure-li hores per quadrar un recompte deixa algú sense sou, i posar-li un
// torn perquè la seva fitxa diu que no fa festa entre setmana és donar-li el
// que ell mateix ha demanat. Les dues coses eren al mateix sac i no hi són.
//
// I no en TREU. No treballar no incompleix cap condició, o sigui que per a la
// puntuació deixar algú tota la setmana a casa és una jugada perfecta: el
// revisor ho va comprovar amb cinc mil combinacions a l'atzar i en seixanta-
// quatre la persona acabava amb la setmana buida. Complir-li la condició
// deixant-lo sense hores no és complir-li res. Un dia només passa a LIBRE quan
// la condició li prohibeix tots els torns que aquell dia podria fer — i llavors
// no és una jugada, és l'única sortida.
//
// `sincronitzatAmb` (en Jordi amb la Núria) va a part, a `sincronitzaMatins`:
// necessita mirar dues persones alhora i per tant no cap dins de la funció que
// mira una fitxa sola.
// ─────────────────────────────────────────────

const ORDRE_DIES = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];
// Els torns de feina surten de utils/condicions.js i no es repeteixen aquí: si
// algun dia se n'afegeix o se'n treu un, ha de canviar en un sol lloc.
const TORNS_DE_FEINA = TORNS;

// El que aquestes passades fan complir de debò viu a utils/condicions.js, al
// costat de les famílies, perquè el panell i les passades no puguin discrepar.
export { FAMILIES_QUE_ES_GARANTEIXEN };

function compta(cond, turno) {
  const p = cond?.partidoCompta;
  return {
    esMati: turno === 'MANANA' || (turno === 'PARTIDO' && p === 'MATI_I_TARDA'),
    esTarda: turno === 'TARDE' || (turno === 'PARTIDO' && (p === 'TARDA' || p === 'MATI_I_TARDA')),
  };
}

/**
 * Quant incompleix aquesta setmana, en punts. Zero és complir-ho tot.
 *
 * Els pesos diuen què fa més mal. Un torn que la persona té PROHIBIT és pitjor
 * que tenir-ne un de més del compte: l'un no hauria de passar mai i l'altre és
 * una qüestió de grau.
 */
export function puntuacio(dies, cond) {
  if (!cond) return 0;
  let p = 0;
  const treballats = dies.filter((d) => d.turno && d.turno !== 'LIBRE');

  if (cond.tornsPermesos) {
    p += 10 * treballats.filter((d) => !cond.tornsPermesos.includes(d.turno)).length;
  }
  for (const [dia, torn] of Object.entries(cond.tornFixe || {})) {
    const d = dies.find((x) => x.dia === dia);
    if (d && d.turno !== 'LIBRE' && d.turno !== torn) p += 5;
  }
  for (const c of cond.condicionals || []) {
    const si = dies.find((x) => x.dia === c.si.dia);
    const llavors = dies.find((x) => x.dia === c.llavors.dia);
    if (si?.turno === c.si.torn && llavors && llavors.turno !== c.llavors.torn) p += 5;
  }

  const tardes = dies.filter((d) => compta(cond, d.turno).esTarda).length;
  const matins = dies.filter((d) => compta(cond, d.turno).esMati).length;
  const partits = dies.filter((d) => d.turno === 'PARTIDO').length;

  if (cond.tardesExactes !== undefined) p += Math.abs(tardes - cond.tardesExactes);
  else if (cond.maxTardes !== undefined) p += Math.max(0, tardes - cond.maxTardes);
  if (cond.matinsExactes !== undefined) p += Math.abs(matins - cond.matinsExactes);
  if (cond.partidosExactes !== undefined) p += Math.abs(partits - cond.partidosExactes);
  else if (cond.maxPartidos !== undefined) p += Math.max(0, partits - cond.maxPartidos);

  if (cond.capFestaEntreSetmana) {
    // Cada dia laborable lliure és un incompliment. Va amb pes 1 com els
    // recomptes: és una qüestió de grau, no una prohibició.
    const FEINERS = ORDRE_DIES.slice(0, 5);
    p += dies.filter((d) => FEINERS.includes(d.dia) && (!d.turno || d.turno === 'LIBRE')).length;
  }

  if (cond.partidosNoConsecutius) {
    const seguits = ORDRE_DIES.map((dia) => dies.find((x) => x.dia === dia));
    for (let i = 1; i < seguits.length; i++) {
      if (seguits[i - 1]?.turno === 'PARTIDO' && seguits[i]?.turno === 'PARTIDO') p += 3;
    }
  }
  return p;
}

/**
 * Acosta els dies d'una persona a les seves condicions, sense trencar res del
 * que mana més.
 *
 * @param opcions.esIntocable(dia)          el que mana més que la condició
 * @param opcions.potFer(dia, torn)         la disponibilitat fixa
 * @param opcions.deixaMarge(dia, de, a)    hi ha prou gent si es fa el canvi?
 * @param opcions.potTreballar(dia)         el dia és seu de debò? (ni la
 *        botiga tancada, ni absència, ni festiu). Va a part de `potFer`, que
 *        parla de mitges jornades: aquí es tracta de si el dia existeix.
 *        ⚠️ Se n'ha de fer UNA PER PERSONA I BOTIGA. No rep de qui parla, i
 *        reaprofitar-ne una per a tothom barrejaria la cobertura d'una botiga
 *        amb la d'una altra sense que res es queixés.
 * @returns { fets, abans, despres }  — `despres` pot no ser 0: si no hi ha
 *          marge, la condició es queda sense complir i qui crida ho ha de dir.
 */
export function aplicaAUnaPersona(dies, cond, opcions = {}) {
  const {
    esIntocable = () => false,
    potFer = () => true,
    deixaMarge = () => true,
    potTreballar = () => true,
    canvia = (d, t) => { d.turno = t; },
  } = opcions;

  const abans = puntuacio(dies, cond);
  if (!cond || abans === 0) return { fets: [], abans, despres: abans };

  const fets = [];
  let actual = abans;

  // Es prova cada canvi possible i es fa el que més baixi la puntuació. Es
  // repeteix fins que cap canvi millori res. El límit d'onze voltes és per si
  // dos canvis s'empaitessin: cada volta ha de baixar almenys un punt, i una
  // setmana no en pot tenir tants.
  for (let volta = 0; volta < 11; volta++) {
    let millor = null;

    for (const d of dies) {
      if (esIntocable(d.dia)) continue;

      // Un dia lliure només es toca per «no fa festa entre setmana», i només
      // entre setmana. `potTreballar` és el que impedeix posar-lo a treballar
      // un dia que la botiga tanca o que ell està de baixa: aquells dies també
      // són LIBRE i des d'aquí no es distingeixen.
      const esLliure = !d.turno || d.turno === 'LIBRE';
      if (esLliure) {
        const feiner = ORDRE_DIES.slice(0, 5).includes(d.dia);
        if (!cond.capFestaEntreSetmana || !feiner || !potTreballar(d.dia)) continue;
      }

      // Els torns possibles aquell dia. LIBRE només hi entra quan el que hi ha
      // està prohibit i no es pot canviar per res que la condició permeti.
      //
      // El primer arreglo només mirava la disponibilitat, i deixava un altre
      // forat: si els torns permesos estaven bloquejats per COBERTURA i no per
      // disponibilitat, la persona quedava encallada amb un torn prohibit i cap
      // jugada possible. Aquí s'ha de mirar tot el que impedeix un canvi, no
      // només la meitat.
      const permesos = cond.tornsPermesos || TORNS_DE_FEINA;
      // No vol dir «aquest dia ja compleix»: vol dir que el TIPUS de torn és
      // dels permesos. Pot seguir incomplint un recompte, i llavors s'arregla
      // canviant-lo per un altre de permès, no buidant-li el dia.
      const tornActualPermes = permesos.includes(d.turno);
      const hiHaSortida = permesos.some((t) => t !== d.turno
        && potFer(d.dia, t) && deixaMarge(d.dia, d.turno, t));
      const capSortida = !esLliure && !tornActualPermes && !hiHaSortida;
      const candidats = capSortida ? [...TORNS_DE_FEINA, 'LIBRE'] : TORNS_DE_FEINA;

      for (const nou of candidats) {
        if (nou === d.turno) continue;
        if (nou !== 'LIBRE' && !potFer(d.dia, nou)) continue;
        if (!deixaMarge(d.dia, d.turno, nou)) continue;

        const original = d.turno;
        d.turno = nou;
        const p = puntuacio(dies, cond);
        d.turno = original;

        if (p < actual && (!millor || p < millor.p)) millor = { d, nou, p, de: original };
      }
    }

    if (!millor) break;
    canvia(millor.d, millor.nou);
    fets.push({ dia: millor.d.dia, de: millor.de, a: millor.nou });
    actual = millor.p;
    if (actual === 0) break;
  }

  return { fets, abans, despres: actual };
}

/** Perquè ningú hagi de recordar l'ordre de memòria en llegir això. */
export const MANEN_MES = PRECEDENCIA.slice(0, PRECEDENCIA.indexOf('condicionsFixes'));

/**
 * «Ha de fer els mateixos MATINS que la Núria Bachs.»
 *
 * L'única condició que no cap a `aplicaAUnaPersona`: necessita l'horari d'algú
 * altre. Va després de tot, perquè la persona amb qui se sincronitza ha
 * d'haver acabat de quadrar la seva setmana.
 *
 * Només SUBSTITUEIX torns, com la resta: si aquell dia ella fa matí i ell
 * treballa, se li posa matí; si ell té festa, no se l'hi posa a treballar. I
 * quan ell fa un matí que ella no fa, se li canvia per un altre torn en comptes
 * de deixar-lo lliure — treure-li hores per sincronitzar-lo seria pitjor que la
 * desincronització.
 *
 * @param horaris  [{ empleadoId, dias }] — es modifica al lloc
 * @param opcions  esIntocable(id, dia), potFer(id, dia, torn),
 *                 deixaMarge(id, dia, de, a) — totes reben de qui parlen
 * @returns [{ empleadoId, fets, sensesortida }]
 */
export function sincronitzaMatins(horaris, condicionsDe, opcions = {}) {
  // Totes reben de QUI parlen: aquí hi ha dues persones en joc alhora i una
  // funció que no sàpiga a qui mira comprovaria la disponibilitat o la
  // cobertura de l'altra.
  const {
    esIntocable = () => false,
    potFer = () => true,
    deixaMarge = () => true,
    canvia = (d, t) => { d.turno = t; },
  } = opcions;

  const fora = [];
  for (const meu of horaris) {
    const cond = condicionsDe(meu.empleadoId);
    const amb = cond?.sincronitzatAmb;
    if (!amb || amb.que !== 'MATINS') continue;

    const seu = horaris.find((h) => h.empleadoId === amb.empleadoId);
    if (!seu) continue;

    const fets = [];
    const sensesortida = [];
    for (const d of meu.dias) {
      if (esIntocable(meu.empleadoId, d.dia)) continue;
      if (!d.turno || d.turno === 'LIBRE') continue;   // no se'l fa treballar

      const ella = seu.dias.find((x) => x.dia === d.dia);
      const ellaFaMati = ella?.turno === 'MANANA' || ella?.turno === 'PARTIDO';
      const ellFaMati = d.turno === 'MANANA' || d.turno === 'PARTIDO';
      if (ellaFaMati === ellFaMati) continue;

      // Un DIA que ha de deixar de fer matí no es baixa a TARDE sol: perdria un
      // terç de les hores d'aquell dia, i el comentari de dalt promet que aquí
      // no se li'n treuen. El revisor ho va comprovar amb en Jordi: PARTIDO
      // passava a TARDE i li retallava justament el que aquesta funció diu
      // evitar. Un dia així es queda tal com estava.
      if (d.turno === 'PARTIDO') { sensesortida.push(d.dia); continue; }

      // Els torns que la seva pròpia condició li deixa fer, per no arreglar una
      // condició trencant-ne una altra.
      const permesos = cond.tornsPermesos || ['MANANA', 'TARDE', 'PARTIDO'];
      const vol = ellaFaMati ? ['MANANA'] : ['TARDE'];
      const nou = vol.find((t) => permesos.includes(t)
        && potFer(meu.empleadoId, d.dia, t)
        && deixaMarge(meu.empleadoId, d.dia, d.turno, t));
      if (!nou) { sensesortida.push(d.dia); continue; }

      // I tampoc si desfà un recompte que la seva pròpia condició ja tenia
      // just: `aplicaCondicionsFixes` corre just abans i pot haver-li deixat
      // exactament els matins o les tardes que li tocaven. Sincronitzar-lo no
      // val la pena si desquadra el que ja estava bé.
      const abans = d.turno;
      const p0 = puntuacio(meu.dias, cond);
      canvia(d, nou);
      if (puntuacio(meu.dias, cond) > p0) { canvia(d, abans); sensesortida.push(d.dia); continue; }
      fets.push({ dia: d.dia, de: abans, a: nou });
    }
    if (fets.length || sensesortida.length) fora.push({ empleadoId: meu.empleadoId, fets, sensesortida });
  }
  return fora;
}
