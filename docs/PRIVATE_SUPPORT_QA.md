# Private employee support QA

The private-owner login remains bound to the protected QA owner credential and
short-lived personal-test policy. An ordinary employee cookie cannot pass that
owner check.

An employee may use the existing audited support flow in the isolated copy:
root-owned temporary support policy, operator-authenticated same-origin grant,
one-use redemption and persisted local support session. Session reads recheck
policy, installation, both enabled profiles, initial-login marker and expiry.
For private-owner mode the complete protected owner check applies to the persisted
support **actor**, while the resulting session retains the **target** employee's
identity. Connector authorization therefore continues to receive the employee's
identity and original grants. Revoking the session or temporary policy closes
access. No caller-supplied actor or target replaces persisted provenance.

The optional root-owned `/etc/aibrain/personal-test-support.json` sponsors model
inference only for explicitly pinned audited support sessions. It does not change
hosted defaults or the ordinary owner policy. Its schema is:

```json
{
  "schemaVersion": 1,
  "installationId": "g03-production",
  "sponsorUserId": "<canonical operator UUID>",
  "sponsorEmail": "<canonical operator email>",
  "createdAt": 0,
  "expiresAt": 0,
  "targets": [{
    "userId": "<canonical employee UUID>",
    "sessionIdHash": "<exact persisted support session SHA256>",
    "profileSha256": "<SHA256 of original user.json bytes>",
    "permissionsSha256": "<framed workspace-admin/state.json and catalog/state.json SHA256>"
  }]
}
```

Timestamps are milliseconds; expiry is future and at most two hours after creation.
The fixed file must be root-owned mode 0640 with the backend group, one link, and
stable through an inode-checked read. Session hashes are not browser credentials;
root pins them after the ordinary audited grant/redeem flow. Each target must be
a current enabled canonical profile with completed initial login. The complete
private owner guard still validates the sponsor, including its own personal-test
expiry. No employee credential, owner `auth.json` or OAuth identity is copied.

`supportModelPermissionsDigest` hashes decimal workspace byte length, `:`, workspace
bytes, decimal catalog byte length, `:`, catalog bytes. Profile bytes have their
own SHA256. Grant/policy/profile drift, revocation and expiry fail closed. Existing
admission/dispatch checks and the private credential lane revalidate this lease;
credentials are released only after another successful check. The sponsor socket
is selected solely inside the model auth provider. Worker IDs, paths, memory,
connector principals and provider ACLs remain those of the employee.

The lease authorizes the TARGET worker while the exact root-pinned support
session remains active. Runtime identity does not carry each request's browser
cookie hash: this is a worker lease anchored to that session, not proof that every
RPC came from that cookie. Another authorized David support session for the same
target can use that target worker while the pinned lease is active. Revoking the
pinned session stops that worker's model access, even if another support session
still exists. The lease never authorizes another employee or changes connector ACLs.

Sponsored workers launch with personal Apps disabled. Their transport blocks
`app/*`, both SDK config write forms (`config/value/write`, `config/batchWrite`) and thread/turn settings that re-enable Apps,
including warm resumes. This QA lease gives no access to the sponsor's GraphikAI
Apps. It grants no new employee connector permission. Local tests do not establish
UI acceptance: send real prompts from the authenticated employee support UI and
verify source-backed results before claiming the capability works end to end.

Use synthetic isolated QA threads and archive both project and chats at closure.
Production support policy, source permissions, external messages and provider
business data are unchanged by this code change.

Existing deterministic authenticated entry points (no model inference):

- `GET /api/connectors/mail/capability`: target Nominalia binding/credential
  capability; does not check provider reachability.
- `GET /api/connectors/mentions`: target catalog projection, including source
  corporate `/capabilities` and Sage health reads; may call providers, no model.
- `GET /api/g03/receiving`: target receiving workspace and Sage receiving data.
- `GET /crm`: Trinalum target-scoped Attio CRM reads.

There is no existing generic authenticated HTTP mail search/read or Sage read
endpoint. Those shared handlers are server-only `executeMailOperation`,
`g03SageReadForIdentity` and `trinalumConnectorHealth`; an internal deterministic
runner must bind its identity to the validated stored session. Capability checks
and read receipts do not prove chat inference or external write functionality.
