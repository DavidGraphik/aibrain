// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostJobsPanel } from "@/components/host-jobs-panel";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("host scope review UI", () => {
  it("requires review and an explicit final authorization before making a mutation", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: true, json: async () => ({ bindings: [] }) });
    vi.stubGlobal("fetch", fetcher);
    render(<HostJobsPanel initial={[{ job: "automation-acceptance", label: "Prueba manual", binding: null }]} projects={[{ id: "project", name: "Operaciones" }]} directory={{ membershipPolicy: "current", currentUserId: "david", users: [{ id: "david", name: "David" }], groups: [] }} />);
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Revisar autorización" }));
    expect(screen.getByRole("heading", { name: "Confirmar: Prueba manual" })).toBeVisible();
    expect(screen.getByText("Cuenta: David · operator@example.invalid · Trinalum.")).toBeVisible();
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" })); expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Revisar autorización" }));
    fireEvent.click(screen.getByRole("button", { name: "Autorizar este análisis" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ job: "automation-acceptance", projectId: "project", audience: { membershipPolicy: "current", userIds: ["david"], groupIds: [] } });
  });
});
