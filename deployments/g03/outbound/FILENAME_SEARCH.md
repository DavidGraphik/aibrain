# Optional source-side filename search

This extends the existing Windows connector and relay. It does not introduce a
second production agent, an index, a write operation, a provider consent or a UI.
Preparing these files does not update Windows, the relay, an application or a
customer installation.

## Contract

The protected host descriptor advertises `capabilities: ["filename_search_v1"]`.
The existing protocol-2 Windows poll optionally sends the same capability. The
relay accepts that claim only in an authenticated, installation/policy/nonce-bound
poll, expires its availability after 30 seconds, and **never dispatches the new
operation to a legacy poll**. A descriptor without the capability causes no new
RPC. `FILENAME_SEARCH_UNSUPPORTED` permits the original app-side browser fallback;
busy, offline, inaccessible or invalid responses do not trigger a hidden tree walk.

An app `filename_search` request carries literal `needle` (null on continuation),
opaque `cursor`, `roots`, `limit`, `budgetMs` and a server-derived `binding` hash.
The binding includes installation, employee, turn document roots and current
employee root grants. It is not accepted from model/browser arguments. The relay
intersects requested roots with its protected policy; Windows independently
checks its current protected configuration and actual opened filesystem handles.
Reparse points, hard-linked files, traversal and policy-excluded names remain
denied. The app validates returned paths against the requested roots and rechecks
revocable grants after the response.

The filename comparison is NFC, ordinal case-insensitive literal substring. ASCII
references containing a digit also ignore only spaces, dots, underscores and
hyphens, preserving letters and every digit/leading zero. User patterns are never
executed as a regex, glob, command or script.

Windows holds opaque continuation pages in bounded memory, not a copied file
index. Page replay preserves the same references/next cursor and rechecks their
current source metadata. Agent restart, expiry or permission changes produce an
explicit restart requirement. A scan observes a changing tree (`snapshot:false`)
and must not be presented as a historical snapshot or global proof of absence.

Bounds: 16 requested roots, 50 matches per response, a 4-second cooperative scan
budget, 100,000 observed entries, 4,096 queued directories, a 2 MiB directory-path
budget, 16 deferred inaccessible branches, 16 sessions, 128 page tokens and a
10-minute monotonic lifetime. Unavailable branches retain their continuation and
do not erase other queued work. Capacity failures require a narrower search.

Cancellation closes the app socket. The relay detects that close while waiting,
retires the job immediately, frees its queue slot and declines late results. The
Windows scan checks cancellation through a typed `active:true` request on the
**existing authenticated `/v1/poll` route**; no new proxy route is required. Native
filesystem calls themselves are synchronous: the cooperative budget cannot
interrupt a Windows kernel I/O call that is already blocked. Real Windows timing
and cancellation acceptance remain necessary.

## Release and isolated QA gates

The public export previously omitted the existing `G03Connector.ps1` and
`G03WriteCore.ps1`. These sources are restored from the authorized private source;
the write core is unchanged relative to that source, not attested against the
currently installed Windows file. The recovered agent omitted ASC although the
live read succeeded: ASC is retained here, and the installed agent/core hashes
and source must be read back before any replacement. Do not treat the recovered
checkout as proof of the exact Windows baseline. The connector obtains its HTTPS endpoint from
the protected installation configuration instead of containing a private hostname.
The new `G03FilenameSearch.ps1` is protected like the other program files and
loaded into that same agent.

The historical supervised Windows updater verifies a manifest's SHA-256 hashes,
uses the already protected dedicated-account credential and registers a limited
scheduled task. Those checks are integrity checks, **not a digital signature or
an automatic update channel**. Its old-version hashes/two-file manifest do not
describe this release; do not rerun that updater unmodified.

1. Review an exact bundle/manifest containing the connector, unchanged write core,
   search module and `Test-G03FilenameSearch.ps1`. No configuration, token, DPAPI
   credential, document or signing material belongs in that bundle.
2. On Windows/NTFS, run the offline fixture test in the reviewed bundle. It uses
   only its own temporary synthetic files, tests actual opened-handle/reparse
   checks, and substitutes only deployment ACL qualification and HTTP. This is
   not installation or UI acceptance. Mac/Linux results cannot replace it.
3. A parallel QA instance uses a **separate protected program/config/token
   directory**, installation ID `g03-qa-*`, `writesEnabled:false`, and
   `-QaIsolated`. Its mutex is derived from its different policy hash; the existing
   production mutex/program/task remain intact. It needs its own matching QA relay
   endpoint/policy and QA app installation/identity binding. Reusing the current
   production app identity or pointing this QA agent at the production relay is
   not a valid shortcut: the installation/policy checks reject it.
4. Run local `-CheckOnly -QaIsolated` under the existing dedicated non-admin
   identity. Preserve SYSTEM/Admin ownership, reader-only program/config/token
   access, existing filesystem grants, and fixed local volumes. Register/start
   only the separately authorized QA task; do not change the old task or sources.
5. Verify new negotiation, scoped real filename matches, stable continuation,
   cancellation, offline/busy/inaccessible errors, current grant revocation and
   the authenticated app UI. The private QA bridge must explicitly admit the new
   read-only metadata operation and its binding/roots contract before forwarding
   it to the QA relay, and propagate app disconnect to the upstream socket.
   Existing bridge allowlists must not be bypassed. Direct production transport
   cancellation tests do not establish cancellation through an extra QA proxy.
6. Production promotion needs its separately authorized Windows update and relay
   activation, preserving the previous reviewed program/manifest and the existing
   task/identity/ACLs. No provider scope, write setting or credential rotation is
   required by filename search.

No Windows installation, remote update, signature verification, source-agent QA
or customer UI acceptance is implied by the offline Python/TypeScript tests.
