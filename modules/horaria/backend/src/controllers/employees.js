import bcrypt from 'bcryptjs';
import { prisma } from '../services/prisma.js';
import { tradueixCondicions, enParaules } from '../services/traductorCondicions.js';
import { validaCondicions, resumDeGarantia } from '../utils/condicions.js';
import { potAccedirABotiga, potTocarPersona, potPosarContrasenya, esGeneral } from '../utils/permisos.js';
import { normalizePhone } from '../services/whatsapp.js';
import { parseConditions } from '../services/conditionCheck.js';

const DIAS_SEM = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];

// Normalize the availability grid to a clean JSON string, or null for "fully available".
// Accepts { LUNES: { M: bool, T: bool }, ... }. Missing entries default to available (true).
export function normalizeDisponibilidad(input) {
  if (input === undefined) return { ok: true, value: undefined }; // not provided → don't touch
  if (input === null) return { ok: true, value: null };
  const invalid = { ok: false, error: 'Disponibilitat mal formada: cal un objecte amb dies LUNES...DOMINGO i franges M/T booleanes, no text lliure.' };
  let obj = input;
  if (typeof input === 'string') { try { obj = JSON.parse(input); } catch { return invalid; } }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return invalid;
  for (const [day, shifts] of Object.entries(obj)) {
    if (!DIAS_SEM.includes(day) || !shifts || typeof shifts !== 'object' || Array.isArray(shifts)) return invalid;
    if (Object.entries(shifts).some(([shift, available]) => !['M', 'T'].includes(shift) || typeof available !== 'boolean')) return invalid;
  }
  const out = {};
  let anyRestriction = false;
  for (const dia of DIAS_SEM) {
    const M = obj?.[dia]?.M !== false; // default available
    const T = obj?.[dia]?.T !== false;
    out[dia] = { M, T };
    if (!M || !T) anyRestriction = true;
  }
  return { ok: true, value: anyRestriction ? JSON.stringify(out) : null }; // all available → store null
}

export async function getAll(req, res) {
  const { establecimiento, rol } = req.query;

  let where = { activo: true };

  if (establecimiento) {
    const estId = parseInt(establecimiento);
    // El filtre per botiga d'una encarregada estava en un `else if`, o sigui
    // que passant ?establecimiento=<altra botiga> no s'aplicava i es veia la
    // plantilla sencera d'una tenda que no és seva, amb telèfons i condicions.
    if (!potAccedirABotiga(req.user, estId)) {
      return res.status(403).json({ error: 'No tens accés a aquest establiment' });
    }
    // Include employees whose PRIMARY establishment is this one
    // AND those who have this establishment in their "allowed" list (cross-establishment)
    where = {
      ...where,
      OR: [
        { establecimientoId: estId },
        { establecimientosPermitidos: { some: { establishmentId: estId } } },
      ],
    };
  } else if (req.user.rol === 'MANAGER_LOCAL') {
    where.establecimientoId = { in: req.user.establecimientos };
  }

  if (rol) where.rol = rol;

  const employees = await prisma.employee.findMany({
    where,
    select: {
      id: true,
      nombre: true,
      apellidos: true,
      email: true,
      telefonoWhatsapp: true,
      rol: true,
      funcion: true,
      flexible: true,
      activo: true,
      maxHorasSemana: true,
      disponibilidad: true,
      condicionesFijas: true,
      // La traducció ha de viatjar amb el text. Sense això la pantalla no la
      // veu mai i totes les fitxes surten com a «sense traduir», encara que ho
      // estiguin: el camp existeix, es desa, i pel camí no el carrega ningú.
      condicionesEstructuradas: true,
      horasPorTurno: true,
      horaEntradaManana: true,
      horaEntradaTarde: true,
      establecimiento: { select: { id: true, nombre: true } },
      establecimientosPermitidos: {
        select: { establishment: { select: { id: true, nombre: true } } },
      },
    },
    orderBy: [{ apellidos: 'asc' }, { nombre: 'asc' }],
  });

  // Add a flag indicating if this employee's primary is different from the queried establishment
  if (establecimiento) {
    const estId = parseInt(establecimiento);
    for (const emp of employees) {
      emp.esVisitante = emp.establecimiento?.id !== estId;
    }
  }

  // The weekly day off a fixed condition grants, read here rather than in the
  // browser: the dashboard needs it to work out the same hour target as the
  // generator, and the two disagreeing about a target is what put a false
  // conflict on the panel once already. One number travels; the parser stays in
  // one place.
  for (const emp of employees) {
    emp.diasLibresPactados = parseConditions(emp.condicionesFijas).minDiasLibres || 0;
  }

  return res.json(employees);
}

/**
 * La forma que espera `potTocarPersona`, a partir del que torna el `select`
 * de getOne: allà l'establiment ve com a objecte i els addicionals també.
 */
function personaPerAlPermis(e) {
  return {
    id: e.id,
    rol: e.rol,
    establecimientoId: e.establecimiento?.id ?? e.establecimientoId ?? null,
    establecimientosPermitidos: (e.establecimientosPermitidos || [])
      .map((x) => x.establishment?.id ?? x.establishmentId ?? x),
  };
}

export async function getOne(req, res) {
  const id = parseInt(req.params.id);
  const employee = await prisma.employee.findUnique({
    where: { id },
    select: {
      id: true,
      nombre: true,
      apellidos: true,
      email: true,
      telefonoWhatsapp: true,
      rol: true,
      flexible: true,
      activo: true,
      maxHorasSemana: true,
      disponibilidad: true,
      condicionesFijas: true,
      // La traducció ha de viatjar amb el text. Sense això la pantalla no la
      // veu mai i totes les fitxes surten com a «sense traduir», encara que ho
      // estiguin: el camp existeix, es desa, i pel camí no el carrega ningú.
      condicionesEstructuradas: true,
      horasPorTurno: true,
      horaEntradaManana: true,
      horaEntradaTarde: true,
      establecimiento: { select: { id: true, nombre: true } },
      establecimientosPermitidos: {
        select: { establishment: { select: { id: true, nombre: true } } },
      },
      preferencias: {
        orderBy: { createdAt: 'desc' },
        take: 5,
      },
      horarios: {
        orderBy: { createdAt: 'desc' },
        take: 14, // last 2 weeks
        include: { establecimiento: { select: { id: true, nombre: true } } },
      },
    },
  });
  if (!employee) return res.status(404).json({ error: 'Empleado no encontrado' });

  // La fitxa porta telèfon, disponibilitat, condicions i els últims 14 torns.
  // No tenia cap filtre: qualsevol responsable la podia llegir de qualsevol
  // treballador de qualsevol botiga provant ids consecutives.
  if (!potTocarPersona(req.user, personaPerAlPermis(employee))) {
    return res.status(403).json({ error: 'No tens accés a aquest treballador' });
  }
  return res.json(employee);
}

// ─────────────────────────────────────────────
// LA RESPONSABLE GENERAL NO PERTANY A CAP BOTIGA
//
// Les botigues les porten les encarregades, que sí que hi treballen i sí que
// compten com a equip. Quatre consultes del flux de WhatsApp defineixen «l'equip
// d'una botiga» i cadascuna ho feia a la seva manera; en comptes de posar el
// mateix filtre a totes quatre i confiar que la cinquena que vingui també se'n
// recordi, es tanca la porta aquí: si no se li pot assignar establiment, les
// quatre són correctes per construcció.
//
// Sense això, assignar-li una botiga des de la fitxa hauria fet que el broadcast
// li demanés preferències mentre el comptador de «ja pots generar» la ignorava.
// ─────────────────────────────────────────────
const SENSE_ESTABLIMENT = 'La responsable general no pertany a cap establiment: les botigues les porten les encarregades.';

/** Qui pot tenir botiga assignada. Exportada per poder-la provar sense base de dades. */
export function potTenirEstabliment(rol) {
  return rol !== 'MANAGER_GENERAL';
}

/**
 * El rol que tindrà quan s'hagi desat, que no és el que té ara.
 *
 * Aquí és on va fallar: una versió triava la branca amb el rol NOU i després
 * comprovava el VELL, i llavors degradar la responsable general a encarregada
 * d'una botiga en el mateix desat es rebutjava — li deia que no pot tenir
 * establiment quan en aquella mateixa petició ja deixava de ser-ho. I el
 * formulari envia sempre el rol, o sigui que no era cap cas de laboratori.
 */
export function rolDespresDeDesar(data, actual) {
  return data.rol !== undefined ? data.rol : actual?.rol;
}

// ─────────────────────────────────────────────
// EL TELÈFON O EL CORREU JA ELS TÉ UNA ALTRA FITXA
//
// Els dos són únics a la base de dades. Quan xoquen, Prisma llança P2002, i
// sense capturar-lo sortia un «error interno del servidor»: ni deia què passava
// ni què s'havia de fer. I el que s'ha de fer no és endevinable, perquè el
// número el sol tenir una fitxa vella, de proves o duplicada, sovint donada de
// baixa i per tant invisible a la pantalla.
//
// Viu aquí i no dins de cada controlador perquè `create` i `update` ho han de
// dir igual: es va arreglar l'update i l'alta va seguir petant una setmana més.
//
// Torna el cos de la resposta 409, o null si l'error no és un duplicat — i
// llavors qui la crida l'ha de deixar pujar: empassar-se tots els errors
// amagaria fallades de debò darrere d'un missatge que parla de telèfons.
// ─────────────────────────────────────────────
const CAMPS_UNICS = {
  telefonoWhatsapp: { com: 'aquest telèfon', on: (v) => ({ telefonoWhatsapp: v }) },
  email:            { com: 'aquest correu',  on: (v) => ({ email: v }) },
};

export async function respostaDeDuplicat(err, dades, usuari) {
  if (err?.code !== 'P2002') return null;
  const camp = err?.meta?.target?.[0];
  const quin = CAMPS_UNICS[camp];
  // Un camp únic que encara no consti aquí: es diu que està repetit i prou. És
  // millor que endevinar que és un correu i buscar-lo com si ho fos.
  if (!quin) return { error: 'Ja hi ha una altra fitxa amb aquesta dada.', camp: camp ?? null, idEnConflicte: null };

  const valor = dades?.[camp];
  let dequi = null;
  if (valor) {
    const altre = await prisma.employee.findUnique({
      where: quin.on(valor),
      select: {
        id: true, nombre: true, apellidos: true, activo: true, rol: true, establecimientoId: true,
        establecimientosPermitidos: { select: { establishmentId: true } },
      },
    });
    // Es diu de qui és, que és l'única cosa que permet arreglar-ho: si no, saps
    // que està repetit i no on. Només si qui ho demana pot veure aquella fitxa.
    if (altre && potTocarPersona(usuari, altre)) dequi = altre;
  }

  // Quan no la pot veure, la resposta és la mateixa que quan no s'ha trobat
  // res. Dir «existeix però no t'ho puc dir» convertiria el formulari en una
  // manera de saber si un número qualsevol està donat d'alta en alguna botiga.
  if (!dequi) return { error: 'Aquesta dada ja consta en una altra fitxa.', camp, idEnConflicte: null };

  return {
    error: `${quin.com} ja el té ${dequi.nombre} ${dequi.apellidos}`
      + `${dequi.activo ? '' : ' (fitxa donada de baixa)'}.`
      + ' Treu-l\'hi d\'allà i torna-ho a desar.',
    camp,
    idEnConflicte: dequi.id,
  };
}

export async function create(req, res) {
  const { nombre, apellidos, email, password, telefonoWhatsapp, rol, funcion, establecimientoId, flexible, maxHorasSemana, disponibilidad, condicionesFijas, horasPorTurno, horaEntradaManana, horaEntradaTarde } = req.body;

  if (!nombre || !apellidos) {
    return res.status(400).json({ error: 'Nombre y apellidos son obligatorios' });
  }
  if (req.user.rol === 'MANAGER_LOCAL' && rol && rol !== 'EMPLEADO') {
    return res.status(403).json({ error: 'Un manager local solo puede crear empleados' });
  }
  if (!potTenirEstabliment(rol) && establecimientoId) {
    return res.status(400).json({ error: SENSE_ESTABLIMENT });
  }
  // La importació en bloc ja ho comprovava; l'alta d'un en un, no.
  if (establecimientoId && !potAccedirABotiga(req.user, establecimientoId)) {
    return res.status(403).json({ error: 'No tens accés a aquest establiment' });
  }
  if (password && !potPosarContrasenya(req.user)) {
    return res.status(403).json({ error: 'Només la responsable general pot posar contrasenyes' });
  }

  const availability = normalizeDisponibilidad(disponibilidad);
  if (!availability.ok) return res.status(400).json({ error: availability.error });

  let passwordHash;
  if (password) {
    passwordHash = await bcrypt.hash(password, 10);
  }

  const dades = {
    nombre,
    apellidos,
    email: email || null,
    passwordHash: passwordHash || null,
    telefonoWhatsapp: telefonoWhatsapp || null,
    rol: rol || 'EMPLEADO',
    funcion: funcion || 'DEPENDIENTA',
    establecimientoId: establecimientoId || null,
    flexible: flexible || false,
    maxHorasSemana: maxHorasSemana ? parseInt(maxHorasSemana) : 40,
    disponibilidad: availability.value ?? null,
    condicionesFijas: condicionesFijas || null,
    horasPorTurno: horasPorTurno ? parseInt(horasPorTurno) : null,
    horaEntradaManana: horaEntradaManana || null,
    horaEntradaTarde: horaEntradaTarde || null,
  };

  let employee;
  try {
    employee = await prisma.employee.create({ data: dades });
  } catch (err) {
    const xoc = await respostaDeDuplicat(err, dades, req.user);
    if (!xoc) throw err;
    return res.status(409).json(xoc);
  }

  const { passwordHash: _, ...safeEmployee } = employee;
  return res.status(201).json(safeEmployee);
}

// ─────────────────────────────────────────────
// BULK IMPORT
// Rows come from a spreadsheet paste, so every field arrives as loose text and
// has to be interpreted rather than trusted.
// ─────────────────────────────────────────────

// Spreadsheet phone columns look like "600 11 22 33", "0034600112233" or
// "+34 600 112 233". We store E.164 and assume Spain when no country code is
// given — normalizePhone() alone would turn a bare 9-digit number into a
// nonsense "+600112233".
function normalizeImportPhone(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim().replace(/[\s.\-()]/g, '');
  if (!s) return null;
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (/^\d{9}$/.test(s)) s = `+34${s}`;
  else if (/^34\d{9}$/.test(s)) s = `+${s}`;
  const phone = normalizePhone(s);
  return /^\+\d{10,15}$/.test(phone) ? phone : null;
}

// The function column is written however the manager happens to write it, in
// Catalan or Spanish, sometimes as a single letter.
const FUNCION_ALIASES = {
  dependienta: 'DEPENDIENTA', dependiente: 'DEPENDIENTA', dependenta: 'DEPENDIENTA',
  dependent: 'DEPENDIENTA', d: 'DEPENDIENTA', botiga: 'DEPENDIENTA',
  tienda: 'DEPENDIENTA', venta: 'DEPENDIENTA', venda: 'DEPENDIENTA', mostrador: 'DEPENDIENTA',
  elaboracion: 'ELABORACION', elaboracio: 'ELABORACION', obrador: 'ELABORACION',
  e: 'ELABORACION', produccion: 'ELABORACION', produccio: 'ELABORACION', cuina: 'ELABORACION',
};
function parseFuncion(raw) {
  const key = String(raw || '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return FUNCION_ALIASES[key] || null;
}

export async function importEmployees(req, res) {
  const { empleados, establecimientoId } = req.body;

  if (!Array.isArray(empleados) || empleados.length === 0) {
    return res.status(400).json({ error: 'No hay empleados para importar' });
  }
  if (empleados.length > 500) {
    return res.status(400).json({ error: 'Máximo 500 empleados por importación' });
  }
  const estId = establecimientoId ? parseInt(establecimientoId) : null;
  if (req.user.rol === 'MANAGER_LOCAL' && (!estId || !req.user.establecimientos.includes(estId))) {
    return res.status(403).json({ error: 'Solo puedes importar a tu propio establecimiento' });
  }

  // Rows are independent: one bad row must not discard the rest, so each is
  // created on its own and reported back with its spreadsheet line number.
  const resultados = [];
  for (let i = 0; i < empleados.length; i++) {
    const row = empleados[i] || {};
    const linea = i + 1;
    const nombre = String(row.nombre || '').trim();
    const apellidos = String(row.apellidos || '').trim();
    const etiqueta = `${nombre} ${apellidos}`.trim() || `(línea ${linea})`;

    if (!nombre || !apellidos) {
      resultados.push({ linea, etiqueta, ok: false, error: 'Faltan nombre o apellidos' });
      continue;
    }

    const horas = parseInt(row.maxHorasSemana, 10);
    try {
      const emp = await prisma.employee.create({
        data: {
          nombre,
          apellidos,
          telefonoWhatsapp: normalizeImportPhone(row.telefonoWhatsapp),
          funcion: parseFuncion(row.funcion) || 'DEPENDIENTA',
          maxHorasSemana: Number.isFinite(horas) && horas > 0 && horas <= 60 ? horas : 40,
          establecimientoId: estId,
          rol: 'EMPLEADO',
        },
        select: { id: true, nombre: true, apellidos: true },
      });
      resultados.push({ linea, etiqueta, ok: true, id: emp.id });
    } catch (err) {
      // P2002 = unique constraint; in practice always a repeated phone number.
      const campo = err?.meta?.target?.[0];
      resultados.push({
        linea,
        etiqueta,
        ok: false,
        error: err?.code === 'P2002'
          ? `Ya existe un empleado con ese ${campo === 'telefonoWhatsapp' ? 'teléfono' : campo || 'dato'}`
          : 'No se pudo crear',
      });
    }
  }

  return res.json({
    creados: resultados.filter((r) => r.ok).length,
    fallidos: resultados.filter((r) => !r.ok).length,
    resultados,
  });
}

export async function update(req, res) {
  const id = parseInt(req.params.id);
  const { nombre, apellidos, email, password, telefonoWhatsapp, rol, funcion, establecimientoId, flexible, activo, maxHorasSemana, disponibilidad, condicionesFijas, condicionesEstructuradas, horasPorTurno, horaEntradaManana, horaEntradaTarde } = req.body;

  // Primer el que es decideix només amb la petició, sense consultar res.
  if (password && !potPosarContrasenya(req.user)) {
    return res.status(403).json({ error: 'Només la responsable general pot posar contrasenyes' });
  }
  if (establecimientoId && !potAccedirABotiga(req.user, establecimientoId)) {
    return res.status(403).json({ error: 'No tens accés a aquest establiment' });
  }
  if (rol !== undefined && !potTenirEstabliment(rol) && establecimientoId) {
    return res.status(400).json({ error: SENSE_ESTABLIMENT });
  }

  // I ara sí, qui és la persona que s'edita. Abans no es mirava ni de quina
  // botiga era ni quin rol tenia: com que aquest mateix endpoint deixa posar
  // contrasenya, una encarregada podia canviar la de la responsable general i
  // entrar com ella.
  const objectiu = await prisma.employee.findUnique({
    where: { id },
    select: {
      id: true, rol: true, establecimientoId: true,
      establecimientosPermitidos: { select: { establishmentId: true } },
    },
  });
  if (!objectiu) return res.status(404).json({ error: 'Empleado no encontrado' });
  if (!potTocarPersona(req.user, objectiu)) {
    return res.status(403).json({ error: 'No tens accés a aquest treballador' });
  }

  const availability = normalizeDisponibilidad(disponibilidad);
  if (!availability.ok) return res.status(400).json({ error: availability.error });
  const data = {};
  if (nombre !== undefined) data.nombre = nombre;
  if (apellidos !== undefined) data.apellidos = apellidos;
  if (email !== undefined) data.email = email || null;
  if (telefonoWhatsapp !== undefined) data.telefonoWhatsapp = telefonoWhatsapp || null;
  if (funcion !== undefined) data.funcion = funcion;
  if (flexible !== undefined) data.flexible = flexible;
  if (activo !== undefined) data.activo = activo;
  if (maxHorasSemana !== undefined) data.maxHorasSemana = parseInt(maxHorasSemana);
  if (disponibilidad !== undefined) data.disponibilidad = availability.value;
  if (condicionesFijas !== undefined) data.condicionesFijas = condicionesFijas || null;
  if (condicionesEstructuradas !== undefined) {
    // Validat aquí i no només a la pantalla: aquest camp el fa complir el motor
    // amb passades deterministes, i una forma que no entengui seria una
    // condició que el responsable creu posada i que no aplica ningú.
    const v = validaCondicions(condicionesEstructuradas);
    if (!v.ok) return res.status(400).json({ error: `Condicions mal formades: ${v.errors.join('; ')}` });
    data.condicionesEstructuradas = v.net;
  }
  if (horasPorTurno !== undefined) data.horasPorTurno = horasPorTurno ? parseInt(horasPorTurno) : null;
  if (horaEntradaManana !== undefined) data.horaEntradaManana = horaEntradaManana || null;
  if (horaEntradaTarde !== undefined) data.horaEntradaTarde = horaEntradaTarde || null;
  if (password) data.passwordHash = await bcrypt.hash(password, 10);
  if (rol !== undefined && req.user.rol === 'MANAGER_GENERAL') data.rol = rol;
  if (establecimientoId !== undefined && req.user.rol === 'MANAGER_GENERAL') {
    data.establecimientoId = establecimientoId;
  }

  // Només es mira si la petició toca el rol o la botiga, i només es consulta la
  // base de dades si el rol no ve — abans es feia una consulta extra a cada
  // desada, i update és el camí més fressat del controlador.
  if (data.rol !== undefined || data.establecimientoId !== undefined) {
    if (!potTenirEstabliment(rolDespresDeDesar(data, objectiu))) {
      if (data.establecimientoId) return res.status(400).json({ error: SENSE_ESTABLIMENT });
      data.establecimientoId = null;   // promoure algú el desvincula de la botiga
    }
  }

  // El telèfon i el correu són únics a la base de dades. Sense aquest `catch`,
  // desar un número que ja tingués una altra fitxa petava amb un «error intern
  // del servidor», que no diu ni què passa ni què has de fer: el número el sol
  // tenir un registre vell, de proves o duplicat, i des de la pantalla no es
  // veu. `importEmployees` ja ho explicava; aquest camí, que és el que es fa
  // servir cada dia, no.
  let employee;
  try {
    employee = await prisma.employee.update({ where: { id }, data });
  } catch (err) {
    const xoc = await respostaDeDuplicat(err, data, req.user);
    if (!xoc) throw err;
    return res.status(409).json(xoc);
  }
  const { passwordHash: _, ...safeEmployee } = employee;
  return res.json(safeEmployee);
}

// ─────────────────────────────────────────────
// QUÈ ENTÉN EL SISTEMA D'UNA CONDICIÓ ESCRITA
//
// Tradueix i ENSENYA. No desa res: la traducció la valida una persona, i es
// guarda amb la resta de la fitxa quan es prem desar. Ningú ha de validar un
// JSON, o sigui que el que torna són frases.
//
// La frase original no es toca mai. Si la traducció no és bona, s'esmena la
// frase i es torna a provar — així el que hi ha escrit a la fitxa segueix sent
// el que la gent llegeix i discuteix.
// ─────────────────────────────────────────────
export async function tradueixLesCondicions(req, res) {
  const id = parseInt(req.params.id);
  const { texto } = req.body || {};
  if (typeof texto !== 'string') return res.status(400).json({ error: 'Falta el text' });

  const jo = await prisma.employee.findUnique({
    where: { id },
    select: {
      id: true, establecimientoId: true,
      horaEntradaManana: true, horaEntradaTarde: true, horasPorTurno: true, maxHorasSemana: true,
    },
  });
  if (!jo) return res.status(404).json({ error: 'Empleado no encontrado' });
  if (!potAccedirABotiga(req.user, jo.establecimientoId)) {
    return res.status(403).json({ error: 'No tens accés a aquest treballador' });
  }

  const companys = await prisma.employee.findMany({
    where: { activo: true, establecimientoId: jo.establecimientoId, id: { not: id } },
    select: { id: true, nombre: true, apellidos: true },
  });

  const r = await tradueixCondicions(texto, {
    companys,
    jaALaFitxa: {
      horaEntradaManana: jo.horaEntradaManana,
      horaEntradaTarde: jo.horaEntradaTarde,
      horasPorTurno: jo.horasPorTurno,
      maxHorasSemana: jo.maxHorasSemana,
    },
  });

  if (!r.ok) return res.json({ ok: false, errors: r.errors });
  return res.json({
    ok: true,
    condicions: r.condicions,
    frases: enParaules(r.condicions),
    ...resumDeGarantia(r.condicions),
  });
}

export async function remove(req, res) {
  const id = parseInt(req.params.id);

  // Avui la ruta ja el limita a la responsable general, que se salta qualsevol
  // comprovació igualment. Es posa perquè si algun dia algú afegeix
  // 'MANAGER_LOCAL' a la ruta — com ja passa a create, update i import — no
  // torni a obrir-se el forat que aquest fitxer acaba de tancar. La seguretat
  // no ha de dependre que ningú toqui routes/ sense adonar-se'n.
  const objectiu = await prisma.employee.findUnique({
    where: { id },
    select: {
      id: true, rol: true, establecimientoId: true,
      establecimientosPermitidos: { select: { establishmentId: true } },
    },
  });
  if (!objectiu) return res.status(404).json({ error: 'Empleado no encontrado' });
  if (!potTocarPersona(req.user, objectiu)) {
    return res.status(403).json({ error: 'No tens accés a aquest treballador' });
  }

  // Soft delete
  await prisma.employee.update({ where: { id }, data: { activo: false } });
  return res.json({ mensaje: 'Empleado desactivado' });
}

export async function updateAllowedEstablishments(req, res) {
  const employeeId = parseInt(req.params.id);
  const { establishmentIds } = req.body; // array of establishment IDs

  if (!Array.isArray(establishmentIds)) {
    return res.status(400).json({ error: 'establishmentIds debe ser un array' });
  }
  // Cap botiga que no sigui seva, decidit abans de consultar res.
  const forat = establishmentIds.find((e) => !potAccedirABotiga(req.user, e));
  if (forat !== undefined) {
    return res.status(403).json({ error: 'No tens accés a aquest establiment' });
  }

  // Igual que a remove: avui la ruta ja ho limita, però la comprovació viu aquí
  // perquè no depengui de la ruta.
  const qui = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      id: true, rol: true, establecimientoId: true,
      establecimientosPermitidos: { select: { establishmentId: true } },
    },
  });
  if (!qui) return res.status(404).json({ error: 'Empleado no encontrado' });
  if (!potTocarPersona(req.user, qui)) {
    return res.status(403).json({ error: 'No tens accés a aquest treballador' });
  }
  if (establishmentIds.length > 0 && !potTenirEstabliment(qui.rol)) {
    return res.status(400).json({ error: SENSE_ESTABLIMENT });
  }

  // Delete current allowed establishments and recreate
  await prisma.employeeEstablishment.deleteMany({ where: { employeeId } });

  if (establishmentIds.length > 0) {
    await prisma.employeeEstablishment.createMany({
      data: establishmentIds.map((establishmentId) => ({
        employeeId,
        establishmentId,
        asignadoPor: req.user.id,
      })),
    });
  }

  // Ensure employee is marked as flexible
  await prisma.employee.update({
    where: { id: employeeId },
    data: { flexible: establishmentIds.length > 0 },
  });

  return res.json({ mensaje: 'Establecimientos permitidos actualizados' });
}
