import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tocaRecordar, finestraPeticions, HORES_ABANS_DE_RECORDAR } from '../src/services/whatsapp.js';

const h = (n) => n * 60 * 60 * 1000;

describe('quan toca enviar el recordatori', () => {
  // La finestra de sèrie: obre diumenge a les 09:00, tanca dimecres a les 13:00.
  const { obre, tanca } = finestraPeticions('2026-W34');

  test('acabada d\'obrir, encara no', () => {
    // Amb el batec cada hora, aquest és el cas de la immensa majoria de crides:
    // ha de dir que no i no fer res.
    assert.equal(tocaRecordar(obre, tanca), false);
  });

  test('a mig camí, tampoc', () => {
    const mig = new Date((obre.getTime() + tanca.getTime()) / 2);
    assert.equal(tocaRecordar(mig, tanca), false);
  });

  test('el dia abans de tancar, sí', () => {
    assert.equal(tocaRecordar(new Date(tanca.getTime() - h(23)), tanca), true);
  });

  test('just al límit de les 24 h, sí', () => {
    assert.equal(tocaRecordar(new Date(tanca.getTime() - h(HORES_ABANS_DE_RECORDAR)), tanca), true);
  });

  test('una hora abans del límit, encara no', () => {
    assert.equal(tocaRecordar(new Date(tanca.getTime() - h(25)), tanca), false);
  });

  test('passat el termini, no: ja no serveix de res', () => {
    // Recordar-li que contesti quan ja no pot contestar només fa quedar
    // malament el sistema.
    assert.equal(tocaRecordar(new Date(tanca.getTime() + h(1)), tanca), false);
  });

  test('la finestra mana: si es mou, el recordatori es mou sol', () => {
    // El motiu de tot plegat. Amb la finestra tancant-se divendres a les 18:00,
    // el recordatori ha de sortir dijous a la tarda sense tocar cap cron.
    const altra = finestraPeticions('2026-W34', {
      obreDia: 1, obreHora: 9, tancaDia: 5, tancaHora: 18,
    });
    assert.equal(tocaRecordar(new Date(altra.tanca.getTime() - h(20)), altra.tanca), true);
    // I la mateixa hora que abans era «toca» ara encara no ho és.
    assert.equal(tocaRecordar(new Date(tanca.getTime() - h(23)), altra.tanca), false);
  });
});
