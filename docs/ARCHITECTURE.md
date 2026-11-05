# Keep the core small

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
