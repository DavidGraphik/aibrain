import { createHash } from "node:crypto";
import { canonicalJson } from "@/lib/canonical-json";
import { PermissionResolutionError } from "@/permissions/errors";

export function canonicalPermissionJson(value: unknown) {
  return canonicalJson(value, detail => new PermissionResolutionError(
    "PERMISSION_POLICY_INVALID", `Canonical permission data ${detail}`,
  ));
}

export function permissionFingerprint(value: unknown) {
  return createHash("sha256").update(canonicalPermissionJson(value)).digest("hex");
}
