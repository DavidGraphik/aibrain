import { prisma } from '../services/prisma.js';

export async function getFreeRules(req, res) {
  const { establecimiento } = req.query;
  if (!establecimiento) return res.status(400).json({ error: 'Parámetro establecimiento requerido' });

  const rules = await prisma.freeTextRule.findMany({
    where: { establecimientoId: parseInt(establecimiento), activa: true },
    orderBy: { createdAt: 'asc' },
  });
  return res.json(rules);
}

export async function createFreeRule(req, res) {
  const { establecimientoId, texto } = req.body;
  if (!establecimientoId || !texto?.trim()) {
    return res.status(400).json({ error: 'establecimientoId y texto son obligatorios' });
  }

  const rule = await prisma.freeTextRule.create({
    data: { establecimientoId: parseInt(establecimientoId), texto: texto.trim() },
  });
  return res.status(201).json(rule);
}

export async function updateFreeRule(req, res) {
  const id = parseInt(req.params.id);
  const { texto } = req.body;
  if (!texto?.trim()) return res.status(400).json({ error: 'El texto no puede estar vacío' });

  const rule = await prisma.freeTextRule.update({
    where: { id },
    data: { texto: texto.trim() },
  });
  return res.json(rule);
}

export async function deleteFreeRule(req, res) {
  const id = parseInt(req.params.id);
  await prisma.freeTextRule.update({ where: { id }, data: { activa: false } });
  return res.json({ mensaje: 'Regla eliminada' });
}
