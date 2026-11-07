/** A request for an invented Arnall schedule must finish with the template artifact. */
export function requiresFictionalScheduleArtifact(companySlug: string | undefined, message: string): boolean {
  if (companySlug !== "arnall") return false;
  const normalized = message.normalize("NFD").replace(/[\u0300-\u036f]/gu, "").toLocaleLowerCase();
  const fiction = /\b(?:fictici(?:a|es|s)?|ficticio(?:s)?|fictitious|inventad[oa]s?|simulacio|simulacion|demo)\b/gu;
  const requestedSimulation = [...normalized.matchAll(fiction)].some((match) => {
    const preceding = normalized.slice(0, match.index).split(/[.!?;,\n]/u).at(-1) ?? "";
    // "No amplíes mínimos ficticios" or "sense dades fictícies" describes a
    // real-data boundary, not a request to create an invented schedule.
    return !/\b(?:no|sin|sense|mai|nunca|never|without|not)\b[^.!?;,\n]*$/u.test(preceding);
  });
  if (!requestedSimulation) return false;
  // The action must target a schedule, not merely coexist with a mention of
  // schedules elsewhere (for example, a guide's fictional employee/shop setup).
  const requests = normalized.matchAll(/\b(?:fes|feu|haz|haced|genera(?:r|d)?|crea(?:r|d)?|prepara(?:r|d)?|mostra|muestra|create|generate|prepare)\b([^.!?;\n]{0,160}?)\b(?:horari|horario|schedule|quadrant|cuadrante)s?\b/gu);
  return [...requests].some((match) => {
    const preceding = normalized.slice(0, match.index).split(/[.!?;,\n]/u).at(-1) ?? "";
    if (/\b(?:no|sin|sense|mai|nunca|never|without|not|com|como|how)\b[^.!?;,\n]*$/u.test(preceding)) return false;
    return !/\b(?:alta|altes|fitxa|fitxes|ficha|fichas|guia|guide|manual|documentacio|documentacion|regla|regles|reglas|rule|rules|treballador|treballadors|empleat|empleats|empleado|empleados|employee|employees|botiga|botigues|tienda|tiendas|shop|shops|absence|absencia|ausencia)\b/u.test(match[1]);
  });
}
