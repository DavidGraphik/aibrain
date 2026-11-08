import { NextResponse } from "next/server";
import { getSession } from "@/auth/session";
import { advancedArtifactLibraryItem, buildLibraryItems, type LibraryItemType } from "@/library/contracts";
import { listAdvancedArtifactsForSession } from "@/artifacts/server-service";
import { resourceLocationIndexForInstallation } from "@/library/server-resource-access";
import { loadInstallationConfig } from "@/config/installation";
import { loadWorkbench } from "@/workbench/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const types = new Set<LibraryItemType>(["upload", "image", "document", "result", "browser", "visualization", "internal-site"]);

function normalized(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es");
}
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "No autenticat." }, { status: 401 });
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some((key) => !["type", "projectId", "q"].includes(key)) ||
      ["type", "projectId", "q"].some((key) => params.getAll(key).length > 1)) {
    return NextResponse.json({ error: "Consulta no vàlida." }, { status: 400 });
  }
  const type = params.get("type");
  const projectId = params.get("projectId")?.trim() || null;
  const query = params.get("q")?.trim() || null;
  if ((type && !types.has(type as LibraryItemType)) || (query && (query.length > 100 || /\p{C}/u.test(query)))) {
    return NextResponse.json({ error: "Consulta no vàlida." }, { status: 400 });
  }
  try {
    const snapshot = await loadWorkbench(session);
    let items = buildLibraryItems(snapshot);
    if (session.provider === "local") {
      const installation = await loadInstallationConfig();
      const locations = await resourceLocationIndexForInstallation(installation)
        .listForProjects(new Set(snapshot.projects.map((project) => project.id)));
      const byKey = new Map(locations.map((location) => [`${location.kind}:${location.resourceId}`, location]));
      const writableProjects = new Set(snapshot.projects.filter((project) => {
        const membership = project.sharing.members.find((member) =>
          member.id === session.user.id || member.email === session.user.email.toLocaleLowerCase());
        return membership?.role !== "viewer";
      }).map((project) => project.id));
      items = items.map((item) => {
        const resourceId = item.id.startsWith("upload:")
          ? item.id.split(":").at(-1) ?? null
          : item.id.startsWith("artifact:") ? item.id.slice("artifact:".length) : null;
        const kind = item.type === "upload" ? "upload"
          : item.type === "image" ? "generated-image"
            : item.type === "document" ? "workspace-file" : null;
        if (!resourceId || !kind) {
          return {
            ...item,
            capabilities: {
              preview: item.previewUrl !== null,
              download: item.downloadUrl !== null,
              history: false,
              mutate: item.type === "result" && writableProjects.has(item.projectId),
            },
          };
        }
        const location = byKey.get(`${kind}:${resourceId}`);
        const available = Boolean(location && location.projectId === item.projectId && location.threadId === item.threadId);
        return {
          ...item,
          previewUrl: available ? item.previewUrl : null,
          downloadUrl: available ? item.downloadUrl : null,
          status: available ? item.status : "error" as const,
          capabilities: {
            preview: available && item.previewUrl !== null,
            download: available && item.downloadUrl !== null,
            history: available && item.type === "upload",
            mutate: available && writableProjects.has(item.projectId),
          },
        };
      });
    }
    try {
      const projectNames = new Map(snapshot.projects.map((project) => [project.id, project.name]));
      const threadTitles = new Map(snapshot.threads.map((thread) => [thread.id, thread.title]));
      const advanced = (await listAdvancedArtifactsForSession(session)).flatMap((artifact) => {
        const projectName = projectNames.get(artifact.projectId);
        const threadTitle = threadTitles.get(artifact.threadId);
        if (!projectName || !threadTitle) return [];
        const item = advancedArtifactLibraryItem(artifact, { projectName, threadTitle });
        const membership = snapshot.projects.find((project) => project.id === artifact.projectId)
          ?.sharing.members.find((member) => member.id === session.user.id || member.email === session.user.email.toLocaleLowerCase());
        return [{
          ...item,
          capabilities: {
            preview: true,
            download: true,
            history: artifact.latestVersion > 1,
            mutate: membership?.role !== "viewer",
          },
        }];
      });
      items = [...advanced, ...items].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    } catch {
      // The core library remains available if the optional advanced-artifact index is unavailable.
    }
    if (type) items = items.filter((item) => item.type === type);
    if (projectId) items = items.filter((item) => item.projectId === projectId);
    if (query) {
      const needle = normalized(query);
      items = items.filter((item) => normalized(`${item.name} ${item.projectName} ${item.threadTitle}`).includes(needle));
    }
    return NextResponse.json({ items }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "La biblioteca no està disponible." }, { status: 503 });
  }
}
