import { redirect } from "next/navigation";
import { LoginForm } from "@/components/login-form";
import {
  getAuthMode,
  getSession,
  isVercelPreviewDemoEnabled,
} from "@/auth/session";
import { loadInstallationConfig } from "@/config/installation";
import { publicInstallationBranding } from "@/config/installation-branding";
import { listDemoAccounts } from "@/config/tenants";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ settings?: string }> }) {
  const { settings } = await searchParams;
  const returnTo: "/" | "/?settings=connectors" | "/?settings=memory" = settings === "connectors" || settings === "memory" ? `/?settings=${settings}` : "/";
  if (await getSession()) redirect(returnTo);
  const installation = await loadInstallationConfig();
  const mode = getAuthMode();

  return (
    <LoginForm
      accounts={mode === "demo" ? listDemoAccounts() : []}
      branding={publicInstallationBranding(installation)}
      returnTo={returnTo}
      mode={mode}
      remotePreview={isVercelPreviewDemoEnabled()}
    />
  );
}
