// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "../render-spanish";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WeeklyTokenBudgetNotice } from "@/components/weekly-token-budget-notice";
import { UiLocaleProvider } from "@/i18n/provider";

const budget = {
  weekStart: "2026-09-20T22:00:00.000Z",
  resetAt: "2026-09-27T22:00:00.000Z",
  remainingPercent: 75,
  threshold: 25,
  initialized: true,
};

let payload: unknown;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  payload = { budget: { ...budget } };
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => payload }));
  vi.stubGlobal("fetch", fetchMock);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const mount = (userId = "employee-one") => render(<WeeklyTokenBudgetNotice tenantId="arnall" userId={userId} />);
const focus = async () => { await act(async () => { window.dispatchEvent(new Event("focus")); }); };

describe("weekly token budget notice", () => {
  it("shows only remaining percentage and the Madrid reset time", async () => {
    mount();
    expect(await screen.findByLabelText("Saldo semanal compartido")).toHaveTextContent("Saldo semanal disponible: 75%");
    expect(screen.getByLabelText("Saldo semanal compartido")).not.toHaveTextContent(/tokens|caché|7[.,]?500[.,]?000/i);
    expect(screen.getByLabelText("Saldo semanal compartido")).toHaveTextContent("28 sept 2026, 0:00 (hora de Madrid)");
    expect(screen.getByRole("status")).toHaveTextContent("75%");
    expect(fetchMock).toHaveBeenCalledWith("/api/usage/budget", expect.objectContaining({ cache: "no-store", credentials: "same-origin" }));
  });

  it("does not render a placeholder when the installation has no limit", async () => {
    payload = { budget: null };
    const { container } = mount();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(container).toBeEmptyDOMElement();
  });

  it("translates the percentage-only notice into the employee locale", async () => {
    render(<UiLocaleProvider locale="en"><WeeklyTokenBudgetNotice tenantId="arnall" userId="employee-one" /></UiLocaleProvider>);
    const region = await screen.findByLabelText("Shared weekly allowance");
    expect(region).toHaveTextContent("Weekly allowance remaining: 75%");
    expect(region).not.toHaveTextContent(/tokens|cache|7[.,]?500[.,]?000/i);
    expect(screen.getByRole("status")).toHaveTextContent("75% or less of the shared weekly allowance remains");
    expect(screen.getByRole("button", { name: "Dismiss weekly usage notice" })).toHaveTextContent("Got it");
  });

  it("notifies each reached milestone once per employee and week, retaining usage after dismissal", async () => {
    const first = mount();
    expect(await screen.findByRole("status")).toHaveTextContent("75%");
    fireEvent.click(screen.getByRole("button", { name: "Cerrar aviso de consumo semanal" }));
    await focus();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText(/Saldo semanal disponible:/)).toBeInTheDocument();
    for (const threshold of [50, 75]) {
      payload = { budget: { ...budget, remainingPercent: 100 - threshold, threshold } };
      await focus();
      expect(screen.getByRole("status")).toHaveTextContent(`${100 - threshold}%`);
      fireEvent.click(screen.getByRole("button", { name: "Cerrar aviso de consumo semanal" }));
      await focus();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    }
    first.unmount();
    const second = mount();
    await screen.findByText(/Saldo semanal disponible:/);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    second.unmount();
    mount("employee-two");
    expect(await screen.findByRole("status")).toHaveTextContent("25%");
    payload = { budget: { ...budget, weekStart: "2026-09-27T22:00:00.000Z", resetAt: "2026-10-04T22:00:00.000Z" } };
    await focus();
    expect(screen.getByRole("status")).toHaveTextContent("75%");
  });

  it("keeps exhaustion visible without a dismiss button and updates after renewal", async () => {
    payload = { budget: { ...budget, remainingPercent: 0, threshold: 100 } };
    const { unmount } = mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("Límite semanal agotado");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    await focus();
    expect(screen.getByRole("alert")).toHaveTextContent("bloqueadas hasta la renovación");
    unmount();
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("Límite semanal agotado");
    payload = { budget: { ...budget, weekStart: "2026-09-27T22:00:00.000Z", resetAt: "2026-10-04T22:00:00.000Z", remainingPercent: 100, threshold: 0 } };
    await focus();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(/Saldo semanal disponible:/)).toHaveTextContent("100%");
  });

  it.each(["uninitialized", "malformed", "failed"])("shows unavailable rather than zero for %s usage", async (kind) => {
    mount();
    await screen.findByText(/Saldo semanal disponible:/);
    if (kind === "uninitialized") payload = { budget: { ...budget, initialized: false, remainingPercent: null, threshold: 0 } };
    if (kind === "malformed") payload = { budget: { ...budget, remainingPercent: -1 } };
    if (kind === "failed") fetchMock.mockRejectedValue(new Error("offline"));
    await focus();
    expect(await screen.findByRole("alert")).toHaveTextContent("No se puede comprobar el saldo semanal");
    expect(screen.queryByText(/Saldo semanal disponible:/)).not.toBeInTheDocument();
  });

  it("does not claim an unconfigured installation is blocked if the endpoint is unavailable", async () => {
    fetchMock.mockRejectedValue(new Error("old release has no budget endpoint"));
    const { container } = mount();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(container).toBeEmptyDOMElement();
  });

  it("continues to warn safely if browser storage is unavailable", async () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => { throw new Error("unavailable"); });
    vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("unavailable"); });
    mount();
    expect(await screen.findByRole("status")).toHaveTextContent("75%");
    fireEvent.click(screen.getByRole("button", { name: "Cerrar aviso de consumo semanal" }));
    await focus();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("polls every 15 seconds only while visible and refreshes when returning", async () => {
    vi.useFakeTimers();
    mount();
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
