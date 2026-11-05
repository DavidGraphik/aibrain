import { describe, expect, it } from "vitest";
import { safeMailSearchDiagnostic } from "./mail-search-diagnostic";

describe("mail search diagnostics", () => {
  it("accepts only the fixed phase and exception class", () => {
    expect(safeMailSearchDiagnostic("AIBRAIN_MAIL_SEARCH_DIAG phase=snapshot_select exception=TimeoutError\n"))
      .toBe("MAIL_SEARCH_DIAGNOSTIC phase=snapshot_select exception=TimeoutError");
  });
  it.each([
    "AIBRAIN_MAIL_SEARCH_DIAG phase=snapshot_select exception=TimeoutError private-provider-text\n",
    "AIBRAIN_MAIL_SEARCH_DIAG phase=INBOX exception=TimeoutError\n",
    "AIBRAIN_MAIL_SEARCH_DIAG phase=snapshot_select exception=secret@example.com\n",
    "AIBRAIN_MAIL_SEARCH_DIAG phase=snapshot_select exception=TimeoutError\nsecret",
    "secret\nAIBRAIN_MAIL_SEARCH_DIAG phase=snapshot_select exception=TimeoutError\n",
  ])("rejects diagnostics with any untrusted content", value => {
    expect(safeMailSearchDiagnostic(value)).toBeNull();
  });
});
