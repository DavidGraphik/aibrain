import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { isSameOriginMutation } from "@/auth/request-security";
import { codexManagedAppActionForSession } from "@/connectors/server-service";

export const runtime = "nodejs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function opaqueId(value: unknown) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value) ? value : null;
}

function prepareInput(value: unknown) {
  if (!isRecord(value) || Object.keys(value).length !== 5 || value.operation !== "prepare") return null;
  const threadId = opaqueId(value.threadId);
  const turnId = opaqueId(value.turnId);
  const itemId = opaqueId(value.itemId);
  const approvalId = opaqueId(value.approvalId);
  return threadId && turnId && itemId && approvalId ? { threadId, turnId, itemId, approvalId } : null;
}

function executeInput(value: unknown) {
  if (!isRecord(value) || Object.keys(value).length !== 3 || value.operation !== "execute" ||
      !isRecord(value.locator) || typeof value.authorizationFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.authorizationFingerprint)) return null;
  const locator = value.locator;
  const threadId = opaqueId(locator.threadId);
  const turnId = opaqueId(locator.turnId);
  const itemId = opaqueId(locator.itemId);
  const approvalId = opaqueId(locator.approvalId);
  if (Object.keys(locator).length !== 4 || !threadId || !turnId || !itemId || !approvalId) return null;
  return { operation: "execute" as const, locator: { threadId, turnId, itemId, approvalId }, authorizationFingerprint: value.authorizationFingerprint };
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "CONNECTOR_ACTION_UNAVAILABLE";
}

export async function POST(request: Request) {
  if (!await isSameOriginMutation(request)) {
    return NextResponse.json({ error: "Origen no autoritzat." }, { status: 403 });
  }
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  const body: unknown = await request.json().catch(() => null);
  const prepare = prepareInput(body);
  const execute = prepare ? null : executeInput(body);
  if (!prepare && !execute) {
    return NextResponse.json({ error: "La acción del conector no es válida." }, { status: 400 });
  }
  try {
    const action = await codexManagedAppActionForSession(session);
    if (prepare) {
      const result = await action.prepare({
        installationId: session.tenant.id,
        userId: session.user.id,
        ...prepare,
      });
      return NextResponse.json({ schemaVersion: 1, descriptor: result }, {
        headers: { "Cache-Control": "private, no-store" },
      });
    }
    if (!execute) {
      return NextResponse.json({ error: "La acción del conector no es válida." }, { status: 400 });
    }
    const result = await action.execute({ ...execute, operation: "execute-allowlisted-action" });
    return NextResponse.json({ schemaVersion: 1, outcome: result.outcome }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: "La acción del conector no está disponible.", code: errorCode(error), retryable: false },
      { status: 409, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
