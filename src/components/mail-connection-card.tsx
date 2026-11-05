"use client";

import { useId, useState, type FormEvent } from "react";
import { EnvelopeSimple } from "@phosphor-icons/react";
import { useUiText } from "@/i18n/provider";
import type { PersonalConnectorSettings } from "@/settings/connector-settings";

/** Mailbox passwords stay in this form and are never part of chat or navigation. */
export function MailConnectionCard({ connector, accountEmail, onChanged }: {
  connector: PersonalConnectorSettings;
  accountEmail: string;
  onChanged: () => void;
}) {
  const t = useUiText();
  const passwordId = useId();
  const [password, setPassword] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const connected = connector.status === "connected";
  const showForm = !connected || editing;

  const connect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !password || !connector.connectUrl) return;
    setBusy(true); setError(null); setSuccess(false);
    const body = JSON.stringify({ password });
    setPassword("");
    try {
      const response = await fetch(connector.connectUrl, {
        method: "POST", headers: { "Content-Type": "application/json" }, body,
      });
      if (!response.ok) {
        setError(t(response.status === 401 || response.status === 422
          ? "No se ha podido conectar el buzón. Comprueba la contraseña de tu correo y vuelve a intentarlo."
          : "No se ha podido comprobar la conexión. Vuelve a intentarlo dentro de un momento."));
        return;
      }
      setEditing(false); setSuccess(true); onChanged();
    } catch {
      setError(t("No se ha podido comprobar la conexión. Vuelve a intentarlo dentro de un momento."));
    } finally { setBusy(false); }
  };

  const disconnect = async () => {
    if (busy || !connector.disconnectUrl) return;
    setBusy(true); setError(null); setSuccess(false); setPassword("");
    try {
      const response = await fetch(connector.disconnectUrl, { method: "POST" });
      if (!response.ok) throw new Error("disconnect failed");
      setEditing(false); onChanged();
    } catch { setError(t("No se ha podido desconectar. Vuelve a intentarlo.")); }
    finally { setBusy(false); }
  };

  return <article className="border-b border-[var(--border-subtle)] px-3 py-4 last:border-0">
    <div className="flex items-start gap-3">
      <EnvelopeSimple aria-hidden size={28} className="shrink-0 text-[var(--text-subtle)]" />
      <div className="min-w-0 flex-1">
        <h5 className="text-[13px] font-medium">{t(connector.label)}</h5>
        <p className="mt-1 text-[11px] leading-4 text-[var(--text-subtle)]">{t("Lee, organiza, redacta y envía correos de Nominalia desde la conversación.")}</p>
        <p className="mt-1 break-all text-[11px] text-[var(--text-subtle)]">{accountEmail}</p>
      </div>
      {connected ? <span className="text-[11px] font-medium text-[var(--positive)]">{t("Conectado")}</span> : null}
    </div>
    <div className="mt-3 md:ml-10">
      <p className="text-[11px] leading-4 text-[var(--text-subtle)]">{t(connector.statusDetail)}</p>
      <p className="mt-2 text-[11px] leading-4 text-[var(--text-subtle)]">{t("Pide en el chat lo que necesites hacer con tu correo.")}</p>
      <p className="mt-2 text-[11px] leading-4 text-[var(--text-subtle)]">{t("Solo se ven los mensajes que siguen en el servidor. Los correos descargados y eliminados por Outlook, y los enviados guardados solo en tu ordenador, no aparecen automáticamente.")}</p>
      {showForm && connector.connectUrl ? <form onSubmit={event => void connect(event)} className="mt-3 space-y-2">
        <label htmlFor={passwordId} className="block text-[11px] font-medium">{t("Contraseña de tu correo")}</label>
        <input id={passwordId} name="mailbox-password" type="password" autoComplete="off" spellCheck={false} required disabled={busy} value={password} onChange={event => setPassword(event.target.value)} className="min-h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-[16px] outline-none focus:border-[var(--focus)] disabled:opacity-50 md:text-[13px]" />
        <p className="text-[11px] leading-4 text-[var(--text-subtle)]">{t("Usa la contraseña de este buzón, que puede ser distinta de la de AiBrain. Introdúcela solo aquí, nunca en el chat.")}</p>
        <div className="flex items-center gap-3">
          <button type="submit" disabled={busy || !password} className="rounded-full bg-[var(--brain-accent)] px-4 py-2 text-[11px] font-semibold text-[var(--brain-contrast)] disabled:opacity-50">{busy ? t("Comprobando conexión…") : t("Conectar {p0}", { p0: t(connector.label) })}</button>
          {editing ? <button type="button" disabled={busy} onClick={() => { setEditing(false); setPassword(""); setError(null); }} className="text-[11px] text-[var(--text-subtle)]">{t("Cancelar")}</button> : null}
        </div>
      </form> : null}
      {connected ? <div className="mt-3 flex gap-4">
        {connector.connectUrl && !editing ? <button type="button" disabled={busy} onClick={() => { setEditing(true); setSuccess(false); }} className="text-[11px] text-[var(--text-subtle)] underline underline-offset-2 disabled:opacity-50">{t("Actualizar contraseña")}</button> : null}
        {connector.disconnectUrl ? <button type="button" disabled={busy} aria-label={t("Desconectar {p0}", { p0: t(connector.label) })} onClick={() => void disconnect()} className="text-[11px] text-[var(--text-subtle)] underline underline-offset-2 disabled:opacity-50">{t("Desconectar")}</button> : null}
      </div> : null}
      {success ? <p role="status" className="mt-3 text-[11px] text-[var(--positive)]">{t("Buzón conectado. Ya puedes leer, organizar, redactar y enviar correos desde el chat.")}</p> : null}
      {error ? <p role="alert" className="mt-3 text-[11px] text-[var(--danger)]">{error}</p> : null}
    </div>
  </article>;
}
