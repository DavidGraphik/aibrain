// Verified against the Trinalum commercial list on 2026-09-28.
export const commercialFields = ['estado','segmentos','responsables','fecha_ultima_accion','ultima_accion','fecha_proxima_accion','proxima_accion','estado_original','actividad','observaciones','contacto_principal','email_principal','fuente','owner','historial_importado'];
export function normalizeCommercialValues(input) {
  const aliases = {responsable:'owner',proxima_accion_fecha:'fecha_proxima_accion',ultima_accion_fecha:'fecha_ultima_accion'};
  const result = {};
  for (const [key,value] of Object.entries(input)) {
    const canonical = aliases[key] ?? key;
    if (!commercialFields.includes(canonical)) throw new Error(`Unknown commercial field ${key}; supported: ${commercialFields.join(', ')}`);
    if (canonical in result && JSON.stringify(result[canonical]) !== JSON.stringify(value)) throw new Error(`Conflicting values for ${canonical}`);
    if (canonical.startsWith('fecha_') && value != null && value !== '' && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10)!==value)) throw new Error(`${canonical} must be a real YYYY-MM-DD date`);
    result[canonical] = value;
  }
  return result;
}
