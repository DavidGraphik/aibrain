# Acceptance coverage inventory

Inventory base: `d381ccf836516f91464f20225403996e7e8158d1`.

## Current coverage classification

| Area | Existing evidence | Classification before this harness | Next live gate |
|---|---|---|---|
| HTTP/contracts | Versioned route/schema and CI workflow contract tests | Local/CI prefilter | Candidate checkout, CI, deploy state, runtime and separate app/gateway OCI inspections must correlate to one SHA; readiness evidence covers both health routes |
| Functional desktop/mobile | Playwright flows, responsive states and 14 E2E specs | Local demo prefilter; Playwright starts `127.0.0.1` with demo auth/runtime | Run against Arnall with real auth and no route interception |
| Accessibility/visual | 5 accessibility specs, 4 visual suites and one visual matrix | Local demo prefilter | Coordinated serial live/browser slot after functional gates |
| Performance/concurrency | Synthetic high-frequency stream and intercepted concurrent conversations | Local synthetic prefilter | Measure navigation, input, TTFT, stream gaps, total turn, reconnect and tool readback against declared p95 budgets |
| Restart/reconnect | Worker, journal, HTTP restart, replay and crash recovery tests | Strong local integration prefilter | Coordinated real restart/reconnect with duplicate and persistence assertions |
| Two users | Multi-user acceptance covers four turns and isolation | Local fake App Server; not two real Arnall identities | David/Arnau positive flows plus negative cross-user reads/mutations |
| Real turn | Opt-in real App Server smoke/resume/cancel spec | Local opt-in; not bound to the Arnall release | Authenticated David+Arnau turn, stream, runtime readback and logs on the same SHA |
| Files/search/library/memory | Unit and route integration slices | Local synthetic fixtures | Both users upload/use/search/library/memory with typed evidence for each route |
| Connector/action/readback | Durable approval and browser tool unit/integration coverage | Local synthetic execution; no real provider action | One OAuth-authorized live provider operation with tenant/actor/release correlation, exactly-once execution and provider readback; health/capability/audit/connected states do not qualify |
| Logs/backup/rollback | Logging, backup orchestration and release manager tests | Local/simulated operational prefilter | Live log correlation plus typed backup, restore and rollback evidence |

There was no `tests/security` directory, canonical live manifest or machine gate that
prevented local/demo evidence from being called accepted. The new verifier closes
that false-acceptance path. It deliberately does not claim any live gate has run.

## Required live sequence

1. `release-identity-readiness`: exact canonical target, TLS/readiness, a verified candidate checkout, and independent CI, deploy-state, runtime and app/gateway OCI readbacks correlated to one SHA. A predeploy declaration alone blocks this gate.
2. `threat-model-contracts`: route/schema/security contracts on the candidate SHA.
3. `functional-desktop-mobile`, then `accessibility` and `visual` in the coordinated slot.
4. `performance-concurrency` with all required p95 metrics recorded and at or below a declared budget.
5. `failure-restart-reconnect` with persistence, dedupe and recovery readback.
6. `two-user-isolation` using the two real roles and negative cross-user operations.
7. `real-turn` for both users through the real runtime, not merely a listening port.
8. `files-search-library-memory` end to end for both users on persisted live data.
9. `real-action-approval-readback` using one reversible provider action with OAuth credential reference, durable approval, exactly-once execution and provider readback, all correlated to actor, tenant and release.
10. `logs-backup-rollback` with log, backup, restore and rollback evidence from the same release window.

Usage:

```text
npm run acceptance:verify -- --manifest /absolute/evidence/manifest.json --evidence-root /absolute/evidence --format markdown
```

Exit code `0` means accepted. Exit code `2` means rejected or prefilter-only. The
verifier never performs login, actions, restart, rollback or deploy; collectors and
those operations remain separately coordinated.
