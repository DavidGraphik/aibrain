# AI Brain

A company assistant with durable conversations, projects, files, scoped knowledge, document tools, connectors and scheduled work. Each installation owns its identities, data, credentials and permissions.

This repository is an independent, historyless source preparation. Existing deployments are not connected to it. Customer configuration, documents, credentials, production destinations and historical operational evidence are intentionally kept outside this repository. Named adapter identifiers remain where required for compatibility; they are not customer data or permission grants.

## Development

Use Node.js 24.18.1 and the committed npm lockfile:

```sh
npm ci
npm run typecheck -- --incremental false
node .github/scripts/run-quality-tests.mjs
npm run build -- --webpack
```

For local development, copy `.env.example` to an untracked `.env.local` and select a synthetic installation example from `config/installations`. Use your own provider connections; no working production credentials ship here. Start with `npm run dev -- --webpack` when dependencies are symlinked outside the checkout. Never point an example at a real user's data directory.

## Capabilities retained

- Durable projects and conversations, selected-history reads, sharing and server-side access checks.
- Streaming/reconnect/cancellation, task visibility, memory and company knowledge.
- File upload, document versions, previews and generation, including PDF and Office formats.
- Connector adapters, support workflows, scheduling and background automation workers.
- Native worker/document sandbox and egress policy code, identity/session checks and recovery tooling.

Employee computer-use was retired before this export. Native web research and document tools remain. Provider consent and installed native dependencies remain prerequisites; an adapter's source code is not proof that a live account is connected.

## Public-source boundary

See [architecture](docs/ARCHITECTURE.md), [configuration](docs/CONFIGURATION.md), [native connections](docs/NATIVE_CONNECTIONS.md), [validation](docs/VALIDATION.md), [live acceptance](docs/BACKEND_ACCEPTANCE.md) and [migration](docs/MIGRATION.md). Public CI has read-only repository permissions, uses a standard Ubuntu runner and tests/builds source only. It does not publish images, contact production servers or activate deployments.

Third-party notices and copyright statements are retained in `THIRD_PARTY_NOTICES.md` and individual source files. No new project-wide license grant is introduced by this preparation.
