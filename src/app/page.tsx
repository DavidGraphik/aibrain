import { redirect } from "next/navigation";
import { getSession } from "@/auth/session";
import { canAccessInsiJetsCMS } from "@/insijets/cms-access";
import { BrainApp } from "@/components/brain-app";
import { baseBrainManifest } from "@/config/brain";
import { loadInstallationConfig } from "@/config/installation";
import {
  applyInstallationBranding,
  publicInstallationBranding,
} from "@/config/installation-branding";
import { getSeedManifest } from "@/config/tenants";
import { loadWorkbench } from "@/workbench/store";
import { userUiLocale } from "@/i18n/server";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ settings?: string }> }) {
  const { settings } = await searchParams;
  const loginPath = settings === "connectors" || settings === "memory" ? `/login?settings=${settings}` : "/login";
  const session = await getSession();
  if (!session) redirect(loginPath);

  const installation = await loadInstallationConfig();
  const storedManifest = session.provider === "local"
    ? { ...baseBrainManifest, id: `aibrain-${installation.installationId}` }
    : getSeedManifest(session.tenant.id);
  if (!storedManifest) redirect("/login");

  const locale = await userUiLocale(session);
  const manifest = applyInstallationBranding({
    ...storedManifest,
    identity: { ...storedManifest.identity, language: locale },
  }, installation);
  const branding = publicInstallationBranding(installation);
  const workbench = await loadWorkbench(session, true);

  return (
    <BrainApp
      branding={branding}
      manifest={manifest}
      session={session}
      initialWorkbench={workbench}
      insijetsWorkspaceAccess={canAccessInsiJetsCMS(session, installation.installationId)}
      insijetsOutreachAccess={canAccessInsiJetsCMS(session, installation.installationId) && process.env.AIBRAIN_INSIJETS_OPERATOR_ENABLED === "true" && process.env.AIBRAIN_INSIJETS_OUTREACH_SYSTEM_ENABLED === "true"}
      insijetsSourcingAccess={canAccessInsiJetsCMS(session, installation.installationId) && process.env.AIBRAIN_INSIJETS_MULTISOURCE_V2_ENABLED === 'true'}
    />
  );
}
