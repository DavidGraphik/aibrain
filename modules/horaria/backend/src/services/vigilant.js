import { prisma } from './prisma.js';
import { botiguesAutomatiques, setmanaEnFinestraConfigurada, quiRepLaPeticio } from './whatsapp.js';

/**
 * Mira des de FORA si la setmana ha arrencat.
 *
 * Tots els avisos que hi havia són a dins de la feina: el 503 i el WhatsApp a
 * la responsable els envia el propi enviament automàtic. Perquè t'avisin que
 * ha anat malament, doncs, la feina s'ha d'haver executat. El cas que no
 * cobreix ningú és el que no s'executa: si el servei de crons cau, si algú
 * esborra la tasca o si el compte caduca, el diumenge no passa res i el
 * sistema no se n'assabenta, perquè no hi ha ningú mirant-lo.
 *
 * Això és aquell algú. No mira si la feina va dir que havia anat bé: mira si
 * els missatges hi són.
 *
 * Compte amb què NO cobreix: només distingeix «no ha sortit res» de «ha sortit
 * alguna cosa». Si el cron s'executa i falla per a 8 de 9 persones, aquí no
 * salta res — d'això se n'encarrega el 503 de l'enviament automàtic, que sí
 * que compta els fallits un per un.
 */
export async function revisaElCicleSetmanal(ara = new Date()) {
  const setmana = await setmanaEnFinestraConfigurada(ara);
  // Fora de la finestra no hi ha res a haver passat encara. No és cap problema.
  if (!setmana) return { setmana: null, motiu: 'fora_de_finestra', problemes: [] };

  const recompte = [];
  for (const est of await botiguesAutomatiques()) {
    // La mateixa consulta que fa el broadcast, no una que se li assembli: si
    // aquí hi faltessin els compartits, una botiga que només en tingui sortiria
    // com si no hi hagués ningú a qui avisar, i el vigilant callaria.
    const gent = await prisma.employee.findMany({
      where: quiRepLaPeticio(est.id),
      select: { telefonoWhatsapp: true },
    });
    const telefons = gent.map((e) => e.telefonoWhatsapp);
    const enviats = telefons.length === 0 ? 0 : await prisma.whatsappMessage.count({
      where: {
        semana: setmana,
        direccion: 'saliente',
        conversacion: { telefono: { in: telefons } },
      },
    });
    recompte.push({ nombre: est.nombre, ambTelefon: telefons.length, enviats });
  }

  return { setmana, botigues: recompte.length, problemes: detectaProblemes(recompte) };
}

/**
 * Qui té un problema, donat el recompte. A part de la consulta perquè la
 * decisió és el que pot estar malament, i així es pot provar sense base de
 * dades ni tocar res de producció.
 */
export function detectaProblemes(recompte) {
  return recompte
    // Una botiga on ningú no té telèfon no pot rebre res, i marcar-ho com a
    // problema cada setmana és la manera més ràpida d'ensenyar a ignorar
    // l'avís. Que a Girona hi hagi 12 persones sense telèfon és una altra
    // conversa, i ja surt a la seva pantalla.
    .filter((b) => b.ambTelefon > 0 && b.enviats === 0)
    .map((b) => ({ botiga: b.nombre, esperava: b.ambTelefon }));
}

/** El text de l'avís, a part perquè es pugui llegir sense base de dades. */
export function textAvis({ setmana, problemes }) {
  const quines = problemes.map((p) => `• ${p.botiga} (${p.esperava} persones amb WhatsApp)`);
  return 'ATENCIÓ: la petició de preferències de la setmana '
    + `${setmana} no ha sortit.\n\n${quines.join('\n')}\n\n`
    + 'Ningú no ha rebut res. Entra a horarIA i envia-la a mà des de la '
    + 'pantalla de WhatsApp abans que es tanqui la finestra.';
}
