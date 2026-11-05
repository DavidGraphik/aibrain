"use client";

import type { ComponentProps, ReactNode } from "react";
import { AppsWorkspace } from "@/g03-products/apps-workspace";
import { g03ProductInstallation } from "@/g03-products/contracts";
import { ProductionWorkspace } from "@/g03-products/production-workspace";
import { ReceptionWorkspace } from "@/g03-products/reception-workspace";
import { AutomationsPanel } from "@/components/automations-panel";
import { InsiJetsCMSPanel } from "@/components/insijets-cms-panel";
import { InsiJetsDirectoryPanel } from "@/components/insijets-directory-panel";
import { OutreachWorkspacePanel } from "@/components/outreach-workspace-panel";
import layout from "@/components/outreach-layout.module.css";

type WorkbenchContentProps = {
  installationId: string;
  actorId: string;
  productView: "production" | "apps" | "reception" | null;
  onProductChat: (message: string) => void;
  onToggleSidebar: (opener?: HTMLElement | null) => void;
  insijets: {
    allowed: boolean;
    panel: "cms" | "pricing" | "directory" | null;
  } & Pick<ComponentProps<typeof InsiJetsCMSPanel>, "onDirtyChange" | "onRequestChat">;
  automations: Omit<ComponentProps<typeof AutomationsPanel>, "onToggleSidebar">;
  outreach: {
    allowed: boolean;
    open: boolean;
    compactView: "chat" | "outreach";
    onCompactViewChange: (view: "chat" | "outreach") => void;
    panel: ComponentProps<typeof OutreachWorkspacePanel>;
  };
  children: ReactNode;
};

/** View selection only. Session, permissions, drafts and navigation state stay in BrainApp. */
function WorkspaceView({
  installationId,
  actorId,
  productView,
  onProductChat,
  onToggleSidebar,
  insijets,
  automations,
  children,
}: Omit<WorkbenchContentProps, "outreach">) {
  if (g03ProductInstallation(installationId)) {
    if (productView === "reception") return <ReceptionWorkspace />;
    if (productView === "production") return <ProductionWorkspace onChat={onProductChat} />;
    if (productView === "apps") return <AppsWorkspace actor={actorId} onChat={onProductChat} />;
  }

  if (insijets.allowed) {
    if (insijets.panel === "cms" || insijets.panel === "pricing") {
      return <InsiJetsCMSPanel
        key={insijets.panel}
        mode={insijets.panel === "pricing" ? "pricing" : "content"}
        onToggleSidebar={onToggleSidebar}
        onDirtyChange={insijets.onDirtyChange}
        onRequestChat={insijets.onRequestChat}
      />;
    }
    if (insijets.panel === "directory") return <InsiJetsDirectoryPanel onToggleSidebar={onToggleSidebar} />;
  }

  if (automations.open) return <AutomationsPanel {...automations} onToggleSidebar={onToggleSidebar} />;
  return children;
}

/** Shared chat/outreach layout, with the same compact-pane visibility as the main workbench. */
export function WorkbenchContent({ outreach, ...workspace }: WorkbenchContentProps) {
  const outreachVisible = outreach.open && outreach.allowed;
  return (
    <div className={layout.workspace}>
      {outreachVisible ? (
        <nav className={layout.switch} aria-label="Outreach workspace view">
          <button type="button" aria-pressed={outreach.compactView === "chat"} onClick={() => outreach.onCompactViewChange("chat")}>Chat</button>
          <button type="button" aria-pressed={outreach.compactView === "outreach"} onClick={() => outreach.onCompactViewChange("outreach")}>Outreach</button>
        </nav>
      ) : null}
      <div className={layout.split}>
        <div className={`${layout.chat} [&>main]:min-h-0 ${outreach.open && outreach.compactView === "outreach" ? layout.hiddenCompact : ""}`}>
          {workspace.productView && g03ProductInstallation(workspace.installationId) ? (
            <button className="md:hidden self-start m-2 rounded-lg border px-3 py-2" onClick={(event) => workspace.onToggleSidebar(event.currentTarget)}>Navegació</button>
          ) : null}
          <WorkspaceView {...workspace} />
        </div>
        {outreachVisible ? (
          <aside className={`${layout.panel} ${outreach.compactView === "chat" ? layout.hiddenCompact : ""}`} aria-label="Outreach workspace">
            <OutreachWorkspacePanel {...outreach.panel} />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
