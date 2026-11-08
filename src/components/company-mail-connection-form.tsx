"use client";
import { useState, type FormEvent } from "react";
import { useUiText } from "@/i18n/provider";

export function CompanyMailConnectionForm({ onConnected, onCancel }: { onConnected: () => void; onCancel: () => void }) {
  const t = useUiText();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [folder, setFolder] = useState("INBOX");
  const [since, setSince] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    const secret = password;
    setPassword("");
    try {
      const response = await fetch("/api/connectors/company-mail/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email.trim(), password: secret, folder: folder.trim(), since }), cache: "no-store" });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "No se ha podido conectar el buzón.");
      onConnected();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "No se ha podido conectar el buzón."); }
    finally { setBusy(false); }
  };
  const inputClass = "mt-1 min-h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 text-[16px] md:text-[13px]";
  return <form onSubmit={event => void submit(event)} className="mb-5 rounded-xl border border-[var(--border)] p-4" aria-label={t("Conectar correo de empresa")}>
    <h4 className="text-[13px] font-semibold">{t("Conectar correo de empresa")}</h4>
    <p className="mt-2 text-[12px] leading-5 text-[var(--text-muted)]">{t("Introduce los datos de tu buzón. La contraseña se cifra en el servidor y solo se usa para leer el correo. Las facturas se guardan en el almacenamiento privado de AiBrain.")}</p>
    <div className="mt-4 grid gap-3">
      <label className="text-[12px]">{t("Correo de empresa")}<input required type="email" autoComplete="username" maxLength={254} value={email} onChange={e => setEmail(e.target.value)} disabled={busy} className={inputClass} /></label>
      <label className="text-[12px]">{t("Contraseña del buzón")}<input required type="password" autoComplete="off" maxLength={1024} value={password} onChange={e => setPassword(e.target.value)} disabled={busy} className={inputClass} /></label>
      <label className="text-[12px]">{t("Carpeta de correo")}<input required maxLength={200} value={folder} onChange={e => setFolder(e.target.value)} disabled={busy} className={inputClass} /><span className="mt-1 block text-[11px] text-[var(--text-subtle)]">{t("INBOX es la bandeja de entrada. Usa el nombre exacto si las facturas llegan a otra carpeta.")}</span></label>
      <label className="text-[12px]">{t("Importar desde")}<input required type="date" value={since} onChange={e => setSince(e.target.value)} disabled={busy} className={inputClass} /><span className="mt-1 block text-[11px] text-[var(--text-subtle)]">{t("Elige la fecha inicial. La importación y su horario se configuran después en el proyecto de facturas.")}</span></label>
    </div>
    {error ? <p role="alert" className="mt-3 text-[12px] text-[var(--danger)]">{t(error)}</p> : null}
    <div className="mt-4 flex gap-2"><button type="submit" disabled={busy} className="min-h-10 rounded-full bg-[var(--brain-accent)] px-4 text-[12px] font-semibold text-[var(--brain-contrast)] disabled:opacity-50">{busy ? t("Comprobando buzón…") : t("Conectar buzón")}</button><button type="button" disabled={busy} onClick={onCancel} className="min-h-10 rounded-full border border-[var(--border)] px-4 text-[12px]">{t("Cancelar")}</button></div>
  </form>;
}
