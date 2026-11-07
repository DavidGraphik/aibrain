import { CATALEG, ajustos, desaAjust, validaAjust } from '../utils/ajustos.js';

export async function getAjustos(req, res) {
  const estId = req.query.establecimiento ? parseInt(req.query.establecimiento) : null;
  const valors = await ajustos(estId);
  // The catalogue travels with the values so the screen does not carry its own
  // copy of what each setting is; two lists of the same thing is how the hour
  // target came to have two different formulas.
  const cataleg = Object.fromEntries(
    Object.entries(CATALEG).map(([k, d]) => [k, { ambit: d.ambit, tipus: d.tipus, defecte: d.defecte }])
  );
  return res.json({ establecimiento: estId, valores: valors, catalogo: cataleg });
}

export async function putAjustos(req, res) {
  const { establecimientoId, valores } = req.body;
  if (!valores || typeof valores !== 'object') {
    return res.status(400).json({ error: 'valores requerido' });
  }
  // Everything is checked before anything is written, so a bad value in the
  // middle cannot leave half the settings changed.
  for (const [clau, valor] of Object.entries(valores)) {
    const problema = validaAjust(clau, valor);
    if (problema) return res.status(400).json({ error: problema });
  }
  for (const [clau, valor] of Object.entries(valores)) {
    await desaAjust(clau, valor, establecimientoId ? parseInt(establecimientoId) : null);
  }
  return res.json({ guardados: Object.keys(valores).length, valores: await ajustos(establecimientoId ? parseInt(establecimientoId) : null) });
}
