import "server-only";
import { createHash } from "node:crypto";
import path from "node:path";
import type { InstallationConfig } from "@/config/installation-schema";
import { resolveWorkerOwnedPath } from "@/runtime/workers/provisioner";
import { readRegularFileWithin } from "@/security/safe-file";
import { atomicWriteFile } from "@/storage/atomic-file";

const ARNALL_LOGO_SOURCE = "branding/arnall/logo.jpg";
export const ARNALL_LOGO_WORKSPACE_PATH = ".aibrain-brand/arnall-logo.jpg";
const ARNALL_LOGO_SHA256 = "d09bb6bb7e8af8270c9a0c2f8143cfc710ae8c4f75112dad2fe1cc7e5d24b2f8";
const MAXIMUM_LOGO_BYTES = 64 * 1024;

function isOfficialLogo(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex") === ARNALL_LOGO_SHA256;
}

/** Trusted installation policy and a local asset, refreshed on every turn. */
export async function prepareDesignBrandAssets(
  config: Readonly<Pick<InstallationConfig, "companySlug">>,
  projectWorkspace: string,
  publicRoot = path.join(process.cwd(), "public"),
) {
  if (config.companySlug !== "arnall") return "";

  const instructions = [
    "## Arnall design files: mandatory official logo",
    "Whenever creating or revising a designed file for this installation, include the official Arnall logo automatically. This covers presentations, slide PDFs, designed reports and documents, posters, flyers, menus, social graphics and other visual deliverables, in any language. Follow-ups and resumed tasks inherit this requirement. Do not ask whether to add it or ask the user to supply it again.",
    "Embed the actual logo image in every final design file, including each requested export, so it remains visible when downloaded or opened offline. A separate logo attachment, external URL, text mention or placeholder does not satisfy this requirement. Place it visibly and legibly in a suitable brand area; preserve the entire mark, its proportions, original colors and background. Never crop, distort, recolor, redraw or invent a replacement. For multi-page documents, include it at least on the cover or opening page and retain it in exports.",
    "Use local design authoring that supports embedding the image; a basic text-only renderer cannot fulfill a designed-file request. When using image generation, use the official asset as a reference and verify that the final mark is faithfully preserved before delivery. Do not treat a generated approximation as the official logo.",
    "Before delivery, inspect the actual rendered output and confirm the logo is present, complete and readable in each final format alongside the existing visual checks. Correct missing or damaged branding before delivering. A revision must retain the logo. Keep original source files intact and work on the requested output copy. Do not add attachments or logos to ordinary chat replies. This policy grants no publishing, sending, provider or cross-tenant permissions.",
  ];

  try {
    const officialLogo = await readRegularFileWithin(publicRoot, ARNALL_LOGO_SOURCE, MAXIMUM_LOGO_BYTES);
    if (!isOfficialLogo(officialLogo)) throw new Error("Unverified packaged logo.");
    const logoPath = await resolveWorkerOwnedPath(projectWorkspace, ARNALL_LOGO_WORKSPACE_PATH);
    const existing = await readRegularFileWithin(projectWorkspace, ARNALL_LOGO_WORKSPACE_PATH, MAXIMUM_LOGO_BYTES)
      .catch(() => null);
    if (!existing || !isOfficialLogo(existing)) {
      await atomicWriteFile(logoPath, officialLogo);
    }
    instructions.push(`The verified official logo is available at ${JSON.stringify(logoPath)} (JPEG, 194 × 194). Use these supplied bytes; no web download or upload is needed. This asset is an input, not a final deliverable.`);
  } catch {
    // A missing/unsafe asset must not prevent unrelated chat work or lead to
    // an unbranded deliverable being presented as complete.
    instructions.push("The official logo could not be prepared safely for this turn. If producing a design file, explain that its required branding is unavailable and needs administrator attention; do not claim completion or deliver a final unbranded substitute. Unrelated work may proceed.");
  }
  return instructions.join("\n");
}
