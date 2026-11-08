import { NextResponse, type NextRequest } from "next/server";
import { LOCAL_SESSION_COOKIE } from "@/auth/session-cookie-name";
import { SUPPORT_PREVIEW_SESSION_PREFIX } from "@/auth/support-preview-cookie";
import { createLocalSessionContext } from "@/auth/auth-context";

export async function proxy(request: NextRequest) {
  // Ordinary sessions take the unchanged fast path. A synthetic support
  // cookie is a server-issued restriction, not an authentication credential by
  // itself: missing, expired, revoked or malformed records fail closed.
  const cookie=request.cookies.get(LOCAL_SESSION_COOKIE)?.value;
  const url=new URL(request.url);
  const api=url.pathname.startsWith("/api/");
  if (cookie?.startsWith(SUPPORT_PREVIEW_SESSION_PREFIX) && (api || !["GET","HEAD","OPTIONS"].includes(request.method))) {
    try {
      const {installation,sessions}=await createLocalSessionContext();
      const current=await sessions.read(cookie,installation.installationId);
      const preview=current?.record.support?.preview;
      if (!current || !preview || !await sessions.isActiveBinding(installation.installationId,current.record.userId,current.record.sessionIdHash)) throw new Error("Invalid preview session");
      const readOnly=["GET","HEAD","OPTIONS"].includes(request.method);
      // Do not assume GET is harmless: OAuth callbacks and forwarded APIs may
      // change external state. Only the UI bootstrap and this thread are allowed.
      const readPaths=new Set(["/api/auth/session","/api/workbench","/api/threads","/api/projects",
        "/api/g03/welcome","/api/settings","/api/connectors","/api/connectors/mentions",
        "/api/connectors/mail/capability","/api/usage/me","/api/usage/budget","/api/task-center","/api/library"]);
      const projectRead=/^\/api\/projects\/[0-9a-f-]{36}(?:\/(?:files|threads))?$/i.test(url.pathname);
      const threadRead=url.pathname===`/api/threads/${preview.threadId}`;
      const previewRead=url.pathname==="/api/g03/production/preview" && url.searchParams.get("id")===preview.appId;
      const allowed=readOnly ? (readPaths.has(url.pathname)||projectRead||threadRead||previewRead) :
        (url.pathname==="/api/chat" || url.pathname==="/api/auth/logout" || previewRead);
      if (!allowed) throw new Error("Preview session is read-only outside its synthetic turn");
    } catch { return NextResponse.json({error:"Aquesta sessió només permet operar a la vista sintètica vinculada."},{status:403,headers:{"Cache-Control":"private, no-store"}}); }
  }
  return NextResponse.next({ request });
}

export const config = {
  matcher: [
    "/api/:path*",
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
