// ─────────────────────────────────────────────
// WHAT META ACTUALLY SAID
//
// Publishing catches a failed notification so that a WhatsApp problem never
// costs you the publish. What it then told the manager was "No s'ha pogut
// enviar el PDF a l'encarregat" — the same eleven words whether the number was
// wrong, the token had expired, or the message was refused for a reason with a
// documented fix.
//
// It cost a day: the schedule for Girona never reached Neus Sala, and the
// screen gave no way to tell that from a typo in her number. Meta had said
// exactly why, in the response body, and we threw it away.
//
// So: keep the raw text for the logs, and put one plain sentence on screen.
// ─────────────────────────────────────────────

// Meta's numeric codes, and what to do about each.
const CODIS = [
  {
    codi: 131047,
    // The one that bit us. Free-form messages — including a document — are only
    // delivered within 24h of the recipient's last message to us.
    missatge: 'Fa més de 24 hores que aquesta persona no us escriu, i WhatsApp només deixa enviar missatges lliures dins d\'aquesta finestra. Cal una plantilla aprovada (variable WHATSAPP_TEMPLATE_HORARIO).',
  },
  { codi: 131026, missatge: 'El número no té WhatsApp o no pot rebre missatges.' },
  { codi: 131030, missatge: 'El número no és a la llista de destinataris permesos del compte de proves de Meta.' },
  { codi: 132001, missatge: 'La plantilla no existeix o no està aprovada amb aquest nom i idioma.' },
  { codi: 132000, missatge: 'La plantilla espera un nombre de variables diferent del que li enviem.' },
  { codi: 133010, missatge: 'El número de telèfon de l\'empresa no està registrat a WhatsApp.' },
  { codi: 190, missatge: 'El token de WhatsApp ha caducat o s\'ha revocat. Cal renovar-lo a Render.' },
  { codi: 100, missatge: 'Meta ha rebutjat la petició per un paràmetre incorrecte.' },
];

const PER_TEXT = [
  { re: /media|document|link/i, missatge: 'WhatsApp no ha pogut descarregar el PDF des del servidor.' },
  { re: /rate limit|too many/i, missatge: 'Massa enviaments seguits: WhatsApp ha limitat el ritme. Torna-ho a provar d\'aquí una estona.' },
  { re: /timeout|ETIMEDOUT|ENOTFOUND|fetch failed/i, missatge: 'No s\'ha pogut contactar amb WhatsApp. Pot ser cosa de xarxa; torna-ho a provar.' },
];

/**
 * One sentence a shop manager can act on, from whatever the API threw.
 *
 * Returns null when we genuinely cannot tell — better silence than a confident
 * wrong explanation, since the raw error is in the logs either way.
 */
export function explicaErrorWhatsapp(text) {
  const s = String(text || '');
  if (!s) return null;

  // Meta puts the code in a JSON body we carry along inside the message.
  for (const { codi, missatge } of CODIS) {
    if (new RegExp(`"code"\\s*:\\s*${codi}\\b`).test(s) || new RegExp(`\\b(?:error|code)[^\\d]{0,12}${codi}\\b`, 'i').test(s)) {
      return missatge;
    }
  }
  for (const { re, missatge } of PER_TEXT) {
    if (re.test(s)) return missatge;
  }
  if (/\b401\b|unauthor/i.test(s)) return 'WhatsApp ha rebutjat les credencials. Comprova el token a Render.';
  if (/\b403\b/.test(s)) return 'WhatsApp ha denegat el permís per enviar aquest missatge.';
  return null;
}
