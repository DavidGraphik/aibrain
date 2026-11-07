import { describe, expect, it, vi } from "vitest";
import { runtimeReadinessProbes } from "@/operations/runtime-readiness";

const environment = {
  AIBRAIN_CODEX_APP_SERVER_ACCEPTED: "1",
  CODEX_BIN: "/usr/local/bin/aibrain-codex-worker",
  AIBRAIN_SOFFICE_BIN: "/usr/local/bin/aibrain-soffice",
  AIBRAIN_PDFINFO_BIN: "/usr/local/bin/aibrain-pdfinfo",
  AIBRAIN_PDFTOPPM_BIN: "/usr/local/bin/aibrain-pdftoppm",
  AIBRAIN_PDFTOTEXT_BIN: "/usr/local/bin/aibrain-pdftotext",
  AIBRAIN_QPDF_BIN: "/usr/local/bin/aibrain-qpdf",
};

describe("runtime readiness probes", () => {
  it("requires the exact Codex version, worker isolation and every document adapter", async () => {
    const probes = runtimeReadinessProbes(environment, {
      async executable() { return true; },
      async version(executable) {
        expect(executable).toBe("/usr/local/bin/codex-real");
        return "codex-cli 0.162.1";
      },
    });
    const controller = new AbortController();
    await expect(Promise.all(probes.map((probe) => probe.check(controller.signal))))
      .resolves.toEqual([
        { status: "ready", code: "OK" },
        { status: "ready", code: "OK" },
      ]);
    expect(probes.every((probe) => probe.required)).toBe(true);
  });

  it("degrades independently for version drift and a missing document executable", async () => {
    const probes = runtimeReadinessProbes(environment, {
      async executable(executable) { return executable !== "/usr/local/bin/aibrain-qpdf"; },
      async version(executable) {
        expect(executable).toBe("/usr/local/bin/codex-real");
        return "codex-cli 0.150.0";
      },
    });
    const controller = new AbortController();
    await expect(Promise.all(probes.map((probe) => probe.check(controller.signal))))
      .resolves.toEqual([
        { status: "unavailable", code: "CODEX_VERSION_MISMATCH" },
        { status: "unavailable", code: "DOCUMENT_TOOLCHAIN_UNAVAILABLE" },
      ]);
  });

  it.each([undefined, "invalid", "0.0.0.0"])("does not require retired computer-use executables or Chrome version %s", async chromeVersion => {
    const executable = vi.fn(async (candidate: string) => !candidate.includes("chrom"));
    const version = vi.fn(async (candidate: string) => {
      if (candidate !== "/usr/local/bin/codex-real") throw new Error("Unexpected version probe");
      return "codex-cli 0.162.1";
    });
    const probes = runtimeReadinessProbes({
      ...environment,
      AIBRAIN_CHROME_BIN: "/missing/retired-chrome-wrapper",
      AIBRAIN_CHROME_EXPECTED_VERSION: chromeVersion,
    }, { executable, version });
    expect(probes.map(probe => probe.name)).toEqual(["codex-toolchain", "document-toolchain"]);
    await expect(Promise.all(probes.map(probe => probe.check(new AbortController().signal))))
      .resolves.toEqual([{ status: "ready", code: "OK" }, { status: "ready", code: "OK" }]);
    expect(executable.mock.calls.some(([candidate]) => candidate.includes("chrom"))).toBe(false);
    expect(version).toHaveBeenCalledExactlyOnceWith("/usr/local/bin/codex-real", ["--version"], expect.any(AbortSignal));
  });

  it.each(["/usr/bin/bwrap", "/usr/local/bin/aibrain-codex-worker"])("still rejects missing worker isolation executable %s", async missing => {
    const version = vi.fn(async () => "codex-cli 0.162.1");
    const probes = runtimeReadinessProbes(environment, {
      async executable(candidate) { return candidate !== missing; }, version,
    });
    await expect(probes[0]?.check(new AbortController().signal)).resolves.toEqual({
      status: "unavailable", code: "CODEX_EXECUTABLE_UNAVAILABLE",
    });
    expect(version).not.toHaveBeenCalled();
    await expect(probes[1]?.check(new AbortController().signal)).resolves.toEqual({ status: "ready", code: "OK" });
  });

  it("stays unavailable until this container startup completed a real App Server handshake", async () => {
    const probes = runtimeReadinessProbes({
      ...environment,
      AIBRAIN_CODEX_APP_SERVER_ACCEPTED: undefined,
    }, {
      async executable() { return true; },
      async version(executable) {
        expect(executable).toBe("/usr/local/bin/codex-real");
        return "codex-cli 0.162.1";
      },
    });
    const controller = new AbortController();
    await expect(probes[0]?.check(controller.signal)).resolves.toEqual({
      status: "unavailable",
      code: "CODEX_APP_SERVER_ACCEPTANCE_REQUIRED",
    });
  });
});
