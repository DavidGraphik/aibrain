import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { finestraPeticions, computeDeadline, setmanaEnFinestra, FINESTRA_DEFECTE } from '../src/services/whatsapp.js';

// From Sunday at 09:00 to Wednesday at 13:00, the week before the one being
// planned — so the replies are in before the schedule is generated on the
// Thursday and published on the Friday.
describe('la finestra per enviar preferències', () => {
  const cat = (d) => d.toLocaleString('sv-SE').slice(0, 16);   // YYYY-MM-DD HH:MM, local

  test('2026-W34, que comença dilluns 17 d\'agost', () => {
    const { obre, tanca } = finestraPeticions('2026-W34');
    assert.equal(cat(obre), '2026-08-09 09:00', 'diumenge, vuit dies abans');
    assert.equal(cat(tanca), '2026-08-12 13:00', 'dimecres, cinc dies abans');
  });

  test('sempre obre abans de tancar, i dins la mateixa tirada', () => {
    for (const w of ['2026-W01', '2026-W10', '2026-W26', '2026-W35', '2026-W52']) {
      const { obre, tanca } = finestraPeticions(w);
      assert.ok(obre < tanca, `${w}: obre després de tancar`);
      const dies = (tanca - obre) / (24 * 60 * 60 * 1000);
      assert.ok(dies > 3 && dies < 4, `${w}: la finestra dura ${dies} dies`);
    }
  });

  test('obre en diumenge i tanca en dimecres', () => {
    for (const w of ['2026-W05', '2026-W20', '2026-W40']) {
      const { obre, tanca } = finestraPeticions(w);
      assert.equal(obre.getDay(), 0, `${w}: no obre en diumenge`);
      assert.equal(obre.getHours(), 9);
      assert.equal(tanca.getDay(), 3, `${w}: no tanca en dimecres`);
      assert.equal(tanca.getHours(), 13);
    }
  });

  // A window that has already shut is a broadcast nobody can answer: every
  // reply would be discarded in silence.
  test('un broadcast enviat tard no neix mort', async () => {
    const tard = new Date('2026-08-12T20:00:00');       // ja passat el dimecres 13h
    const limit = await computeDeadline('2026-W34', tard, FINESTRA_DEFECTE);
    assert.ok(limit.getTime() > tard.getTime() + 20 * 60 * 60 * 1000, 'ha de donar marge');
  });

  test('a temps, el límit és el de la finestra', async () => {
    const aviat = new Date('2026-08-09T10:00:00');
    assert.equal(cat(await computeDeadline('2026-W34', aviat, FINESTRA_DEFECTE)), '2026-08-12 13:00');
  });

  test('el canvi d\'any no la trenca', () => {
    const { obre, tanca } = finestraPeticions('2026-W01');   // dilluns 29 des. 2025
    assert.equal(cat(obre), '2025-12-21 09:00');
    assert.equal(cat(tanca), '2025-12-24 13:00');
  });
});

// La finestra ja no viu en variables del servidor: es configura des de l'app.
describe('la finestra configurada a mà', () => {
  const cat = (d) => d.toLocaleString('sv-SE').slice(0, 16);

  test('dissabte 08:00 → dimarts 18:00', () => {
    const { obre, tanca } = finestraPeticions('2026-W34', {
      obreDia: 6, obreHora: 8, tancaDia: 2, tancaHora: 18,
    });
    assert.equal(cat(obre), '2026-08-08 08:00');
    assert.equal(cat(tanca), '2026-08-11 18:00');
  });

  test('el mateix dia, obrint abans de tancar: finestra curta però vàlida', () => {
    const { obre, tanca } = finestraPeticions('2026-W34', {
      obreDia: 3, obreHora: 9, tancaDia: 3, tancaHora: 13,
    });
    assert.equal(cat(obre), '2026-08-12 09:00');
    assert.equal(cat(tanca), '2026-08-12 13:00');
  });

  // Configurada al revés, l'obertura ha de caure la setmana d'abans o la
  // finestra duraria menys que zero i no s'hi podria contestar mai.
  test("el mateix dia, obrint DESPRÉS de tancar: se'n va set dies enrere", () => {
    const { obre, tanca } = finestraPeticions('2026-W34', {
      obreDia: 3, obreHora: 18, tancaDia: 3, tancaHora: 13,
    });
    assert.ok(obre < tanca, 'no pot obrir després de tancar');
    assert.equal(cat(obre), '2026-08-05 18:00');
    assert.equal(cat(tanca), '2026-08-12 13:00');
  });
});

// Quina setmana s'està demanant, segons quan corre el cron.
//
// Això existeix perquè getNextWeek() no serveix: és «la setmana ISO d'avui més
// set dies», i diumenge més set dies és un altre diumenge, que encara pertany a
// la setmana que comença DEMÀ. Com que la finestra obre justament en diumenge,
// el cron automàtic hauria demanat cada setmana les preferències de la setmana
// que comença l'endemà — amb l'horari ja generat i publicat — i, com que aquella
// gent ja té conversa d'aquella setmana, la guarda els hauria saltat tots. Cada
// diumenge, sense enviar res i sense dir-ho.
describe('la setmana que té la finestra oberta', () => {
  const quan = (iso, hora) => new Date(`${iso}T${hora}:00`);

  test('diumenge, quan obre: la setmana de d\'aquí a vuit dies', () => {
    // Diumenge 16 d'agost → dilluns 24, que és la W35. NO la W34, que comença
    // l'endemà i que és el que donava getNextWeek().
    assert.equal(setmanaEnFinestra(quan('2026-08-16', '09:00')), '2026-W35');
  });

  test('tota la finestra apunta a la mateixa setmana', () => {
    for (const [dia, hora] of [['2026-08-16', '09:00'], ['2026-08-16', '23:59'],
      ['2026-08-17', '09:00'], ['2026-08-18', '15:30'], ['2026-08-19', '12:59']]) {
      assert.equal(setmanaEnFinestra(quan(dia, hora)), '2026-W35', `${dia} ${hora}`);
    }
  });

  test('un minut abans d\'obrir, encara no', () => {
    assert.equal(setmanaEnFinestra(quan('2026-08-16', '08:59')), null);
  });

  test('un minut després de tancar, ja no', () => {
    assert.equal(setmanaEnFinestra(quan('2026-08-19', '13:01')), null);
  });

  test('entre finestres no hi ha res a demanar', () => {
    for (const dia of ['2026-08-20', '2026-08-21', '2026-08-22']) {
      assert.equal(setmanaEnFinestra(quan(dia, '10:00')), null, dia);
    }
  });

  test('el diumenge següent ja demana la setmana següent', () => {
    assert.equal(setmanaEnFinestra(quan('2026-08-23', '09:00')), '2026-W36');
  });

  // La finestra es pot moure des d'Ajustos, i això s'ha de moure amb ella.
  test('segueix la finestra que li diguin, no uns dies comptats a mà', () => {
    const config = { obreDia: 5, obreHora: 8, tancaDia: 1, tancaHora: 20 };  // dv 08:00 → dl 20:00
    assert.equal(setmanaEnFinestra(quan('2026-08-14', '08:00'), config), '2026-W35', 'divendres, quan obre');
    assert.equal(setmanaEnFinestra(quan('2026-08-17', '20:00'), config), '2026-W35', 'dilluns, quan tanca');
    assert.equal(setmanaEnFinestra(quan('2026-08-17', '20:01'), config), null, 'un minut després');
  });

  test('el canvi d\'any tampoc la trenca', () => {
    assert.equal(setmanaEnFinestra(quan('2025-12-21', '09:00')), '2026-W01');
  });
});
