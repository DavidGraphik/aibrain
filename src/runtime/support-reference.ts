import { SUPPORT_UUID } from "@/support/contracts";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** A case reference is usable in employee-visible prose without allowing raw
 * internal UUIDs through the global display scrubber. It grants no access:
 * read/reply still resolve within the authenticated employee's own store. */
export function supportReference(id: string) {
  if (!SUPPORT_UUID.test(id)) throw new Error("Invalid support request identity.");
  let value = BigInt(`0x${id.replaceAll("-", "")}`);
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = ALPHABET[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return `SUP-${encoded}`;
}

export function supportRequestId(reference: unknown): string | null {
  if (typeof reference !== "string") return null;
  // Keep older internal calls compatible while publishing only safe references.
  if (SUPPORT_UUID.test(reference)) return reference.toLowerCase();
  if (!/^SUP-[A-Z2-7]{26}$/i.test(reference)) return null;
  let value = 0n;
  for (const char of reference.slice(4).toUpperCase()) value = (value << 5n) | BigInt(ALPHABET.indexOf(char));
  if (value >= 1n << 128n) return null;
  const hex = value.toString(16).padStart(32, "0");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return SUPPORT_UUID.test(id) && supportReference(id) === reference.toUpperCase() ? id : null;
}
