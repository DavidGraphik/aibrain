import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import type { InstallationConfig } from "@/config/installation-schema";
import { generateLocalDocument } from "@/runtime/documents/local-document-generator";
import { renderReviewedSchedulePdf } from "./reviewed-pdf";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ root: "", threadId: "", uploadId: "", sourceSha256: "" }));
vi.mock("@/documents/server-service", () => ({
  documentServicesForUser: async () => ({
    manifest: { roots: { userRoot: "/var/lib/aibrain/data/users/97e35f14-31b9-404f-b43e-2000c3f61086", staging: "/staging" } },
    storageGate: { run: (work: () => Promise<Buffer>) => work() },
    staging: { stage: async (input: { threadId: string; uploadId: string; validated: { sha256: string } }) => {
      state.threadId = input.threadId; state.uploadId = input.uploadId; state.sourceSha256 = input.validated.sha256;
      return input;
    } },
  }),
}));
vi.mock("@/documents/preview-service", () => ({
  DocumentPreviewService: class {
    constructor(options: { previewRoot: string; spreadsheetLayout: string }) {
      state.root = options.previewRoot;
      expect(options.spreadsheetLayout).toBe("print");
    }
    async create() { return { sourceSha256: state.sourceSha256, pages: 1 }; }
    async readFile() { return Buffer.from("%PDF-1.7\nfixture\n%%EOF"); }
  },
}));

it("keeps the print derivative isolated by identity inside the production conversion allowlist", async () => {
  const workbook = await generateLocalDocument({ format: "xlsx", title: "Test", content: "Synthetic", rows: [["Test", "15:00–20:45"]] });
  await renderReviewedSchedulePdf({} as InstallationConfig, "97e35f14-31b9-404f-b43e-2000c3f61086", "cff61048-7784-4e2a-8bdd-8f79c930f35b", workbook.data, "corrected.xlsx");
  const firstId = state.uploadId;
  const sourceHash = createHash("sha256").update(workbook.data).digest("hex");
  expect(state.sourceSha256).toBe(sourceHash);
  const wrapper = await readFile("infra/hetzner/app/soffice-safe.sh", "utf8");
  const allowlist = wrapper.split("\n").filter(line => /^(uuid|preview_pattern)=/.test(line)).join("\n");
  expect(allowlist).toContain("preview_pattern=");
  await promisify(execFileCallback)("/bin/bash", ["-c", `${allowlist}\n[[ "$1" =~ $preview_pattern ]]`, "allowlist-test", `${state.root}/${state.threadId}/${state.uploadId}/.work-fixture`]);
  await renderReviewedSchedulePdf({} as InstallationConfig, "97e35f14-31b9-404f-b43e-2000c3f61086", state.threadId, workbook.data, "renamed.xlsx");
  expect(state.uploadId).toBe(firstId);
  await renderReviewedSchedulePdf({} as InstallationConfig, "97e35f14-31b9-404f-b43e-2000c3f61086", "cff61048-7784-4e2a-8bdd-8f79c930f35c", workbook.data, "corrected.xlsx");
  expect(state.uploadId).not.toBe(firstId);
});
