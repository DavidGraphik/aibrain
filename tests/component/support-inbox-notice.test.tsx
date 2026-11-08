// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SupportInboxNotice } from "@/components/support-inbox-notice";
vi.mock("@/i18n/provider", () => ({ useUiText: () => (value: string) => value }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(() => { localStorage.clear(); Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); });
it("notifies on a real support response and opens the inbox", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ requests: [{ messages: [{ author: "support", createdAt: "2026-11-04T07:00:00Z" }] }] }) }));
  const open = vi.fn(); render(<SupportInboxNotice accountKey="synthetic:employee" open={false} onOpen={open} />);
  fireEvent.click(await screen.findByRole("status")); expect(open).toHaveBeenCalledOnce();
});
it("does not turn a queued submission or a fetch failure into a resolved notification", async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ requests: [{ status: "queued", messages: [{ author: "user", createdAt: "2026-11-04T07:00:00Z" }] }] }) });
  vi.stubGlobal("fetch", fetcher); render(<SupportInboxNotice accountKey="synthetic:employee" open={false} onOpen={vi.fn()} />);
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce()); await act(async () => {});
  expect(screen.queryByRole("status")).toBeNull();
});
it("records seen timestamp on open, with no ticket content saved in storage", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ requests: [{ messages: [{ author: "support", body: "private reply", createdAt: "2026-11-04T07:00:00Z" }] }] }) }));
  render(<SupportInboxNotice accountKey="synthetic:employee" open={true} onOpen={vi.fn()} />);
  await waitFor(() => expect(localStorage.getItem("aibrain.support.seen.synthetic:employee")).toBe("2026-11-04T07:00:00Z"));
  expect(JSON.stringify(localStorage)).not.toContain("private reply"); expect(screen.queryByRole("status")).toBeNull();
});
