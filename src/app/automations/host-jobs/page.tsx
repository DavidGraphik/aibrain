import { redirect } from "next/navigation";
import { getSession } from "@/auth/session";
import { hostBindingsForSession } from "@/automations/host-analysis/service";
import { listAutomationTasks } from "@/automations/server-service";
import { listProjects } from "@/workbench/store";
import { HostJobsPanel } from "@/components/host-jobs-panel";
export const dynamic = "force-dynamic";
export default async function HostJobsPage() {
  const session = await getSession(); if (!session) redirect("/login");
  let data;
  try {
    const bindings = await hostBindingsForSession(session);
    const [{ directory }, projects] = await Promise.all([listAutomationTasks(session), listProjects(session, { status: "active", limit: 50 })]);
    data = { bindings, directory, projects };
  } catch { data = null; }
  if (!data) return <main className="mx-auto max-w-3xl p-8"><h1>Acceso no disponible</h1><p>Esta autorización requiere la cuenta de David en Trinalum.</p></main>;
  return <HostJobsPanel initial={data.bindings} projects={data.projects.items.map(p => ({ id: p.id, name: p.name }))} directory={data.directory} />;
}
