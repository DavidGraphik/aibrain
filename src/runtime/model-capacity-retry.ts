import type { RuntimeModelOption, RuntimeReasoningEffort } from "@/lib/runtime-status";

/** Only a confirmed, empty provider admission failure can authorize another
 * model submission. Transport failures and partial work never qualify.
 * Both bounded retries wait ten seconds, matching the visible chat notice. */
export const MODEL_CAPACITY_RETRY_DELAYS_MS = [10_000, 10_000] as const;
export const MODEL_CAPACITY_MESSAGE = "El servicio de IA está temporalmente saturado. La conversación y los adjuntos se conservan. Vuelve a intentarlo en unos minutos.";

// The pinned App Server contract does not expose Retry-After. A 429 is not
// evidence of model overload and must not authorize this module's rerouting.
export const MODEL_RATE_LIMIT_MESSAGE = "El proveedor de IA ha rechazado la petición por un límite de solicitudes o de uso. Este intento no se ha completado; la conversación y los adjuntos se conservan. AI Brain no repetirá automáticamente este turno. Respeta el plazo o resuelve la restricción de cuenta que indique el proveedor antes de volver a intentarlo.";
export const MODEL_RATE_LIMIT_PENDING_MESSAGE = "El proveedor de IA ha rechazado la petición por un límite de solicitudes o de uso. El servicio ha anunciado un reintento; este turno sigue pendiente. Este aviso no inicia otro intento desde AI Brain.";

export type CapacityModel = { model: string; effort: RuntimeReasoningEffort | null };
// Family names only define the preference order. Every candidate still needs
// a fresh catalog match below; this list grants neither access nor capability.
const ALTERNATIVES: Record<string, readonly string[]> = {
  "gpt-6.1-terra": ["gpt-6.1-sol"],
  "gpt-6.1-sol": ["gpt-6-sol", "gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-luna"],
  "gpt-6-sol": ["gpt-6.1-sol", "gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-luna"],
  "gpt-6-luna": ["gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol", "gpt-6-astra", "gpt-5.6-terra"],
  "gpt-6-astra": ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"],
  "gpt-5.6-sol": ["gpt-6-astra", "gpt-5.6-terra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"],
  "gpt-5.6-terra": ["gpt-5.6-sol", "gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"],
};

export function capacityFallback(input: {
  originalModel: string | null; currentModel: string | null;
  effort: RuntimeReasoningEffort | null; models: readonly RuntimeModelOption[];
  requiresImages: boolean; imageGeneration: boolean;
}): CapacityModel | null {
  // Only product-supported families with a fresh positive catalog match.
  // Image-generation capabilities are not advertised per model in this catalog.
  if (!input.originalModel || input.imageGeneration) return null;
  for (const id of ALTERNATIVES[input.originalModel] ?? []) {
    if (id === input.currentModel) continue;
    const model = input.models.find(value => value.id === id);
    if (!model || !model.inputModalities.includes("text") ||
        (input.requiresImages && !model.inputModalities.includes("image"))) continue;
    const effort = input.effort && model.supportedReasoningEfforts.includes(input.effort)
      ? input.effort : model.defaultReasoningEffort;
    if (effort && !model.supportedReasoningEfforts.includes(effort)) continue;
    return { model: id, effort };
  }
  return null;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Structured variants from the pinned v2 CodexErrorInfo contract only.
 * Message/log text and a bare status cannot prove a provider rate limit. */
export function isModelRateLimitError(error: unknown) {
  if (!record(error)) return false;
  const info = error.codexErrorInfo;
  if (info === "rateLimitExceeded") return true;
  if (!record(info)) return false;
  return ["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts"]
    .some(key => { const detail = info[key]; return record(detail) && detail.httpStatusCode === 429; });
}

export function isModelCapacityError(error: unknown) {
  return record(error) && error.codexErrorInfo === "serverOverloaded";
}

export function isRejectedModelAdmission(turn: unknown, turnId: string, clientUserMessageId: string) {
  return record(turn) && turn.id === turnId && turn.status === "failed" &&
    isModelCapacityError(turn.error) && Array.isArray(turn.items) && turn.items.length === 1 &&
    turn.items.every(item => record(item) && item.type === "userMessage" && item.clientId === clientUserMessageId);
}

export class ModelCapacityRetryReady extends Error {
  constructor() { super("A confirmed empty capacity rejection has a durable retry intent."); }
}
