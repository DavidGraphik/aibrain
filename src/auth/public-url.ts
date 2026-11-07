import "server-only";

import { loadInstallationConfig } from "@/config/installation";

export async function getPublicOrigin() {
  return new URL((await loadInstallationConfig()).publicUrl).origin;
}
