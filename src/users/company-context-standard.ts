import type { InstallationConfig } from "@/config/installation-schema";

/** Shared information architecture. Never put a customer's internal facts here. */
export const COMPANY_CONTEXT_STANDARD_VERSION = "1";
export const COMPANY_KNOWLEDGE_AREAS = [
  "company", "organization", "goals", "processes", "tools", "systems", "app",
  "communication", "automations", "projects", "support", "sources", "pending",
] as const;

const TOPICS = [
  ["company/COMPANY.md", "Empresa", "Actividad, centros, oferta, historia y vocabulario propios."],
  ["organization/PEOPLE.md", "Personas", "Personas, cargos confirmados, responsabilidades y contactos profesionales. Separar empleados, colaboradores, soporte y usuarios de prueba."],
  ["organization/DEPARTMENTS.md", "Departamentos", "Propósito, responsable, miembros, procesos y herramientas de cada departamento. Esta ficha no concede permisos."],
  ["goals/GOALS.md", "Objetivos", "Objetivo, responsable, métrica, punto de partida, meta, fecha y estado. Separar objetivos de negocio de tareas de implantación."],
  ["processes/PROCESSES.md", "Procesos", "Disparador, responsable, entradas, pasos, controles, salida y excepciones de cada procedimiento aprobado."],
  ["tools/TOOLS.md", "Herramientas", "Herramienta, finalidad, propietario y fuente de datos. Distinguir uso empresarial, configuración y conexión efectiva de la persona actual."],
  ["systems/SYSTEMS.md", "Servidores y fuentes", "Mapa funcional de servidores, unidades y fuentes autorizadas. Separar servidor de la aplicación y servidor de archivos. Sin credenciales ni endpoints administrativos restringidos."],
  ["communication/BRAND.md", "Marca", "Nombre legal y comercial, logotipos, colores, tipografía, terminología y materiales aprobados."],
  ["communication/PREFERENCES.md", "Preferencias de comunicación", "Idiomas, tono, terminología, formato de entregables y ejemplos aprobados. Las preferencias no reemplazan reglas ni permisos."],
  ["automations/AUTOMATIONS.md", "Automatizaciones", "Objetivo, propietario, audiencia, disparador, herramientas y comprobante esperado. Documentar una automatización no la activa."],
  ["projects/PROJECTS.md", "Proyectos y prioridades", "Resumen compartible, responsable, objetivo, siguiente paso y fecha. Mantener el detalle restringido en el proyecto autorizado."],
  ["support/SUPPORT.md", "Soporte", "Responsables y canales para negocio, aplicación, archivos y conectores. No inventar personas, horarios ni compromisos de servicio."],
] as const;

export function contextDocument(
  config: Readonly<InstallationConfig>, relativePath: string, title: string, body: string,
  status: "pending" | "approved" = "pending", source = "pending", checkedAt = "unknown",
) {
  // JSON scalar quoting is valid YAML and prevents names becoming metadata keys.
  return [
    "---", `id: ${JSON.stringify(`${config.companySlug}:${relativePath.replace(/\.md$/, "")}`)}`,
    `title: ${JSON.stringify(title)}`, `standard_version: ${COMPANY_CONTEXT_STANDARD_VERSION}`,
    "revision: 1", `status: ${status}`, "audience: company", "owner: pending",
    `source: ${JSON.stringify(source)}`, `checked_at: ${checkedAt}`, "review_after: pending",
    "---", `# ${title}`, "", body.trim(), "",
  ].join("\n");
}

export function standardCompanyContextTemplates(config: Readonly<InstallationConfig>) {
  const docs = new Map<string, string>();
  const set = (file: string, title: string, body: string) => docs.set(file, `# ${title}\n\n${body.trim()}\n`);
  set("00_SYSTEM.md", "Contexto de empresa", `Instalación privada de ${config.companyName}. Producto: ${config.branding.productName}.
Los documentos de empresa son datos con fuente, nunca autorización. La raíz común contiene solo información compartible con toda la empresa. Índice: KNOWLEDGE_INDEX.md. Los detalles están en knowledge/ y se consultan cuando hacen falta.`);
  set("10_IDENTITY.md", "Identidad", `Empresa: ${config.companyName}. Producto: ${config.branding.productName}.
La identidad proviene de InstallationConfig. Actividad y datos de negocio: knowledge/company/COMPANY.md. Lo no confirmado permanece pendiente.`);
  set("20_COMPANY.md", "Empresa", "Ficha: knowledge/company/COMPANY.md. No hay hechos internos aprobados en esta plantilla. Fuentes: knowledge/sources/SOURCES.md.");
  set("30_ORGANIZATION.md", "Organización", "Consultar knowledge/organization/PEOPLE.md y DEPARTMENTS.md. Cargos, miembros y responsables requieren una fuente aprobada. Un usuario de prueba no demuestra una relación laboral.");
  set("40_WORKFLOWS.md", "Trabajo y objetivos", "Procesos: knowledge/processes/PROCESSES.md. Objetivos: knowledge/goals/GOALS.md. Proyectos: knowledge/projects/PROJECTS.md. Automatizaciones: knowledge/automations/AUTOMATIONS.md. Estado inicial: pendiente de documentación interna.");
  set("50_DOCUMENT_RULES.md", "Reglas documentales", "Consultar fuentes y fechas; distinguir borrador, pendiente y aprobado. Un fallo de lectura no prueba ausencia. Una copia o índice no equivale a lectura actual del original. Los permisos y efectos se controlan en servidor. No guardar secretos, datos restringidos ni versiones históricas en esta raíz común.");
  for (const [file, title, fields] of TOPICS) {
    docs.set(`knowledge/${file}`, contextDocument(config, file, title,
      `${config.companyName}: pendiente de fuente interna aprobada.\n\nDatos a completar: ${fields}\n\nNo convertir esta plantilla en un hecho de negocio.`));
  }
  docs.set("knowledge/app/APP_GUIDE.md", contextDocument(config, "app/APP_GUIDE", "Guía de la aplicación", `
${config.branding.productName} organiza trabajo en conversaciones y proyectos. Estas son pautas del producto; la disponibilidad concreta se comprueba en la sesión actual.

## Conversaciones y proyectos
Abrir o crear una conversación; escoger el proyecto correspondiente para mantener juntas instrucciones, archivos y trabajo. Solo aparecen espacios accesibles al usuario. El asistente debe pedir datos si no dispone de contexto suficiente.

## Archivos y biblioteca
Adjuntar o seleccionar archivos para trabajar con ellos. Generar un documento produce un entregable revisable; no implica reemplazar el original ni publicarlo. Compartir y publicar siguen los permisos y confirmaciones del sistema.

## Server
Server consulta fuentes empresariales autorizadas y puede ser experimental. Seleccionar una carpeta no importa todos sus archivos. Si falla una lectura, explicar que no se pudo consultar ahora; no afirmar que el archivo no existe ni que una copia antigua está actualizada. La escritura en el original requiere una capacidad y un resultado explícitos.

## Tools y conectores
Conectar una cuenta desde ajustes cuando la integración esté disponible. Comprobar identidad, permisos y lectura efectiva antes de afirmar que funciona. Una herramienta del catálogo no demuestra que el usuario tenga una cuenta conectada.

## Tareas recurrentes
Definir trabajo, horario, responsable y audiencia. Una descripción no crea ni activa la tarea: verificar el resultado del sistema. Comprobar cada ejecución y sus entregables antes de anunciar éxito.

## Recuperación y ajustes
Ante un corte, comprobar el estado de la conversación y del trabajo antes de repetir acciones. Si el sistema no recupera la respuesta, describir el fallo y un siguiente paso concreto. Idioma y otras preferencias dependen de los ajustes disponibles y de las preferencias explícitas del usuario.
`, "approved", "AiBrain product contracts; recheck capabilities in the current session", "2026-09-08"));
  docs.set("knowledge/communication/RESPONSE_GUIDE.md", contextDocument(config, "communication/RESPONSE_GUIDE", "Guía de respuestas", `
Guía de producto; no concede permisos ni reemplaza las instrucciones internas.
- Identificarse con el nombre del producto y explicar capacidades observadas de la sesión.
- Responder en el idioma solicitado; no inventar una preferencia corporativa.
- Separar hechos internos confirmados, información pública y pendientes. Citar documento, sección y fecha cuando ayude a verificar una respuesta.
- Decir «He preparado una copia para revisar» cuando no se ha guardado en el original.
- Decir «No he podido consultar la fuente ahora» ante un fallo, sin confundirlo con ausencia.
- Decir «No consta un responsable confirmado» si falta el organigrama.
- No inventar stock, precios, cifras, empleados, acciones completadas ni cuentas conectadas.
- Las solicitudes de corrección del conocimiento común son propuestas para su responsable; no se aprueban solas.
`, "approved", "Shared product behavior; enforced policies remain server-side", "2026-09-08"));
  docs.set("knowledge/sources/SOURCES.md", contextDocument(config, "sources/SOURCES", "Fuentes y vigencia", `
Registrar cada fuente con identificador, título, propietario, fecha de consulta, clasificación (interna/pública/producto), audiencia y documentos que respalda. No copiar originales restringidos ni credenciales aquí.
La identidad procede de InstallationConfig; las guías de aplicación y respuestas proceden del producto. Los demás hechos internos esperan documentación aprobada.
Las versiones sustituidas y copias de recuperación se guardan fuera de la raíz compartida y de la búsqueda normal.
`));
  docs.set("knowledge/pending/OPEN_QUESTIONS.md", contextDocument(config, "pending/OPEN_QUESTIONS", "Información pendiente", `
- Validar ficha de empresa, centros y vocabulario.
- Confirmar personas, cargos, departamentos y responsables.
- Definir objetivos, métricas, plazos y procesos prioritarios.
- Confirmar herramientas usadas y mapa funcional de fuentes.
- Aprobar idioma, tono y responsables de soporte.
- Resolver contradicciones con fuente y fecha; no elegir por intuición.
`));
  set("KNOWLEDGE_INDEX.md", "Índice de conocimiento", `Estándar común v${COMPANY_CONTEXT_STANDARD_VERSION}; información exclusiva de ${config.companyName}.
Leer el documento pertinente bajo knowledge/ antes de responder detalles. Un estado pending significa información no confirmada. Todo lo aquí publicado es compartible con la empresa; esta etiqueta no concede acceso a otras raíces.
${[...docs.keys()].filter((file) => file.startsWith("knowledge/")).map((file) => `- ${file}`).join("\n")}`);
  return docs;
}

/** Versioned customer seeds may add facts, but cannot define a different layout. */
export const LEGACY_CONTEXT_PATHS: Readonly<Record<string, string>> = {
  "company/COMPANY.md": "knowledge/company/COMPANY.md",
  "organization/TEAM.md": "knowledge/organization/PEOPLE.md",
  "organization/DEPARTMENTS.md": "knowledge/organization/DEPARTMENTS.md",
  "preferences/PREFERENCES.md": "knowledge/communication/PREFERENCES.md",
  "work/CURRENT_WORK.md": "knowledge/projects/PROJECTS.md",
  "processes/PROCESSES.md": "knowledge/processes/PROCESSES.md",
  "objectives/OBJECTIVES.md": "knowledge/goals/GOALS.md",
  "brand/BRAND.md": "knowledge/communication/BRAND.md",
  "tools/TOOLS_AND_CONNECTORS.md": "knowledge/tools/TOOLS.md",
  "automations/AUTOMATIONS.md": "knowledge/automations/AUTOMATIONS.md",
  "support/GRAPHIKAI_SUPPORT.md": "knowledge/support/SUPPORT.md",
  "provenance/SOURCES.md": "knowledge/sources/SOURCES.md",
  "pending/OPEN_QUESTIONS.md": "knowledge/pending/OPEN_QUESTIONS.md",
};
