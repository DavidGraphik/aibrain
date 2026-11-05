import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
const root = path.resolve(import.meta.dirname, "../..");
describe("dictation permission policy", () => {
  it("permits a native microphone request from this origin at both policy layers", async () => {
    for (const file of ["next.config.ts", "infra/hetzner/nginx/aibrain.conf.example"]) {
      const source = await readFile(path.join(root, file), "utf8");
      expect(source).toContain("microphone=(self)");
      expect(source).not.toContain("microphone=()");
      expect(source).not.toContain("microphone=*");
      expect(source).toContain("camera=()");
      expect(source).toContain("geolocation=()");
    }
  });
});
