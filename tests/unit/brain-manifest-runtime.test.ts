import { describe, expect, it } from "vitest";
import { baseBrainManifest, operationsBrainManifest } from "@/config/brain";

describe("public brain manifest runtime", () => {
  it("describes only the private worker WebSocket transport", () => {
    for (const manifest of [baseBrainManifest, operationsBrainManifest]) {
      expect(manifest.runtime).toEqual({
        adapter: "codex_app_server",
        transport: "private_websocket",
      });
    }
  });
});
