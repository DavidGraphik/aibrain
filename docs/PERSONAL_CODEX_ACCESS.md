# Personal development access-token boundary

This is not the hosted deployment path. Hosted production defaults to
[server model authentication](HOSTED_CODEX.md). Personal development and an
explicit, private, one-owner test installation can use that person's Codex
subscription. This is not permission to share the account with customers or
treat personal QA as hosted-provider acceptance.

## Private personal testing

`AIBRAIN_MODEL_AUTH=personal-test` selects the existing per-user access provider
for a compiled private test installation. It requires a protected, read-only
`/etc/aibrain/personal-test.json` owned by root, with this exact non-secret shape:

```json
{
  "schemaVersion": 1,
  "installationId": "example-personal-test",
  "canonicalUserId": "11111111-1111-4111-8111-111111111111",
  "createdAt": 1793926800000,
  "expiresAt": 1793930400000
}
```

Times are UTC epoch milliseconds; the window may not exceed two hours. Bind the
private test controller, its access snapshot and its loopback-only ingress to
the same owner and a no-longer-lived lease. The profile authorizes exactly one
installation/user pair and is revalidated for warm clients as well as startup.
A missing, unsafe, expired or different-owner profile fails closed. It contains
no subscription token or task-approval phrase.

The native worker uses ephemeral ChatGPT authentication through the existing
private stdio lane. No API spending, shared/owner credential fallback, legacy
auth-cache import or customer activation is part of this test mode. Keep native
credential privacy profiles enabled. Label all UI receipts `personal-test`;
model/provider behavior under this mode does not establish hosted API-key
acceptance or portability of the person's ChatGPT App connections.

## Access snapshot boundary

`AIBRAIN_CODEX_USER_ACCESS_SOCKET_ROOT` optionally enables a server-side provider
for one development installation and employee.
Use `AIBRAIN_CODEX_AUTH_SCOPE=per-user` or omit the scope. Shared-QA sources,
installation-owner sockets and owner acknowledgements are incompatible.

The backend derives the Unix socket exclusively from the registry's canonical
identity:

```
<root>/<installationId>/<canonical-user-UUID>.sock
```

The full pathname must fit within 103 bytes. Configure a short absolute canonical
root; no symlink may appear in its path. Root and installation directories must
belong to UID 0 and reject group/other writes. Ancestors must also be root-owned
and protected; root-owned sticky system temporary ancestors are accepted. The
socket must be root-owned, owner-readable/writable, without executable or
other-user permissions. When group access is enabled, its group must equal the
backend process's effective group. Typical permissions are directories `0750`
and socket `0660`, owned by `root:<backend group>`.

The provider sends `POST /access` over that socket. The JSON request contains
exactly `installationId`, `userId`, and `previousAccountId` (initially `null`).
It sends no token to the broker. A successful response is HTTP 200 with exactly:

```json
{
  "installationId": "example-qa",
  "userId": "11111111-1111-4111-8111-111111111111",
  "accessToken": "<current access token>",
  "chatgptAccountId": "<bound ChatGPT account ID>",
  "chatgptPlanType": null
}
```

The broker must authorize the exact installation/user pair independently of the
request's declarations. It must fail closed for all unmapped identities. An
installation-wide credential or an operator account is not an employee mapping.
Both IDs are verified on every response, the account remains fixed for the
worker lifetime, and socket ownership/permissions/inode are checked before and
after the request. Responses are bounded to 32 KiB and requests time out after
8.5 seconds. Unknown keys, refresh tokens, account changes and a token already
rejected by Codex are rejected. Errors do not expose response contents.

`userAccessAuthProvider(context)` creates one callback per worker context. The
runtime factory's `authForContext` hook resolves it before exposing the worker
transport. `initialize`, `account/login/start` with the pinned 0.162.1
`chatgptAuthTokens` contract, and subsequent private refresh replies use the
existing private stdio lane. Credentials never pass through transport journals,
browser inputs or worker environment variables. The module reads no auth files
and performs no refresh, consent, OAuth or account discovery; the host returns
its current authorized access-token snapshot.

This is a backend boundary, not a production sign-in implementation. The
[official App Server documentation](https://learn.chatgpt.com/docs/app-server)
describes external tokens as experimental and requires the host to own their
lifecycle. It also directs commercial/hosted authentication to Sign in with
ChatGPT. A hosted product must implement the supported
[Sign in with ChatGPT lifecycle and provider configuration](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
and verify its approved scopes and token compatibility; this adapter does not
establish those prerequisites or make desktop app connections portable.

Native connection guards remain `per-user`; provider credentials and identity
are separate from application grants. No production broker, credential or
customer mapping is installed by enabling this code. QA can supply a separately
owned broker and isolated installation, without mounting production data or
altering the canonical token owner's renewal process.
