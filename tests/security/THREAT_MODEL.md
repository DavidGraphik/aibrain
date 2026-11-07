# AiBrain acceptance threat model

Scope: evidence used to decide whether one immutable AiBrain release is accepted on
`https://arnall.example-platform.invalid`. Localhost, preview environments, CI, mocks and demo
runtime are outside the final trust boundary and can only be prefilters.

## Assets and trust boundaries

- User and tenant isolation: David and Arnau must have distinct authenticated
  identities, workspaces, runtime state, files, browser state and audit records.
- Action authority: an approval must bind the exact user, thread, turn, tool call,
  arguments and release; execution must have a post-action readback.
- Release identity: candidate, CI, deploy, runtime, app OCI and gateway OCI must
  all equal the same full Git SHA; readiness evidence covers live and ready routes.
- Evidence integrity: raw HTTP/UI/log/metric/backup/rollback artifacts are private
  regular files below one evidence root and are addressed by SHA-256.
- Secrets: manifests and reports contain role-safe aliases only, never emails,
  cookies, bearer tokens, passwords or credentials.

## Prioritized abuse cases and gates

| Priority | Abuse or failure | Required gate |
|---|---|---|
| P0 | A green localhost/demo/CI suite is presented as production acceptance | Canonical live target and live-only manifest contract |
| P0 | Evidence from another release is substituted after deploy | Full release SHA on manifest, every gate and every evidence item |
| P0 | One user can read or mutate another user's threads, files, memory, browser or approvals | Two real users with negative cross-user reads and mutations |
| P0 | A connector health/capability/audit or “connected” state is presented as a real provider action | OAuth credential, live provider, durable approval, exactly-once execution and provider readback must share actor, tenant, operation and release identifiers |
| P0 | A stale or ambiguous approval executes a different action, repeats after reconnect, or lacks readback | Typed approval plus post-action readback evidence on the same release |
| P0 | A process restart/reconnect duplicates a turn or action, loses state, or crosses threads | Failure/restart/reconnect gate on the live release |
| P0 | Evidence paths escape, redirect through symlinks, or are replaced through hard links | Evidence-root containment, regular-file checks and SHA-256 |
| P0 | Tokens, cookies or user emails leak into the acceptance report | Strict schema and secret-shaped content rejection |
| P1 | Health endpoints are green while the real AI path is broken | Real authenticated turn plus readiness/release identity |
| P1 | Browser/file/search/library/memory surfaces expose demo data or cross trust boundaries | Live functional gates with negative isolation assertions |
| P1 | Backups exist but cannot restore, or rollback points at the wrong release | Separate backup, restore and rollback evidence bound to release SHA |
| P1 | Concurrency, streaming or reconnect is too slow or unstable to use | Recorded p95 navigation/input/TTFT/gap/turn/reconnect/tool-readback metrics |
| P2 | Desktop works while mobile, keyboard, accessibility or visuals regress | Coordinated functional/mobile/accessibility/visual Playwright gates |

The harness proves evidence completeness and integrity. It does not make a weak
artifact semantically strong: each live collector must still assert the behavior it
records, and acceptance reviewers must inspect failed or blocked gates.
