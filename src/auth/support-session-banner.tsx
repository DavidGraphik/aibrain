import { getSession } from "@/auth/session";
export async function SupportSessionBanner() {
  const session = await getSession();
  if (!session?.support) return null;
  return <aside role="status" data-testid="support-session-banner" style={{ pointerEvents: "none", position: "fixed", top: 0, right: 0, zIndex: 10000, maxWidth: "70vw", padding: "4px 12px", background: "#fef3c7", color: "#78350f", fontSize: 12 }}>
    Suport temporal · {session.user.name} · {session.user.email} · operador {session.support.actorEmail} · fins {session.support.expiresAt}
  </aside>;
}
