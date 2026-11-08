// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "../render-spanish";
import { WorkbenchContent } from "@/components/workbench-content";
import layout from "@/components/outreach-layout.module.css";

vi.mock("@/g03-products/reception-workspace", () => ({ ReceptionWorkspace: () => <main>Reception</main> }));
vi.mock("@/g03-products/production-workspace", () => ({ ProductionWorkspace: () => <main>Production</main> }));
vi.mock("@/g03-products/apps-workspace", () => ({ AppsWorkspace: () => <main>Apps</main> }));
vi.mock("@/components/insijets-cms-panel", () => ({ InsiJetsCMSPanel: ({ mode }: { mode: string }) => <main>CMS {mode}</main> }));
vi.mock("@/components/insijets-directory-panel", () => ({ InsiJetsDirectoryPanel: () => <main>Directory</main> }));
vi.mock("@/components/automations-panel", () => ({ AutomationsPanel: () => <main>Automations</main> }));
vi.mock("@/components/outreach-workspace-panel", () => ({ OutreachWorkspacePanel: () => <div>Outreach panel</div> }));

function props(): ComponentProps<typeof WorkbenchContent> {
  return {
    installationId: "other-installation",
    actorId: "internal-test-user",
    productView: null,
    onProductChat: vi.fn(),
    onToggleSidebar: vi.fn(),
    insijets: { allowed: true, panel: "cms", onDirtyChange: vi.fn(), onRequestChat: vi.fn() },
    automations: { open: true, projects: [] },
    outreach: { allowed: false, open: false, compactView: "chat", onCompactViewChange: vi.fn(), panel: { onClose: vi.fn(), onAsk: vi.fn() } },
    children: <main>Chat fallback</main>,
  };
}

afterEach(cleanup);

describe("Workbench view selection", () => {
  it.each([
    ["reception", "Reception"],
    ["production", "Production"],
    ["apps", "Apps"],
  ] as const)("gives authorized %s priority over CMS and automations", (productView, text) => {
    const input = { ...props(), installationId: "g03-production", productView };
    render(<WorkbenchContent {...input} />);
    expect(screen.getByRole("main")).toHaveTextContent(text);
    expect(screen.queryByText("CMS content")).not.toBeInTheDocument();
    expect(screen.queryByText("Automations")).not.toBeInTheDocument();
    const navigation = screen.getByRole("button", { name: "Navegació" });
    fireEvent.click(navigation);
    expect(input.onToggleSidebar).toHaveBeenCalledWith(navigation);
  });

  it("does not expose an industrial view for another installation", () => {
    render(<WorkbenchContent {...props()} productView="production" />);
    expect(screen.getByRole("main")).toHaveTextContent("CMS content");
    expect(screen.queryByRole("button", { name: "Navegació" })).not.toBeInTheDocument();
  });

  it.each([
    ["cms", "CMS content"],
    ["pricing", "CMS pricing"],
    ["directory", "Directory"],
  ] as const)("selects the authorized %s panel before automations", (panel, text) => {
    const input = props();
    render(<WorkbenchContent {...input} insijets={{ ...input.insijets, panel }} />);
    expect(screen.getByRole("main")).toHaveTextContent(text);
  });

  it("falls through a forbidden CMS panel to automations, then chat", () => {
    const input = props();
    input.insijets.allowed = false;
    const view = render(<WorkbenchContent {...input} />);
    expect(screen.getByRole("main")).toHaveTextContent("Automations");
    view.rerender(<WorkbenchContent {...input} automations={{ ...input.automations, open: false }} />);
    expect(screen.getByRole("main")).toHaveTextContent("Chat fallback");
    expect(screen.queryByText("CMS content")).not.toBeInTheDocument();
  });

  it("preserves compact outreach controls and the visibility classes on both panes", () => {
    const input = props();
    input.insijets.allowed = false;
    input.automations.open = false;
    input.outreach = { ...input.outreach, allowed: true, open: true, compactView: "outreach" };
    const view = render(<WorkbenchContent {...input} />);
    const mainPane = screen.getByRole("main").parentElement;
    expect(mainPane).toHaveClass(layout.chat, layout.hiddenCompact);
    expect(screen.getByRole("complementary", { name: "Outreach workspace" })).not.toHaveClass(layout.hiddenCompact);
    expect(screen.getByRole("button", { name: "Outreach", pressed: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Chat" }));
    expect(input.outreach.onCompactViewChange).toHaveBeenCalledWith("chat");

    view.rerender(<WorkbenchContent {...input} outreach={{ ...input.outreach, compactView: "chat" }} />);
    expect(mainPane).not.toHaveClass(layout.hiddenCompact);
    expect(screen.getByRole("complementary", { name: "Outreach workspace" })).toHaveClass(layout.hiddenCompact);
    expect(screen.getByRole("button", { name: "Chat", pressed: true })).toBeInTheDocument();

    view.rerender(<WorkbenchContent {...input} outreach={{ ...input.outreach, allowed: false }} />);
    expect(screen.queryByRole("navigation", { name: "Outreach workspace view" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Outreach workspace" })).not.toBeInTheDocument();
  });
});
