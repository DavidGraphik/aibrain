import { prisma } from '../services/prisma.js';

// Coverage is stored as a min and a max per function and shift. Nothing stopped
// the two crossing, and a rule asking for "at least 6, at most 5" cannot be
// satisfied: the repair passes add people to reach the minimum and remove them
// to respect the maximum, five times over, and whatever else was true of the
// schedule is what gives way. Girona had exactly that on Tuesday, Wednesday and
// Thursday, which is why Eva Mademont could not be given the morning she was
// owed — six were already on and the maximum said five.
const RANGOS = [
  ['minDependientasManana', 'maxDependientasManana', 'dependientas por la mañana'],
  ['minDependientasTarde', 'maxDependientasTarde', 'dependientas por la tarde'],
  ['minElaboracionManana', 'maxElaboracionManana', 'elaboración por la mañana'],
  ['minElaboracionTarde', 'maxElaboracionTarde', 'elaboración por la tarde'],
];

/** Returns a message when a min exceeds its max, or null when the rule is sane. */
export function validateRuleRanges(valores) {
  for (const [minKey, maxKey, etiqueta] of RANGOS) {
    const min = valores[minKey];
    const max = valores[maxKey];
    if (min == null || max == null) continue;
    if (Number(min) > Number(max)) {
      return `El mínimo de ${etiqueta} (${min}) no puede ser mayor que el máximo (${max}).`;
    }
  }
  return null;
}

export async function getRules(req, res) {
  const { establecimiento } = req.query;
  if (!establecimiento) return res.status(400).json({ error: 'Parámetro establecimiento requerido' });

  const rules = await prisma.establishmentRules.findMany({
    where: { establecimientoId: parseInt(establecimiento), activa: true },
    orderBy: { createdAt: 'asc' },
  });
  return res.json(rules);
}

export async function createRule(req, res) {
  const {
    establecimientoId, nombre, descripcion,
    minDependientasManana, maxDependientasManana,
    minDependientasTarde, maxDependientasTarde,
    minElaboracionManana, maxElaboracionManana,
    minElaboracionTarde, maxElaboracionTarde,
    minPersonasDescansoPartido,
  } = req.body;

  if (!establecimientoId || !nombre) {
    return res.status(400).json({ error: 'establecimientoId y nombre son obligatorios' });
  }

  const rangoInvalido = validateRuleRanges({
    minDependientasManana: minDependientasManana ?? 1, maxDependientasManana: maxDependientasManana ?? 99,
    minDependientasTarde: minDependientasTarde ?? 1, maxDependientasTarde: maxDependientasTarde ?? 99,
    minElaboracionManana: minElaboracionManana ?? 1, maxElaboracionManana: maxElaboracionManana ?? 99,
    minElaboracionTarde: minElaboracionTarde ?? 1, maxElaboracionTarde: maxElaboracionTarde ?? 99,
  });
  if (rangoInvalido) return res.status(400).json({ error: rangoInvalido });

  const rule = await prisma.establishmentRules.create({
    data: {
      establecimientoId: parseInt(establecimientoId),
      nombre,
      descripcion: descripcion || null,
      minDependientasManana: minDependientasManana ?? 1,
      maxDependientasManana: maxDependientasManana ?? 99,
      minDependientasTarde: minDependientasTarde ?? 1,
      maxDependientasTarde: maxDependientasTarde ?? 99,
      minElaboracionManana: minElaboracionManana ?? 1,
      maxElaboracionManana: maxElaboracionManana ?? 99,
      minElaboracionTarde: minElaboracionTarde ?? 1,
      maxElaboracionTarde: maxElaboracionTarde ?? 99,
      minPersonasDescansoPartido: minPersonasDescansoPartido ?? 2,
      diasAplica: req.body.diasAplica ? JSON.stringify(req.body.diasAplica) : null,
    },
  });
  return res.status(201).json(rule);
}

export async function updateRule(req, res) {
  const id = parseInt(req.params.id);
  const {
    nombre, descripcion,
    minDependientasManana, maxDependientasManana,
    minDependientasTarde, maxDependientasTarde,
    minElaboracionManana, maxElaboracionManana,
    minElaboracionTarde, maxElaboracionTarde,
    minPersonasDescansoPartido, activa,
  } = req.body;

  // An update sends only what changed, so the pair has to be checked against
  // what is already stored: lowering a maximum below an untouched minimum is
  // exactly how Girona ended up with "at least 6, at most 5".
  const actual = await prisma.establishmentRules.findUnique({ where: { id } });
  if (!actual) return res.status(404).json({ error: 'Regla no encontrada' });

  const rangoInvalido = validateRuleRanges({
    minDependientasManana: minDependientasManana ?? actual.minDependientasManana,
    maxDependientasManana: maxDependientasManana ?? actual.maxDependientasManana,
    minDependientasTarde: minDependientasTarde ?? actual.minDependientasTarde,
    maxDependientasTarde: maxDependientasTarde ?? actual.maxDependientasTarde,
    minElaboracionManana: minElaboracionManana ?? actual.minElaboracionManana,
    maxElaboracionManana: maxElaboracionManana ?? actual.maxElaboracionManana,
    minElaboracionTarde: minElaboracionTarde ?? actual.minElaboracionTarde,
    maxElaboracionTarde: maxElaboracionTarde ?? actual.maxElaboracionTarde,
  });
  if (rangoInvalido) return res.status(400).json({ error: rangoInvalido });

  const rule = await prisma.establishmentRules.update({
    where: { id },
    data: {
      ...(nombre !== undefined && { nombre }),
      ...(descripcion !== undefined && { descripcion }),
      ...(minDependientasManana !== undefined && { minDependientasManana }),
      ...(maxDependientasManana !== undefined && { maxDependientasManana }),
      ...(minDependientasTarde !== undefined && { minDependientasTarde }),
      ...(maxDependientasTarde !== undefined && { maxDependientasTarde }),
      ...(minElaboracionManana !== undefined && { minElaboracionManana }),
      ...(maxElaboracionManana !== undefined && { maxElaboracionManana }),
      ...(minElaboracionTarde !== undefined && { minElaboracionTarde }),
      ...(maxElaboracionTarde !== undefined && { maxElaboracionTarde }),
      ...(minPersonasDescansoPartido !== undefined && { minPersonasDescansoPartido }),
      ...(req.body.diasAplica !== undefined && { diasAplica: req.body.diasAplica ? JSON.stringify(req.body.diasAplica) : null }),
      ...(activa !== undefined && { activa }),
    },
  });
  return res.json(rule);
}

export async function deleteRule(req, res) {
  const id = parseInt(req.params.id);
  await prisma.establishmentRules.update({ where: { id }, data: { activa: false } });
  return res.json({ mensaje: 'Regla eliminada' });
}
