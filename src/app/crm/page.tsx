import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/auth/session";
import { loadInstallationConfig } from "@/config/installation";
import { crmView, trinalumCrm } from "@/connectors/trinalum-crm";

export const dynamic = "force-dynamic";
export default async function CrmPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const session = await getSession(); if (!session) redirect("/login");
  const installation = await loadInstallationConfig(); if (installation.installationId !== "trinalum-production") notFound();
  const requested = (await searchParams).view;
  const view = ["trini", "miguel", "nerea"].includes(requested ?? "") ? requested! : "trini";
  const date = (value?: string) => value ? new Intl.DateTimeFormat("es-ES", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Madrid" }).format(new Date(value)) : "Sin próxima tarea";
  let data;
  try {
    const crm = await trinalumCrm(installation.installationId, session.user.id);
    data = { crm, deals: crmView(crm.deals, crm.members, view) };
  } catch { data = null; }
  if (!data) return <main style={{ padding: 32 }}><Link href="/">← Volver</Link><h1>No se ha podido consultar Attio</h1><p>Tu cuenta debe tener acceso al registro comercial. Si ya lo tiene, vuelve a intentarlo; los datos siguen guardados en Attio.</p></main>;
  const { crm, deals } = data;
  return <main style={{ padding: "32px 24px", maxWidth: 1400, margin: "auto" }}>
      <Link href="/">← Volver a Trinalum AI</Link>
      <h1 style={{ marginTop: 24 }}>Deals y tareas</h1>
      <p>Información actual de Attio. Abre un Deal para editarlo o pide el cambio en el chat.</p>
      <nav aria-label="Vistas de Deals" style={{ display: "flex", gap: 12, margin: "24px 0" }}>{[["trini", "Trini · todo el equipo"], ["miguel", "Miguel"], ["nerea", "Nerea"]].map(([id, label]) => <Link key={id} href={`/crm?view=${id}`} aria-current={view === id ? "page" : undefined} style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid #b9c7d4", background: view === id ? "#e6edf3" : "transparent" }}>{label}</Link>)}</nav>
      <p>{deals.length} Deals · actualizado {date(crm.checkedAt)}</p>
      <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
        <thead><tr>{["Deal", "Responsable", "Next Step", "Action Deadline", "Próxima Task", "Next due task Due date"].map(name => <th key={name} style={{ padding: 12, borderBottom: "2px solid #b9c7d4" }}>{name}</th>)}</tr></thead>
        <tbody>{deals.map(deal => {
          const member = crm.members.find(m => m.id.workspace_member_id === deal.owner);
          return <tr key={deal.id}><td style={{ padding: 12, borderBottom: "1px solid #dce4eb" }}><a href={`https://app.attio.com/${encodeURIComponent(process.env.AIBRAIN_ATTIO_WORKSPACE ?? "example-workspace")}/deals/record/${encodeURIComponent(deal.id)}`} target="_blank" rel="noopener noreferrer">{deal.name}</a><div>{deal.stage}</div></td><td style={{ padding: 12 }}>{member?.first_name ?? "Sin responsable"}</td><td style={{ padding: 12 }}>{deal.next_step || "Sin próximo paso"}</td><td style={{ padding: 12 }}>{deal.action_deadline || "Sin fecha"}</td><td style={{ padding: 12 }}>{deal.next_task?.content ?? "Sin próxima tarea"}{deal.open_task_count > 1 && <div>{deal.open_task_count} Tasks abiertas</div>}</td><td style={{ padding: 12 }}>{date(deal.next_task?.deadline_at)}</td></tr>;
        })}</tbody>
      </table></div>
      {deals.length === 0 && <p>No hay Deals en esta vista.</p>}
    </main>;
}
