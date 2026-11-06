# Hosted Codex and provider connections

Keep the existing UI, current employee permissions and one isolated official
Codex App Server per employee/service role. Use its default stdio transport.
The hosted model authenticates with a server-owned OpenAI project API key;
provider accounts connect independently through native MCP or the existing
necessary provider adapter. There is no second agent loop or new model gateway.

## Supported model authentication

The [official App Server auth contract](https://learn.chatgpt.com/docs/app-server#auth-endpoints)
states that ChatGPT app-server authentication is not permitted for commercial
or hosted services. The subscription tokens used by a personal Codex installation
are not the model credential for this hosted product.

Production defaults to `AIBRAIN_MODEL_AUTH=server-api-key`. Personal Codex mode
is available only outside production. The server uses the native
`account/login/start` API-key method through the private stdio lane, with
`cli_auth_credentials_store="ephemeral"` and `forced_login_method="api"`.
Credentials do not belong in worker arguments, command environments, UI
requests, transport events or journals. A missing or invalid server credential
must fail closed; it must not select a personal account as a fallback.

The operator provisions `/etc/aibrain/model-api-key` as a read-only secret,
owned by root and readable by the backend group (`0640`). Its JSON binds the
credential to the installation:

```json
{
  "schemaVersion": 1,
  "installationId": "example-production",
  "apiKey": "<project API key>"
}
```

Do not put this file in Git, an image, a provider catalogue or an artifact.
The existing worker filesystem boundary hides `/etc/aibrain` from agent
commands. Keep a distinct key/project and budget for each installation; configure
provider spending limits and monitor actual usage. Hosted workers also require
Codex permission profiles that deny subprocess access to native MCP credentials,
auth files and private runtime stores; App Server itself retains access. Model
commands cannot expand those permissions or obtain an escalation grant. Rotate
the project key through protected operator provisioning and restart its owned
workers to load the replacement; do not copy it into employee configuration.
A local API-key login or
`account/read` result does not prove credit, model access or successful inference.

The separate [Sign in with ChatGPT program](https://developers.openai.com/siwc/token-sharing-open-source)
has eligibility and preview restrictions. Paid/hosted access requires the
appropriate program approval. This repository does not implement or assume
that approval, and never substitutes an operator's subscription for it.

## Native provider access

Use [Codex's native MCP configuration and OAuth](https://learn.chatgpt.com/docs/extend/mcp)
for a provider with a verified compatible server. The existing connection routes
bind the employee, assigned server, allowed tools and OAuth completion to current
installation policy. Supply the provider registration and register the stable HTTPS installation
callback before advertising a connection as ready. The workbench leases the
private Codex callback port and routes a single-use, employee-bound native state;
Codex retains discovery, PKCE, token exchange and provider credentials. See the
[supported callback contract](NATIVE_CONNECTIONS.md#native-authentication-and-lifecycle).
Model access does not establish provider consent or account/workspace identity.

Google documents remote MCP endpoints for
[Gmail](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server),
Drive and Calendar in its [supported-products catalogue](https://docs.cloud.google.com/mcp/supported-products).
These Workspace endpoints are Developer Preview and require program membership,
a Cloud project, enabled services and provider OAuth registration/consent.
Treat them as optional until that access and the actual account operations are
verified. An endpoint URL or a successful unauthenticated discovery request is
not an available customer connection.

The [Google Workspace CLI](https://github.com/googleworkspace/cli) is another
implementation reference, but its maintainers explicitly describe it as
unsupported and still subject to breaking changes. Do not replace a working
customer connection with it without equivalent acceptance evidence.

Keep a direct SDK/host adapter where the required supported native operation
does not exist, including IMAP, an ERP or an on-premises Windows drive. Fix
filtering, batching, continuation and original-resource handling at the source;
wrapping an inefficient implementation in MCP preserves its inefficiency.
Remove the old path only after the new one proves equivalent permissions,
operations, timing and effects from the authenticated UI.

## Release gate

Before any customer migration, verify a real funded/authorized model project,
each provider's actual identity and consent, two-user isolation, original reads,
repeat-safe writes, cancellation, restart recovery and normal query latency from
the unchanged UI. Keep blocked and not-run cases visible. Personal prototypes,
synthetic pipes, compilation and HTTP health do not satisfy this acceptance.

Do not import a legacy model auth file or MCP credential as proof of an
employee's provider identity. Verify the actual account, workspace, consent and
current resource grant independently. Preserve original histories and credentials
for recovery; migrate conversation data separately from connection authorization.
