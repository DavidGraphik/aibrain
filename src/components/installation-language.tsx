"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useUiLocale } from "@/i18n/provider";
import { isUiLocale } from "@/i18n/locale";
export function InstallationLanguage() {
  const locale = useUiLocale();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  return <section className="rounded-2xl border border-[var(--border)] p-4">
    <label htmlFor="installation-language" className="block text-body-semibold">{locale === "ca" ? "Idioma de l’empresa" : locale === "es" ? "Idioma de la empresa" : "Company interface language"}</label>
    <p className="my-2 text-caption-1-regular text-[var(--text-muted)]">{locale === "ca" ? "S’aplica a l’accés i a la interfície de totes les persones de l’empresa. Els documents i les converses conserven el seu idioma." : locale === "es" ? "Se aplica al acceso y a la interfaz de todas las personas de esta empresa. Los documentos y las conversaciones conservan su idioma." : "Applies to sign-in and the interface for everyone in this company. Documents and conversations keep their original language."}</p>
    <select id="installation-language" value={locale} disabled={busy} className="min-h-11 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-[16px]" onChange={async event => {
      const next = event.target.value;
      if (!isUiLocale(next)) return;
      setBusy(true); setError(false);
      try {
        const response = await fetch("/api/admin/language", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ locale: next }) });
        const result: unknown = await response.json();
        if (!response.ok || !result || typeof result !== "object" || !("locale" in result) || result.locale !== next) throw new Error("Language save failed");
        router.refresh();
      } catch { setError(true); } finally { setBusy(false); }
    }}><option value="ca">Català</option><option value="en">English</option><option value="es">Español</option></select>
    {busy ? <p role="status">{locale === "ca" ? "Desant…" : locale === "es" ? "Guardando…" : "Saving…"}</p> : null}
    {error ? <p role="alert" className="mt-2 text-[var(--danger)]">{locale === "ca" ? "No s’ha pogut desar l’idioma. Torna-ho a provar." : locale === "es" ? "No se ha podido guardar el idioma. Vuelve a intentarlo." : "Could not save the language. Please try again."}</p> : null}
  </section>;
}
