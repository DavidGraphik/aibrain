# Backend acceptance evidence

`scripts/verify-backend-acceptance.mjs` is a fail-closed validator of supplied
live evidence. It does not run cases, connect accounts, collect screenshots,
generate a passing receipt, publish, or deploy. Unit tests and a healthy HTTP
response are insufficient for this acceptance.

The public bank is `tests/acceptance/backend-use-cases.json`: 48 synthetic case
definitions covering mail, CRM, ERP, documents, history and runtime. It was
registered **after the initial backend implementation**. It must not be described
as a pre-change baseline or as a held-out benchmark. Run the same pinned bank
against a baseline and candidate before claiming improvement. Later variants
should be registered before the change they evaluate.

## Acceptance rule

- More than 90% of all registered cases must pass, including their time budget.
  Missing, failed, blocked and not-run cases remain in the denominator.
- Each category must reach at least 90%, and every critical case must pass.
- At least two registered employee identities must have passing authenticated
  UI cases. Cases include denied cross-user and cross-company requests.
- Duplicate effects, unauthorized access or incorrect writes reject the entire
  receipt regardless of its average. Passed writes require independent readback
  and repetition verification.
- Measure from the user's submission to the final response, including recovery
  and reconnection. Timing only the final segment is invalid.

These are acceptance criteria for the registered cases, not a guarantee that no
other error can occur. The validator always returns `improvementVerified:false`:
it has not executed or compared a baseline.

## Inputs and identity

Keep receipts and evidence in private storage outside the public repository.
Do not include credentials, access URLs, real customer data or customer evidence
in public fixtures. Use synthetic case data in an authorized test installation;
`live` means the real deployed backend and providers, not a local mock.

The validator requires three externally reviewed identity values: the complete
candidate Git SHA, the SHA256 of the exact release manifest bytes and the SHA256
of the exact committed case-bank bytes. Do not obtain these expected values from
an untrusted receipt itself. The receipt binds both the candidate and observed
installed revision to that SHA.

The release manifest contract is:

| Field | Required value |
| --- | --- |
| `schemaVersion` | `1` |
| `kind` | `aibrain-release-manifest` |
| `candidateSha` | Full 40-character Git SHA |
| `images` | Nonempty array, including `app`; unique `name`, exact candidate `revision`, immutable `sha256:…` image `digest` |

The receipt contains `schemaVersion:1`,
`kind:"aibrain-backend-live-acceptance"`, `environment:"live"`,
`execution:"authenticated-ui"`, `suiteId:"backend-common-v1"`,
`suiteSha256`, `manifestSha256`, `candidateSha`, `installedSha`, `startedAt`,
`completedAt`, `actors`, `incidents`, `releaseIdentityEvidence` and `results`.
Timestamps use UTC with milliseconds. `actors` contains at least two distinct
opaque aliases. `incidents.crossUserAccess`, `duplicateEffects` and
`incorrectWrites` must all be explicitly false.

`releaseIdentityEvidence` references an independently captured JSON artifact with
`kind:"runtime-inspection"`, `installedSha`, `manifestSha256`, `checkedAt` and
`images` matching the release manifest. Capture it at most five minutes before
the run starts. This ties evidence to observed runtime images; a source commit
alone does not establish installation.

## Case records and evidence

Each `results` entry names one registered `caseId` and a status: `passed`,
`failed`, `blocked` or `not-run`. Duplicate or unknown IDs are rejected.
An omitted case is a failure. Record observed duplicate/unauthorized/incorrect
effects even if the case otherwise failed; never replace an uncertain outcome
with fabricated zero-effect assertions.

A passed entry requires:

- Registered `actorId`, `startedAt`, `completedAt`, integer `elapsedMs` matching
  those timestamps, and `timingBasis:"user-submit-to-final-response"`.
- `passedChecks` containing every check in its case definition, and
  `sourceVerified:true`.
- `duplicatesObserved:0`, `unauthorizedEffects:false`, `incorrectWrite:false`.
- `evidence.ui` and `evidence.source` references. For a write, also
  `readbackVerified:true`, `repetitionVerified:true`, and `evidence.readback`.

Every evidence reference has a relative `path` under the evidence root and a
SHA256 `sha256` of its exact bytes. Files must be regular, not symbolic links or
hard links. The validator enforces byte limits and verifies hashes.

UI evidence is a JSON capture record with `kind:"authenticated-ui-case"` and
`captureMode:"browser"`. Source evidence has `kind:"source-verification"` and
`verified:true`. Both carry the exact case's `caseId`, `actorId`, `candidateSha`,
`startedAt` and `completedAt`. Write readback records have
`kind:"provider-readback"`, matching `caseId`, `actorId`, `candidateSha`,
`verified:true` and `singleEffect:true`. Preserve the underlying browser capture,
provider/source snapshots and their collection provenance alongside these
records for review.

Integrity validation cannot establish that an author honestly collected a
browser/provider artifact. The collector/reviewer remains responsible for
authentic collection and for checking the content against the registered case.
Handwritten booleans or unit-test fixtures must never be presented as live
evidence. The gate binds and checks supplied records; it does not attest to
events it has not observed.

## Run

Run from the reviewed source using the trusted values and private paths:

```sh
node scripts/verify-backend-acceptance.mjs \
  --receipt "$PRIVATE_RECEIPT" \
  --manifest "$PRIVATE_MANIFEST" \
  --manifest-sha256 "$REVIEWED_MANIFEST_SHA256" \
  --case-bank-sha256 "$REVIEWED_CASE_BANK_SHA256" \
  --candidate-sha "$REVIEWED_CANDIDATE_SHA" \
  --evidence-root "$PRIVATE_EVIDENCE_ROOT"
```

There is no success-receipt generator or fixture/live override. Missing input or
evidence exits nonzero; acceptance failure exits nonzero. JSON output reports
the complete denominator, category results, failed/missing cases and identity
bindings. It does not change the input files.

Validate the validator separately:

```sh
node --test --test-concurrency=1 scripts/verify-backend-acceptance.test.mjs
```

The in-memory unit fixtures test the gate's behavior; their success is not a live
backend acceptance result.
