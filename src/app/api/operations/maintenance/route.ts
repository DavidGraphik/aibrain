import { NextResponse } from "next/server";
import { isSameOriginMutation } from "@/auth/request-security";
import {
  MaintenanceDrainInterruptedError,
  MaintenanceDrainTimeoutError,
} from "@/operations/maintenance";
import { isOperatorAuthorized } from "@/operations/operator-auth";
import {
  enterWorkerMaintenance,
  resumeWorkerMaintenance,
  workerMaintenanceStatus,
} from "@/runtime/worker-runtime-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = Object.freeze({ "Cache-Control": "private, no-store" });
const MAX_DRAIN_TIMEOUT_MS = 10 * 60_000;

function unauthorized() {
  return NextResponse.json(
    { error: "Operator authentication required.", code: "OPERATOR_AUTH_REQUIRED" },
    {
      status: 401,
      headers: { ...NO_STORE_HEADERS, "WWW-Authenticate": "Bearer" },
    },
  );
}

function parseCommand(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const command = value as Record<string, unknown>;
  if (command.action === "resume" && Object.keys(command).length === 1) {
    return { action: "resume" as const };
  }
  if (
    command.action === "drain" &&
    Object.keys(command).every((key) => key === "action" || key === "timeoutMs") &&
    Number.isSafeInteger(command.timeoutMs) &&
    Number(command.timeoutMs) >= 1 &&
    Number(command.timeoutMs) <= MAX_DRAIN_TIMEOUT_MS
  ) {
    return { action: "drain" as const, timeoutMs: Number(command.timeoutMs) };
  }
  return null;
}

export async function GET(request: Request) {
  if (!isOperatorAuthorized(request)) return unauthorized();
  return NextResponse.json(await workerMaintenanceStatus(), { headers: NO_STORE_HEADERS });
}

export async function POST(request: Request) {
  if (!isOperatorAuthorized(request)) return unauthorized();
  if (!await isSameOriginMutation(request)) {
    return NextResponse.json(
      { error: "Origin not authorized.", code: "ORIGIN_NOT_ALLOWED" },
      { status: 403, headers: NO_STORE_HEADERS },
    );
  }
  const command = parseCommand(await request.json().catch(() => null));
  if (!command) {
    return NextResponse.json(
      { error: "Maintenance command is invalid.", code: "MAINTENANCE_COMMAND_INVALID" },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  try {
    const status = command.action === "resume"
      ? await resumeWorkerMaintenance()
      : await enterWorkerMaintenance({ timeoutMs: command.timeoutMs });
    return NextResponse.json(status, { headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof MaintenanceDrainTimeoutError) {
      return NextResponse.json(
        { error: error.message, code: error.code, status: error.status },
        { status: 409, headers: NO_STORE_HEADERS },
      );
    }
    if (error instanceof MaintenanceDrainInterruptedError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 409, headers: NO_STORE_HEADERS },
      );
    }
    return NextResponse.json(
      { error: "Maintenance operation failed.", code: "MAINTENANCE_OPERATION_FAILED" },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
}
