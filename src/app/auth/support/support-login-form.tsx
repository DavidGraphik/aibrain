"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
export function SupportLoginForm() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError("");
    try {
      const response = await fetch("/api/auth/support", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
      if (!response.ok) { setError("El codi no és vàlid, ha caducat o no està disponible."); return; }
      setCode(""); router.push("/"); router.refresh();
    } catch { setError("No s’ha pogut connectar. Torna-ho a provar."); }
    finally { setPending(false); }
  }
  return <main style={{ maxWidth: 520, margin: "15vh auto", padding: 24 }}>
    <h1>Accés temporal de suport</h1>
    <p>Comprovació assistida amb els permisos de l’usuari. Caduca en 15 minuts i queda registrada. No canvia la contrasenya personal.</p>
    <label htmlFor="support-code-file">Fitxer privat del codi</label>
    <input id="support-code-file" type="file" accept=".txt,text/plain" disabled={pending} onChange={async event => {
      const file = event.target.files?.[0]; setError(""); setCode("");
      if (!file) return;
      if (file.size > 128) { setError("El fitxer del codi no és vàlid."); return; }
      try {
        const value = (await file.text()).trim();
        if (!/^[A-Za-z0-9_-]{43}$/.test(value)) { setError("El fitxer del codi no és vàlid."); return; }
        setCode(value);
      } catch { setError("No s’ha pogut llegir el fitxer del codi."); }
    }} style={{ display: "block", margin: "12px 0" }} />
    <form onSubmit={submit}>
      <label htmlFor="support-code">Codi de suport d’un sol ús</label>
      <input id="support-code" type="password" autoComplete="off" value={code} onChange={event => setCode(event.target.value)} required minLength={43} maxLength={43} style={{ display: "block", width: "100%", margin: "12px 0", padding: 8 }} />
      <button type="submit" disabled={pending}>{pending ? "Entrant…" : "Iniciar comprovació"}</button>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  </main>;
}
