"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useUiLocale } from "@/i18n/provider";
import { isUiLocale } from "@/i18n/locale";
export function PersonalLanguage() {
  const locale = useUiLocale();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  return <section className="mt-6">
    <label htmlFor="personal-interface-language" className="block text-[12px] font-semibold">{locale === "ca" ? "El teu idioma" : locale === "es" ? "Tu idioma" : "Your language"}</label>
    <p className="my-2 text-[11px] text-[var(--text-subtle)]">{locale === "ca" ? "Es guarda al teu compte i s’aplica quan tornes a entrar. No canvia l’idioma de l’equip." : locale === "es" ? "Se guarda en tu cuenta y se aplica cuando vuelves a entrar. No cambia el idioma del equipo." : "Saved to your account for your next visit. Your team’s language stays unchanged."}</p>
    <select id="personal-interface-language" value={locale} disabled={busy} className="min-h-11 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-[16px]" onChange={async event => {
      const next = event.target.value;
      if (!isUiLocale(next)) return;
      setBusy(true); setError(false);
      try {
        const response = await fetch("/api/settings/language", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ locale: next }) });
        const result: unknown = await response.json();
        if (!response.ok || !result || typeof result !== "object" || !("locale" in result) || result.locale !== next) throw new Error("Language save failed");
        router.refresh();
      } catch { setError(true); } finally { setBusy(false); }
    }}><option value="ca">Català</option><option value="en">English</option><option value="es">Español</option></select>
    {busy ? <p role="status">{locale === "ca" ? "Desant…" : locale === "es" ? "Guardando…" : "Saving…"}</p> : null}
    {error ? <p role="alert" className="mt-2 text-[var(--danger)]">{locale === "ca" ? "No s’ha pogut desar l’idioma. Torna-ho a provar." : locale === "es" ? "No se ha podido guardar el idioma. Vuelve a intentarlo." : "Could not save the language. Please try again."}</p> : null}
  </section>;
}
