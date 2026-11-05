// Mirall de backend/src/services/peticions.js.
//
// El backend anota cada casella quan la serveix, i el frontend necessita la
// MATEIXA regla per a una altra pregunta: si canvio aquesta casella, deixarà de
// complir la petició? Una confirmació que salta quan no cal s'acaba acceptant
// sense llegir, i llavors ja no protegeix res.
//
// Hi ha una prova de paritat al backend que compara els dos comportaments. Els
// altres miralls d'aquest projecte ja van derivar un cop sense que ho notés res.
//
// ─────────────────────────────────────────────
// QUÈ HI HA EN UNA CASELLA PERQUÈ ALGÚ HO VA DEMANAR
//
// El motor honra les peticions setmanals — hi ha passades deterministes que
// les imposen — però un cop l'horari és a la graella, res distingeix un torn
// que va sortir d'una petició d'un que va sortir del quadre. La responsable
// retoca la setmana, gira dos torns per quadrar la cobertura, i sense
// adonar-se'n desfà el dimecres de tarda que aquella persona havia demanat
// expressament per WhatsApp. La petició es va complir i es va perdre entre
// dilluns i divendres.
//
// Es dedueix, no es desa. Un camp a la fila diria el que era veritat el dia de
// la generació; això diu el que és veritat ara, i si la persona canvia la
// petició dins de la finestra, la marca es mou amb ella.
// ─────────────────────────────────────────────

/**
 * Per què aquesta casella és així, si és per una petició.
 *
 *   NO_DISPONIBLE  — va demanar aquell dia lliure, i el té
 *   TORN_DEMANAT   — va demanar aquell torn concret, i el fa
 *   FESTA_CANVIADA — va demanar aquell dia lliure, i treballa
 *   TORN_CANVIAT   — va demanar un torn, i en fa un altre
 *   null           — no havia demanat res d'aquell dia
 *
 * Els dos primers volen dir «li hem donat el que demanava» i els altres dos
 * «hi havia una petició i no s'ha complert». La graella en pinta dos estils,
 * no quatre: contínua quan es compleix, a ratlles quan no.
 *
 * La marca diu ARA que hi ha una petició en aquell dia, i abans deia que la
 * petició estava complerta. La diferència importa: amb la regla vella, canviar
 * una tarda demanada per un matí feia desaparèixer la línia, i justament quan
 * repassa la graella el que a la responsable li convé veure és ON HA PASSAT PER
 * SOBRE d'una petició. Es perdia exactament allà on calia.
 */
export function peticioDeLaCasella({ dia, turno, prefs }) {
  if (!prefs || prefs.activa === false) return null;

  const voliaFesta = (prefs.diasNoDisponible || []).includes(dia);
  if (voliaFesta) return turno === 'LIBRE' ? 'NO_DISPONIBLE' : 'FESTA_CANVIADA';

  const perDia = tornsDemanats(prefs);
  const demanat = perDia?.[dia];
  if (!demanat) return null;
  if (demanat === turno) return 'TORN_DEMANAT';

  // Un PARTIDO cobreix la mitja jornada que demanava, però hi afegeix l'altra
  // meitat: no és el que va demanar. Va amb la resta de canvis, a ratlles.
  return 'TORN_CANVIAT';
}

/** Els torns que va demanar, dia a dia. Json?: pot arribar com a text. */
export function tornsDemanats(prefs) {
  let perDia = prefs?.turnosPorDia;
  if (typeof perDia === 'string') {
    try { perDia = JSON.parse(perDia); } catch { perDia = null; }
  }
  return perDia || null;
}

/** Què havia demanat aquell dia: un torn, 'LIBRE', o res. */
export function queDemanava({ dia, prefs }) {
  if (!prefs || prefs.activa === false) return null;
  if ((prefs.diasNoDisponible || []).includes(dia)) return 'LIBRE';
  return tornsDemanats(prefs)?.[dia] || null;
}

/** La petició està complerta? Els dos estils de la graella surten d'aquí. */
export function compleixLaPeticio(motiu) {
  return motiu === 'NO_DISPONIBLE' || motiu === 'TORN_DEMANAT';
}
