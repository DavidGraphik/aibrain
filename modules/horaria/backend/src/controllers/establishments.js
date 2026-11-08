import { prisma } from '../services/prisma.js';

const DIAS_VALIDOS = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];

// Normalizes diasApertura input (array of day names) to a JSON string, or null for "open every day".
// Returns { ok, value } — ok=false when input is invalid.
function normalizeDiasApertura(dias) {
  if (dias === undefined) return { ok: true, value: undefined }; // not provided → don't touch
  if (dias === null) return { ok: true, value: null };
  if (!Array.isArray(dias)) return { ok: false };
  const clean = [...new Set(dias.map((d) => String(d).toUpperCase()))].filter((d) => DIAS_VALIDOS.includes(d));
  if (clean.length !== dias.length) return { ok: false };
  if (clean.length === 0) return { ok: false }; // an establishment that never opens makes no sense
  if (clean.length === 7) return { ok: true, value: null }; // all days = same as null
  return { ok: true, value: JSON.stringify(clean) };
}

export async function getAll(req, res) {
  const where =
    req.user.rol === 'MANAGER_LOCAL'
      ? { id: { in: req.user.establecimientos } }
      : {};

  const establishments = await prisma.establishment.findMany({
    where,
    include: {
      managerLocal: { select: { id: true, nombre: true, apellidos: true } },
      _count: { select: { empleados: true } },
    },
    orderBy: { nombre: 'asc' },
  });
  return res.json(establishments);
}

export async function getOne(req, res) {
  const id = parseInt(req.params.id);
  const establishment = await prisma.establishment.findUnique({
    where: { id },
    include: {
      managerLocal: { select: { id: true, nombre: true, apellidos: true } },
      empleados: {
        where: { activo: true },
        select: { id: true, nombre: true, apellidos: true, rol: true, flexible: true },
      },
    },
  });
  if (!establishment) return res.status(404).json({ error: 'Establecimiento no encontrado' });
  return res.json(establishment);
}

// Every town in the calendar we read is Catalan, so choosing one answers the
// community question as well — one less field to remember.
function comunidadDe(municipiCodi) {
  return municipiCodi ? 'ES-CT' : null;
}

export async function create(req, res) {
  const { nombre, direccion, managerLocalId, horarioApertura, horarioCierre, cierraMediodia, inicioCierreMediodia, finCierreMediodia, diasApertura, cierraFestivos, comunidadAutonoma, municipiCodi, municipiNom } = req.body;
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
  const dias = normalizeDiasApertura(diasApertura);
  if (!dias.ok) return res.status(400).json({ error: 'diasApertura debe ser una lista de días válidos (LUNES...DOMINGO) con al menos un día' });

  const establishment = await prisma.establishment.create({
    data: {
      nombre,
      direccion: direccion || null,
      managerLocalId: managerLocalId || null,
      horarioApertura: horarioApertura || '08:00',
      horarioCierre: horarioCierre || '21:00',
      cierraMediodia: cierraMediodia || false,
      inicioCierreMediodia: cierraMediodia ? (inicioCierreMediodia || null) : null,
      finCierreMediodia: cierraMediodia ? (finCierreMediodia || null) : null,
      diasApertura: dias.value === undefined ? null : dias.value,
      cierraFestivos: cierraFestivos === undefined ? true : Boolean(cierraFestivos),
      comunidadAutonoma: comunidadAutonoma || comunidadDe(municipiCodi),
      municipiCodi: municipiCodi || null,
      municipiNom: municipiNom || null,
    },
  });
  return res.status(201).json(establishment);
}

export async function update(req, res) {
  const id = parseInt(req.params.id);
  const { nombre, direccion, managerLocalId, activo, horarioApertura, horarioCierre, cierraMediodia, inicioCierreMediodia, finCierreMediodia, diasApertura, cierraFestivos, comunidadAutonoma, municipiCodi, municipiNom } = req.body;
  const dias = normalizeDiasApertura(diasApertura);
  if (!dias.ok) return res.status(400).json({ error: 'diasApertura debe ser una lista de días válidos (LUNES...DOMINGO) con al menos un día' });

  const establishment = await prisma.establishment.update({
    where: { id },
    data: {
      ...(nombre !== undefined && { nombre }),
      ...(direccion !== undefined && { direccion }),
      ...(managerLocalId !== undefined && { managerLocalId }),
      ...(activo !== undefined && { activo }),
      ...(horarioApertura !== undefined && { horarioApertura }),
      ...(horarioCierre !== undefined && { horarioCierre }),
      ...(cierraMediodia !== undefined && { cierraMediodia }),
      ...(inicioCierreMediodia !== undefined && { inicioCierreMediodia: cierraMediodia ? inicioCierreMediodia : null }),
      ...(finCierreMediodia !== undefined && { finCierreMediodia: cierraMediodia ? finCierreMediodia : null }),
      ...(dias.value !== undefined && { diasApertura: dias.value }),
      ...(cierraFestivos !== undefined && { cierraFestivos: Boolean(cierraFestivos) }),
      ...(comunidadAutonoma !== undefined && { comunidadAutonoma: comunidadAutonoma || null }),
      ...(municipiCodi !== undefined && { municipiCodi: municipiCodi || null }),
      ...(municipiNom !== undefined && { municipiNom: municipiNom || null }),
      // Picking a town in the Catalan calendar settles the community too. Two
      // of the three shops had it empty, which is why the holiday import
      // refused to run for them at all.
      ...(municipiCodi && !comunidadAutonoma && { comunidadAutonoma: 'ES-CT' }),
    },
  });
  return res.json(establishment);
}
