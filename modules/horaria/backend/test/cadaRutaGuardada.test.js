import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// ─────────────────────────────────────────────
// QUE NO EN QUEDI CAP DE DESTAPADA
//
// Aquesta prova no comprova cap regla: comprova que la regla estigui posada a
// tot arreu. Repassant les rutes a mà en vaig tapar vint-i-tres i me'n vaig
// deixar sis, i entre les sis hi havia /whatsapp/broadcast — o sigui que una
// encarregada podia enviar WhatsApp als treballadors de l'altra botiga.
// Repassar-ho a mà no serveix: el que falla no és la regla, és recordar
// posar-la la pròxima vegada que algú afegeixi una ruta.
//
// La comprovació: si el que atén la petició llegeix una botiga del cos o de la
// query, algú ha de comprovar que qui truca hi pugui entrar. O bé la porta
// (requireEstablishmentAccess / requireEstablishmentParam), o bé el mateix
// controlador cridant potAccedirABotiga. Si no ho fa cap dels dos, la ruta ha
// de ser en aquesta llista, dient per què.
//
// La primera versió d'aquesta prova tenia dos forats que la deixaven passar
// amb rutes destapades de veritat, i els comentaris de sota diuen quins: una
// prova que diu «ja no caldrà mirar-s'ho» ha de guanyar-s'ho.
// ─────────────────────────────────────────────

const PERDONADES = {
  'POST /mock/reset':
    'Només respon amb el mode de proves engegat; en producció retorna 403 abans de mirar res.',
};

const ARREL = path.join(import.meta.dirname, '..', 'src');
const DIR_RUTES = path.join(ARREL, 'routes');
const DIR_CONTROLADORS = path.join(ARREL, 'controllers');

/** Llegeix la botiga de la petició? Els controladors la treuen desestructurant. */
const LLEGEIX_BOTIGA = new RegExp(
  String.raw`const \{[^}]*\bestablecimiento(Id)?\b[^}]*\} = req\??\.(query|body)`
  + String.raw`|req\??\.(query|body|params)\??\.establecimiento(Id)?\b`
  + String.raw`|req\??\.params\??\.establishmentId\b`,
);

/**
 * `fitxer.js:nom` -> cos de la funció.
 *
 * La clau porta el fitxer perquè `getAll`, `create` i `update` existeixen tant
 * a employees.js com a establishments.js. Indexant només pel nom es quedava
 * amb el primer per ordre alfabètic, o sigui que les rutes d'establishments.js
 * es comprovaven contra el codi d'employees.js: una ruta d'establiments que
 * llegís una botiga sense mirar-la hauria passat desapercebuda.
 */
function totsElsControladors() {
  const trobats = new Map();
  for (const fitxer of fs.readdirSync(DIR_CONTROLADORS).filter((f) => f.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(DIR_CONTROLADORS, fitxer), 'utf8');
    // Les definicions de dalt de tot comencen a la columna 0; el cos va d'una
    // definició a la següent, que ja és prou per saber què llegeix.
    const inicis = [...text.matchAll(
      /^(?:export )?(?:async )?function (\w+)|^(?:export )?const (\w+) = (?:async )?\(/gm,
    )];
    inicis.forEach((m, i) => {
      const nom = m[1] || m[2];
      const fi = i + 1 < inicis.length ? inicis[i + 1].index : text.length;
      trobats.set(`${fitxer}:${nom}`, text.slice(m.index, fi));
    });
  }
  return trobats;
}

/** Nom importat -> fitxer de controlador d'on ve, per a un fitxer de rutes. */
function controladorsImportats(text) {
  const dequi = new Map();
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'[^']*controllers\/([\w.]+)'/g)) {
    for (const cru of m[1].split(',')) {
      const nom = cru.trim().split(/\s+as\s+/).pop().trim();
      if (nom) dequi.set(nom, m[2]);
    }
  }
  return dequi;
}

/**
 * Cada `router.verb(...)` sencer, encara que ocupi diverses línies.
 *
 * La primera versió tallava al primer salt de línia. Com que avui totes les
 * rutes hi caben, semblava que anava bé; però una ruta escrita amb cada peça a
 * la seva línia —cosa normal quan la línia s'allarga— quedava reduïda a una
 * coma: no s'hi trobava ni la porta ni el controlador, i se saltava en silenci.
 * La prova hauria donat verd amb una ruta destapada de debò.
 */
function definicionsDeRuta(text) {
  const fora = [];
  for (const m of text.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']*)'/g)) {
    let i = m.index + m[0].length;
    let nivell = 1;         // el parèntesi de router.verb( ja compta
    let cometa = null;
    while (i < text.length && nivell > 0) {
      const c = text[i];
      if (cometa) {
        if (c === '\\') i++;
        else if (c === cometa) cometa = null;
      } else if (c === "'" || c === '"' || c === '`') cometa = c;
      else if (c === '(') nivell++;
      else if (c === ')') nivell--;
      i++;
    }
    assert.equal(nivell, 0, `parèntesis desequilibrats a ${m[1]} ${m[2]}`);
    fora.push({
      etiqueta: `${m[1].toUpperCase()} ${m[2]}`,
      cadena: text.slice(m.index + m[0].length, i),
    });
  }
  return fora;
}

describe('cap ruta que toqui una botiga sense comprovar-ho', () => {
  const controladors = totsElsControladors();

  test('totes les rutes o bé la comproven o bé consten a la llista', () => {
    const destapades = [];

    for (const fitxer of fs.readdirSync(DIR_RUTES).filter((f) => f.endsWith('.js'))) {
      const text = fs.readFileSync(path.join(DIR_RUTES, fitxer), 'utf8');
      const dequi = controladorsImportats(text);

      for (const { etiqueta, cadena } of definicionsDeRuta(text)) {
        if (PERDONADES[etiqueta]) continue;
        if (/requireEstablishment(Access|Param)/.test(cadena)) continue;

        // Qui atén: l'últim nom de la cadena que vingui d'un controlador. Si no
        // n'hi ha cap, la ruta és de middleware sol (soloPost i companyia) i no
        // hi ha cap cos on mirar.
        const noms = [...cadena.matchAll(/\b(\w+)\b/g)].map((x) => x[1]);
        const qui = noms.reverse().find((n) => dequi.has(n));
        if (!qui) continue;

        const clau = `${dequi.get(qui)}:${qui}`;
        const cos = controladors.get(clau);
        assert.ok(cos, `${etiqueta}: no trobo ${clau}; el lector de controladors s'ha quedat curt`);

        if (!LLEGEIX_BOTIGA.test(cos)) continue;
        if (cos.includes('potAccedirABotiga')) continue;

        destapades.push(`${etiqueta}  (${fitxer} → ${clau})`);
      }
    }

    assert.deepEqual(destapades, [],
      'Aquestes rutes llegeixen una botiga i ningú comprova que qui truca hi pugui entrar:\n  '
      + destapades.join('\n  '));
  });

  // A /publish la botiga viatja dins d'un multipart, i el cos de la petició és
  // buit fins que multer no l'ha llegit. Amb la porta al davant, com a totes
  // les altres, no hi trobava cap botiga i tancava: 403 a l'encarregada just
  // en publicar l'horari. Va sortir provant-ho, no revisant-ho.
  test('a /publish la porta va després de llegir el fitxer', () => {
    const text = fs.readFileSync(path.join(DIR_RUTES, 'schedules.js'), 'utf8');
    const ruta = definicionsDeRuta(text).find((r) => r.etiqueta === 'POST /publish');
    assert.ok(ruta, 'ja no hi ha la ruta /publish');
    assert.ok(
      ruta.cadena.indexOf('uploadPdf') < ruta.cadena.indexOf('requireEstablishmentAccess'),
      'la porta ha d\'anar darrere d\'uploadPdf: abans el cos encara és buit i dona 403',
    );
  });

  test('la llista de perdonades no es queda amb rutes que ja no existeixen', () => {
    const totes = new Set();
    for (const fitxer of fs.readdirSync(DIR_RUTES).filter((f) => f.endsWith('.js'))) {
      const text = fs.readFileSync(path.join(DIR_RUTES, fitxer), 'utf8');
      for (const { etiqueta } of definicionsDeRuta(text)) totes.add(etiqueta);
    }
    for (const perdonada of Object.keys(PERDONADES)) {
      assert.ok(totes.has(perdonada), `${perdonada} ja no existeix: treu-la de PERDONADES`);
    }
  });
});
