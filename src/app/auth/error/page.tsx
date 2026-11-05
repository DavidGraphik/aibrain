import { installationUiLocale } from "@/i18n/server";
import { translate } from "@/i18n/messages";
import Link from "next/link";
import { WarningCircle } from "@phosphor-icons/react/dist/ssr";

export default async function AuthErrorPage() {
  const locale = await installationUiLocale();
  const t = (source: string) => translate(locale, source);
  return (
    <main className="grid min-h-[100dvh] place-items-center bg-[var(--page)] px-5 text-[var(--text)]">
      <section className="w-full max-w-[440px] rounded-[24px] border border-[var(--border)] bg-[var(--surface-raised)] p-8 text-center shadow-[var(--shadow-lg)]">
        <span className="mx-auto grid size-11 place-items-center rounded-2xl bg-[var(--danger-soft)] text-[var(--danger)]">
          <WarningCircle size={20} />
        </span>
        <h1 className="mt-6 text-[24px] font-semibold tracking-[-.04em]">{t("No hemos podido validar el acceso")}</h1>
        <p className="mt-3 text-[14px] leading-6 text-[var(--text-secondary)]">
          {t("El enlace puede haber caducado, ya se ha utilizado o esta cuenta todavía no tiene una empresa asignada.")}
        </p>
        <Link href="/login" className="mt-7 inline-flex min-h-11 items-center rounded-lg bg-[var(--text)] px-4 py-2.5 text-[12px] font-semibold text-[var(--surface)]">
          {t("Volver al acceso")}
        </Link>
      </section>
    </main>
  );
}
