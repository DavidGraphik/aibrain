// ─────────────────────────────────────────────
// QUI POT TOCAR QUÈ
//
// L'auditoria del 12 d'agost va trobar que `PUT /api/employees/:id` només
// comprovava que qui truqués fos responsable, sense mirar de quina botiga era
// la persona que s'editava ni quin rol tenia. Com que el mateix endpoint deixa
// posar contrasenya, una encarregada podia canviar la de la responsable general
// i entrar com ella. Hi ha dos comptes d'encarregada actius, així que no era
// teòric.
//
// Les decisions viuen aquí, com a funcions pures, per dos motius: perquè els
// controladors les comparteixin en comptes de repetir-les — que és com se'n va
// quedar una sense — i perquè es puguin provar sense base de dades.
//
// `usuari` és el que porta el token: { id, rol, establecimientos: [ids] }.
// ─────────────────────────────────────────────

const RANG = { EMPLEADO: 0, MANAGER_LOCAL: 1, MANAGER_GENERAL: 2 };

export function esGeneral(usuari) {
  return usuari?.rol === 'MANAGER_GENERAL';
}

/** Les botigues que aquest usuari pot mirar. La responsable general, totes. */
export function botiguesDe(usuari) {
  return usuari?.establecimientos || [];
}

/** Pot veure o tocar coses d'aquesta botiga? */
export function potAccedirABotiga(usuari, establecimientoId) {
  if (esGeneral(usuari)) return true;
  const id = Number(establecimientoId);
  if (!Number.isInteger(id)) return false;   // sense botiga concreta, no s'obre la porta
  return botiguesDe(usuari).includes(id);
}

/**
 * Pot veure o editar aquesta persona?
 *
 * `objectiu` és { rol, establecimientoId, establecimientosPermitidos? }. Una
 * encarregada només arriba a la gent de les seves botigues, i mai a algú del
 * seu mateix rang o superior: si no, dues encarregades podrien editar-se entre
 * elles, i qualsevol d'elles la responsable general.
 */
export function potTocarPersona(usuari, objectiu) {
  if (esGeneral(usuari)) return true;
  if (!objectiu) return false;
  // La seva pròpia fitxa sempre. Sense això, la regla de rangs de sota deixaria
  // una encarregada sense poder ni obrir-se la seva.
  if (objectiu.id != null && objectiu.id === usuari?.id) return true;
  if ((RANG[objectiu.rol] ?? 0) >= (RANG[usuari?.rol] ?? 0)) return false;

  const seves = botiguesDe(usuari);
  if (seves.includes(objectiu.establecimientoId)) return true;
  return (objectiu.establecimientosPermitidos || [])
    .some((e) => seves.includes(e.establishmentId ?? e));
}

/**
 * Pot posar-li contrasenya?
 *
 * Només la responsable general. Els treballadors no entren a l'app — el login
 * rebutja el rol EMPLEADO — o sigui que una encarregada no té cap motiu per
 * canviar la contrasenya de ningú, i deixar-l'hi era el camí per fer-se
 * responsable general.
 */
export function potPosarContrasenya(usuari) {
  return esGeneral(usuari);
}
