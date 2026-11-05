import type { Metadata, Viewport } from "next";
import { Geist_Mono } from "next/font/google";
import Script from "next/script";
import type { CSSProperties } from "react";
import { ThemeProvider } from "@/components/theme-provider";
import { loadInstallationConfig } from "@/config/installation";
import { publicInstallationBranding } from "@/config/installation-branding";
import { THEME_BOOTSTRAP_SCRIPT } from "@/ui/theme";
import { translate } from "@/i18n/messages";
import { getSession } from "@/auth/session";
import { installationUiLocale, userUiLocale } from "@/i18n/server";
import { UiLocaleProvider } from "@/i18n/provider";
import { SupportSessionBanner } from "@/auth/support-session-banner";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const dynamic = "force-dynamic";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

export async function generateMetadata(): Promise<Metadata> {
  const installation = await loadInstallationConfig();
  return {
    metadataBase: new URL(installation.publicUrl),
    applicationName: installation.branding.productName,
    title: {
      default: `${installation.branding.productName} · ${installation.companyName}`,
      template: `%s · ${installation.branding.productName}`,
    },
    description: translate(await installationUiLocale(), "Espacio de trabajo privado de {company}.", { company: installation.companyName }),
    icons: {
      icon: installation.branding.faviconPath,
    },
  };
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const locale = await userUiLocale(await getSession());
  const branding = publicInstallationBranding(await loadInstallationConfig());
  const installationStyle = { "--installation-accent": branding.accentColor } as CSSProperties;

  return (
    <html
      lang={locale}
      data-installation={branding.installationId}
      data-theme="light"
      suppressHydrationWarning
      style={installationStyle}
    >
      <body className={geistMono.variable}>
        <SupportSessionBanner />
        <UiLocaleProvider locale={locale}><ThemeProvider>{children}</ThemeProvider></UiLocaleProvider>
        <Script id="aibrain-theme" strategy="beforeInteractive">
          {THEME_BOOTSTRAP_SCRIPT}
        </Script>
      </body>
    </html>
  );
}
