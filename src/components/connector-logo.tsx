"use client";
import { useState } from "react";
import { Plugs } from "@phosphor-icons/react";
import { connectorPresentation } from "@/connectors/presentation";

export function ConnectorLogo({ id, size = 24 }: { id: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const { logoUrl } = connectorPresentation(id);
  return logoUrl && !failed
    // Provider's public logo endpoint; no account identity or referrer is sent.
    // eslint-disable-next-line @next/next/no-img-element
    ? <img src={logoUrl} alt="" width={size} height={size} referrerPolicy="no-referrer" onError={() => setFailed(true)} style={{ width: size, height: size, objectFit: "contain", flexShrink: 0 }} />
    : <Plugs aria-hidden size={size} className="shrink-0 text-[var(--text-subtle)]" />;
}
