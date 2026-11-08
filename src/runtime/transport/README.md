# App Server transport boundary

`AppServerTransport` keeps runtime routing independent from one Codex transport.
The first implementation, `WebSocketAppServerTransport`, connects the AiBrain
backend to the private per-user worker gateway. The gateway owns the raw Codex
App Server connection and adds the small versioned envelope required for
durable acceptance, heartbeat, event ids, acknowledgements and replay.
The transport has no implicit in-memory replay fallback: composition must
provide a `TransportEventJournal`, and production must use a durable adapter.
`FileTransportEventJournal` is the local filesystem adapter. It stores a
versioned JSONL record, verifies contiguous worker sequences, rejects event-id
reuse and restores the replay cursor after a backend restart.
Delivered history is compacted atomically to a bounded tail (256 events by
default) while every undelivered event remains durable. Payload sequence and
the delivery cursor stay authoritative across compaction and restart; the
internal JSONL sequence is intentionally regenerable.

### Control replies during durable replay

A persisted live RPC response must not wait for every historical page to drain.
The transport can offer RPC responses from its existing bounded event buffer
while a replay page is blocked, including the first page. Historical
notifications and tool requests retain FIFO ordering. At connect, the transport
exposes the first unprojected sequence from its delivery cursor, and the scoped
router anchors contiguous application ACKs there before consuming any event.
An early initialize response can therefore resolve its caller without marking
that response delivered until all preceding events have completed projection.
The deferred worker transport forwards this cursor contract. No timeout,
request identifier, wire sequence validation or replay cursor is reset, and
losing a replay-read/response-wakeup race never removes an event from the buffer.

### Thread creation and late responses

Thread creation uses the admitted local turn ID as its stable request key.
Retries of that turn retain the same key; a subsequent user turn or toolset
bootstrap does not reuse an older creation request. After the initial 60-second
deadline, the chat waits up to 120 seconds for that request's original response
without submitting another `thread/start` or model turn. Duplicate pending
requests remain rejected by the router. If the deadline expires during the
durable response projection, completing that projection also resolves the
original late-response promise and clears its timeout receipt.

On 2026-09-21, production revision `7f89f20` recorded a creation timeout at
11:58:40 UTC, followed by two attempts with the same conversation-wide creation
key. The original response reached the journal at 12:00:31 UTC. A concurrent
horarIA calculation produced more than 1,300 streamed deltas, with the original
tool event still undelivered. This evidence motivates bounded late-response
recovery; it does not establish that journal throughput or cancellation of a
nested calculation is fixed. The new recovery and request-key behavior require
separate CI, publication, deployment and authenticated acceptance.

Local regression coverage includes recovery of a late creation without a
second submission, distinct creation keys for subsequent turns, projection
completion after the primary deadline, and 1,400 calculation deltas while the
parent tool is blocked. The 138 targeted runtime, transport, permission,
multi-user, restart and release tests passed, along with type checking, scoped
lint, generated-contract validation, infrastructure checks and the worker build.

Client submissions are acknowledged only after the gateway has durably
accepted their idempotency key and written them to App Server stdin. JSON-RPC
responses to server-initiated requests are stricter: their
`clientRequestId` is deterministically derived from the durable request event
and a SHA-256 fingerprint of its thread/turn scope,
and the gateway does not send `accepted` until App Server emits a later event
for the same thread and turn. If the process dies in that window, the response
stays uncertain and is replayed with the same identifier after worker restart.
This avoids acknowledging an approval response merely because it reached an
operating-system pipe.

The JSON-RPC payload types and runtime validators come from the generated Codex
`0.162.1` bindings and JSON Schemas in `contracts/codex/0.162.1`. Unknown
envelope fields, unknown methods, malformed or method-incompatible params,
non-JSON payloads, sequence gaps and binary WebSocket frames fail closed.

## Authentication and network boundary

### Bounded large responses (6 October 2026 candidate)

The 8 MiB WebSocket frame ceiling and client-submission ceiling remain in
place. Large server event envelopes use ordered `event-chunk` frames, each
containing at most 512 KiB of bytes encoded as base64. Their exact keys are
`protocolVersion`, `type`, `id`, `index`, `count`, `bytes`, `sha256`, and `data`.
The receiver permits one assembly, at most 32 MiB and 30 seconds; it checks
canonical encoding, lengths, order, identity, SHA-256 and UTF-8 before parsing
the original event. Duplicate, corrupt, oversized or interrupted assemblies
fail closed. Disconnect drops partial assembly; durable event replay starts
again without acknowledging partial content. Queued frames from an old socket
are ignored after reconnect. Journals retain their original complete event
schema and contiguous delivery semantics.

The private App Server stdout/response ledger allow a bounded message under
32 MiB, reserving space for its event envelope. Larger responses still exceed
the supported message budget. Gateway and transport must be released together.
Local tests recover the exact 9 MiB answer and perform a subsequent RPC with
the same live worker; this does not certify customer acceptance or arbitrary
unbounded answers.

- Credentials are supplied lazily by `WebSocketCredentialProvider` and are
  never accepted in the URL.
- Raw Codex App Server authentication uses `Authorization: Bearer <token>`.
  A subprotocol credential is available only for an AiBrain worker gateway that
  explicitly implements `aibrain.auth.*`; it is not presented as a raw Codex
  protocol feature.
- The endpoint must resolve entirely to loopback or RFC1918/ULA addresses.
  Docker service names require an explicit hostname allowlist. `ws://` outside
  loopback additionally requires an explicit private-plaintext opt-in; use
  `wss://` whenever the connection crosses hosts.

## Node WebSocket composition

Node's browser-compatible global `WebSocket` API does not expose a supported
way to add an `Authorization` header. `StandardWebSocketFactory` therefore
supports only the explicit subprotocol mode. The server-side composition uses
the pinned `ws` dependency through `NodeWebSocketFactory`, which supports the
private gateway's bearer header. Next keeps `ws` in `serverExternalPackages`;
bundling it into an API-route chunk can substitute framework WebSocket code and
prevent the loopback client from connecting even though the gateway listener
is healthy.

Codex App Server `0.156.1` marks its WebSocket listener experimental and
unsupported for production. The raw listener also does not provide AiBrain's
durable `eventId` replay or `clientRequestId` acceptance contract. Those
guarantees belong to the private worker gateway envelope implemented here;
they must not be simulated by reconnecting directly to a raw App Server and
silently resending accepted requests.


### Shared startup metadata index — 2 November 2026

Transport journals opt into a bounded process-local index shared only by the
same canonical file path, lock namespace, schema object and stable event-key /
sequence functions. Each read validates file identity (device, inode, size,
mtime, ctime, mode and link count); links and noncanonical aliases fail closed.
External append, rewrite or rotation invalidates the index. Only offsets, event
keys and sequence metadata are shared: decoded historical payload trees and
permissions are never retained by this mode. The existing 64 MiB / 128-index
LRU remains; the scope directory is capped at 128 entries.

Concurrent `loadCursor` startup reads may join the same in-flight canonical
revision before acquiring any resource lock. A changed revision starts an
independent read. A snapshot is validated before releasing its read lease; a
legitimate same-inode append afterward may return that linearized snapshot,
while subsequent readers validate the new full fingerprint. Rotation or unsafe
file identity before publication fails closed. The
in-flight table is capped at 128 scopes and four revisions per scope; completed
or failed promises are removed. This prevents a replacement local client from
revalidating the same large history behind a cold reader and exhausting the
unchanged lock deadline. Notifications, RPC routing, durable event ACKs,
compaction and recovery cursors retain their original protocol. No history or
cursor is edited as an operational workaround.

The regression holds a real journal lease in one generation and starts a
second generation: the isolated-index control times out, whereas the shared
metadata reader joins safely. It also covers schema isolation, selected-payload
revalidation, external append/rewrite/rotation and unsafe file identities.
Historical production lock-owner tokens were not retained by the failure logs;
the exact historical holder is therefore not claimed. Deployed acceptance of
the affected background task remains a separate gate.

Startup compaction also batches the removable delivered prefix. A journal may
be oversized because of undelivered history; its first ACK after restart must
not rewrite that entire pending suffix merely to remove one small old record.
An oversized journal compacts after either a full retained-event batch or a
retained-byte batch can actually be removed. Large delivered records still
trigger byte-based pruning; the delivery anchor and all pending events remain
untouched. Lock deadlines, replay order and acknowledgement durability do not
change.

Discretionary compaction defers under the append lock while the delivery anchor
is behind the last received event, including count/byte boundaries during
catch-up. This preserves the append lane for new RPC responses. A deferred
compaction is checked again by later ACKs and runs after replay drains even if
the final ACK is not a boundary; normal prefix-retention and anchor validation
then apply. Reconnect reconciliation still validates and durably confirms the
cumulative cursor immediately; it forces the compaction check, while any
pending suffix keeps the rewrite deferred by the same rule.
