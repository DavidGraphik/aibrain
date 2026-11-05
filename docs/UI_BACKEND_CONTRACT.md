# Contrato UI ↔ backend de AiBrain

Estado verificado: rama `codex/aibrain-backend-definitivo`, implementación observada el 27-08-2026. Este documento describe las rutas, validadores y tipos que existen en el repositorio. No convierte stores internos en APIs públicas ni promete endpoints futuros.

Contrato ejecutable V1: `contracts/aibrain/v1/ui-backend.schema.json` contiene los JSON Schemas y ejemplos compilables; `contracts/aibrain/v1/http-routes.json` inventaría cada método y ruta pública. `npm run test:contract` exige paridad exacta con los handlers de Next, valida los ejemplos y fixtures TypeScript y las pruebas E2E validan respuestas reales de sesión, workbench y runtime contra esos schemas. Este Markdown es la guía humana complementaria.

## 1. Convenciones de transporte y seguridad

### Recuperación de una solicitud fallida (2026-09-04)

«Editar solicitud» recupera el texto en el composer del mismo thread sin
crear un turno, repetir efectos ni modificar el historial. Conserva cualquier
borrador ya escrito y descarta respuestas tardías si cambia la selección.
Los adjuntos se verifican mediante el GET autorizado de su historial: se
reutiliza el upload original únicamente si coinciden thread, identificador,
nombre, MIME y tamaño. Nunca se sustituye por la última revisión del archivo.
La lectura de versiones no cambia la autorización server-side del siguiente
turno, que vuelve a resolver staging y permisos.

Un adjunto sin contenido recuperable (incluidas imágenes inline antiguas sin
upload persistente) permanece visible como no disponible. Botón de envío,
Enter y dispatch del composer se bloquean hasta volver a adjuntarlo o quitarlo
explícitamente; no se envía silenciosamente una solicitud sin sus documentos.
El usuario revisa los modos y conectores actuales antes del nuevo envío.

- Todas las rutas de producto se ejecutan en Node.js y usan la cookie de sesión; la UI no envía tokens de Supabase ni credenciales de Codex.
- Las mutaciones exigen mismo origen. El backend compara `Origin` con `InstallationConfig.publicUrl`; si no hay `Origin`, usa `Sec-Fetch-Site: same-origin`. La excepción sin esas cabeceras solo existe fuera de producción.
- La respuesta de error HTTP estable es, como mínimo, `{ "error": string }`. Algunas rutas retiradas añaden `code`.
- Los `GET` que contienen estado privado usan `Cache-Control: no-store` o `private, no-store`.
- Los identificadores de proyecto, thread, mensaje, upload, operación y turn creados por la UI son UUID. `clientRequestId` es UUID en controles de turn y un identificador opaco seguro en publicación.
- El App Server no se expone al navegador. `/api/chat` traduce su transporte WebSocket privado per-user a NDJSON HTTP autenticado.
- No enviar campos adicionales a contratos marcados como estrictos: controles de turn y publicación los rechazan.

Ejemplo de error:

```json
{
  "error": "No autenticat."
}
```

## 2. Resumen de superficies públicas

| Método | Ruta | Contrato actual |
| --- | --- | --- |
| `POST` | `/api/auth/login` | Login demo o intercambio Supabase → sesión local opaca |
| `GET` | `/api/auth/session` | Sesión actual |
| `POST` | `/api/auth/logout` | Revoca sesión local y cookies |
| `POST` | `/api/auth/password/change-initial` | Cambio inicial mediante challenge en cookie |
| `POST` | `/api/auth/password/reset/request` | Solicitud de recuperación, respuesta no enumerable |
| `POST` | `/api/auth/password/recovery` | Completa recuperación y crea sesión local |
| `POST` | `/api/auth/support` | Intercambia código temporal de un uso por sesión de soporte; deshabilitado sin autorización temporal del operador root |
| `POST`, `DELETE` | `/api/operations/support-access` | Emite o revoca un acceso temporal concreto; bearer independiente de operador y mismo origen; véase `SUPPORT_ACCESS.md` |
| `GET`, `POST` | `/api/memory` | Lista o crea memoria explícita privada del empleado |
| `POST` | `/api/memory/{memoryId}/revoke` | Revoca memoria explícita con trazabilidad |
| `GET` | `/api/workbench` | Snapshot completo de proyectos y threads |
| `GET`, `POST` | `/api/projects` | Lista/búsqueda y creación |
| `GET`, `PATCH` | `/api/projects/{projectId}` | Lectura, renombrado, pin y archivo/restauración |
| `GET`, `POST` | `/api/projects/{projectId}/threads` | Lista y creación de threads del proyecto |
| `GET` | `/api/threads` | Lista/búsqueda global de threads |
| `GET`, `PATCH` | `/api/threads/{threadId}` | Lectura, renombrado, pin y archivo/restauración |
| `GET`, `PATCH` | `/api/task-center` | Historial derivado de turns, lectura y preferencias de avisos |
| `POST` | `/api/chat` | Turn persistente y stream NDJSON |
| `POST` | `/api/runtime/turns/control` | Steering o stop idempotente |
| `POST` | `/api/runtime/approvals` | Resolución durable de aprobación |
| `GET` | `/api/runtime/status?projectId={uuid}` | Estado, modelos, skills y capacidades del worker |
| `GET`, `PATCH` | `/api/settings` | Cuenta, apps reales, permisos, privacidad, red y preferencias persistentes |
| `POST` | `/api/threads/{threadId}/messages/{messageId}/result` | Estado de revisión/reversión del resultado |
| `GET` | `/api/projects/{projectId}/artifacts/{artifactId}` | Artefacto de imagen generado |
| `GET` | `/api/projects/{projectId}/files?path={path}` | Vista autenticada del archivo actual del workspace |
| `POST` | `/api/threads/{threadId}/documents` | Upload seguro, staging y preview |
| `GET` | `/api/threads/{threadId}/documents/{uploadId}/preview/{fileName}` | Fichero privado de preview |
| `POST` | `/api/threads/{threadId}/publications` | Congela un candidato para confirmación |
| `POST` | `/api/threads/{threadId}/publications/{operationId}` | Confirma o rechaza publicación |
| `GET` | `/api/health/live` | Liveness del proceso, sin autenticación |
| `GET` | `/api/health/ready` | Readiness de roots, capacidad y aislamiento del host |

No existe hoy una ruta HTTP pública de branding. Browser/Computer Use se ha retirado de este candidato; no hay rutas de control ni viewer (sección 14).

## 3. Auth y sesión

### 3.1 Tipo de sesión

```ts
type AuthSession = {
  provider: "demo" | "local";
  user: {
    id: string;       // UUID
    name: string;
    email: string;
  };
  tenant: {
    id: string;       // installationId en sesión local
    name: string;
  };
  expiresAt: string;  // ISO-8601; vencimiento idle visible
};
```

En producción con Supabase Auth, un login correcto emite una sesión file-backed y el `provider` que la UI lee es `local`. Los access/refresh tokens del proveedor no se guardan en el navegador ni se usan para persistencia de producto.

### 3.2 Login

`POST /api/auth/login`

Modo Supabase configurado:

```json
{
  "email": "employee@example.com",
  "password": "temporary-or-current-password"
}
```

Resultado normal `200`:

```json
{ "authenticated": true }
```

Si el usuario tiene el marcador de cambio inicial, el backend guarda el challenge en una cookie HttpOnly y responde:

```json
{
  "passwordChangeRequired": true,
  "expiresAt": "2026-08-27T12:10:00.000Z"
}
```

Modo demo, disponible solo bajo las condiciones de desarrollo/preview del backend:

```json
{ "userId": "demo-user-id" }
```

Su respuesta es `{ "session": AuthSession }`. La UI no debe asumir esta forma en producción.

Errores relevantes: `400` input inválido, `401` credenciales incorrectas,
`403` origen o usuario demo no autorizado, `429` límite temporal con
`Retry-After`, y `503` proveedor o rate limiter no disponible. Login se limita
por cliente y email (30/cliente y 10/email cada 15 minutos).

### 3.3 Cambio inicial y recuperación

`POST /api/auth/password/change-initial`

```json
{
  "password": "Permanent-pass-456",
  "confirmation": "Permanent-pass-456"
}
```

La contraseña debe tener 12–128 caracteres, al menos una letra y un número. Éxito: `{ "authenticated": true }`. Un challenge ausente/caducado responde `401`.

`POST /api/auth/password/reset/request`

```json
{ "email": "employee@example.com" }
```

Respuesta siempre no enumerable: `202 { "accepted": true }`, tanto si la
cuenta existe como si no, si el proveedor está inaccesible o si se alcanzó el
límite (10/cliente y 3/email por hora). No incluye `Retry-After` ni revela qué
componente rechazó la operación.

`POST /api/auth/password/recovery`

Debe incluir exactamente una prueba, `code` o `tokenHash`, además de las contraseñas:

```json
{
  "tokenHash": "provider-recovery-proof",
  "password": "Recovered-pass-789",
  "confirmation": "Recovered-pass-789"
}
```

Éxito: `{ "authenticated": true }`; `400` contrato/password inválido, `401`
prueba inválida/caducada, `429` límite por cliente+prueba con `Retry-After`, y
`503` proveedor o limiter inaccesible. Cambio inicial y recovery se limitan
antes de consumir el challenge/code/token.

### 3.4 Lectura y cierre

`GET /api/auth/session` → `200 { "session": AuthSession }` o `401 { "error": "No autenticat." }`.

`POST /api/auth/logout` → `200 { "ok": true }`. El backend elimina el registro local de sesión, el challenge si existe y las cookies.

Cookies de producción:

- `__Host-aibrain-session` y `__Host-aibrain-auth-challenge`;
- `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, prioridad alta;
- sesión: 7 días de inactividad, renovación de actividad cada 24 horas y máximo absoluto de 30 días.

Una sesión local ya emitida sigue funcionando si Supabase queda temporalmente inaccesible. Nuevos logins, cambios de contraseña y recuperaciones sí pueden devolver `503`.

## 4. Instalación y branding

### 4.1 Configuración server-side

El servidor carga un único `InstallationConfig` versionado:

```ts
type InstallationConfig = {
  schemaVersion: 1;
  installationId: string;
  companyName: string;
  companySlug: string;
  publicUrl: string;
  branding: {
    productName: string;
    logoPath: string;
    faviconPath: string;
    accentColor: string; // #RRGGBB
  };
  paths: {
    dataRoot: string;
    companyContextRoot: string;
    usersRoot: string;
    sourceReadRoot: string;
    publishWriteRoot: string;
    backupsRoot: string;
  };
};
```

Las rutas filesystem nunca se entregan a la UI. `installationId`, company y branding se proyectan como:

```ts
type PublicInstallationBranding = {
  installationId: string;
  companyName: string;
  companySlug: string;
  publicUrl: string;
  productName: string;
  logoPath: string;
  faviconPath: string;
  accentColor: string;
};
```

### 4.2 Límite público actual

**No hay endpoint JSON de branding.** Next.js carga esta proyección server-side y la pasa como props a login y recovery. El workbench recibe un `BrainManifest` renderizado en servidor cuyo `identity.productName` y color de accent se sobrescriben con el branding exacto de instalación. Metadata, favicon y título también se generan server-side.

La rama UI debe conservar ese límite o acordar una ruta nueva antes de intentar `fetch('/api/installation')`; esa ruta no existe.

No existe todavía un control plane remoto de onboarding o invitaciones. La identidad local provisionada y `PERMISSIONS.md` siguen siendo las únicas fuentes server-side de autorización efectiva. Los miembros guardados en un proyecto son metadatos locales explícitos: no crean cuentas, no envían correo y no amplían permisos del runtime. El workbench recibe también `logoPath`, por lo que login y aplicación muestran la marca de la instalación sin una rama por empresa.

## 5. Proyectos y threads

### 5.1 Tipos

```ts
type WorkbenchWorkspace = {
  id: string; // UUID
  label: string;
  hostType: "managed";
  status: "ready" | "pending" | "unavailable";
  isPrimary: boolean;
};

type ProjectSource = {
  id: string;
  kind: "file" | "link" | "note";
  name: string;
  url: string | null;
  mimeType: string | null;
  size: number | null;
  excerpt: string | null; // texto persistido, máximo 32.000
  status: "ready" | "pending-index";
  createdAt: string;
};

type ProjectMember = {
  id: string;
  email: string;
  name: string | null;
  role: "owner" | "editor" | "viewer";
  status: "active" | "invited-local";
  addedAt: string;
};

type WorkbenchProject = {
  id: string;
  name: string;       // 1–80 caracteres no vacíos
  slug: string;
  status: "active" | "archived";
  pinned: boolean;
  instructions: string; // máximo 16.000; se inyecta como instrucción persistente
  sources: ProjectSource[]; // máximo 100
  memory: { enabled: boolean; notes: string; updatedAt: string | null };
  sharing: {
    visibility: "private" | "shared";
    members: ProjectMember[]; // acceso declarado local, no invitación remota
  };
  workspace: WorkbenchWorkspace;
  createdAt: string;
  updatedAt: string;
};

type WorkbenchThread = {
  id: string;
  projectId: string;
  title: string;      // 1–120 caracteres no vacíos
  status: "active" | "archived";
  pinned: boolean; // preferencia durable del usuario que recibe la respuesta
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
};

type WorkbenchThreadSummary = Omit<WorkbenchThread, "messages"> & {
  messageCount: number;
  lastMessageAt: string | null;
};
```

### 5.2 Listas, búsqueda y paginación

Rutas:

- `GET /api/projects`
- `GET /api/threads`
- `GET /api/projects/{projectId}/threads`

Query compartida:

```text
status=active|archived|all  // default active
limit=1..50                // default 20
q=<texto>                  // trim, 1..100
cursor=<base64url opaco>   // 1..256
```

No se permiten parámetros desconocidos, repetidos ni formatos como `limit=01`.

Respuesta de proyectos:

```json
{
  "projects": [
    {
      "id": "0198b9f0-6631-7000-8000-000000000301",
      "name": "Private Operations",
      "slug": "private-operations",
      "status": "active",
      "pinned": false,
      "workspace": {
        "id": "0198b9f0-6631-7000-8000-000000000311",
        "label": "Private Operations",
        "hostType": "managed",
        "status": "ready",
        "isPrimary": true
      },
      "createdAt": "2026-08-27T10:00:00.000Z",
      "updatedAt": "2026-08-27T10:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

Threads listados usan `WorkbenchThreadSummary` y la clave `threads`.

### 5.3 Crear, leer, renombrar, fijar, archivar y restaurar

`POST /api/projects`

```json
{ "name": "Private Operations" }
```

→ `201 { "project": WorkbenchProject }`.

`GET /api/projects/{projectId}` → `{ "project": WorkbenchProject }`.

`PATCH /api/projects/{projectId}` acepta uno o varios de `name`, `pinned`, `status`, `instructions`, `sources`, `memory` y `sharing`:

```json
{
  "name": "Renamed Operations",
  "pinned": true,
  "status": "active",
  "instructions": "Responde en español y cita las fuentes del proyecto.",
  "memory": { "enabled": true, "notes": "El cliente prefiere entregas los viernes.", "updatedAt": "2026-08-28T09:00:00.000Z" },
  "sharing": { "visibility": "private", "members": [] }
}
```

→ `{ "project": WorkbenchProject }`. Restaurar equivale a `PATCH { "status": "active" }`.

`POST /api/projects/{projectId}/threads`

```json
{ "title": "Confidential planning" }
```

→ `201 { "thread": WorkbenchThread }`.

`GET /api/threads/{threadId}` → `{ "thread": WorkbenchThread }` con todos los mensajes.

`PATCH /api/threads/{threadId}` acepta `title`, `pinned` y/o `status`, con las mismas reglas que project. No existe borrado HTTP; archivo/restauración es el lifecycle soportado. `pinned` es una preferencia personal y durable: se guarda bajo la raíz del usuario autenticado, no modifica el thread del propietario y también puede aplicarse a un thread compartido de solo lectura después de resolver su ACL. `title` y `status` sí siguen requiriendo permiso de edición. Los ids anclados se proyectan únicamente sobre threads visibles y mantienen orden de anclado estable; un id sin acceso nunca provoca una lectura del recurso extranjero.

Los recursos se resuelven por el usuario de sesión. Un ID válido de otro usuario se presenta como `404`, no como recurso global.

### 5.4 Snapshot inicial

`GET /api/workbench`:

```ts
type WorkbenchSnapshot = {
  persistence: "filesystem" | "filesystem-demo" | "browser-preview";
  projects: WorkbenchProject[];
  threads: WorkbenchThread[];
};
```

Respuesta: `{ "workbench": WorkbenchSnapshot }`. Para una sesión local real la persistencia es `filesystem`. Supabase no es un valor válido de persistencia: participa únicamente durante los flujos de identidad anteriores a la emisión de la sesión local. Los threads anclados aparecen primero en su orden personal durable; el sidebar los muestra una sola vez en “Anclados” y los excluye de las listas de Chats/Proyectos mientras sigan anclados.

### 5.5 Centro de tareas

`GET /api/task-center` reconstruye el historial desde los mensajes durables del usuario y devuelve estados `running`, `needs_attention`, `completed` o `failed`, junto con `readTaskIds`, preferencias de avisos y `continuity: "worker_required"`. La última señal impide que la UI prometa ejecución cloud si el servidor o el worker no están activos.

`PATCH /api/task-center` marca ids como leídos o guarda las preferencias `inApp` y `desktop`. El backend persiste ese estado dentro de la raíz del usuario autenticado; no acepta tenant ni user en el body. Los avisos Web requieren además permiso explícito en el navegador y nunca se solicitan al cargar la página. Véase [`TASK_CENTER.md`](TASK_CENTER.md).

## 6. Mensajes, turns y streaming

### 6.1 Modelo persistido

```ts
type TurnSource = {
  id: string;
  kind: "web" | "file" | "app";
  title: string;
  url: string | null;         // solo HTTP(S) entregado por el runtime
  domain: string | null;
  snippet: string | null;
  publishedAt: string | null; // ISO-8601 cuando existe en metadatos
};

type ToolResult = {
  id: string;
  kind: "command" | "file" | "web" | "app" | "browser";
  title: string;
  status: "running" | "complete" | "failed" | "stopped";
  summary: string | null;
  output: string | null;      // salida real acotada; nunca texto inferido del asistente
  sourceIds: string[];
  createdAt: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  status: "complete" | "streaming" | "error" | "stopped";
  activity: ActivityItem[];
  plan: PlanStep[];
  approvals: ApprovalItem[];
  diff: string;
  attachments: ChatAttachment[];
  artifacts: GeneratedArtifact[];
  sources?: TurnSource[];     // opcional solo para leer mensajes V1 previos
  toolResults?: ToolResult[]; // opcional solo para leer mensajes V1 previos
};
```

Las fuentes se proyectan únicamente desde URLs o archivos presentes en los metadatos del runtime, la búsqueda web, una app/MCP o los adjuntos del turno. Un resultado sin URL no se transforma en cita. Los tool results conservan salida y estado por separado de `activity`, de modo que siguen siendo revisables tras refresh.

### 6.2 Iniciar o reanudar un turn

`POST /api/chat`

```ts
type ChatRequest = {
  projectId: string;          // UUID
  threadId: string;           // UUID activo y del project
  userMessageId: string;      // UUID generado por cliente
  assistantMessageId: string; // UUID generado por cliente
  message: string;            // no vacío tras trim
  displayMessage?: string;    // máximo 500; solo representación persistida
  preferences: {
    tone: "direct" | "balanced" | "detailed";
    language: "ca" | "es" | "en";
    showActivity: boolean;
  };
  options: {
    mode: "agent" | "plan" | "ask";
    model: string | null;      // máximo 100
    effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | null;
    webSearch: boolean;
    imageGeneration: boolean;
    skill: string | null;      // máximo 100
    attachments: ChatInputAttachment[];
    documentUploadIds?: string[]; // máximo 10 UUID ya staged en este thread
  };
};
```

Ejemplo:

```json
{
  "projectId": "0198b9f0-6631-7000-8000-000000000301",
  "threadId": "0198b9f0-6631-7000-8000-000000000302",
  "userMessageId": "0198b9f0-6631-7000-8000-000000000303",
  "assistantMessageId": "0198b9f0-6631-7000-8000-000000000304",
  "message": "Revisa el contrato y resume los riesgos.",
  "preferences": { "tone": "direct", "language": "es", "showActivity": true },
  "options": {
    "mode": "agent",
    "model": null,
    "effort": "medium",
    "webSearch": false,
    "imageGeneration": false,
    "skill": null,
    "attachments": [],
    "documentUploadIds": ["0198b9f0-6631-7000-8000-000000000511"]
  }
}
```

La respuesta correcta es `application/x-ndjson; charset=utf-8`: un JSON por línea, no SSE.

```text
{"type":"activity","item":{"id":"codex-connected","kind":"system","label":"Codex connectat","detail":"Sessió dedicada verificada","status":"complete"}}
{"type":"delta","value":"He revisado "}
{"type":"delta","value":"el contrato."}
{"type":"done"}
```

### 6.3 Eventos y reducción en UI

```ts
type ChatStreamEvent =
  | { type: "snapshot"; message: ChatMessage }
  | { type: "content"; value: string }
  | { type: "delta"; value: string }
  | { type: "activity"; item: ActivityItem }
  | { type: "plan"; explanation: string | null; steps: PlanStep[] }
  | { type: "approval"; item: ApprovalItem }
  | { type: "diff"; value: string }
  | { type: "artifact"; item: GeneratedArtifact }
  | { type: "source"; item: TurnSource }
  | { type: "toolResult"; item: ToolResult }
  | { type: "done" }
  | { type: "stopped" }
  | { type: "error"; message: string };
```

Reglas del reducer actual:

- `snapshot` reemplaza el mensaje completo;
- `content` reemplaza `content`; `delta` concatena;
- `activity` y `approval` hacen upsert por `item.id`;
- `plan` reemplaza `message.plan` con `steps`; `explanation` no se persiste en `ChatMessage`;
- `diff` reemplaza el diff completo;
- `artifact` añade el elemento;
- `source` y `toolResult` hacen upsert por `item.id`; cada `toolResult.sourceIds` solo referencia fuentes observadas en el mismo turn;
- `done`, `stopped`, `error` cambian el estado terminal.

### 6.4 Idempotencia, refresh y recuperación

La identidad idempotente del turn es el par persistido `userMessageId + assistantMessageId` dentro del thread.

- Reenviar la misma petición con el mismo contenido/adjuntos devuelve el resultado existente.
- Si ya terminó, la respuesta contiene un único evento `snapshot` y la cabecera `X-AiBrain-Idempotent-Replay: true`.
- Si sigue activo en el worker, la respuesta empieza con `snapshot` y sigue las proyecciones durables hasta estado terminal, también con esa cabecera.
- Reutilizar IDs con contenido distinto responde `409`.
- Solo puede existir un assistant `streaming` por thread; otros threads y usuarios siguen siendo independientes.

La UI debe conservar los cuatro UUID del request hasta obtener un estado terminal. Un corte de red se recupera repitiendo el mismo body, no generando nuevos IDs.

### 6.5 Steering y stop

`POST /api/runtime/turns/control`

Stop:

```json
{
  "action": "stop",
  "threadId": "0198b9f0-6631-7000-8000-000000000302",
  "assistantMessageId": "0198b9f0-6631-7000-8000-000000000304",
  "clientRequestId": "0198b9f0-6631-7000-8000-000000000305"
}
```

Steer:

```json
{
  "action": "steer",
  "threadId": "0198b9f0-6631-7000-8000-000000000302",
  "assistantMessageId": "0198b9f0-6631-7000-8000-000000000304",
  "clientRequestId": "0198b9f0-6631-7000-8000-000000000306",
  "userMessageId": "0198b9f0-6631-7000-8000-000000000307",
  "message": "Incluye también los riesgos operativos."
}
```

`message` de steer admite hasta 32.000 caracteres. La UI nunca envía IDs de App Server; el backend los resuelve desde la proyección privada.

Respuesta:

```json
{ "ok": true, "action": "steer", "idempotent": false }
```

Repetir el mismo `clientRequestId` después de que su actividad durable exista cambia `idempotent` a `true` y no reenvía el control. `409` indica turn terminal/no controlable/continuidad cambiada; `502` indica una respuesta incoherente del App Server.

## 7. Plan, actividad, tools y estado del runtime

### 7.1 Plan y actividad

```ts
type PlanStep = {
  step: string;
  status: "pending" | "in_progress" | "completed";
};

type ActivityItem = {
  id: string;
  kind: "system" | "reasoning" | "plan" | "command" | "file" | "tool" | "web" | "agent";
  label: string;
  detail?: string;
  output?: string;
  status: "pending" | "running" | "waiting" | "complete" | "failed" | "stopped";
};
```

La actividad de comandos puede actualizar `output` incrementalmente, pero cada evento contiene el snapshot acumulado del item. El tipo `tool` es actividad observable, no un endpoint de invocación arbitraria. El worker no registra herramientas de Browser/Computer Use; la búsqueda web nativa sigue disponible.

### 7.2 Estado, modelos, skills y capacidades

`GET /api/runtime/status?projectId={uuid}`. `projectId` es opcional; si se proporciona debe resolver a un proyecto del usuario.

```ts
type RuntimeStatus = {
  tenantId: string;
  projectId: string | null;
  projectName: string;
  mode: "demo" | "codex";
  codex: "checking" | "connected" | "unavailable" | "disabled";
  isolated: boolean;
  ready: boolean;
  authMode: "chatgpt" | "apiKey" | "amazonBedrock" | null;
  planType: string | null;
  processWarm: boolean;
  rateLimit: {
    usedPercent: number;
    windowDurationMins: number | null;
    resetsAt: number | null;
  } | null;
  usage: {
    lifetimeTokens: number | null;
    currentStreakDays: number | null;
    longestRunningTurnSec: number | null;
  } | null;
  workspaceName: string;
  model: string | null;
  approvalPolicy: "never" | "on-request";
  sandbox: "read-only" | "workspace-write";
  models: Array<{
    id: string;
    label: string;
    description: string;
    isDefault: boolean;
    inputModalities: Array<"text" | "image" | "audio">;
    supportedReasoningEfforts: Array<"none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra">;
    defaultReasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" | null;
    supportsPersonality: boolean;
  }>;
  skills: Array<{ id: string; label: string; description: string }>;
  capabilities: {
    webSearch: boolean;
    imageInput: boolean;
    imageGeneration: boolean;
  };
};
```

Ejemplo degradado válido con HTTP `200`:

```json
{
  "tenantId": "example-lab-dev",
  "projectId": null,
  "projectName": "Example Lab",
  "mode": "codex",
  "codex": "unavailable",
  "isolated": true,
  "ready": false,
  "authMode": null,
  "planType": null,
  "processWarm": false,
  "rateLimit": null,
  "usage": null,
  "workspaceName": "Example Lab / default",
  "model": null,
  "approvalPolicy": "on-request",
  "sandbox": "workspace-write",
  "models": [],
  "skills": [],
  "capabilities": { "webSearch": false, "imageInput": false, "imageGeneration": false }
}
```

La UI debe habilitar selección/invocación según `models`, `skills` y `capabilities` de esta respuesta, no según el manifest visual.

### 7.3 Superficies no publicadas

AiBrain no envía invitaciones ni publica un control plane remoto. El panel de proyecto persiste miembros locales; cuando el correo coincide con una persona provisionada y habilitada de la misma instalación, el backend activa la visibilidad compartida según `viewer` o `editor`. Un correo sin identidad local sigue como `invited-local`, no obtiene acceso y la UI debe explicar que no se ha enviado nada. La autorización efectiva siempre se resuelve en servidor.

Las automatizaciones programadas son locales y explícitas: `GET/POST /api/automations` lista y crea tareas visibles para el empleado; `PATCH/DELETE /api/automations/{taskId}` exige permiso de gestión; `GET /api/automations/{taskId}/runs` exige acceso actual a resultados; y `POST /api/automations/{taskId}/run` encola una ejecución manual idempotente mediante `clientRequestId`. El runner documentado en `docs/AUTOMATIONS.md` ejecuta los prompts en el servidor mientras ese proceso está vivo, incluso con el navegador del usuario cerrado. La API y la UI muestran la señal real del worker; no prometen ejecución cloud, no envían mensajes externos por sí solas y conservan las aprobaciones normales del runtime.

La creación desde chat usa una propuesta durable ligada al tenant, usuario, conversación y turno. Acción, horario, zona horaria, proyecto o `Sin proyecto` y audiencia deben estar completos antes de proponerla. La tarea solo se crea después de una confirmación explícita en un mensaje posterior. En cada ejecución el backend fuerza web en vivo y vuelve a resolver las skills y conectores que sigan autorizados; el contenido del prompt nunca concede permisos ni conserva una autorización revocada.

### Centro de administración del workspace

`GET /api/admin` exige una sesión local del mismo tenant y un rol persistido con `canManageWorkspace=true`. Devuelve personas, estado observado de workers, uso interno, roles, grupos, políticas y los últimos eventos de auditoría. Nunca inicia un worker para calcular su estado.

`PATCH /api/admin` exige además mismo origen. Admite comandos estrictos para cambiar rol/estado de una persona, crear/actualizar/eliminar grupos y provisionar un perfil local. Las políticas de rol y grupo cubren apps (`web-search`, `image-generation`, `skills`; `managed-browser` solo se conserva en registros históricos y no se ofrece en UI) y capacidades (`consult`, `respond`, `execute`, `publish`); un bloqueo de cualquier grupo prevalece. Los cambios se persisten por instalación y se registran con actor, destino, acción y fecha.

`provision-local-member` reutiliza `UserProvisioner`: crea perfil, worker y workspace locales para un UUID que ya debe existir en el proveedor de identidad. La respuesta declara `emailSent:false` e `identityCreated:false`. AiBrain no finge una invitación, un alta de IdP ni un correo enviado.

## 8. Approvals

```ts
type ApprovalItem = {
  id: string;
  threadId: string;
  turnId: string;
  itemId: string;
  kind: "command" | "file" | "browser";
  title: string;
  detail: string;
  command?: string;
  cwd?: string;
  permissionFingerprint?: string; // SHA-256 hex
  status: "pending" | "accepted" | "accepted_session" | "declined";
};
```

Los items llegan en el stream como `{ "type": "approval", "item": ApprovalItem }`. Resolver con `POST /api/runtime/approvals`:

```json
{
  "approvalId": "approval-runtime-id",
  "threadId": "runtime-thread-id",
  "turnId": "runtime-turn-id",
  "itemId": "runtime-item-id",
  "decision": "accept"
}
```

`decision` admite `accept`, `acceptForSession` o `decline`. Los cuatro IDs son opacos y deben copiarse literalmente del evento; no deben reconstruirse.

Éxito y replay de la misma decisión:

```json
{ "ok": true, "status": "resolved" }
```

Una aprobación ya no pendiente devuelve `404`; una decisión distinta concurrente puede devolver `409`; indisponibilidad del store, `503`. La espera de una aprobación pertenece solo a su turn y no bloquea otros turns. El backend persiste el record pendiente antes de emitirlo, por lo que una resolución inmediata de UI no puede adelantarse al store.

Las solicitudes genéricas de comando, cambio de fichero o ampliación de
permisos solo pueden crear un pendiente cuando el snapshot inmutable del turn
contiene `tools.execute | execute | allow`. Ausencia o `deny` se rechaza
server-side antes del store; la UI puede observar el item ya `declined`, pero no
puede convertir esa denegación de `PERMISSIONS.md` en una concesión humana.

## 9. Review y diffs

El diff se entrega como texto completo en `{ "type": "diff", "value": string }` y se persiste en `ChatMessage.diff`. No existe actualmente una API de hunks tipados, aplicación parcial ni patch directo desde UI.

La UI puede registrar el estado de revisión con:

`POST /api/threads/{threadId}/messages/{messageId}/result`

```json
{ "action": "approved" }
```

Acciones: `approved`, `pending`, `undo_waiting`, `undo_complete`. Respuesta: `{ "message": ChatMessage }`. El backend hace upsert de una actividad `result-review` o `result-undo`; este endpoint registra estado de UI y **no ejecuta por sí mismo una reversión filesystem**.

## 10. Adjuntos y artefactos generados

### 10.1 Imágenes inline en chat

```ts
type ChatAttachment = {
  id: string;       // UUID
  name: string;     // 1..120
  mimeType: string; // whitelist de imagen o documento soportado
  size: number;     // imagen inline <=2 MB; staged <=50 MiB
};

type ChatInputAttachment = ChatAttachment & {
  dataUrl: string;  // data:<mimeType>;base64,...
};
```

Máximo 3 imágenes y 5.000.000 bytes reales en total. El backend decodifica
base64, compara tamaño y firma PNG/JPEG/WebP/GIF con el MIME; no confía solo en
la metadata declarada. El `dataUrl` solo viaja en el request; el mensaje
persistido conserva metadata, no base64.

### 10.2 Imágenes generadas

```ts
type GeneratedArtifact = {
  id: string;          // UUID derivado de forma estable del evento
  type: "image";
  name: string;
  url: string;         // /api/projects/{projectId}/artifacts/{artifactId}
  prompt: string | null;
};
```

`GET /api/projects/{projectId}/artifacts/{artifactId}` responde bytes `image/png`, inline, con `Cache-Control: private, no-store`. La URL se reautoriza en cada request; no debe reutilizarse desde caché tras logout o cambio de empleado. IDs inválidos o artefactos ajenos/inexistentes responden `400` o `404` sin revelar paths.

`GET /api/projects/{projectId}/files?path={path}` reautoriza el proyecto y confina la lectura a su workspace. Devuelve metadata y contenido acotado para texto/código; para imágenes y PDF devuelve una `previewUrl` del mismo endpoint con `raw=1`. Las respuestas no se cachean y una ruta absoluta emitida por Codex solo se acepta si resuelve dentro del workspace autorizado.

Los documentos Office/PDF/texto/imagen no usan este contrato inline; usan la API de documentos siguiente.

## 11. Office, PDF, texto, imágenes y previews

### 11.1 Upload

`POST /api/threads/{threadId}/documents`, `multipart/form-data`, exactamente dos partes:

- `uploadId`: UUID generado por cliente y reutilizado solo para reintentar el mismo fichero;
- `file`: fichero binario.

Límite de fichero 50 MiB; request multipart máximo 52 MiB. Formatos aceptados:

| Kind | Extensión/MIME coherente | Preview |
| --- | --- | --- |
| `docx` | `.docx` OOXML | `document.pdf`, `page-1.png` |
| `xlsx` | `.xlsx` OOXML | `document.pdf`, `page-1.png` |
| `pptx` | `.pptx` OOXML | `document.pdf`, `page-1.png` |
| `pdf` | `.pdf`, firma `%PDF-` | `document.pdf`, `page-1.png` |
| `text` | `.txt`, `.md`, `.csv`, `.json`; UTF-8 | `preview.txt` |
| `image` | PNG, JPEG, GIF, WebP | `preview.<ext>` |

Texto: 10 MiB máximo; imagen: 20 MiB. OOXML rechaza macros/ActiveX/custom UI/macrosheets, traversal, cifrado, Zip64, codecs no seguros, más de 5.000 entradas, más de 250 MiB descomprimidos o ratio mayor de 100. PDF cifrado, sin número de páginas válido o con más de 500 páginas se rechaza durante preview.

Respuesta `201`:

```json
{
  "document": {
    "schemaVersion": 1,
    "uploadId": "0198b9f0-6631-7000-8000-000000000511",
    "threadId": "0198b9f0-6631-7000-8000-000000000302",
    "fileName": "notes.md",
    "relativePath": "threads/0198b9f0-6631-7000-8000-000000000302/uploads/0198b9f0-6631-7000-8000-000000000511/notes.md",
    "kind": "text",
    "mediaType": "text/plain",
    "size": 17,
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "status": "staged",
    "createdAt": "2026-08-27T10:00:00.000Z"
  },
  "preview": {
    "schemaVersion": 2,
    "uploadId": "0198b9f0-6631-7000-8000-000000000511",
    "threadId": "0198b9f0-6631-7000-8000-000000000302",
    "sourceSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "status": "ready",
    "kind": "text",
    "files": [
      {
        "name": "preview.txt",
        "url": "/api/threads/0198b9f0-6631-7000-8000-000000000302/documents/0198b9f0-6631-7000-8000-000000000511/preview/preview.txt"
      }
    ],
    "artifacts": [
      {
        "fileName": "preview.txt",
        "size": 17,
        "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      }
    ],
    "pages": null,
    "createdAt": "2026-08-27T10:00:01.000Z"
  }
}
```

`relativePath` es metadata opaca; la UI no debe enviarla de vuelta como
authority. `409` para `uploadId` reutilizado con otro contenido; `413` por
tamaño; `400` validación de seguridad; `429` con `Retry-After` cuando todos los
slots compartidos de upload/conversión están ocupados o cuando el volumen no
puede absorber el peor burst sin invadir su margen libre; `503` si no puede
medirse el volumen o el toolchain/store no está disponible. La saturación de
almacenamiento se rechaza antes de leer o persistir el multipart; la de
conversión, antes de arrancar LibreOffice/Poppler. La UI puede reintentar el
mismo `uploadId` después del intervalo indicado.

`preview.schemaVersion: 2` atesta cada artefacto mediante `fileName`, tamaño y
SHA-256. El backend vuelve a verificar los bytes antes de reutilizar un preview
`ready`; si falta o cambia un fichero regular lo reconstruye desde el upload
staged validado. Un symlink o metadata corrupta falla cerrado. La UI puede usar
`artifacts` como evidencia informativa, pero las URLs server-side siguen siendo
la única autoridad de lectura.

Para adjuntar el documento a un turn, la UI envía únicamente su `uploadId` en
`options.documentUploadIds` del `POST /api/chat`, después de recibir el `201`.
No reenvía `relativePath`, paths absolutos, MIME, hash ni nombre. El backend:

- exige `documents.read | consult | allow` en el fingerprint de ese turn;
- vuelve a verificar user, thread, fichero regular, tamaño y SHA-256;
- mantiene el path absoluto y todo staging bajo autoridad exclusiva del
  servidor; el worker solo ve su `staging/tmp` privado;
- para texto valida UTF-8; para Office/PDF usa exclusivamente el PDF atestado
  por preview, extrae texto acotado con Poppler y, si existe, incorpora la
  primera página renderizada; para imagen incorpora bytes validados como data
  URL;
- entrega esos inputs preparados como datos no confiables dentro del request
  App Server. Nunca usa `mention`, `localImage`, `localAudio` ni otra referencia
  a un path staged.

Máximo 10 documentos y 200 MiB verificados por turn como protección de
saturación. El contenido preparado se limita además a 2 MiB de texto por
documento, 4 MiB de texto y 20 MiB de imágenes codificadas por turn. Los
metadatos seguros se guardan en `ChatMessage.attachments`; los paths no se
devuelven a la UI ni al worker. Un ID de otro thread/empleado, un contenido
alterado, un preview no atestado o un permiso denegado falla antes de iniciar el
turn de Codex.

El backend consume el multipart por streaming y escribe un temporal privado;
no materializa el request ni el fichero completo en RAM. Para OOXML compara
headers central/local, rangos, CRC, tamaño y ratio reales mientras descomprime.
El staging publica sin overwrite y un retry solo recupera el orphan exacto si
hash y tamaño coinciden.

### 11.2 Leer preview

Usar exactamente cada `preview.files[].url`. La respuesta es el fichero, con MIME derivado del nombre, `Content-Disposition: inline`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store` y CSP sandbox. La ruta verifica sesión, usuario, thread, upload y whitelist de fichero; otro usuario obtiene `404`.

## 12. Publicación documental

La publicación es un protocolo de dos pasos. La UI nunca elige roots server-side ni publica el path staged directamente.

### 12.1 Congelar candidato

`POST /api/threads/{threadId}/publications`

Body estricto:

```json
{
  "operationId": "0198b9f0-6631-7000-8000-000000000615",
  "clientRequestId": "freeze-publish-001",
  "turnId": "0198b9f0-6631-7000-8000-000000000612",
  "uploadId": "0198b9f0-6631-7000-8000-000000000613",
  "targetRelativePath": "knowledge/approved.txt"
}
```

Precondiciones verificadas server-side:

- sesión local e instalación coincidente;
- thread del usuario y assistant turn perteneciente al thread;
- regla efectiva exacta `documents.publish | publish | allow` y ausencia de `publish | deny` en `PERMISSIONS.md`;
- candidato staged y preview `ready` con el mismo SHA-256;
- path destino relativo normalizado, sin traversal ni symlinks.

Respuesta `201`:

```ts
{
  operation: PublicationOperation;
  confirmationToken: string;
  permissionFingerprint: string; // SHA-256 hex
}
```

La operación visible es:

```ts
type PublicationOperation = {
  schemaVersion: 1;
  operationId: string;
  installationId: string;
  userId: string;
  threadId: string;
  turnId: string;
  targetRelativePath: string;
  status: "awaiting_confirmation" | "publishing" | "published" | "declined" | "expired" | "conflict";
  candidate: { fileName: string; size: number; sha256: string };
  preview: {
    schemaVersion: 1;
    previewId: string;
    threadId: string;
    turnId: string;
    candidateSha256: string;
    status: "ready";
    artifacts: string[];
    createdAt: string;
  };
  original: {
    exists: boolean;
    size: number | null;
    sha256: string | null;
    mtimeMs: number | null;
  };
  confirmationExpiresAt: string;
  version: { size: number; sha256: string; createdAt: string } | null;
  result: {
    size: number;
    sha256: string;
    publishedAt: string;
    recoveredAfterInterruption: boolean;
  } | null;
  createdAt: string;
  updatedAt: string;
};
```

El token de confirmación solo se entrega en este receipt y se liga a instalación, usuario, thread, turn, operación y expiración. La UI debe mantenerlo en memoria hasta decidir; no debe registrarlo.

Al llegar a `confirmationExpiresAt`, el backend reconcilia la operación bajo su
lock a `status: "expired"`. Es un estado terminal, durable y auditable; su
`updatedAt` coincide exactamente con `confirmationExpiresAt`, aunque el primer
acceso posterior ocurra más tarde. La UI debe retirar las acciones de
confirmación y mostrar que hace falta congelar un candidato nuevo.

### 12.2 Confirmar o rechazar

`POST /api/threads/{threadId}/publications/{operationId}`

Body estricto:

```json
{
  "action": "confirm",
  "clientRequestId": "confirm-publish-001",
  "turnId": "0198b9f0-6631-7000-8000-000000000612",
  "confirmationToken": "v1.178...signature"
}
```

`action` es `confirm` o `decline`. Respuesta:

```json
{
  "operation": {
    "status": "published",
    "version": {
      "size": 17,
      "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "createdAt": "2026-08-27T10:01:00.000Z"
    },
    "result": {
      "size": 18,
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "publishedAt": "2026-08-27T10:01:01.000Z",
      "recoveredAfterInterruption": false
    }
  },
  "permissionFingerprint": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
}
```

El ejemplo omite los campos de identidad/preview ya definidos en `PublicationOperation`; la respuesta real incluye la operación completa. En `decline`, `permissionFingerprint` es `null` y el fichero oficial no se modifica.

Si el TTL ya venció, `confirm` devuelve `403` y nunca inicia la escritura. Un
`decline` posterior funciona como acuse de cierre idempotente: devuelve la
operación terminal `expired`, con `permissionFingerprint: null`, sin cambiar el
target ni convertirla en `declined`. Repetir ese cierre no duplica el evento de
auditoría.

Confirmar vuelve a resolver `PERMISSIONS.md`. La escritura compara el original congelado, versiona el original si existe, escribe atómicamente y verifica el hash posterior. El lock del target es único por instalación y destino, incluso cuando dos empleados confirman operaciones desde estados privados distintos. `status: "conflict"` es un resultado válido si el original cambió. Repetir exactamente el mismo `clientRequestId` y decisión devuelve el resultado ya registrado; cambiar contenido o decisión devuelve `409`.

Errores: `403` token expirado/inválido o permiso retirado; `404` operación; `409` decisión previa o `clientRequestId` reutilizado con otra intención; `400` binding/path inseguro; `429` con `Retry-After`, `code: "PUBLICATION_STORAGE_BACKPRESSURE"` y `retryable: true` si el volumen oficial no conserva margen; `503` con `code: "PUBLICATION_STORAGE_CAPACITY_UNAVAILABLE"` y `retryable: true` si su capacidad no puede medirse. Ambos fallan antes de cambiar la operación a `publishing`, crear una versión o tocar el destino. Un cambio del original detectado durante la confirmación normalmente es `200` con `operation.status: "conflict"`. La expiración ya reconciliada se representa como `status: "expired"`, no como `conflict` ni como un pendiente recuperable.

No hay hoy endpoints públicos para listar operaciones ni descargar/restaurar la versión anterior. Esas funciones existen en el publisher server-side, no en el contrato UI.

## 13. Memoria automática, privada y gobernada

Cada turno completado agenda la extracción después de emitir su estado terminal,
por lo que la respuesta visible no espera a memoria. El extractor solo acepta
frases declarativas con preferencias, hechos estables o decisiones; descarta
secretos, credenciales, código/instrucciones inseguras y referencias efímeras.
La escritura es idempotente por turno+tema, deduplica contenido equivalente,
incrementa `revision` cuando el mismo tema cambia y respeta una eliminación
previa sin recrearla automáticamente.

La memoria automática se guarda bajo la raíz privada del usuario/CODEX_HOME.
Las decisiones ligadas al proyecto conservan `projectId`; ningún recuerdo se
promueve automáticamente al ámbito empresa. Instalación, actor y sujeto siempre
se derivan server-side. En el turno siguiente, el snapshot combina memoria
manual y gobernada, priorizada por relevancia respecto al mensaje actual, y la
inyecta como datos no confiables con IDs y fingerprint auditables.

`Configuración > Memoria` consume directamente los endpoints siguientes y
muestra lista, procedencia, alcance, revisión, edición y borrado sin abrir un
segundo panel:

- `GET /api/memory/proposals?projectId={uuid}` lista propuestas heredadas y memorias gobernadas visibles para ese usuario/proyecto.
- `PATCH /api/memory/governed/{memoryId}` corrige contenido con `expectedRevision`.
- `DELETE /api/memory/governed/{memoryId}` crea el tombstone con `expectedRevision`.

La creación manual y la revocación explícita siguen disponibles:

`GET /api/memory?status=active|revoked|all&kind=recollection|decision&limit=1..100`
devuelve `200` y `Cache-Control: private, no-store`:

```ts
type ExplicitMemory = {
  schemaVersion: 1;
  memoryId: string;
  installationId: string;
  subjectUserId: string;
  kind: "recollection" | "decision";
  content: string;
  provenance: {
    sourceType: "manual" | "thread" | "project" | "document" | "decision";
    sourceId: string;
    sourceExcerpt: string;
    capturedAt: string;
  };
  explicit: true;
  createdBy: string;
  createdAt: string;
  status: "active" | "revoked";
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
  idempotencyKey: string;
};
```

`POST /api/memory` acepta un body estricto:

```json
{
  "explicit": true,
  "kind": "decision",
  "content": "Publicar únicamente tras confirmación explícita.",
  "sourceExcerpt": "El empleado pidió recordar esta regla.",
  "clientRequestId": "0198b9f0-6631-7000-8000-000000000711"
}
```

Devuelve `201 { "memory": ExplicitMemory, "created": true }`. Repetir el mismo
UUID y contenido devuelve `200` con `created: false`; reutilizarlo para otra
memoria devuelve `409`.

`POST /api/memory/{memoryId}/revoke`:

```json
{
  "explicit": true,
  "reason": "La decisión fue sustituida.",
  "clientRequestId": "0198b9f0-6631-7000-8000-000000000712"
}
```

La revocación es durable e idempotente. Errores: `400` contrato/consulta,
`401` sesión, `404` memoria ajena o inexistente, `409` clave idempotente en
conflicto y `503` store corrupto/no disponible. Cada turn registra el
fingerprint e IDs de la memoria inyectada, nunca su contenido en auditoría.

## 14. Computer Use retirado y proyección privada de uso

En el candidato de simplificación del 26/10/2026 se retiran el navegador
controlado por IA/humano, su panel, las rutas `/api/runtime/browser*` y el
namespace dinámico `aibrain_browser`. No se sustituye por otro controlador ni
por un flag. Una petición a esas rutas ya no encuentra un endpoint.

La búsqueda web nativa, OAuth, CMS/websites y las conversiones/previews de
archivos conservan sus contratos. Los browsers de pruebas y las herramientas
nativas de documentos son independientes de Computer Use.

El historial durable conserva los tipos de resultados/artefactos browser para
poder leer conversaciones anteriores; conservar su formato no activa herramientas.
Los perfiles y archivos existentes no se eliminan. La revisión del catálogo de
thread se incrementa para que el mecanismo existente de continuidad reconstruya
un runtime con las herramientas actuales desde el historial autorizado.

Este documento describe código de una rama de trabajo: no acredita despliegue
ni aceptación UI del candidato.

### 14.1 Private usage projection

`GET /api/usage/budget` requiere una sesión local de la instalación actual y
devuelve `{ budget: null }`. La UI de empleado no ofrece una sección de uso ni
consulta periódicamente el contador. El cálculo, los umbrales y el bloqueo
siguen siendo privados del operador. Una sesión ausente devuelve `401`, una
instalación ajena `403` y un registro no verificable `503`. Siempre usa
`Cache-Control: private, no-store` y no consulta al proveedor.

`GET /api/usage/me` y `GET /api/usage/company` devuelven el mismo objeto
`{ budget }` cuando la instalación tiene presupuesto configurado. No consultan
al proveedor ni incluyen `internal`, `members` o `sharedSubscription`, tampoco
para `workspace-owner` o `workspace-admin`. Un error del contador nunca activa
un fallback que exponga métricas. En `/admin`, los miembros tampoco incluyen
`inputTokens` ni `outputTokens` en ese caso. El registro privado del host conserva
los contadores para el operador. Los schemas `EmployeePersonalUsageResponse` y
`EmployeeCompanyUsageResponse` declaran ambas variantes.

Sin presupuesto configurado, `GET /api/usage/me` requiere la cookie local opaca
y devuelve las métricas internas del empleado autenticado. `GET /api/usage/company`
requiere además que la asignación durable del usuario sea `workspace-owner` o
`workspace-admin`; `workspace-member` falla de forma cerrada con `403`. La ruta
resuelve el rol server-side desde `dataRoot/workspace-admin/state.json` y no
acepta UUIDs o roles enviados por el navegador.

Ambos endpoints responden `Cache-Control: private, no-store`. El objeto
`internal` usa este contrato:

```ts
type UsageAggregate = {
  turns: number;
  completedTurns: number;
  errorTurns: number;
  stoppedTurns: number;
  activeDays: number;
  averageDurationMs: number | null;
  p95DurationMs: number | null;
  averageFirstTextMs: number | null;
  p95FirstTextMs: number | null;
  turnsWithTokenData: number;
  tokens: {
    totalTokens: number;
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
  };
};
```

Respuesta personal:

```json
{
  "schemaVersion": 1,
  "scope": "personal",
  "generatedAt": "2026-08-27T10:00:00.000Z",
  "userId": "00000000-0000-4000-8000-000000000001",
  "internal": {
    "turns": 8,
    "completedTurns": 7,
    "errorTurns": 1,
    "stoppedTurns": 0,
    "activeDays": 2,
    "averageDurationMs": 6220,
    "p95DurationMs": 8900,
    "averageFirstTextMs": 1250,
    "p95FirstTextMs": 2100,
    "turnsWithTokenData": 7,
    "tokens": {
      "totalTokens": 4800,
      "inputTokens": 3500,
      "cachedInputTokens": 1200,
      "cacheWriteInputTokens": 0,
      "outputTokens": 1300,
      "reasoningOutputTokens": 300
    }
  },
  "sharedSubscription": {
    "schemaVersion": 1,
    "installationId": "example-lab",
    "observedAt": "2026-08-27T10:00:00.000Z",
    "scope": "shared_chatgpt_account",
    "planType": "team",
    "rateLimitsAvailable": true,
    "accountTokenUsageAvailable": true,
    "rateLimits": [
      {
        "limitId": "codex",
        "limitName": "Codex",
        "planType": "team",
        "primary": {
          "usedPercent": 32,
          "windowDurationMins": 300,
          "resetsAt": 1777000000
        },
        "secondary": null,
        "credits": null,
        "individualLimit": null,
        "spendControlReached": false,
        "rateLimitReachedType": null
      }
    ],
    "accountTokenUsage": {
      "lifetimeTokens": "125000",
      "peakDailyTokens": "22000",
      "longestRunningTurnSec": "98",
      "currentStreakDays": "4",
      "longestStreakDays": "9",
      "dailyUsageBuckets": [
        { "startDate": "2026-08-27", "tokens": "12000" }
      ]
    }
  },
  "notices": [
    "Les mètriques internes per empleat provenen només dels torns d’aquesta instal·lació.",
    "El percentatge i l’ús del proveïdor pertanyen al compte ChatGPT compartit; no s’atribueixen a cap empleat."
  ]
}
```

La respuesta de empresa cambia `scope` a `company`, añade `installationId` y
`members: Array<{ userId, displayName, email, usage }>` y mantiene un único
`sharedSubscription`. La UI puede mostrar `rateLimits[].primary.usedPercent`
como porcentaje del plan solo cuando `rateLimitsAvailable=true`; en caso
contrario debe mostrar «No disponible», nunca derivarlo de tokens internos.

Los tokens por empleado se registran únicamente desde
`thread/tokenUsage/updated` ligado al mismo thread y turn. Los totales de
`account/usage/read` son globales de la suscripción compartida y no se reparten
ni estiman por empleado.

## 15. Estados degradados y errores recuperables

Durante un drain operativo, un chat nuevo devuelve `503` con
`code: "MAINTENANCE_ACTIVE"`, `retryAfterMs` y header `Retry-After`. La UI debe
conservar el borrador y reintentar solo por acción del usuario o backoff; no
debe interpretar la respuesta como un turn aceptado. Turns ya admitidos siguen
hasta terminar. `/api/operations/maintenance` es control host-local y no forma
parte del cliente UI.

### 15.1 Mapa de respuesta UI

| Señal | Interpretación | Acción UI segura |
| --- | --- | --- |
| `401` | Sesión ausente/caducada/revocada | Ir a login; no repetir mutaciones automáticamente |
| `403` origen | Request fuera del origen configurado | Error terminal de configuración |
| `403` scope/permiso | Recurso, instalación o `PERMISSIONS.md` no autoriza | No reintentar; refrescar permisos/estado si el usuario lo pide |
| `404` | Recurso no visible para este usuario o inexistente | Retirar de UI y recargar lista |
| `409` | Conflicto/idempotency mismatch/turn terminal/original cambiado | Recargar entidad; conservar evidencia; usar IDs nuevos solo para una intención nueva |
| `410` + `FEATURE_OUT_OF_SCOPE` | Superficie retirada de V1 | Ocultar permanentemente en V1 |
| `413` | Upload/request demasiado grande | Pedir otro fichero; no reintentar igual |
| `429` | Backpressure de upload, disco o conversión documental | Respetar `Retry-After`; no lanzar starts/uploads/conversiones paralelos |
| `502` | Contrato de runtime incoherente | Mostrar degradado y permitir refresh/retry explícito |
| `503` | Provider, filesystem, permisos, toolchain o runtime no disponible | Backoff acotado; no asumir que una mutación no ocurrió |
| stream `{ "type": "error" }` | Turn terminó con error o persistencia final falló | Conservar IDs y recuperar repitiendo el mismo request |
| `RuntimeStatus.ready=false` | Worker no listo aunque HTTP responda `200` | Deshabilitar envío y mostrar estado de conexión |
| publicación `status="conflict"` | Original cambió desde freeze | Exigir nueva revisión/freeze; no confirmar de nuevo con IDs distintos a ciegas |

### 15.2 Liveness y readiness

`GET /api/health/live` no prueba filesystem, Codex, Supabase ni document toolchain. Solo confirma que el proceso HTTP está vivo:

```json
{
  "schemaVersion": 1,
  "status": "live",
  "revision": "fdae78a93e2648f16edca127f77285d5d6be5b46",
  "processStartedAt": "2026-08-27T09:00:00.000Z",
  "checkedAt": "2026-08-27T10:00:00.000Z"
}
```

`revision` refleja `AIBRAIN_REVISION` solo cuando contiene un SHA Git completo
de 40 caracteres hexadecimales; una configuración ausente o inválida devuelve
`null` y nunca se refleja texto arbitrario. Es un readback público acotado del
proceso HTTP, no sustituye la correlación privada de estado de release, digests
OCI y contenedores en ejecución.

Para readiness de usuario/proyecto, usar `/api/runtime/status`.

`GET /api/health/ready` comprueba que las raíces de datos, backups, documentos
y usuarios son directorios accesibles con aislamiento seguro, que queda al
menos 20 % y 1 GiB de disco libre y que no aparece `docker.sock` en el
contenedor. Además agrega tres probes requeridos: Codex 0.149.1 más launcher y
`bwrap`, Chromium con versión exacta más launcher, y LibreOffice/Poppler/QPDF.
Devuelve `200` con `status: "ready"` solo si todos pasan; cualquier componente
`degraded | unavailable` devuelve `503`, con códigos no sensibles. Los probes
solo inspeccionan ejecutables/versiones: no crean workers, perfiles o browsers
ni tocan sesiones de empleados.

## 16. Reglas de integración para la rama UI

1. Obtener la sesión con `/api/auth/session`; no leer cookies ni tokens directamente.
2. Consumir branding mediante los props server-side existentes hasta que haya un endpoint acordado.
3. Generar UUID únicos antes de iniciar un turn y conservarlos durante stream, refresh y retry.
4. Parsear `/api/chat` por líneas NDJSON; no usar `EventSource`.
5. Reducir eventos con las reglas de la sección 6.3 y tratar `snapshot` como autoridad durable.
6. Enviar approvals usando exactamente los IDs del evento; enviar stop/steer usando solo IDs locales.
7. Consultar `/api/runtime/status` para modelos, skills y capacidades. Un manifest visual no habilita tools.
8. Usar las URLs de preview/artifact entregadas por backend, nunca construir paths filesystem.
9. Mantener `confirmationToken` de publicación fuera de logs/URLs y usar el mismo `clientRequestId` al reintentar la misma decisión.
10. No ofrecer Computer Use ni llamar rutas browser retiradas. Conservar la lectura de resultados históricos.

## 17. Fuentes de implementación

- Auth: [`src/auth/types.ts`](../src/auth/types.ts), [`src/auth/session.ts`](../src/auth/session.ts), [`src/auth/auth-service.ts`](../src/auth/auth-service.ts), [`src/app/api/auth`](../src/app/api/auth).
- Memoria explícita: [`src/memory`](../src/memory), [`src/app/api/memory`](../src/app/api/memory), [`tests/integration/memory-routes.integration.test.ts`](../tests/integration/memory-routes.integration.test.ts).
- Instalación: [`src/config/installation-schema.ts`](../src/config/installation-schema.ts), [`src/config/installation-branding.ts`](../src/config/installation-branding.ts).
- Workbench: [`src/workbench/types.ts`](../src/workbench/types.ts), [`src/app/api/projects`](../src/app/api/projects), [`src/app/api/threads`](../src/app/api/threads).
- Chat/runtime: [`src/lib/chat-contract.ts`](../src/lib/chat-contract.ts), [`src/lib/runtime-status.ts`](../src/lib/runtime-status.ts), [`src/app/api/chat/route.ts`](../src/app/api/chat/route.ts), [`src/app/api/runtime`](../src/app/api/runtime).
- Usage: [`src/usage`](../src/usage), [`src/app/api/usage`](../src/app/api/usage).
- Documentos/publicación: [`src/documents`](../src/documents), [`src/app/api/threads/[threadId]/documents`](../src/app/api/threads/%5BthreadId%5D/documents), [`src/app/api/threads/[threadId]/publications`](../src/app/api/threads/%5BthreadId%5D/publications).
- Pruebas de rutas: [`tests/integration`](../tests/integration).

## 18. Settings, apps and capability policy

`GET /api/settings` returns a private, no-store `schemaVersion: 1` snapshot for
the authenticated employee. The snapshot separates account/company identity,
the real capability catalogue, in-app notification preferences, effective
permission rules and privacy/isolation facts. Legacy browser metadata is retained for snapshot compatibility only.

Apps use `connected | available | blocked | not_configured`. A connected label
requires live runtime evidence. No route creates OAuth, secret or provider
records. Missing external adapters are configuration work, not a clickable
fake connection.

`PATCH /api/settings` accepts one strict mutation:

- `{ target: "user-app", appId, enabled }`
- `{ target: "installation-app", appId, enabled }` (admin only)
- `{ target: "notifications", values }`

Controllable app IDs are `web-search`, `image-generation` and `skills`.
Both policy files are private (`0600`), atomically replaced under a cross-process
resource lock, and scoped to the current installation or employee. `/api/chat`
enforces web/image/skill gates. The stored `managed-browser` switch remains
readable so existing strict policy/settings records do not require a destructive
migration, but is absent from the catalogue/admin controls and rejected by
`PATCH /api/settings`.
