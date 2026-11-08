import { potAccedirABotiga } from '../utils/permisos.js';

// Usage: requireRole('MANAGER_GENERAL') or requireRole('MANAGER_LOCAL', 'MANAGER_GENERAL')
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.rol)) {
      return res.status(403).json({ error: 'Sin permisos suficientes' });
    }
    next();
  };
}

/**
 * Una encarregada només arriba a les seves botigues.
 *
 * Llegia `req.params.establishmentId`, però l'única ruta que la fa servir
 * declara el paràmetre com a `:id`. O sigui que sempre era undefined, queia al
 * query —que en un GET /:id tampoc hi és—, i el `if (!requestedId) return
 * next()` la deixava passar. Era l'única guarda d'aquest tipus del projecte i
 * no ha protegit mai res: qualsevol responsable podia llegir les dades de
 * qualsevol botiga, inclòs qui n'és l'encarregada.
 *
 * Ara mira els dos noms de paràmetre i, si no troba cap botiga concreta,
 * tanca en comptes d'obrir. Una guarda que davant del dubte deixa passar no és
 * una guarda.
 */
/**
 * Totes les botigues que porta una petició. Sí: totes, en plural.
 *
 * Abans en tornava una de sola, la primera que trobés mirant l'adreça i
 * després el cos. El revisor va veure que això es podia enganyar: n'hi havia
 * prou d'afegir a l'adreça `?establecimiento=1` —la botiga pròpia, i per tant
 * legítima— i posar la botiga 3 dins del missatge. La guarda mirava l'adreça,
 * hi veia la botiga pròpia i obria; el controlador de `broadcast`, que només
 * llegeix el cos, enviava el WhatsApp als treballadors de l'altra botiga.
 *
 * O sigui que el problema no era quins llocs es miraven sinó que se'n miressin
 * uns i no els altres. Ara es recullen tots i qui truca ha de poder entrar a
 * cadascun: si en porta dos i només té permís per a un, es tanca. Que una
 * petició porti dues botigues diferents no passa mai des de l'app, i si algun
 * dia calgués, la manera correcta seria comprovar-les totes dues igualment.
 *
 * ⚠️ NO mira `req.params.id`, i és a posta. A `/establishments/:id` aquell id és
 * una botiga, però a `/rules/:id` és una regla i a `/schedules/:id` és un torn:
 * comparar-lo amb la llista de botigues de qui pregunta donaria un resultat
 * sense cap sentit —de vegades obrint i de vegades tancant per casualitat— i
 * seria pitjor que no tenir guarda, perquè semblaria que n'hi ha una.
 *
 * Per a les rutes on l'id és d'una altra cosa, la comprovació s'ha de fer al
 * controlador després de carregar el registre i mirar de quina botiga és.
 */
export function botiguesDeLaPeticio(req) {
  // Els cinc noms amb què viatja una botiga per aquesta app, i els tres llocs
  // d'on pot venir. Escrits aquí i no a cada controlador perquè la manera de
  // deixar-se'n un és haver de recordar-los cada vegada.
  const NOMS = ['establecimiento', 'establecimientoId', 'establishmentId'];
  const trobades = [];
  for (const lloc of [req.params, req.query, req.body]) {
    if (!lloc) continue;
    for (const nom of NOMS) {
      if (lloc[nom] !== undefined && lloc[nom] !== null) trobades.push(lloc[nom]);
    }
  }
  return trobades;
}

/**
 * Per a `/establishments/:id`, on l'id SÍ que és una botiga.
 */
export function requireEstablishmentParam(req, res, next) {
  if (!potAccedirABotiga(req.user, req.params.id)) {
    return res.status(403).json({ error: 'No tienes acceso a este establecimiento' });
  }
  next();
}

export function requireEstablishmentAccess(req, res, next) {
  const botigues = botiguesDeLaPeticio(req);
  // Sense cap botiga es tanca igualment: `potAccedirABotiga` amb undefined
  // només obre a la responsable general. Una guarda que davant del dubte deixa
  // passar no és una guarda.
  const totes = botigues.length > 0
    ? botigues.every((id) => potAccedirABotiga(req.user, id))
    : potAccedirABotiga(req.user, undefined);
  if (!totes) {
    return res.status(403).json({ error: 'No tienes acceso a este establecimiento' });
  }
  next();
}
