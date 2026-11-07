"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { AutomationAudience, AutomationAudienceDirectory } from "@/automations/contracts";
import type { HostBinding } from "@/automations/host-analysis/store";
import type { HostAnalysisJob } from "@/automations/host-analysis/contracts";
type Row = { job: HostAnalysisJob; label: string; binding: HostBinding | null };
export function HostJobsPanel({ initial, projects, directory }: { initial: Row[]; projects: { id: string; name: string }[]; directory: AutomationAudienceDirectory }) {
  const [rows, setRows] = useState(initial);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [audience, setAudience] = useState<AutomationAudience>({ membershipPolicy: "current", userIds: [directory.currentUserId], groupIds: [] });
  const [review, setReview] = useState<Row | null>(null);
  const reviewRef = useRef<HTMLElement>(null);
  useEffect(() => { if (review) reviewRef.current?.focus(); }, [review]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toggle = (kind: "userIds" | "groupIds", id: string) => setAudience(a => ({ ...a, [kind]: a[kind].includes(id) ? a[kind].filter(x => x !== id) : [...a[kind], id] }));
  async function mutate(row: Row, method: "POST" | "DELETE") {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/automations/host-bindings", { method, headers: { "Content-Type": "application/json" },
        body: JSON.stringify(method === "DELETE" ? { job: row.job } : { job: row.job, projectId, audience }) });
      if (!response.ok) throw Error("No se ha podido guardar la autorización. Revisa el proyecto y los destinatarios.");
      const refreshed = await fetch("/api/automations/host-bindings", { cache: "no-store" });
      if (!refreshed.ok) throw Error("No se ha podido comprobar el estado actualizado.");
      setRows((await refreshed.json()).bindings); setReview(null);
    } catch (e) { setError(e instanceof Error ? e.message : "No disponible."); }
    finally { setBusy(false); }
  }
  return <main className="mx-auto max-w-3xl space-y-6 p-6 text-[var(--text)]">
    <Link href="/" className="underline">Volver al espacio de trabajo</Link>
    <h1 className="text-2xl font-semibold">Análisis operativos de Trinalum</h1>
    <p>Autoriza cada análisis con tu cuenta actual. Recibirá el lote y sus PDF originales, consultará únicamente las fuentes permitidas y guardará el resultado en el proyecto elegido. Los destinatarios conservan sus permisos actuales.</p>
    <p>El horario operativo existente seguirá iniciando los lotes. Aquí no se crea otro horario. La prueba de automatización solo se inicia manualmente.</p>
    <label className="block">Proyecto <select disabled={busy || !!review} className="ml-2 rounded border p-2" value={projectId} onChange={e => setProjectId(e.target.value)}>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    <fieldset disabled={busy || !!review} className="space-y-2"><legend className="font-semibold">Destinatarios de las nuevas autorizaciones</legend>
      {directory.users.map(u => <label key={u.id} className="mr-4 inline-flex gap-2"><input type="checkbox" checked={audience.userIds.includes(u.id)} onChange={() => toggle("userIds", u.id)} />{u.name}</label>)}
      {directory.groups.map(g => <label key={g.id} className="mr-4 inline-flex gap-2"><input type="checkbox" checked={audience.groupIds.includes(g.id)} onChange={() => toggle("groupIds", g.id)} />Grupo: {g.name}</label>)}
    </fieldset>
    {error && <p role="alert">{error}</p>}
    <ul className="space-y-3">{rows.map(row => <li key={row.job} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"><div><strong>{row.label}</strong><p className="text-sm">{row.binding?.active ? "Autorizado" : "Sin autorización activa"}</p>{row.binding?.active ? <p className="text-sm">Proyecto: {projects.find(p => p.id === row.binding?.projectId)?.name ?? "No disponible"} · Destinatarios: {[...directory.users.filter(u => row.binding?.audience.userIds.includes(u.id)).map(u => u.name), ...directory.groups.filter(g => row.binding?.audience.groupIds.includes(g.id)).map(g => `Grupo: ${g.name}`)].join(", ")}</p> : null}</div>
      {row.binding?.active ? <button disabled={busy} onClick={() => void mutate(row, "DELETE")} className="rounded border px-4 py-2">Revocar</button> : <button disabled={busy || !projectId || !audience.userIds.length && !audience.groupIds.length} onClick={() => { setReview(row); setError(""); }} className="rounded border px-4 py-2">Revisar autorización</button>}
    </li>)}</ul>
    {review && <section ref={reviewRef} tabIndex={-1} aria-labelledby="host-review" className="space-y-3 rounded-xl border-2 p-5">
      <h2 id="host-review" className="text-xl font-semibold">Confirmar: {review.label}</h2>
      <p>Cuenta vinculada a la instalación.</p>
      <p>Proyecto: {projects.find(p => p.id === projectId)?.name}</p>
      <p>Destinatarios: {[...directory.users.filter(u => audience.userIds.includes(u.id)).map(u => u.name), ...directory.groups.filter(g => audience.groupIds.includes(g.id)).map(g => `Grupo: ${g.name}`)].join(", ")}</p>
      <p>Permite recibir y analizar estos lotes en modo Smart, de solo lectura. No envía correos ni modifica CRM o Sibema. Puedes revocar esta autorización en cualquier momento.</p>
      <button disabled={busy} onClick={() => void mutate(review, "POST")} className="mr-3 rounded border px-4 py-2">Autorizar este análisis</button>
      <button disabled={busy} onClick={() => setReview(null)} className="rounded border px-4 py-2">Cancelar</button>
    </section>}
  </main>;
}
