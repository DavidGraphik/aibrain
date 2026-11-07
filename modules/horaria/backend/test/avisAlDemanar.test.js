import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { avisAlDemanar } from '../src/services/saturdayRotation.js';

const va = (turno, semana = '2026-W33') => ({ semana, turno, dia: 'SABADO' });

describe('avisar el treballador quan el dissabte que demana trenca l\'alternança', () => {
  test('va fer matí i demana matí: se li avisa', () => {
    // El cas que motiva tot això. Fins ara se li concedia i l'alternança es
    // trencava sense que ho sabés ni ell ni l'encarregada.
    const avis = avisAlDemanar({ demanat: 'MANANA', ultim: va('MANANA'), idioma: 'ca' });
    assert.ok(avis, 'hauria d\'avisar');
    assert.match(avis, /matí/);
    assert.match(avis, /tarda/);      // el que li tocaria
    assert.match(avis, /dia/);        // l'altra opció permesa
  });

  test('va fer matí i demana tarda: no hi ha res a dir', () => {
    assert.equal(avisAlDemanar({ demanat: 'TARDE', ultim: va('MANANA') }), null);
  });

  test('va fer partit i demana matí: tampoc, que és el que toca', () => {
    assert.equal(avisAlDemanar({ demanat: 'MANANA', ultim: va('PARTIDO') }), null);
  });

  test('va fer partit i demana tarda: se li avisa, que després del partit va matí', () => {
    const avis = avisAlDemanar({ demanat: 'TARDE', ultim: va('PARTIDO'), idioma: 'ca' });
    assert.ok(avis);
    assert.match(avis, /matí/);
  });

  test('qui no ha treballat cap dissabte pot demanar el que vulgui', () => {
    // A qui acaba d'entrar no se li pot dir que li «toca» res.
    assert.equal(avisAlDemanar({ demanat: 'MANANA', ultim: null }), null);
  });

  test('demanar el dissabte lliure no és cap trencament', () => {
    assert.equal(avisAlDemanar({ demanat: 'LIBRE', ultim: va('MANANA') }), null);
  });

  test('no avisa de res si no demana cap torn', () => {
    assert.equal(avisAlDemanar({ demanat: null, ultim: va('MANANA') }), null);
  });

  test('parla en l\'idioma del treballador', () => {
    const ultim = va('MANANA');
    assert.match(avisAlDemanar({ demanat: 'MANANA', ultim, idioma: 'es' }), /mañana|tarde/);
    assert.match(avisAlDemanar({ demanat: 'MANANA', ultim, idioma: 'en' }), /morning|afternoon/);
  });

  test('un idioma que no coneixem no el deixa sense resposta', () => {
    // El bot accepta tres idiomes; si algun dia n'arriba un altre, val més una
    // frase en català que cap frase.
    const avis = avisAlDemanar({ demanat: 'MANANA', ultim: va('MANANA'), idioma: 'fr' });
    assert.ok(avis);
    assert.match(avis, /dissabte/);
  });

  test('pregunta, no prohibeix', () => {
    // La decisió és de l'encarregada. Un bot que digui no en sec genera «el bot
    // no em deixa», que li arriba igualment a ella però sense la informació.
    const avis = avisAlDemanar({ demanat: 'MANANA', ultim: va('MANANA'), idioma: 'ca' });
    assert.match(avis, /Vols que/);
    assert.match(avis, /encarregada/);
  });
});
