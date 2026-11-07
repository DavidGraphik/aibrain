import { prisma } from '../services/prisma.js';

// Un error que es repeteix en bucle —un render que peta i es torna a intentar—
// pot enviar-ne centenars per minut. El límit no és per estalviar espai: és
// perquè el registre continuï sent llegible el dia que el necessitis.
const MAX_PER_HORA = 60;

// El que arriba del navegador és text que envia el client, i per tant no és de
// fiar ni en contingut ni en mida. Es retalla abans de desar-ho.
const talla = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

export async function apuntaError(req, res) {
  const missatge = talla(req.body?.missatge, 500);
  // Sense missatge no hi ha res a diagnosticar; es contesta bé igual, perquè
  // qui informa d'un error no ha de rebre un altre error.
  if (!missatge) return res.status(204).end();

  const desdeFaUnaHora = new Date(Date.now() - 60 * 60 * 1000);
  const quants = await prisma.clientError.count({ where: { createdAt: { gte: desdeFaUnaHora } } });
  if (quants >= MAX_PER_HORA) return res.status(204).end();

  await prisma.clientError.create({
    data: {
      missatge,
      pila: talla(req.body?.pila, 4000),
      pantalla: talla(req.body?.pantalla, 300),
      navegador: talla(req.get('user-agent'), 300),
      empleadoId: req.user?.id ?? null,
    },
  });

  // També als registres del Render, que és on es mira quan es persegueix una
  // cosa en calent i no es vol anar a la base de dades.
  console.error(`[Navegador] ${missatge} · ${talla(req.body?.pantalla, 120) || 'sense pantalla'}`);
  return res.status(204).end();
}

/** Els de la darrera setmana, agrupats: cent iguals són un problema, no cent. */
export async function errorsRecents(_req, res) {
  const desdeFaUnaSetmana = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const files = await prisma.clientError.findMany({
    where: { createdAt: { gte: desdeFaUnaSetmana } },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: { missatge: true, pantalla: true, createdAt: true },
  });

  const per = new Map();
  for (const f of files) {
    const clau = `${f.missatge}·${f.pantalla || ''}`;
    const ja = per.get(clau);
    if (ja) ja.vegades += 1;
    else per.set(clau, { missatge: f.missatge, pantalla: f.pantalla, vegades: 1, ultim: f.createdAt });
  }

  const grups = [...per.values()].sort((a, b) => b.vegades - a.vegades);
  return res.json({ total: files.length, grups });
}
