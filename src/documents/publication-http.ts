import { NextResponse } from "next/server";
import { PublicationStorageBackpressureError } from "@/documents/publication-capacity";
import { operationalLogger } from "@/operations/server-logger";
import { StorageError } from "@/storage";

export function publicationDecisionError(error: unknown) {
  const code = error instanceof StorageError ? error.code : "PUBLICATION_UNAVAILABLE";
  operationalLogger.warn("publication.decision_rejected", { code });
  if (code === "PUBLICATION_REMOTE_UNCERTAIN") {
    return NextResponse.json({ code, error: "No se ha confirmado el guardado. Comprueba el estado de esta misma operación; no prepares otra copia todavía." }, { status: 503 });
  }
  if (code === "PUBLICATION_REMOTE_DISABLED") {
    return NextResponse.json({ code, error: "El guardado en el servidor todavía no está habilitado." }, { status: 503 });
  }
  if (error instanceof PublicationStorageBackpressureError) {
    return NextResponse.json(
      { error: "El volum documental necessita marge abans de publicar.", code, retryable: true },
      {
        status: 429,
        headers: { "Retry-After": String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000))) },
      },
    );
  }
  if (code === "PUBLICATION_STORAGE_CAPACITY_UNAVAILABLE") {
    return NextResponse.json(
      { error: "No s’ha pogut verificar la capacitat del volum documental.", code, retryable: true },
      { status: 503 },
    );
  }
  if (code === "PUBLICATION_NOT_FOUND") {
    return NextResponse.json({ error: "Publicació no trobada." }, { status: 404 });
  }
  if (code === "PUBLICATION_TOKEN_INVALID" || code === "PUBLICATION_TOKEN_EXPIRED") {
    return NextResponse.json({ error: "La confirmació ha caducat o no és vàlida." }, { status: 403 });
  }
  if (code.includes("CONFLICT") || code === "PUBLICATION_ALREADY_DECIDED") {
    return NextResponse.json({ error: "La publicació ja s’ha decidit o el document original ha canviat." }, { status: 409 });
  }
  if (code.includes("INVALID") || code.includes("MISMATCH") || code.includes("UNSAFE")) {
    return NextResponse.json({ error: "La decisió de publicació no és segura." }, { status: 400 });
  }
  return NextResponse.json({ error: "No s’ha pogut completar la decisió." }, { status: 503 });
}
