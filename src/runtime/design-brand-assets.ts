import "server-only";
import packagedAssets from "../../config/design-brand-assets.json";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import type { InstallationConfig } from "@/config/installation-schema";
import { resolveWorkerOwnedPath } from "@/runtime/workers/provisioner";
import { readRegularFileWithin } from "@/security/safe-file";
import { atomicWriteFile } from "@/storage/atomic-file";

export const ARNALL_LOGO_WORKSPACE_PATH = ".aibrain-brand/arnall-logo.jpg";
const MAXIMUM_LOGO_BYTES = 64 * 1024;
type BrandAsset = { companySlug: string; label: string; sourcePath: string; workspacePath: string; sha256: string };
async function brandAssets(): Promise<BrandAsset[]> {
  const file = process.env.AIBRAIN_DESIGN_BRAND_ASSETS_FILE;
  if (file && (!path.isAbsolute(file) || path.normalize(file) !== file)) throw Error("BRAND_REGISTRY_INVALID");
  if (file) {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o022)) throw Error("BRAND_REGISTRY_INVALID");
  }
  const entries: unknown = file
    ? JSON.parse((await readRegularFileWithin(path.dirname(file), path.basename(file), 64 * 1024)).toString("utf8"))
    : packagedAssets;
  if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry !== "object" ||
    ["companySlug", "label", "sourcePath", "workspacePath", "sha256"].some(key => typeof entry[key] !== "string") ||
    !/^[a-f0-9]{64}$/.test(entry.sha256) || !/^[a-z0-9-]+$/.test(entry.companySlug) || entry.label.length > 120 || /[\r\n]/.test(entry.label))) throw Error("BRAND_REGISTRY_INVALID");
  if (new Set(entries.map(entry => entry.companySlug)).size !== entries.length) throw Error("BRAND_REGISTRY_INVALID");
  return entries as BrandAsset[];
}

/** Trusted installation policy and a local asset, refreshed on every turn. */
export async function prepareDesignBrandAssets(
  config: Readonly<Pick<InstallationConfig, "companySlug">>,
  projectWorkspace: string,
  publicRoot = process.env.AIBRAIN_BRAND_ASSET_ROOT || path.join(process.cwd(), "public"),
) {
  let entries: BrandAsset[];
  try { entries = await brandAssets(); } catch {
    return "The official logo could not be prepared safely because its reviewed registry is unavailable. If producing a design file, do not claim completion or deliver a final unbranded substitute. Unrelated work may proceed.";
  }
  const asset = entries.find(entry => entry.companySlug === config.companySlug);
  if (!asset) return "";
  const isOfficialLogo = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex") === asset.sha256;

  const instructions = [
    `## ${asset.label} design files: mandatory official logo`,
    `Whenever creating or revising a designed file for this installation, include the official ${asset.label} logo automatically. This covers presentations, slide PDFs, designed reports and documents, posters, flyers, menus, social graphics and other visual deliverables, in any language. Follow-ups and resumed tasks inherit this requirement. Do not ask whether to add it or ask the user to supply it again.`,
    "Embed the actual logo image in every final design file, including each requested export, so it remains visible when downloaded or opened offline. A separate logo attachment, external URL, text mention or placeholder does not satisfy this requirement. Place it visibly and legibly in a suitable brand area; preserve the entire mark, its proportions, original colors and background. Never crop, distort, recolor, redraw or invent a replacement. For multi-page documents, include it at least on the cover or opening page and retain it in exports.",
    "Use local design authoring that supports embedding the image; a basic text-only renderer cannot fulfill a designed-file request. When using image generation, use the official asset as a reference and verify that the final mark is faithfully preserved before delivery. Do not treat a generated approximation as the official logo.",
    "Before delivery, inspect the actual rendered output and confirm the logo is present, complete and readable in each final format alongside the existing visual checks. Correct missing or damaged branding before delivering. A revision must retain the logo. Keep original source files intact and work on the requested output copy. Do not add attachments or logos to ordinary chat replies. This policy grants no publishing, sending, provider or cross-tenant permissions.",
  ];

  try {
    const officialLogo = await readRegularFileWithin(publicRoot, asset.sourcePath, MAXIMUM_LOGO_BYTES);
    if (!isOfficialLogo(officialLogo)) throw new Error("Unverified packaged logo.");
    const logoPath = await resolveWorkerOwnedPath(projectWorkspace, asset.workspacePath);
    const existing = await readRegularFileWithin(projectWorkspace, asset.workspacePath, MAXIMUM_LOGO_BYTES)
      .catch(() => null);
    if (!existing || !isOfficialLogo(existing)) {
      await atomicWriteFile(logoPath, officialLogo);
    }
    instructions.push(`The verified official logo is available at ${JSON.stringify(logoPath)} (reviewed local asset). Use these supplied bytes; no web download or upload is needed. This asset is an input, not a final deliverable.`);
  } catch {
    // A missing/unsafe asset must not prevent unrelated chat work or lead to
    // an unbranded deliverable being presented as complete.
    instructions.push("The official logo could not be prepared safely for this turn. If producing a design file, explain that its required branding is unavailable and needs administrator attention; do not claim completion or deliver a final unbranded substitute. Unrelated work may proceed.");
  }
  return instructions.join("\n");
}
