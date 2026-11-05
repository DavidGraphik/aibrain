# Per-user worker runtime boundary

This directory owns durable provisioning and process-local lifecycle for one hot
worker per employee. A canonical user UUID maps to a versioned `worker.json`
manifest and private roots below `InstallationConfig.paths.usersRoot`.

The launch context deliberately contains no `publishWriteRoot`. It gives the
runtime read-only company/source mounts, private worker write mounts, and a
separate browser profile/download pair. The concrete process or container
factory must enforce those mount modes; this registry does not spawn processes
or change host mount permissions itself.

`WorkerRuntimeRegistry` has only instance-local handlers and ownership maps. It
deduplicates concurrent starts for a user, bounds concurrent/pending starts,
and refuses a runtime or transport object ever returned for another start.
Durable roots survive a Node restart; the injected factory is responsible for
reattaching or starting the pinned Codex App Server and browser services.

Before reusing a cached handle, the registry checks its controller generation.
A confirmed `failed` or `stopped` controller is retired and replaced for that
employee only, after both process and transport cleanup succeed. Concurrent
requests join the same recovery; explicit stop, close and maintenance fencing
prevent a replacement from starting. Transient transport reconnects, nonterminal
degradation and unavailable health checks never justify replacing an active
generation. Cleanup failure retains ownership until explicit cleanup succeeds.
Recovery reuses the employee's durable roots and journals; it does not replay
accepted RPCs or approve a pending connector effect. Local regression includes
a killed child process with another employee still active. Publication,
installation rollout and authenticated live acceptance are separate gates.

Security boundaries:

- User IDs are canonical lowercase UUIDs; worker-owned relative paths reject
  traversal, backslashes, control characters, and existing symlink components.
- Provisioned directories are real directories with mode `0700`; manifests are
  regular files with mode `0600`.
- Provisioning is locked and idempotent. A changed/corrupt manifest fails closed.
- The worker and browser receive different writable mount lists.
- Backpressure is technical capacity protection, not a user or commercial quota.

Known boundary: filesystem checks prevent persistent symlink substitution at
provision/resolve time, but the launcher must keep the directories private and
use OS/container isolation to prevent a malicious same-host process from racing
path use after validation.

Model queue recovery also carries an optional app-owned `.origin.json` sidecar
beside the v1 durable submission. It binds the exact dispatch request and provider
turn to a unique gateway generation, service role and kernel lock inode. Every
production gateway takes a shared `flock(2)` before launch and hands fd3 to the
sandbox monitor with `bwrap --sync-fd`; the parent closes its duplicate after
handoff. The stable generation inode is never removed or reused. Thus the lock
covers the actual sandbox lifetime, survives a parent crash, and releases when
the last owning process dies without relying on PID reuse or heartbeat age.

A queue observer may use its already-ready cached client only for that exact
origin. Otherwise it takes an exclusive lock on the original generation and
launches an independent bounded metadata-only App Server in the same employee
sandbox. It sends initialize, thread/read and summary pagination only, and never
logs child output or sends login, resume, inference or connector requests. Other
live generations remain unaffected. The exact submission lease and queue CAS
still fence terminal settlement. Missing/corrupt origin or replaced inode stays
unknown. Legacy receipts have no authoritative generation: warm reads additionally
require a loaded thread and no other owning service role; cold reads require all
legacy owner leases to be actually free and never reclaim them by TTL. A reviewed
administrative recovery may be necessary for abandoned legacy jobs. Deploy/drain
both service roles before treating the new kernel boundary as installed.
