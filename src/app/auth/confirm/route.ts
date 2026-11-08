import { NextResponse } from "next/server";
import { getPublicOrigin } from "@/auth/public-url";

export const runtime = "nodejs";

// Legacy magic-link, invite and signup callbacks are intentionally rejected.
// Recovery has its own narrowly scoped flow at /auth/recovery.
export async function GET() {
  const response = NextResponse.redirect(new URL("/auth/error", await getPublicOrigin()), 303);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
