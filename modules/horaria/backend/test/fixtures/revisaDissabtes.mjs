// ─────────────────────────────────────────────
// TORNAR A MIRAR ELS DISSABTES D'UNA SETMANA
//
// L'alternança es decideix quan el treballador contesta, i la setmana anterior
// encara es pot tocar després. A l'Antònia López el bot li va dir que no podia
// fer dissabte matí perquè l'anterior l'havia fet de matí; mitja hora més tard
// aquell dissabte va passar a DIA, i llavors sí que li tocava matí. El bot no
// es va equivocar: els fets van canviar-li a sota.
//
//   node scripts/revisaDissabtes.mjs 2026-W36                        ← mira
//   node scripts/revisaDissabtes.mjs 2026-W36 --empleat 97 --torn MANANA
//   ... i --fes per desar-ho
//
// Només AFEGEIX el dissabte, i només si l'alternança ARA l'hi permet. No en
// treu mai cap ni toca cap altre dia.
//
// Des del 24 d'agost, qui retira un dissabte deixa rastre a `dissabteRetirat`
// i el script el troba sol. `--empleat`/`--torn` es queden per als casos
// anteriors, que no en tenen.
// ─────────────────────────────────────────────
import 'dotenv/config';
import { prisma } from '../src/services/prisma.js';
import { alternancaCompleix, ultimDissabteTreballat } from '../src/services/saturdayRotation.js';

const [semana, ...resta] = process.argv.slice(2);
const fes = resta.includes('--fes');
const empleat = resta.includes('--empleat') ? parseInt(resta[resta.indexOf('--empleat') + 1]) : null;
const tornDemanat = resta.includes('--torn') ? resta[resta.indexOf('--torn') + 1] : null;
const TORNS = ['MANANA', 'TARDE', 'PARTIDO'];

async function main() {
  if (!/^\d{4}-W\d{2}$/.test(semana || '')) {
    console.log('Falta la setmana.\n  node scripts/revisaDissabtes.mjs 2026-W36 [--fes]');
    return;
  }
  // `--empleat` sense número donava NaN, i NaN no filtra res: el script
  // passava a mirar-los TOTS en silenci, i amb --fes hauria escrit a les
  // preferències de gent que no es volia tocar.
  if (resta.includes('--empleat') && !Number.isInteger(empleat)) {
    console.log('--empleat vol un número.');
    return;
  }
  // I un torn mal escrit s'hauria desat tal qual: a qui no tingui cap dissabte
  // treballat, `alternancaCompleix` no té res amb què comparar i diu que sí.
  if (tornDemanat && !TORNS.includes(tornDemanat)) {
    console.log(`--torn ha de ser ${TORNS.join(', ')} — i és «${tornDemanat}».`);
    return;
  }
  if (resta.includes('--empleat') !== !!tornDemanat) {
    console.log('--empleat i --torn van junts: cal dir qui és i què demanava.');
    return;
  }

  // Qui va parlar amb el bot i va quedar amb el dissabte pendent. El torn que
  // demanava queda apuntat a la conversa quan se li retira.
  const converses = await prisma.whatsappConversation.findMany({
    where: { semana, OR: [{ pendentAlternanca: { not: null } }, { dissabteRetirat: { not: null } }] },
    select: { telefono: true, pendentAlternanca: true, dissabteRetirat: true },
  });

  // I qui el va demanar i se li va retirar sense deixar-ne rastre a la conversa:
  // es reconeix perquè la preferència ho diu a les notes.
  const prefs = await prisma.shiftPreference.findMany({
    where: { semana, activa: true },
    select: {
      id: true, empleadoId: true, turnosPorDia: true, notasAdicionales: true,
      empleado: { select: { nombre: true, apellidos: true, telefonoWhatsapp: true, establecimientoId: true } },
    },
  });

  console.log(`\nSetmana ${semana}.${fes ? '' : ' Això NOMÉS mira.'}\n`);
  let toquen = 0;

  for (const p of prefs) {
    const jaEnTe = p.turnosPorDia?.SABADO;
    if (jaEnTe) continue;

    if (empleat && p.empleadoId !== empleat) continue;
    const conv = converses.find((c) => c.telefono === p.empleado.telefonoWhatsapp);
    // El que consta a la conversa, o el que es diu a mà quan ja no hi consta.
    // El que espera resposta, el que va retirar, o el que es diu a mà quan no
    // en consta cap (converses d'abans que això es desés).
    const demanava = conv?.pendentAlternanca || conv?.dissabteRetirat
      || (p.empleadoId === empleat ? tornDemanat : null);
    if (!demanava) continue;

    const files = await prisma.schedule.findMany({
      where: {
        empleadoId: p.empleadoId, establecimientoId: p.empleado.establecimientoId,
        dia: 'SABADO', semana: { lt: semana },
      },
      select: { semana: true, dia: true, turno: true },
      orderBy: { semana: 'desc' },
      take: 26,
    });
    const ultim = ultimDissabteTreballat(files, semana);
    const araPot = alternancaCompleix(ultim?.turno, demanava);

    const qui = `${p.empleado.nombre.trim()} ${p.empleado.apellidos}`;
    console.log(`${qui}: demanava ${demanava} · l'últim dissabte va fer ${ultim?.turno ?? '(cap)'}`
      + ` → ${araPot ? '✓ ARA SÍ que li toca' : 'segueix sense tocar-li'}`);
    if (!araPot) continue;
    toquen++;

    if (fes) {
      await prisma.shiftPreference.update({
        where: { id: p.id },
        data: {
          turnosPorDia: { ...(p.turnosPorDia || {}), SABADO: demanava },
          notasAdicionales: [p.notasAdicionales, `Dissabte ${demanava} recuperat: l'alternança va canviar després de parlar-hi.`]
            .filter(Boolean).join('\n'),
        },
      });
      await prisma.whatsappConversation.updateMany({
        where: { semana, telefono: p.empleado.telefonoWhatsapp },
        data: { pendentAlternanca: null, dissabteRetirat: null },
      });
      console.log('   → desat');
    }
  }

  console.log(`\n${toquen} per corregir.${!fes && toquen ? ` Per desar-ho: node scripts/revisaDissabtes.mjs ${semana} --fes\n` : '\n'}`);
}

main().catch((e) => console.error('\nHa petat:', e.message)).finally(() => prisma.$disconnect());
