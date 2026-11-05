# Installation configuration

Keep installation JSON and all secrets outside the public repository. Set `AIBRAIN_INSTALLATION_CONFIG` to the reviewed local configuration path. The examples use synthetic companies, example domains and temporary data roots. Provider credentials belong in the installation's protected secret store, not in committed examples.

## Deployment identity mapping

Some existing adapter policies bind operations to designated employees. Public source uses synthetic identities. Preserve the policy while supplying the installation's reviewed identities through the server-only `AIBRAIN_DEPLOYMENT_IDENTITIES` JSON environment variable. Supported keys are `operator`, `cmsOwner`, `manager`, `sales`, `administration`, `quality`, `production`, `office` and `hostOwnerId`. Use an email for each named identity and a UUID for `hostOwnerId`. Unknown keys, malformed JSON and invalid requested values are rejected. Missing keys retain the synthetic default, so migrations must supply every key their installation uses.

This mapping does not grant OAuth scopes, workspace roles, provider permissions or cross-user access. Existing session, membership, role, operation and installation checks remain authoritative. Do not expose this variable to the browser or log its contents.

The provisioning tools require caller-supplied identities. Keep the private mapping and ownership registry alongside the installation's other protected configuration. The default release ownership registry enrolls no production destinations; unknown installations fail closed.

## Business service endpoints

`AIBRAIN_SIBEMA_ORIGIN` supplies the protected ERP service origin. It must be HTTPS without credentials, path, query or fragment; the public default is a non-operational example domain. `AIBRAIN_ATTIO_WORKSPACE` supplies the installation's external CRM workspace selector where required. Keep actual values in private deployment configuration and verify them against the connected account.

## Native employee connections

See [native connections](NATIVE_CONNECTIONS.md) for the execution and acceptance boundary. Assign App IDs/MCP server names and permitted operations through the installation catalogue; keep provider URLs, commands and authentication in the employee's protected Codex runtime configuration. `AIBRAIN_CODEX_AUTH_SCOPE=per-user` is required for personal native connections. Shared operator authentication through `AIBRAIN_SHARED_CODEX_AUTH_SOURCE` or `AIBRAIN_CODEX_OWNER_AUTH_SOCKET` disables this path. Model login does not confer provider access.

Remote MCP OAuth requires a reviewed HTTPS browser callback and a fixed private listener port for each employee runtime. Configure native `mcp_oauth_callback_url`/`mcp_oauth_callback_port`, or server-specific `oauth.callback_url`/`oauth.callback_port`, and provision ingress to that employee's listener separately. A callback URL does not set the listener port or install routing. Verify provider registration, browser reachability and the completed native login before reporting a connection ready. Where the pinned runtime cannot authenticate/install a native App, use its supported external employee flow; do not reuse an operator account.

Native disconnect is a local disable, not provider credential revocation. Packaged plugin bundles without verified complete manifest provenance remain disabled. These limitations cannot be fixed by supplying more credentials in installation JSON.

## Host mail and ERP packages

Install provider packages in reviewed service directories outside this repository. Keep mutable databases, signing keys, credentials, original attachments and signatures outside the source checkout and container image. Supply environment values through the protected service configuration; do not commit a populated environment file. Package paths containing historical adapter names do not select a real company or connected account by themselves.

Mail package: `deployments/trinalum/host/outlook`, with its own committed npm lock. Install locked dependencies in the external service directory. The current CLI package uses these protected values:

| Setting | Purpose |
| --- | --- |
| `OUTLOOK_PROVIDER` | `imap_smtp` for the host mail API, or the supported Graph path where explicitly configured. Outlook desktop software alone does not establish a Microsoft-hosted mailbox. |
| `OUTLOOK_MAILBOXES_JSON` | One to 100 distinct `{name,address,loginAddress?}` bindings. Names and addresses must be unique; the authenticated host selects the employee's own binding. |
| `OUTLOOK_IMAP_HOST`, `OUTLOOK_SMTP_HOST` | Explicit provider hosts for IMAP/SMTP; no real host defaults ship in this package. Ports and TLS settings use their existing documented configuration fields. |
| `OUTLOOK_DATA_DIR` | Protected mutable mail state, including encrypted credential records, cursors and durable action receipts. |
| `OUTLOOK_TOKEN_ENCRYPTION_KEY` | Protected encryption key compatible with the existing mail state. Do not rotate by overwriting it or discard the original during migration. |
| `OUTLOOK_OPERATOR_NAME` | Optional trusted operator alias for the legacy action CLI. It does not authorize access or replace mailbox/employee checks. |
| `OUTLOOK_SIGNATURES_FILE` | Protected reviewed signature registry. If absent, the package looks for `email-signatures.json` beneath its configured data directory; it contains no embedded real signature. |
| `OUTLOOK_MAIL_ACTION_MODE` | Existing service action policy. Changing it does not supply human authorization or override explicit email-review requirements. |

SIBEMA package: `deployments/trinalum/host/sibema`, using Node built-ins. Configure `AIBRAIN_SIBEMA_ORIGIN` and `SIBEMA_API_NAMESPACE` together. The latter is the protected namespace used in `/ERPBerma/<namespace>/api/v1` and the provider contract prefix. Its default `company` and the default origin are synthetic and do not connect an installation. `SIBEMA_HOST`, if retained by a service wrapper, must equal the protected origin. The model cannot provide either value.

Provide `SIBEMA_USERNAME`/`SIBEMA_PASSWORD` through the protected service configuration, plus `SIBEMA_DATA_DIR` or `SIBEMA_DB_PATH` for existing durable state and the reviewed `SIBEMA_ACTION_MODE`. Native deletion signing keys and other service-owned files require their protected provider-adapter paths. Preserve existing actor mappings, operation receipts, process/resource fences and keys; their absence is not permission to reset an uncertain action. The package retains a fixed contractor scope and compatibility aliases; a different company's policy requires review rather than a caller-supplied override.

These packages contain no connected accounts, secrets, deployment destinations or timers. Configuration, installation and synthetic tests do not prove real provider effects. Follow [migration](MIGRATION.md) and verify the exact server artifact, native dependencies, employee isolation and affected UI/provider readback before any replacement.

## Approved private artwork

Default brand assets and profile examples are synthetic. A deployment can supply a reviewed design-asset registry with `AIBRAIN_DESIGN_BRAND_ASSETS_FILE` and its protected asset directory with `AIBRAIN_BRAND_ASSET_ROOT`. Each registry entry binds an installation/company to an exact asset hash. Invalid or absent artwork does not authorize a foreign asset or block unrelated work. Original artwork and identity data belong in private deployment storage.

## Host-loss decisions

Offline host preflight requires a fresh `AIBRAIN_HOST_LOSS_ACCEPTANCE_ID` matching the reviewed host configuration, plus the exact HTTPS `AIBRAIN_EXPECTED_PUBLIC_ORIGIN`. Old historical approvals are not inherited by this preparation. Installation scope, replica/alert policy and token checks remain enforced. Supplying an example value is not evidence that a real host has been accepted.
