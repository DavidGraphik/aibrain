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

This change enables authentication only. It does not permit employee model
inference using the owner's subscription. Existing personal-test checks in
worker-runtime-service and direct-stdio-runtime still reject a non-owner model
context; source user-access sockets remain owner-bound. Never bypass these checks
or copy David's model auth into an employee home. A future inference extension
needs an explicit server-owned model sponsorship capability bound to the live
support session and owner policy, with independent target worker roots, provider
identity and connector permissions, revalidated at admission/dispatch/snapshot.
No employee GraphikAI Apps or OAuth permissions can be inferred from model access.

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
