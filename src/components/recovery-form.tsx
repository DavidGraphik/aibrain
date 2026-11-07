"use client";
import { useUiText } from "@/i18n/provider";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { BrandMark, ThemeToggle } from "@/components/ui/primitives";
import { customAccentTokens } from "@/config/brain";
import type { PublicInstallationBranding } from "@/config/installation-branding";

type RecoveryStyle = CSSProperties & {
  "--brain-accent-light": string;
  "--brain-accent-dark": string;
  "--brain-accent-on-soft-light": string;
  "--brain-accent-on-soft-dark": string;
  "--brain-contrast-light": string;
  "--brain-contrast-dark": string;
};

export function RecoveryForm({
  branding,
  proof,
}: {
  branding: PublicInstallationBranding;
  proof: { code: string } | { tokenHash: string } | null;
}) {
  const t = useUiText();
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [showPasswords, setShowPasswords] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextStep, setNextStep] = useState<"new_link" | "sign_in" | null>(null);
  const locked = useRef(false);
  const style = useMemo<RecoveryStyle>(() => {
    const accent = customAccentTokens(branding.accentColor) ?? customAccentTokens("#315ee7")!;
    return {
      "--brain-accent-light": accent.onLight,
      "--brain-accent-dark": accent.onDark,
      "--brain-accent-on-soft-light": accent.onLightSoft,
      "--brain-accent-on-soft-dark": accent.onDarkSoft,
      "--brain-contrast-light": accent.onLightContrast,
      "--brain-contrast-dark": accent.onDarkContrast,
    };
  }, [branding.accentColor]);

  useEffect(() => {
    window.history.replaceState(window.history.state, "", "/auth/recovery");
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!proof || locked.current) return;
    setError(null);
    if (password !== confirmation) {
      setError(t("Las contraseñas no coinciden. Introduce la misma contraseña en ambos campos."));
      return;
    }
    if (password.length < 12 || password.length > 128 || !/[A-Za-zÀ-ÖØ-öø-ÿ]/.test(password) || !/[0-9]/.test(password)) {
      setError(t("Entre 12 y 128 caracteres, con al menos una letra y un número."));
      return;
    }
    locked.current = true;
    setLoading(true);
    try {
      const response = await fetch("/api/auth/password/recovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...proof, password, confirmation }),
      });
      const payload: unknown = await response.json().catch(() => null);
      const body = payload && typeof payload === "object" ? payload as { code?: unknown; nextStep?: unknown; authenticated?: unknown } : null;
      if (!response.ok) {
        if (body?.nextStep === "sign_in") {
          setNextStep("sign_in"); setPassword(""); setConfirmation("");
          setError(body.code === "recovery_session_unavailable"
            ? t("La contraseña se ha actualizado, pero no hemos podido abrir tu sesión. Vuelve al acceso para entrar.")
            : body.code === "recovery_account_unavailable"
              ? t("No se ha podido autorizar esta cuenta. Vuelve al acceso o contacta con el administrador.")
              : body.code === "recovery_verification_required"
                ? t("El servicio exige una verificación adicional. Vuelve al acceso o contacta con el administrador.")
              : t("No hemos podido confirmar el cambio de contraseña. Comprueba el acceso antes de solicitar otro enlace."));
        } else if (body?.nextStep === "new_link" || response.status === 410 || response.status === 401 || response.status === 422) {
          setNextStep("new_link"); setPassword(""); setConfirmation("");
          setError(response.status === 410
            ? t("El enlace de recuperación no es válido, ya se ha usado o ha caducado. Solicita otro enlace.")
            : body?.code === "recovery_password_rejected"
              ? t("El proveedor ha rechazado la contraseña. Solicita otro enlace para elegir una contraseña distinta.")
              : t("No se ha completado la recuperación. Solicita otro enlace antes de volver a intentarlo."));
        } else if (body?.nextStep === "retry" || response.status === 429) {
          locked.current = false;
          setError(response.status === 429 ? t("Demasiados intentos. Vuelve a intentarlo más tarde.")
            : response.status === 400 ? t("Revisa que ambas contraseñas coincidan y tengan entre 12 y 128 caracteres, una letra y un número.")
              : t("El servicio no está disponible. Vuelve a intentarlo más tarde."));
        } else {
          setNextStep("sign_in"); setPassword(""); setConfirmation("");
          setError(t("No hemos podido confirmar el cambio de contraseña. Comprueba el acceso antes de solicitar otro enlace."));
        }
        return;
      }
      if (body?.authenticated !== true) throw Error("Recovery outcome unconfirmed");
      router.replace("/");
      router.refresh();
    } catch {
      setNextStep("sign_in"); setPassword(""); setConfirmation("");
      setError(t("No hemos podido confirmar el cambio de contraseña. Comprueba el acceso antes de solicitar otro enlace."));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={style} className="auth-brand-surface relative grid min-h-[100dvh] place-items-center bg-[var(--canvas)] px-5 py-20 text-[var(--text)]">
      <header className="absolute inset-x-5 top-[max(1.25rem,env(safe-area-inset-top))] flex items-center justify-between sm:inset-x-8 sm:top-7">
        <BrandMark branding={branding} />
        <ThemeToggle />
      </header>
      <section className="w-full max-w-md rounded-[26px] border border-[var(--border)] bg-[var(--surface-raised)] p-8 shadow-[var(--shadow-lg)]">
        <p className="text-[10px] font-semibold uppercase tracking-[.12em] text-[var(--text-subtle)]">{branding.productName}</p>
        <h1 className="mt-4 text-[28px] font-semibold tracking-[-.045em]">{t("Crea una contraseña nueva")}</h1>
        {!proof ? (
          <div className="mt-5 rounded-xl bg-[var(--danger-soft)] px-4 py-3 text-[12px] text-[var(--danger)]"><p role="alert">{t("El enlace de recuperación no es válido o ha caducado.")}</p><Link href="/login" className="mt-3 inline-flex min-h-11 items-center rounded-lg border border-current px-3 font-semibold">{t("Volver al acceso")}</Link></div>
        ) : nextStep ? (
          <div className="mt-6"><Link href="/login" className="inline-flex min-h-11 items-center rounded-lg border border-[var(--border)] px-3 text-[12px] font-semibold">{nextStep === "new_link" ? t("Solicitar otro enlace") : t("Volver al acceso")}</Link></div>
        ) : (
          <form onSubmit={(event) => void submit(event)} className="mt-6 space-y-4" aria-busy={loading}>
            <label className="block" htmlFor="recovery-password">
              <span className="mb-2 block text-[12px] font-medium text-[var(--text-muted)]">{t("Contraseña nueva")}</span>
              <input autoFocus id="recovery-password" type={showPasswords ? "text" : "password"} autoComplete="new-password" minLength={12} maxLength={128} required value={password} onChange={(event) => setPassword(event.target.value)} aria-describedby="recovery-password-requirements" className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 py-3 text-[14px] text-[var(--text)] outline-none focus-visible:border-[var(--focus)] focus-visible:ring-2 focus-visible:ring-[var(--brain-accent-soft)]" />
            </label>
            <label className="block" htmlFor="recovery-password-confirmation">
              <span className="mb-2 block text-[12px] font-medium text-[var(--text-muted)]">{t("Repite la contraseña")}</span>
              <input id="recovery-password-confirmation" type={showPasswords ? "text" : "password"} autoComplete="new-password" minLength={12} maxLength={128} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} aria-describedby="recovery-password-requirements" className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3.5 py-3 text-[14px] text-[var(--text)] outline-none focus-visible:border-[var(--focus)] focus-visible:ring-2 focus-visible:ring-[var(--brain-accent-soft)]" />
            </label>
            <button type="button" aria-pressed={showPasswords} aria-controls="recovery-password recovery-password-confirmation" onClick={() => setShowPasswords((shown) => !shown)} className="min-h-11 rounded-lg px-2 text-[12px] font-semibold focus-visible:outline-2 focus-visible:outline-[var(--focus)]">{t(showPasswords ? "Ocultar contraseñas" : "Mostrar contraseñas")}</button>
            <p id="recovery-password-requirements" className="text-[11px] leading-4 text-[var(--text-subtle)]">{t("Entre 12 y 128 caracteres, con al menos una letra y un número.")}</p>
            <button disabled={loading} className="min-h-11 w-full rounded-xl bg-[var(--brain-accent)] px-4 py-3 text-[12px] font-semibold text-[var(--brain-contrast)] disabled:opacity-55">{loading ? t("Actualizando…") : t("Actualizar y entrar")}</button>
          </form>
        )}
        {error ? <p role="alert" className="mt-4 rounded-xl bg-[var(--danger-soft)] px-4 py-3 text-[12px] text-[var(--danger)]">{t(error)}</p> : null}
      </section>
    </main>
  );
}
