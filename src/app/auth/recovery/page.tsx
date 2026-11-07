import { cookies } from "next/headers";
import { PASSWORD_RECOVERY_COOKIE } from "@/auth/session-cookie";
import type { Metadata } from "next";
import { recoveryProofFromQuery } from "@/auth/recovery-proof";
import { RecoveryForm } from "@/components/recovery-form";
import { loadInstallationConfig } from "@/config/installation";
import { publicInstallationBranding } from "@/config/installation-branding";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { referrer: "no-referrer", robots: { index: false, follow: false } };

export default async function RecoveryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const installation = await loadInstallationConfig();
  const proof = recoveryProofFromQuery(params);
  const hasRecoveryCookie = /^[A-Za-z0-9_-]{43}$/.test((await cookies()).get(PASSWORD_RECOVERY_COOKIE)?.value ?? "");
  return (
    <RecoveryForm
      branding={publicInstallationBranding(installation)}
      proof={proof?.code && !hasRecoveryCookie ? null : proof}
    />
  );
}
