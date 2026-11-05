import { prisma } from '../services/prisma.js';
import { handlePaperImage } from '../services/whatsapp.js';
import { botiguesDe, esGeneral, potTocarPersona } from '../utils/permisos.js';
import { idNumeric } from '../utils/ids.js';
import { DIAS_SEMANA } from '../utils/weeklyTarget.js';

export async function getPreferences(req, res) {
  const { semana, establecimiento } = req.query;
  if (!semana) return res.status(400).json({ error: 'Parámetro semana requerido' });

  const employees = await prisma.employee.findMany({
    where: {
      activo: true,
      ...(establecimiento ? { establecimientoId: parseInt(establecimiento) } : {}),
    },
    select: { id: true },
  });
  const employeeIds = employees.map((e) => e.id);

  // Res al model garanteix que només n'hi hagi una preferència activa per
  // empleat i setmana, i qui les crea mira si n'hi ha i després crea o
  // actualitza, en dos passos. Ordenem per updatedAt i ens quedem amb la més
  // recent de cada empleat, igual que preferenciesDe a schedules.js, perquè
  // el frontend vegi exactament la mateixa preferència "guanyadora" que fa
  // servir el backend per calcular la marca peticio.
  const preferences = await prisma.shiftPreference.findMany({
    where: { semana, empleadoId: { in: employeeIds }, activa: true },
    include: {
      empleado: { select: { id: true, nombre: true, apellidos: true } },
    },
    orderBy: { updatedAt: 'desc' },
  });
  const vistes = new Set();
  const deduplicades = [];
  for (const p of preferences) {
    if (vistes.has(p.empleadoId)) continue;
    vistes.add(p.empleadoId);
    deduplicades.push(p);
  }
  return res.json(deduplicades);
}

// The photographed sheets behind a week's preferences. Metadata only — the image
// itself is a separate request, so a page listing them doesn't drag several
// megabytes along with it.
export async function getPaperSheets(req, res) {
  const { establecimiento, semana } = req.query;
  if (!establecimiento || !semana) {
    return res.status(400).json({ error: 'Parámetros establecimiento y semana requeridos' });
  }
  const sheets = await prisma.paperSheet.findMany({
    where: { establecimientoId: parseInt(establecimiento), semana },
    select: { id: true, createdAt: true, mimeType: true, enviadoPorId: true },
    orderBy: { createdAt: 'desc' },
  });
  return res.json(sheets);
}

// The image itself, so a disagreement about what somebody wrote can be settled
// by looking at the paper instead of trusting the reading of it.
export async function getPaperSheetImage(req, res) {
  const sheet = await prisma.paperSheet.findUnique({
    where: { id: parseInt(req.params.id) },
    select: { imagen: true, mimeType: true },
  });
  if (!sheet) return res.status(404).json({ error: 'Hoja no encontrada' });
  res.setHeader('Content-Type', sheet.mimeType || 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=300');
  return res.send(Buffer.from(sheet.imagen));
}

export async function updatePreference(req, res) {
  const empleadoId = idNumeric(req.params.empleadoId);
  const { semana, turnoPreferido, diasNoDisponible, turnosPorDia, notasAdicionales } = req.body;
  if (!empleadoId || typeof semana !== 'string' || !/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(semana)) {
    return res.status(400).json({ error: 'Cal un treballador i una setmana ISO vàlids' });
  }
  const employee = await prisma.employee.findUnique({
    where: { id: empleadoId },
    select: { id: true, rol: true, establecimientoId: true, establecimientosPermitidos: { select: { establishmentId: true } } },
  });
  if (!employee || !potTocarPersona(req.user, employee)) {
    return res.status(403).json({ error: 'No tens accés a aquest treballador' });
  }
  const allowed = ['semana', 'turnoPreferido', 'diasNoDisponible', 'turnosPorDia', 'notasAdicionales'];
  if (Object.keys(req.body).some((key) => !allowed.includes(key))) {
    return res.status(400).json({ error: 'Camp de preferència desconegut. Les hores màximes i la flexibilitat pertanyen a la fitxa del treballador.' });
  }
  const shifts = ['MANANA', 'TARDE', 'PARTIDO', 'LIBRE'];
  if (turnoPreferido !== undefined && turnoPreferido !== null && !shifts.includes(turnoPreferido)) {
    return res.status(400).json({ error: 'turnoPreferido ha de ser MANANA, TARDE, PARTIDO, LIBRE o null (sense preferència)' });
  }
  if (diasNoDisponible !== undefined && (!Array.isArray(diasNoDisponible) || diasNoDisponible.some((day) => !DIAS_SEMANA.includes(day)))) {
    return res.status(400).json({ error: 'diasNoDisponible ha de ser una llista de dies LUNES..DOMINGO' });
  }
  if (turnosPorDia !== undefined && (!turnosPorDia || typeof turnosPorDia !== 'object' || Array.isArray(turnosPorDia)
    || Object.entries(turnosPorDia).some(([day, shift]) => !DIAS_SEMANA.includes(day) || !shifts.includes(shift)))) {
    return res.status(400).json({ error: 'turnosPorDia ha de ser un objecte de dies LUNES..DOMINGO amb MANANA, TARDE, PARTIDO o LIBRE' });
  }
  if (notasAdicionales !== undefined && notasAdicionales !== null && typeof notasAdicionales !== 'string') {
    return res.status(400).json({ error: 'notasAdicionales ha de ser text o null' });
  }
  // Update the same latest active record that readers and the scheduler use.
  // An omitted field preserves it; an explicit [] or {} clears that field.
  const current = await prisma.shiftPreference.findFirst({ where: { empleadoId, semana, activa: true }, orderBy: { updatedAt: 'desc' } });
  const data = {
    ...(turnoPreferido !== undefined ? { turnoPreferido } : {}),
    ...(diasNoDisponible !== undefined ? { diasNoDisponible: [...new Set(diasNoDisponible)] } : {}),
    ...(turnosPorDia !== undefined ? { turnosPorDia } : {}),
    ...(notasAdicionales !== undefined ? { notasAdicionales } : {}),
    recogidoVia: 'MANUAL',
  };
  const finalDaysOff = data.diasNoDisponible ?? current?.diasNoDisponible ?? [];
  const finalShifts = data.turnosPorDia ?? current?.turnosPorDia ?? {};
  if (finalDaysOff.some((day) => finalShifts[day] && finalShifts[day] !== 'LIBRE')) {
    return res.status(400).json({ error: 'Un dia no disponible no pot tenir alhora un torn. Revisa diasNoDisponible i turnosPorDia.' });
  }
  const preference = current
    ? await prisma.shiftPreference.update({ where: { id: current.id }, data })
    : await prisma.shiftPreference.create({ data: { empleadoId, semana, ...data } });
  return res.json(preference);
}


// ─────────────────────────────────────────────
// PUJAR UN FULL DE PETICIONS DES DE L'APP
//
// Fins ara els fulls de paper només podien entrar fotografiant-los i enviant-los
// al WhatsApp del bot. Tenint el full a la mà davant de l'ordinador, l'única
// manera de ficar-lo a l'app era fer-li una foto amb el mòbil i enviar-la — o
// teclejar les preferències una per una.
//
// La lectura és la mateixa d'allà, cridada tal com és: si un dia canvia la
// manera de llegir la lletra manuscrita, ha de canviar per als dos camins
// alhora. L'únic que es canvia és qui puja el full i on van les respostes.
// ─────────────────────────────────────────────
export async function uploadPaperSheet(req, res) {
  if (!req.file?.buffer) {
    return res.status(400).json({ error: 'Cal adjuntar una foto del full' });
  }

  // La fitxa sencera i no `req.user`: la lectura necessita saber quines
  // botigues porta i el token només en porta els números.
  const remitent = await prisma.employee.findUnique({
    where: { id: req.user.id },
    include: { establecimientoGestionado: { select: { id: true, nombre: true } } },
  });
  if (!remitent) return res.status(403).json({ error: 'No tienes acceso a este establecimiento' });

  // La botiga no la diu qui puja el full: la diu el full, i no se sap fins que
  // la IA n'ha llegit la capçalera. Per això aquí no hi ha
  // requireEstablishmentAccess i la comprovació va a dins, un cop llegida.
  const botigues = esGeneral(req.user) ? null : botiguesDe(req.user);

  const avisos = [];
  const resultat = await handlePaperImage(remitent.telefonoWhatsapp, {
    buffer: req.file.buffer,
    mimeType: req.file.mimetype,
  }, {
    remitent,
    botigues,
    respon: (text) => { avisos.push(text); },
  });

  if (resultat.reason === 'establishment_not_allowed') {
    return res.status(403).json({ error: avisos.join('\n') });
  }
  const haFallat = ['image_from_non_manager', 'image_download_failed', 'unsupported_image_type',
    'paper_read_failed', 'establishment_not_identified'].includes(resultat.reason);
  if (haFallat) {
    return res.status(400).json({ error: avisos.join('\n'), motiu: resultat.reason });
  }

  return res.json({ ...resultat, resumen: avisos.join('\n') });
}
