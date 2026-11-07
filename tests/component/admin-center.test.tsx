// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "../render-spanish";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceAdminSnapshot } from "@/admin/contracts";
import { AdminCenter } from "@/components/admin-center";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const snapshot: WorkspaceAdminSnapshot = {
  schemaVersion: 1,
  installationId: "admin-qa",
  companyName: "Empresa QA",
  currentUserRoleId: "workspace-owner",
  identityProvisioning: {
    mode: "local-profile-only",
    emailDelivery: false,
    detail: "Crea el perfil local de una identidad existente.",
  },
  roles: [],
  groups: [],
  members: [],
  audit: [],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AdminCenter loading and managed skill form", () => {
  it("offers recovery when the administration snapshot cannot be loaded", async () => {
    let adminAttempt = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin") {
        adminAttempt += 1;
        return adminAttempt === 1
          ? new Response(JSON.stringify({ error: "No disponible" }), { status: 503, headers: { "Content-Type": "application/json" } })
          : new Response(JSON.stringify(snapshot), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ packages: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));

    render(<AdminCenter />);
    expect(screen.getByText("Cargando administración…")).toBeInTheDocument();
    const retry = await screen.findByRole("button", { name: "Reintentar" });
    fireEvent.click(retry);

    expect(await screen.findByText("Centro de administración")).toBeInTheDocument();
    expect(adminAttempt).toBe(2);
  });

  it("distinguishes a catalog failure from an empty catalog and labels every managed-skill field", async () => {
    let catalogAttempt = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/admin") return new Response(JSON.stringify(snapshot), { status: 200, headers: { "Content-Type": "application/json" } });
      catalogAttempt += 1;
      return catalogAttempt === 1
        ? new Response(JSON.stringify({ error: "No disponible" }), { status: 503, headers: { "Content-Type": "application/json" } })
        : new Response(JSON.stringify({ packages: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));

    render(<AdminCenter />);
    expect(await screen.findByText("No se ha podido cargar el catálogo de skills.")).toBeInTheDocument();
    expect(screen.queryByText("No hay skills publicadas en este catálogo.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await screen.findByText("No hay skills publicadas en este catálogo.")).toBeInTheDocument();

    expect(screen.getByRole("textbox", { name: "Identificador de la skill" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Nombre visible" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Versión" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Cuándo debe usarse" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Instrucciones confirmadas" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Procedencia y fecha de confirmación" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Audiencia" })).toBeInTheDocument();
  });
});
