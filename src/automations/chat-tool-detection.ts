/**
 * App Server fixes dynamic tools when a private thread is created.  This
 * deliberately narrow detector lets the chat route re-bootstrap a legacy
 * thread before a scheduling request reaches the model, without discarding
 * normal conversation continuity after every product upgrade.
 */
export function needsAutomationChatTools(message: string, includeConfirmation = true) {
  const normalized = message.trim();
  if (!normalized) return false;
  if (includeConfirmation && /^(?:confirmo|confirmar|confírmala|confirmala|adelante|créala|creala|actívala|activala)(?:\b|[,.!;:]|$)/iu.test(normalized)) {
    return true;
  }
  return /\b(?:automatiz(?:a|ación|acion|aciones|ar)|automations?|recordatorios?|recordarme|recordarnos|reminder|recuérdame|recuerdame|avísame|avisame|prográmame|programame|program(?:ad[oa]s?|a(?:r)?)|schedule|automatismos)\b/iu.test(normalized) ||
    /\b(?:cada|todos?\s+los?|every)\b.{0,80}\b(?:minutos?|horas?|días?|dias?|mes(?:es)?|trimestres?|años?|semanas?|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo|day|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/iu.test(normalized) ||
    /\b(?:dentro\s+de|en)\s+\d{1,4}\s+(?:minutos?|horas?|minutes?|hours?)\b/iu.test(normalized);
}
