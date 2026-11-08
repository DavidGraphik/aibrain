import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
await build({ entryPoints: [path.join(root, "scripts/provision-trinalum.ts")], outfile: path.join(root, "dist/trinalum-provision.cjs"), bundle: true, platform: "node", format: "cjs", target: "node24", conditions: ["react-server", "node", "require"], alias: { "@": path.join(root, "src") }, legalComments: "none" });

await build({ entryPoints: [path.join(root, "scripts/provision-trinalum-catalog.ts")], outfile: path.join(root, "dist/trinalum-catalog.cjs"), bundle: true, platform: "node", format: "cjs", target: "node24", conditions: ["react-server", "node", "require"], alias: { "@": path.join(root, "src") }, legalComments: "none" });

await build({ entryPoints: [path.join(root, "scripts/host-analysis.ts")], outfile: path.join(root, "dist/host-analysis.cjs"), bundle: true, platform: "node", format: "cjs", target: "node24", conditions: ["react-server", "node", "require"], alias: { "@": path.join(root, "src") }, legalComments: "none" });

// The privileged host relay is built separately by build-trinalum-host-relay.mjs.
// Its deployment scripts remain excluded from the reusable container context.
