# Native connections

Hosted deployments use the employee's isolated Codex App Server to execute
assigned native MCP tools. The model uses a server-owned API key; each provider
retains its own employee authorization. Codex owns the MCP authentication and protocol;
the workbench supplies the authenticated employee, current catalogue policy,
per-turn tool admission, conversation state and artifact handling. This path adds
neither another model dispatcher nor a new OAuth token exchange service.

ChatGPT Apps described below are a personal development compatibility surface.
Hosted API-key mode disables their discovery and execution; a desktop connection
cannot be assumed portable. The [official App Server auth contract](https://learn.chatgpt.com/docs/app-server#auth-endpoints)
does not permit ChatGPT app-server authentication for commercial/hosted services.
See [hosted model authentication and provider readiness](HOSTED_CODEX.md).

Existing direct API and host adapters remain available where a native connection
does not cover the provider's required capabilities. A native connection must
prove equivalent operations and account scope before replacing one of them.
Changing an IMAP adapter's transport to MCP alone does not improve its search.

## Employee identity and policy

Personal native connections require `AIBRAIN_CODEX_AUTH_SCOPE=per-user`, a valid
employee identity and that employee's isolated runtime. Shared operator auth
through `AIBRAIN_SHARED_CODEX_AUTH_SOURCE` or
`AIBRAIN_CODEX_OWNER_AUTH_SOCKET` disables this personal path. Model access and a
provider connection are separate: a signed-in model account does not grant mail,
CRM or ERP access.

The installation catalogue assigns each resource, its MCP server name or,
in personal development, native App ID,
and its allowed operations. The catalogue, workspace permissions and
current native inventory are checked together. MCP tools are limited to the
assigned read/write names; native App tools require current enabled/read-only
metadata, with writes additionally governed by workspace/catalogue policy and
an executable foreground agent turn. A denied execution grant disables all
native tools; read-only and background turns cannot inherit native write grants.
Previously enabled apps/tools receive explicit negative overrides when removed;
defaults alone cannot replace an existing per-tool grant in Codex configuration.
The complete committed installed-app snapshot supplies negative overrides for
unassigned apps after a restart. Loaded conversations also retain prior tool
names only to disable them, never to carry permissions forward. An unavailable
inventory disables native Apps for that turn while ordinary chat can continue.
This check does not force a remote provider refresh on every turn.
Unknown, ambiguous or disabled resources do not receive blanket tool access.
Native App IDs are opaque provider keys, such as `connector_<opaque-id>` or
`asdk_app_<opaque-id>`. Preserve the exact installed ID, including underscores;
internal catalogue resource/rule IDs keep their separate slug format. App IDs
cannot contain key-path separators, traversal or the reserved `_default` setting.
Never infer a provider account or company workspace from the App's display name.
Provider output cannot authorize a mutation. Explicit account-holder review
requirements, including exact email review, still apply.

Packaged plugin MCP servers are not authoritative installation configuration.
Their bundle stays disabled until complete manifest provenance and policy can be
verified; assigning one known server cannot authorize its bundled siblings. The
current implementation does not claim that verification. Use a separately
reviewed native resource where supported rather than enabling an unknown bundle.

## Native authentication and lifecycle

Authenticated management routes are:

- `GET /api/connectors/native/[resourceId]`: inspect this employee's assigned
  resource and its available lifecycle operations.
- `POST /api/connectors/native/[resourceId]/oauth`: start a supported native MCP
  login with an empty body or `{}`. Its same-origin `GET` counterpart starts the
  flow and redirects the existing connection link. The resource, server and
  employee come from current server policy.
- `POST /api/connectors/native/[resourceId]` with
  `{"operation":"enable"}` or `{"operation":"disconnect"}`: enable or
  disconnect the local assigned connection.

These routes accept no provider host, tool command, token or replacement identity.
OAuth login uses Codex's native RPC and completion notification. Completion must
match the originating employee, server and login ID; after a restart, status is
rediscovered rather than inferred from a missing login receipt. Provider consent
must be completed by the actual account holder. A configured login is not proof
that OAuth or a provider operation has succeeded.

Remote OAuth uses one stable installation callback at
`GET /api/connectors/native/callback` (and a native callback suffix only when
verified in the SDK authorization redirect). Register that HTTPS callback with
the provider where required. The workbench automatically leases a positive
private loopback port for the login and writes only the assigned MCP server's
`oauth.callback_url` and `oauth.callback_port`; it reloads and reads them back
before asking Codex to start OAuth. Operators do not assign one public port or
proxy route per employee.

A private bounded receipt binds the native state digest to the authenticated
employee, installation resource, worker generation, login ID and port. The
callback takes its public origin from protected installation configuration,
including behind a reverse proxy; incoming Host/forwarded headers cannot select
it. It rechecks current authorization and that generation, then consumes the
receipt before forwarding the unchanged query to the exact private loopback
listener. It sends no browser cookies or authorization headers and never follows
provider redirects. Codex validates state/PKCE and performs the token exchange.
An interrupted or uncertain callback is not replayed. Expired, cross-user,
revoked and restarted-worker attempts require a new login.

The verified registration path uses native DCR with an explicit callback.
The pinned SDK honors a configured OAuth client before DCR, but its ordinary
static-client flow adds a random per-login callback suffix. A provider requiring
one exact registered redirect cannot accept that address. That incompatible
static callback is rejected before exposing the consent link, with
`NATIVE_OAUTH_STATIC_CALLBACK_UNSUPPORTED`. Do not bypass the SDK's issuer/auth
restrictions or advertise Google login from this fixture.

CIMD's restricted redirect rules and PAR links without an exposed state/redirect
also remain unsupported here. Google Workspace preview eligibility and an
actually compatible OAuth registration remain separate prerequisites. Keep the
necessary direct provider adapter until equivalent native access is verified.
A configured route or connected status is not proof of a real provider operation.
Authorization links and callback codes must not enter ordinary logs or source.

The pinned runtime can inspect native Apps that are already installed and
callable. If that surface does not expose the App's authentication/install
lifecycle, complete it through the supported external Codex/provider flow for
the same employee. A desktop connection is not automatically a server-worker
connection. Report unsupported lifecycle explicitly rather than inventing an
OAuth implementation or borrowing the operator's account.

Disconnect disables the local MCP configuration, refreshes it and retires the
employee runtime when necessary so loaded thread overrides cannot retain access.
It **does not revoke provider consent or delete provider credentials**: the
pinned App Server has no MCP OAuth revoke/logout RPC. Its result reports
`providerCredentialsRevoked: false`. Provider-side revocation is a separate
supported account operation. Re-enabling does not prove authentication is valid.

## Host provider adapters

The source packages under `deployments/trinalum/host/outlook` and
`deployments/trinalum/host/sibema` retain historical adapter identifiers for
compatibility. They contain provider code and synthetic tests, not connected
accounts, private installation configuration, timers or a deployment target.

Install reviewed packages into dedicated service directories outside the source
checkout and keep their databases, originals, credentials, keys and signatures in
protected installation storage. The mail package has its own committed npm lock;
install its dependencies there with that lock. SIBEMA uses Node built-ins. Use
the project's supported Node version. The authenticated host boundary binds the
employee, mailbox/company and allowed operation before invoking these operator
CLIs; they must not be exposed as arbitrary commands to the browser or model.
See [configuration](CONFIGURATION.md) for required private values.

The complete native package and its state must be versioned/recovered together
with the runtime contract. Do not reset operation receipts or create a new
database/key to get around an uncertain write. Existing identities, receipts and
artifact references require compatibility checks before migration.

The ERP contract fingerprint binds method, path and executable request
constraints, while excluding illustrative `example`/`examples` annotations.
This format differs from historical prepared-action hashes. Re-prepare only an
action proved not dispatched; preserve dispatched/uncertain receipts and their
reconciliation fences. Never reset their store to accommodate the new hash.

### Mail search and originals

`MailApi` exposes discovery, live search/read, grouped read, original/bundle and
attachment export, plus durable mail actions. A targeted structured search uses
`criteria` instead of `query`, for example:

```json
{
  "operation": "search",
  "criteria": {
    "reference": "123456-X:7890",
    "referenceIn": "subject",
    "companies": ["Example supplier", "Example customer"],
    "from": "sender@example.test",
    "after": "2026-01-01",
    "before": "2026-02-01"
  },
  "limit": 20
}
```

All supplied criteria are mandatory AND constraints. `referenceIn` selects
subject or text, with bounded separator-spacing variants preserving identifier
characters. Optional `subject`, `text` and `to` are also available. Dates are
inclusive `after` and exclusive `before`. `query` retains its literal Boolean
grammar; it is mutually exclusive with `criteria`. Invalid criteria must not
silently become a broader search.

Continue with identical criteria/query, folder and filters plus the returned
signed cursor. A different reference cannot reuse that cursor. Read exact
matching originals promptly for a targeted lookup. Exhaustive reports and
mailbox-wide absence claims require complete coverage; relevant-folder ordering
is not global chronological ordering. Received-first and MIME hints cannot
certify the globally latest PDF while other folders remain unsearched. A
metadata MIME/name match is not verification of original file bytes.

IMAP search uses bounded work, up to two connections with ordered progress, and
explicit partial coverage/errors on timeout or fallback. Optional empty-folder
proofs require fresh UID generation/status and expire; they cannot override a
provider error or establish a transactional mailbox snapshot. No provider
performance guarantee follows from synthetic timings.

`read_many` reads up to 20 exact native IDs from one mailbox folder/generation in
one read-only connection. Respect its byte/result/time limits and unprocessed
IDs. `bundle` exports the verified original EML and selected attachments from one
original load. Preserve IDs, bytes and hashes; exporting an original is distinct
from analyzing its PDF pages. A repeated/uncertain write is reconciled against
the same durable operation rather than resent with a new ID.

### ERP operations

The SIBEMA package includes its sanitized provider contract, schema discovery,
generic reads/actions and native extensions for notes, tariffs, offers, order
documents and deliveries. General API access remains limited to documented
operations and the configured installation. The current contractor scope and
legacy actor aliases are compatibility contracts, not grants for another
company. A new company mapping requires explicit review.

Mutations validate current identity/schema and preserve the unchanged entity
where required. Independent readback distinguishes verified fields from missing
or uncertain effects. PDF resource fences and durable receipts prevent duplicate
dispatch after interruption. Tariffs, offers, orders, deliveries and invoices
remain distinct resources; a missing provider operation cannot be replaced with
a different business effect. Provider UI functions may exceed its public API.

## Verification before replacement

Run the packages' focused tests with a single test worker:

```sh
npm test --prefix deployments/trinalum/host/outlook
npm test --prefix deployments/trinalum/host/sibema
```

The tests use synthetic providers and disposable state. Some ownership and
process-crash checks require root or Linux and explicitly skip elsewhere; retain
and run them in the matching acceptance environment. They do not connect a real
mailbox or demonstrate the complete native document/sandbox stack.

Before replacing an existing connector, verify native initialization and actual
provider consent on the server, allowed/denied tools for two employees, callback
ingress, disconnect behavior, repeated requests without duplicates, original
attachment integrity and real reversible provider readback. Measure provider,
tool and total user-response time separately on representative requests. A
configured OAuth flow, source build, mock test, connected status or HTTP health
response alone does not establish that acceptance.

### References in displayed results

Completed successful structured tool results may carry bounded `publicReferences`
display evidence. It preserves verified external record IDs and file digests
through streamed answers, durable reload and the final renderer. It does not
grant access or make a provider's proposed allowlist authoritative. Failed,
unstructured, input/secret/runtime metadata and known private context IDs do not
create exemptions. Private paths and other runtime details remain redacted.
Historical text already stored as a redaction cannot reconstruct its original ID;
re-read the authorized source when the actual reference is needed.
