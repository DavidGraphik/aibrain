/** Only a fixed phase and exception class may cross from the provider process into logs. */
export function safeMailSearchDiagnostic(stderr: string): string | null {
  const match = /^AIBRAIN_MAIL_SEARCH_DIAG phase=(arguments|folders_list|snapshot_select|snapshot_uidnext|page_select|page_search|page_fetch) exception=(TimeoutError|ConnectionError|ConnectionResetError|BrokenPipeError|OSError|SSLError|MailError|ValueError|TypeError|RuntimeError|error|abort|readonly|Other)\n?$/.exec(stderr);
  return match ? `MAIL_SEARCH_DIAGNOSTIC phase=${match[1]} exception=${match[2]}` : null;
}
