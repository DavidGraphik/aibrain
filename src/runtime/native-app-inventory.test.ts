import { expect, it, vi } from "vitest";
import { assertNativeAppToolsReady, nativeInstalledApps } from "./native-app-inventory";

const app = { id: "connector_own", enabled: true, callable: true };
it("uses a fresh committed SDK observation on every warm read without forcing hosted rediscovery", async () => {
  const transport = { request: vi.fn().mockResolvedValue({ apps: [app] }) };
  for (let turn = 0; turn < 3; turn++) expect(await nativeInstalledApps(transport, [app.id], `turn-${turn}`)).toEqual([app]);
  expect(transport.request).toHaveBeenCalledTimes(3);
  expect(transport.request.mock.calls.every(([, params, , timeout]) => params.forceRefresh === false && params.threadId === null && timeout === 10_000)).toBe(true);
});

it("refreshes one missing assigned ID once and trusts the new absence without a stale fallback", async () => {
  const transport = { request: vi.fn().mockResolvedValueOnce({ apps: [app] }).mockResolvedValueOnce({ apps: [] }) };
  expect(await nativeInstalledApps(transport, [app.id, "connector_missing"], "missing")).toEqual([]);
  expect(transport.request.mock.calls.map(([, params]) => params.forceRefresh)).toEqual([false, true]);
  expect(transport.request.mock.calls[1][3]).toBe(45_000);
  expect(() => assertNativeAppToolsReady([app.id], {})).toThrow(expect.objectContaining({ code: "NATIVE_APP_READINESS_UNAVAILABLE" }));
});

it("preserves an explicitly disabled app without refreshing or enabling it", async () => {
  const entry = { ...app, enabled: false, callable: false };
  const transport = { request: vi.fn().mockResolvedValue({ apps: [entry] }) };
  expect(await nativeInstalledApps(transport, [app.id], "revoked")).toEqual([entry]);
  expect(transport.request).toHaveBeenCalledTimes(1);
  expect(() => assertNativeAppToolsReady([], {})).not.toThrow(); // Text/local tasks have no required native tools.
});

it("waits for enabled cold apps' tools and preserves a still-uncallable refreshed result", async () => {
  const cold = { ...app, callable: false };
  const transport = { request: vi.fn().mockResolvedValueOnce({ apps: [cold] }).mockResolvedValueOnce({ apps: [app] }) };
  expect(await nativeInstalledApps(transport, [app.id], "cold-tools")).toEqual([app]);
  expect(transport.request.mock.calls.map(([, params]) => params.forceRefresh)).toEqual([false, true]);
  transport.request.mockReset().mockResolvedValue({ apps: [cold] });
  expect(await nativeInstalledApps(transport, [app.id], "unavailable-tools")).toEqual([cold]);
  expect(transport.request).toHaveBeenCalledTimes(2);
});

it.each([{ apps: null }, { apps: [app, app] }, { apps: [{ id: app.id, enabled: true }] }, { apps: [app], nextCursor: "partial" }])(
  "rejects malformed committed inventory without trying another or stale source", async snapshot => {
    const transport = { request: vi.fn().mockResolvedValue(snapshot) };
    await expect(nativeInstalledApps(transport, [app.id], "invalid")).rejects.toMatchObject({ code: "NATIVE_APP_READINESS_UNAVAILABLE" });
    expect(transport.request).toHaveBeenCalledTimes(1);
  },
);

it("does not retain an earlier user's snapshot when another scoped transport rejects access", async () => {
  const own = { request: vi.fn().mockResolvedValue({ apps: [app] }) };
  const foreign = { request: vi.fn().mockRejectedValue(new Error("RUNTIME_IDENTITY_DENIED")) };
  await nativeInstalledApps(own, [app.id], "own");
  await expect(nativeInstalledApps(foreign, [app.id], "other")).rejects.toMatchObject({ code: "NATIVE_APP_READINESS_UNAVAILABLE" });
  expect(foreign.request).toHaveBeenCalledTimes(1);
});

it("does not use the committed partial snapshot after a failed cold refresh", async () => {
  const transport = { request: vi.fn().mockResolvedValueOnce({ apps: [app] }).mockRejectedValueOnce(new Error("timeout or revoked auth")) };
  await expect(nativeInstalledApps(transport, [app.id, "missing"], "cold")).rejects.toMatchObject({ code: "NATIVE_APP_READINESS_UNAVAILABLE" });
  expect(transport.request).toHaveBeenCalledTimes(2);
});
