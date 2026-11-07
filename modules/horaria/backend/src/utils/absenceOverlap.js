import { prisma } from '../services/prisma.js';

const TIPO_LABEL = {
  ca: { BAJA_MEDICA: 'baixa mèdica', VACACIONES: 'vacances', FESTIVO: 'festiu' },
  es: { BAJA_MEDICA: 'baja médica', VACACIONES: 'vacaciones', FESTIVO: 'festivo' },
  en: { BAJA_MEDICA: 'sick leave', VACACIONES: 'holiday', FESTIVO: 'public holiday' },
};

// ─────────────────────────────────────────────
// Does this absence clash with one already recorded?
//
// A person cannot be off sick twice over the same days, nor on holiday and
// sick at once. Nothing stopped either before: the same leave registered twice
// (easy to do over WhatsApp, where a failed confirmation invites a retry) left
// two rows the manager then had to reconcile by hand.
//
// Deliberately NOT scoped to an establishment: the employee is the person, not
// the shop. Being ill at one shop means being ill at all of them.
//
// FESTIVO is the exception — it closes one particular shop, so two shops can
// perfectly well have a holiday on the same day, and it is only compared
// against holidays of that same establishment.
// ─────────────────────────────────────────────
export async function findOverlappingAbsence({ tipo, empleadoId, establecimientoId, fechaInicio, fechaFin, excludeId = null }) {
  const inicio = new Date(fechaInicio);
  const fin = new Date(fechaFin);

  // Two ranges overlap when each starts before the other ends.
  const solapa = { fechaInicio: { lte: fin }, fechaFin: { gte: inicio } };

  const where = tipo === 'FESTIVO'
    ? { ...solapa, tipo: 'FESTIVO', establecimientoId: parseInt(establecimientoId) }
    : { ...solapa, empleadoId: parseInt(empleadoId), tipo: { in: ['VACACIONES', 'BAJA_MEDICA'] } };

  if (excludeId) where.id = { not: parseInt(excludeId) };
  // A cancelled absence blocks nothing.
  where.estado = { not: 'RECHAZADO' };

  const existente = await prisma.absence.findFirst({
    where,
    select: {
      id: true,
      tipo: true,
      fechaInicio: true,
      fechaFin: true,
      empleado: { select: { nombre: true, apellidos: true } },
    },
    orderBy: { fechaInicio: 'asc' },
  });
  return existente;
}

// Human-readable reason, reused by the API and by the WhatsApp manager flow so
// both explain the clash the same way.
// `lang` matters: this text is shown straight to whoever tried to file the
// absence, and over WhatsApp that is somebody who may well have written in
// Spanish. A Catalan refusal to a Spanish request reads as a glitch.
export function describeOverlap(existente, tipoNuevo, lang = 'ca') {
  const L = TIPO_LABEL[lang] || TIPO_LABEL.ca;
  const desde = existente.fechaInicio.toISOString().slice(0, 10);
  const hasta = existente.fechaFin.toISOString().slice(0, 10);
  const quien = existente.empleado
    ? `${existente.empleado.nombre} ${existente.empleado.apellidos}`.trim()
    : { ca: 'aquest establiment', es: 'este establecimiento', en: 'this establishment' }[lang];
  const ya = L[existente.tipo] || existente.tipo;
  const nuevo = L[tipoNuevo] || tipoNuevo;

  if (existente.tipo === tipoNuevo) {
    return {
      ca: `${quien} ja té una ${ya} registrada del ${desde} al ${hasta}, que se solapa amb aquestes dates.`,
      es: `${quien} ya tiene una ${ya} registrada del ${desde} al ${hasta}, que se solapa con estas fechas.`,
      en: `${quien} already has ${ya} recorded from ${desde} to ${hasta}, which overlaps these dates.`,
    }[lang];
  }
  return {
    ca: `${quien} ja té una ${ya} del ${desde} al ${hasta}: no pot estar de ${nuevo} i de ${ya} alhora.`,
    es: `${quien} ya tiene una ${ya} del ${desde} al ${hasta}: no puede estar de ${nuevo} y de ${ya} a la vez.`,
    en: `${quien} already has ${ya} from ${desde} to ${hasta}: they cannot be on ${nuevo} and ${ya} at once.`,
  }[lang];
}
