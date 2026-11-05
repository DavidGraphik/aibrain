# Keep the core small

## Native runtime decision — 5 November 2026

Keep the existing browser UI and its authenticated API contract. Run one
persistent, isolated official Codex App Server per employee and service role.
Use its default stdio protocol inside that boundary. The application translates
native events into the existing UI stream; it does not run a second agent loop.

```text
Existing UI -> authenticated API / current ACL -> isolated Codex App Server
                                                     | native Apps / MCP
                                                     | provider-local operations
                                                     + owned files / artifacts
```

Codex owns the native thread, turn, item IDs, model execution and native history.
The workbench owns project membership, preferences, artifact links and the UI
checkpoint. It keeps native IDs rather than constructing another conversation
identity from transport ACKs. A UI checkpoint is not a complete native history.

The direct stdio implementation is a separate, explicit live transport. It has
no private WebSocket listener, gateway request ledger, mirrored transport event
journals, ACK replay or reconnect resend. Its process epoch and event ordinals
describe live delivery only. Never persist those ordinals as durable replay
cursors or infer a completed business action from a successful pipe write.
The legacy gateway remains available for compatibility while the direct path
passes the affected recovery and authenticated acceptance checks. That is a
migration boundary, not a second dispatcher to enable concurrently.

### Responsibilities that remain

| Responsibility | Authority |
| --- | --- |
| Session, tenant, membership, revocable permissions | Authenticated application boundary; never model output |
| Thread, turn, items, paged native history | Pinned official Codex App Server |
| UI state and projects | Workbench checkpoint, linked to native IDs |
| One admitted user intent across interruption | Durable turn submission and current native readback |
| Business writes and uncertain effects | Provider adapter receipts; never automatic stdin replay |
| Provider login and token renewal | Supported provider/Codex lifecycle for the actual employee |
| Mail, ERP and file search | Query execution next to the authoritative source |

The process launcher, filesystem isolation, resource limits, kernel ownership,
provider effect fences and exact email review requirements survive this change.
Retiring transport duplication must not retire those guarantees.

### Source operations instead of model-driven crawling

Prefer native connections that provide the required account scope and operation.
Use one supported path per resource. Keep a provider adapter only for a missing
capability, such as a local Windows drive, an IMAP mailbox or a business ERP.
Wrapping an inefficient adapter in MCP does not fix its search algorithm.

Search and filtering run at the provider, with bounded batching and continuation.
Folder traversal must not become hundreds of backend-to-host round trips. The
optional filename search capability runs in the existing source-side agent;
its installation and Windows/NTFS acceptance are separate from its code tests.
Return original resource IDs, coverage, continuation and typed errors. Partial
coverage cannot establish absence, a global total or the latest original.

Entity distinctions belong in executable provider contracts: a tariff is not
an offer, an ordered quantity is not a pending quantity, and an attachment name
is not verified original content. A read result cannot authorize a mutation.

### Acceptance and removal gates

Before selecting direct stdio for an installation, demonstrate actual provider
reads from the unchanged authenticated UI, a warm subsequent turn, reload,
stop then continue, two-user isolation and restart readback without duplicated
effects. Include attachment originals and downloaded generated documents.
Measure preparation, model time, tool time and final UI time separately.

The initial performance target is a normal targeted email lookup completing
within 60 seconds end to end on the agreed sample, with cold and warm results
reported separately. This is an acceptance target, not a measured guarantee.
Long reports may take longer but must preserve progress and complete coverage.
Do not conceal a four-minute foreground scan by increasing timeouts or by
claiming success from partial results.

Delete the old transport and recovery branches only after the replacement has
matching evidence for active-turn interruption, lost responses and persisted
legacy conversations. An unknown write remains unknown until source readback.
No at-least-once generic RPC queue may repeat it to improve availability.

### References and authentication boundary

The [official App Server protocol](https://learn.chatgpt.com/docs/app-server)
is the primary implementation reference. Generate bindings from the pinned
installed version, not an unpinned upstream schema. [T3 Code](https://github.com/pingdotgg/t3code)
(MIT) is an implementation reference for provider/UI separation;
[codex-webui](https://github.com/lezi-fun/codex-webui) (MIT) demonstrates a small
stdio bridge, but explicitly targets local/LAN use. Neither is proof of hosted
multi-tenant security, equivalent tools or a production login lifecycle.
No third-party product or visual assets have been imported by this decision.

The documented [Sign in with ChatGPT token-sharing route](https://developers.openai.com/siwc/token-sharing-open-source)
has separate eligibility and preview limitations for hosted products and
connectors. Successful personal QA with an existing account does not establish
commercial onboarding or portable desktop connections. See
[personal access](PERSONAL_CODEX_ACCESS.md) and
[native connections](NATIVE_CONNECTIONS.md); keep model authorization separate
from authorization to the company's mail, CRM, ERP and files.

The workbench coordinates conversations. Business adapters own their provider
contracts and effects. A new feature should extend its responsible module rather
than introduce another decision path in the conversation coordinator.

## Turn execution

- `src/runtime/worker-codex-turn.ts` owns turn admission, execution, event
  projection, cancellation and recovery.
- `src/runtime/worker-turn-tools.ts` makes one per-turn decision about the
  optional tool catalogue and its matching developer instructions. Its context
  is explicit; it does not read deployment configuration from the environment.
- Tool handlers keep their existing identity, permission and scope checks.
  Advertising a tool does not authorize its execution or prove a live provider
  connection. Restricted support previews replace the ordinary catalogue.
- Connector modules own authentication and provider errors. A read may refresh
  a rejected session under its documented policy. An uncertain write must not
  be repeated automatically.

## Native connections and bounded work

Assigned Apps and MCP tools execute through the employee's existing Codex App
Server. Current native inventory, installation catalogue and turn permissions
determine explicit tool overrides. Previously configured apps and tool grants
are disabled explicitly when removed; restrictive defaults alone do not erase
an earlier per-tool grant. Read-only and background turns do not receive native
write tools. Provider consent and callback ingress are installation prerequisites,
not effects of listing a resource. See [native connections](NATIVE_CONNECTIONS.md).

Provider-specific adapters remain where a native provider does not supply an
equivalent operation. Mail search preserves all constraints and cursor coverage,
ERP reads use bounded batches, and server filename searches retain a durable
continuation instead of discarding remaining folders. Protocol events are
persisted in bounded groups before delivery. One background maintenance task
can drain without delaying admission of the next scheduled job.

## Workbench UI

- `src/components/brain-app.tsx` coordinates the active conversation, drafts
  and navigation.
- `src/components/workbench-content.tsx` selects the visible workspace using
  the existing installation and access gates.
- `src/components/use-task-center.ts` owns task synchronization, response
  generations, pending mutations, notifications and optional preview cache.
  Older responses cannot overwrite newer changes; busy stays true until every
  pending mutation has settled. Server records remain authoritative.

Keep hooks and adapters explicit and narrowly scoped. Do not introduce a generic
plugin framework just to reduce one file's line count. Preserve public contracts
while moving responsibilities, and check the affected permissions, failure paths
and concurrent responses. The focused quality manifest includes these regressions.
