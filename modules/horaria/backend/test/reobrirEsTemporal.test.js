import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// El cas del 19 d'agost: la Núria Bachs va acabar de donar preferències, es van
// desar, i després va escriure «Igualment». Aquell missatge va reobrir la
// conversa i la va deixar oberta per sempre. Constava com a pendent tota la
// setmana amb les seves dades desades.
//
// El primer arreglo desfeia la reobertura al final de la funció, i el revisor
// va trobar que hi havia SET sortides que no hi passaven. L'arreglo bo és no
// escriure-la: reobrir és una cosa d'aquesta petició, no un canvi d'estat.
const FONT = readFileSync(new URL('../src/services/whatsapp.js', import.meta.url), 'utf8');

// El tros que va de la reobertura fins al final de la funció.
//
// Els dos límits han de sortir UNA sola vegada. Si algun es dupliqués —un
// comentari copiat a una altra funció, per exemple— el tall aniria a parar a un
// altre lloc i les proves de sota comprovarien un fragment que no és aquest,
// passant en verd sense mirar res. És la manera com aquesta mena de proves
// menteixen, i per això es comprova abans de fer-les servir.
const compta = (t) => FONT.split(t).length - 1;
const MARCA_INICI = 'Dins de la finestra per rectificar';
const MARCA_FI = 'return { handled: true, completed: preferencesCompleted }';
const INICI = FONT.indexOf(MARCA_INICI);
const FI = FONT.indexOf(MARCA_FI);
const TROS = FONT.slice(INICI, FI);

describe('reobrir per rectificar no canvia l\'estat desat', () => {
  test('el tros que es mira existeix, és únic i té sentit', () => {
    // Si això falla, les proves de sota miren un fragment equivocat.
    assert.ok(INICI > 0 && FI > INICI, 'no s\'ha trobat el tram de la reobertura');
    assert.equal(compta(MARCA_INICI), 1, 'el començament del tram surt més d\'un cop: el tall no és fiable');
    assert.equal(compta(MARCA_FI), 1, 'el final del tram surt més d\'un cop: el tall no és fiable');
    assert.ok(TROS.includes('reabiertaParaEditar = true'), 'el tram no conté la reobertura');
    assert.ok(TROS.length > 500, 'el tram és sospitosament curt');
  });

  test('no s\'escriu EN_PROGRESO a la base de dades en reobrir', () => {
    // Aquesta és LA prova. Si algú torna a escriure-ho, la conversa es tornarà
    // a quedar oberta per qualsevol de les set sortides de la funció.
    assert.doesNotMatch(TROS, /estado: 'EN_PROGRESO'/);
    assert.doesNotMatch(TROS, /completedAt: null/);
  });

  test('només es canvia en memòria, per a aquesta petició', () => {
    assert.match(TROS, /conv\.estado = 'EN_PROGRESO';/);
  });

  test('i qui rectifica de debò sí que queda desat amb la data d\'ara', () => {
    // El camí de desar continua marcant-la acabada amb la data nova.
    assert.match(TROS, /estado: 'COMPLETADO',\s*\n\s*completedAt: new Date\(\)/);
  });
});
