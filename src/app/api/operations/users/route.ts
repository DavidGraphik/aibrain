import { NextResponse } from "next/server";
import { isSameOriginMutation } from "@/auth/request-security";
import { isOperatorAuthorized } from "@/operations/operator-auth";
import { SchemaValidationError } from "@/storage/errors";
import {
  UserLifecycleError,
  userLifecycleCommandSchema,
} from "@/users/lifecycle";
import { executeUserLifecycleCommand } from "@/users/lifecycle-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = Object.freeze({ "Cache-Control": "private, no-store" });

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

export async function POST(request: Request) {
  if (!isOperatorAuthorized(request)) {
    return NextResponse.json(
      { error: "Operator authentication required.", code: "OPERATOR_AUTH_REQUIRED" },
      {
        status: 401,
        headers: { ...NO_STORE_HEADERS, "WWW-Authenticate": "Bearer" },
      },
    );
  }
  if (!await isSameOriginMutation(request)) {
    return json({ error: "Origin not authorized.", code: "ORIGIN_NOT_ALLOWED" }, 403);
  }
  try {
    const command = userLifecycleCommandSchema.parse(
      await request.json().catch(() => null),
      "operator user lifecycle request",
    );
    return json(await executeUserLifecycleCommand(command));
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      return json({ error: "User lifecycle command is invalid.", code: "USER_LIFECYCLE_COMMAND_INVALID" }, 400);
    }
    if (error instanceof UserLifecycleError) {
      return json({ error: error.message, code: error.code }, error.status);
    }
    return json({ error: "User lifecycle operation failed.", code: "USER_LIFECYCLE_OPERATION_FAILED" }, 503);
  }
}
