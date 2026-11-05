import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { explicaErrorWhatsapp } from '../src/utils/whatsappErrors.js';

// Publishing the Girona schedule never reached Neus Sala, and the screen said
// only "no s'ha pogut enviar el PDF" — indistinguishable from a typo in her
// number. Meta had said exactly why, in a body we discarded.
describe('explicar per què WhatsApp ha fallat', () => {
  const metaError = (code, msg) =>
    `WhatsApp media error: 400 — {"error":{"message":"${msg}","type":"OAuthException","code":${code},"fbtrace_id":"Axx"}}`;

  test('el cas real: fora de la finestra de 24 hores', () => {
    const e = explicaErrorWhatsapp(metaError(131047, 'Re-engagement message'));
    assert.match(e, /24 hores/);
    assert.match(e, /WHATSAPP_TEMPLATE_HORARIO/);
  });

  test('un número sense WhatsApp no s\'explica com un problema de plantilla', () => {
    assert.match(explicaErrorWhatsapp(metaError(131026, 'Message undeliverable')), /no té WhatsApp/);
  });

  test('plantilla inexistent o no aprovada', () => {
    assert.match(explicaErrorWhatsapp(metaError(132001, 'Template name does not exist')), /no està aprovada/);
  });

  test('token caducat', () => {
    assert.match(explicaErrorWhatsapp(metaError(190, 'Access token has expired')), /token/i);
  });

  test('número de proves no autoritzat', () => {
    assert.match(explicaErrorWhatsapp(metaError(131030, 'Recipient not in allowed list')), /llista de destinataris/);
  });

  test('quan no és de Meta, es mira el text', () => {
    assert.match(explicaErrorWhatsapp('fetch failed: ETIMEDOUT'), /No s'ha pogut contactar/);
    assert.match(explicaErrorWhatsapp('WhatsApp API error: 401 — Unauthorized'), /credencials/);
    assert.match(explicaErrorWhatsapp('Could not retrieve the media from the link'), /descarregar el PDF/);
  });

  // Silence beats a confident wrong explanation: the raw error is in the logs.
  test('si no ho sap, calla', () => {
    assert.equal(explicaErrorWhatsapp('Boom'), null);
    assert.equal(explicaErrorWhatsapp(''), null);
    assert.equal(explicaErrorWhatsapp(null), null);
  });

  test('no confon un codi amb un número qualsevol del missatge', () => {
    assert.equal(explicaErrorWhatsapp('S\'han enviat 131047 bytes correctament'), null);
  });
});
