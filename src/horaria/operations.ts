/** Fixed internal endpoints; the model never chooses a host, URL or identity. */
export type Operation = { method: "GET" | "POST" | "PUT" | "DELETE"; path: string; effect: "read" | "draft" | "write" | "ai" | "delivery"; fields?: string };
export const OPERATIONS: Record<string, Operation> = {
  status: { method: "GET", path: "/api/session", effect: "read" },
  "workflow.readiness": { method: "GET", path: "/api/integration/readiness", effect: "read", fields: "query: establecimiento (required). Read-only per-shop configuration blockers for availability collection, automation and PDF delivery, missing contacts and next collection window. configurationReady does not prove delivery, a reply or the reviewed-Excel return workflow." },
  preview: { method: "GET", path: "/api/integration/preview", effect: "read", fields: "query: semana (YYYY-Www), establecimiento" },
};
const add = (name: string, method: Operation["method"], path: string, effect: Operation["effect"], fields?: string) => { OPERATIONS[name] = { method, path: `/api/${path}`, effect, fields }; };
for (const resource of ["employees", "establishments", "absences", "rules", "free-rules"]) {
  add(`${resource}.list`, "GET", resource, "read", "query: establecimiento; absences also year, empleado");
  add(`${resource}.create`, "POST", resource, "write");
  add(`${resource}.update`, "PUT", `${resource}/:id`, "write");
  if (resource !== "establishments") add(`${resource}.delete`, "DELETE", `${resource}/:id`, "write");
}
add("employees.get", "GET", "employees/:id", "read");
add("employees.import", "POST", "employees/import", "write", "body: establecimientoId, empleados[]");
add("employees.allowed-shops", "PUT", "employees/:id/allowed-establishments", "write", "body: establishmentIds[]");
add("employees.translate-conditions", "POST", "employees/:id/condicions/tradueix", "ai", "body: texto; translates only, does not save");
add("establishments.get", "GET", "establishments/:id", "read");
for (const name of ["week", "balance", "municipis"]) add(`absences.${name}`, "GET", `absences/${name}`, "read");
add("absences.import-holidays", "POST", "absences/import-holidays", "write", "body: establecimientoId, year; calls official holiday data provider");
add("preferences.list", "GET", "preferences", "read", "query: semana, establecimiento");
add("preferences.sheets", "GET", "preferences/sheets", "read", "query: semana, establecimiento");
add("collection.template", "GET", "integration/collection-template", "read", "query: semana, establecimiento. Attach a blank availability Excel and return a WhatsApp reply template and seven-day form schema; no messages or business writes.");
add("collection.export", "GET", "integration/collection-export", "read", "query: semana, establecimiento. Attach the authorized shop's received preferences and pending responses as Excel; unknown days remain SIN_INDICAR.");
add("collection.preview", "POST", "integration/collection-preview", "draft", "body: establecimientoId, semana, responses: [{employeeId, week, source: WHATSAPP|FORMULARIO, days:{LUNES..DOMINGO: MANANA|TARDE|AMBOS|NO_DISPONIBLE|SIN_INDICAR}, notes}]. Validate and attach Excel, never apply preferences or send messages. Employee identity/source require review before saving.");
add("preferences.update", "PUT", "preferences/:id", "write", "id=empleadoId; body: semana (YYYY-Www), turnoPreferido=MANANA|TARDE|PARTIDO|LIBRE|null (null means no preference; never FLEXIBLE), diasNoDisponible=[LUNES..DOMINGO], turnosPorDia={MIERCOLES:TARDE,...}, notasAdicionales. Put day-specific availability in turnosPorDia, never only in notes. Unavailable whole days go in diasNoDisponible; a day cannot simultaneously require a working shift. Omitted fields are preserved, explicit [] or {} clears them. maxHorasSemana and flexible belong to employees.update, never to this operation. Read preferences.list after saving to verify every day restriction.");
add("preferences.upload-sheet", "POST", "preferences/sheets", "ai", "uploadPath: authorized project image; body: semana");
add("schedules.list", "GET", "schedules", "read", "query: semana, establecimiento");
for (const name of ["conflicts", "other-hours", "fairness", "edit-patterns", "correcciones", "historial", "report", "intensity", "closed-days"]) add(`schedules.${name}`, "GET", `schedules/${name}`, "read", "query: semana, establecimiento");
add("schedules.create", "POST", "schedules", "write", "body: empleadoId, establecimientoId, semana, dia, turno");
add("schedules.update", "PUT", "schedules/:id", "write", "body: turno and correction reason as required by service");
add("schedules.generate", "POST", "schedules/generate-async", "ai", "Only when explicitly asked to save or replace business schedules; requires confirmation. For ordinary schedule preparation use schedules.draft instead. body: establecimientoId, semana, quality=standard|high. Poll job then show preview.");
add("schedules.draft", "POST", "integration/draft", "draft", "Generate and attach a non-persisted draft immediately, no confirmation. body: establecimientoId, semana, quality=standard|high, requests?: [{employeeId, daysOff?: [LUNES..DOMINGO], shiftsByDay?: {LUNES: MANANA|TARDE, ...} (only available for that half; a free day is allowed), requiredShiftsByDay?: {MIERCOLES: TARDE, ...} (explicitly assign that shift; a free day is NOT fulfillment), noSplit?: boolean, maxHours?: number, absences?: {JUEVES: VACACIONES|BAJA_MEDICA, ...}}]. Use real employee IDs from employees.list. Only include restrictions explicitly requested, never invented ones. coverage?: {minDependientasManana, minDependientasTarde, minElaboracionManana, minElaboracionTarde}, each an integer 0..99: temporary weekly minimum targets explicitly requested, without rules.create. Stricter saved minima and all saved maxima still apply. Returns Excel preview and review of the final grid; never saves or sends business data.");
add("schedules.generation-status", "GET", "schedules/generate-status/:id", "read");
add("schedules.intensity-set", "POST", "schedules/intensity", "write", "body: establecimientoId, semana, intensidad");
add("schedules.correction-reason", "POST", "schedules/correcciones", "write");
add("schedules.publish", "POST", "integration/publish", "delivery", "body: establecimientoId, semana, previewHash (from latest preview); canonical PDF generated by server");
add("schedules.review-upload", "POST", "integration/reviewed-excel", "draft", "uploadPath: corrected .xlsx from this project's authorized attachments; body: establecimientoId, sourceId (from the original draft/preview), recipientEmployeeId?: number (general manager only, exclusively when the user explicitly designates a recipient, such as a limited test), deliveryFormat?: pdf (default) | xlsx (only if explicitly requested). Store the exact returned workbook and generate a PDF from its original print layout, validate against the original, show changes, PDF hash, recipient and previewHash. Never provide a PDF path or hash yourself; conversion is server-side. Never regenerate or save shifts. No messages are sent.");
add("schedules.reviewed-status", "GET", "integration/reviewed-excel/:id", "read", "id: reviewId; query: establecimiento. Read the preserved file hash, reviewed recipient and delivery receipt. An uncertain send must not be retried.");
add("schedules.reviewed-send", "POST", "integration/reviewed-excel-send", "delivery", "body: establecimientoId, reviewId, sha256, previewHash from schedules.review-upload. After reviewing and explicit confirmation, send the preserved PDF derived from the corrected Excel using the approved document template; no recent inbound reply is required for PDF. The optional xlsx format and old XLSX receipts still require a recent inbound reply. Never call schedules.publish or regenerate from saved shifts. Check status on uncertainty.");
add("summary", "GET", "summary", "read", "query: semana, establecimiento");
add("settings.get", "GET", "ajustes", "read", "query: establecimiento");
add("settings.update", "PUT", "ajustes", "write", "body: establecimientoId, valores. Includes automatic WhatsApp collection/reminder windows.");
for (const name of ["status", "conversation", "config-check"]) add(`whatsapp.${name}`, "GET", `whatsapp/${name}`, "read", "query: establecimiento, semana; conversation uses telefono");
for (const name of ["broadcast", "reminders", "unblock"]) add(`whatsapp.${name}`, "POST", `whatsapp/${name}`, "delivery", "body: establecimientoId, semana; unblock uses telefono");
OPERATIONS["whatsapp.broadcast"].fields = "body: establecimientoId, semana, employeeIds?: number[]. When the user selects one person or a limited group, ALWAYS pass their exact IDs from employees.list; never omit employeeIds for a limited test. The service verifies every selected person belongs to this shop and is active with a phone. No reset unless explicitly authorized. Never send to others.";
OPERATIONS["whatsapp.reminders"].fields = "body: establecimientoId, semana, employeeIds?: number[]. ALWAYS include exact employeeIds for a limited test or selected recipients. Skips completed, expired and recently reminded conversations. Does not send to other employees.";
OPERATIONS["whatsapp.config-check"].fields = "Read-only actual provider template names, language, approval status, body-variable count and document-header type, plus configured bindings and automatic/manager notification switches. Check this before recommending names/variables or claiming readiness. Configuration alone does not prove delivery.";

export type OperationInput = { operation: string; id?: string; query?: Record<string, string | number | boolean>; body?: Record<string, unknown>; uploadPath?: string };
export function resolveOperation(input: OperationInput) {
  const operation = Object.hasOwn(OPERATIONS, input.operation) ? OPERATIONS[input.operation] : null;
  if (!operation) throw new Error("Operación de horarios desconocida.");
  let target = operation.path;
  if (target.includes(":id")) {
    if (!input.id || !/^[A-Za-z0-9_-]{1,100}$/.test(input.id)) throw new Error("Falta un identificador válido.");
    target = target.replace(":id", encodeURIComponent(input.id));
  } else if (input.id !== undefined) throw new Error("Esta operación no admite un identificador.");
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (!["semana", "establecimiento", "year", "empleado", "rol", "telefono", "limit", "comunidad", "q"].includes(key) || !["string", "number", "boolean"].includes(typeof value) || String(value).length > 200) throw new Error("Filtro de horarios no válido.");
    query.set(key, String(value));
  }
  if (operation.method === "GET" && (input.body || input.uploadPath)) throw new Error("Una consulta no admite datos de escritura.");
  if (input.uploadPath && !["preferences.upload-sheet", "schedules.review-upload"].includes(input.operation)) throw new Error("Archivo no admitido.");
  if (input.operation === "schedules.review-upload" && !input.uploadPath) throw new Error("Adjunta el Excel corregido.");
  return { ...operation, target: `${target}${query.size ? `?${query}` : ""}` };
}

// Request fields from the imported controllers (not arbitrary database columns).
const employeeFields = "body: nombre, apellidos (required for create), email, telefonoWhatsapp, rol=EMPLEADO|MANAGER_LOCAL|MANAGER_GENERAL, funcion=DEPENDIENTA|ELABORACION, establecimientoId, flexible, activo (update), maxHorasSemana, disponibilidad (object {LUNES:{M:true,T:true}, ... through DOMINGO}, never prose; false means unavailable, null means fully available; include all seven days when explicitly supplied), condicionesFijas, condicionesEstructuradas (update), horasPorTurno, horaEntradaManana, horaEntradaTarde. IDs are numbers in body. Read back saved fields before claiming the requested restrictions were applied.";
OPERATIONS["employees.create"].fields = employeeFields;
OPERATIONS["employees.update"].fields = employeeFields;
for (const verb of ["create", "update"]) {
  OPERATIONS[`establishments.${verb}`].fields = "body: nombre, direccion, managerLocalId, horarioApertura, horarioCierre, cierraMediodia, inicioCierreMediodia, finCierreMediodia, diasApertura, cierraFestivos, comunidadAutonoma, municipiCodi, municipiNom, activo (update)";
  OPERATIONS[`absences.${verb}`].fields = "body: tipo=VACACIONES|BAJA_MEDICA|FESTIVO, fechaInicio, fechaFin, empleadoId, establecimientoId, notas, estado=PENDIENTE|APROBADO|RECHAZADO. Read current records for field formats.";
  OPERATIONS[`free-rules.${verb}`].fields = "body: establecimientoId (create), texto";
  OPERATIONS[`rules.${verb}`].fields = "Read rules.list first. Supply the edited coverage/maximum fields using the existing record's keys; establecimientoId required for create.";
}
