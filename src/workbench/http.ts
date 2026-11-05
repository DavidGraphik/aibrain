import "server-only";

import { NextResponse } from "next/server";
import {
  WorkbenchConflictError,
  WorkbenchNotFoundError,
  WorkbenchPersistenceError,
  WorkbenchValidationError,
} from "@/workbench/errors";
import { operationalLogger } from "@/operations/server-logger";

export function workbenchErrorResponse(error: unknown, fallback: string) {
  if (error instanceof WorkbenchNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof WorkbenchConflictError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof WorkbenchValidationError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof WorkbenchPersistenceError) {
    return NextResponse.json({ error: error.message }, { status: 503 });
  }
  operationalLogger.error("workbench.request_failed", { error, fallback });
  return NextResponse.json({ error: fallback }, { status: 503 });
}
