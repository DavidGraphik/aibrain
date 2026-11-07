import "server-only";

import { NextResponse } from "next/server";
import {
  LibraryResourceLocationConflictError,
  LibraryResourceLocationNotFoundError,
} from "@/library/resource-location-index";
import { LibraryResourceForbiddenError } from "@/library/server-resource-access";
import { WorkbenchNotFoundError } from "@/workbench/errors";

export function contentDisposition(fileName: string, mode: "inline" | "attachment") {
  const fallback = fileName
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._ -]/g, "-")
    .replace(/["\\]/g, "-")
    .trim()
    .slice(0, 120) || "archivo";
  const encoded = encodeURIComponent(fileName)
    .replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${mode}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function libraryResourceErrorResponse(error: unknown, notFoundMessage: string) {
  if (error instanceof LibraryResourceForbiddenError) {
    return NextResponse.json({ error: error.message }, { status: 403 });
  }
  if (error instanceof LibraryResourceLocationConflictError) {
    return NextResponse.json({ error: "El recurso ya no coincide con su ubicación indexada." }, { status: 409 });
  }
  if (error instanceof LibraryResourceLocationNotFoundError || error instanceof WorkbenchNotFoundError) {
    return NextResponse.json({ error: notFoundMessage }, { status: 404 });
  }
  return null;
}
