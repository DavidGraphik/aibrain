# Validation scope

The public quality manifest `.github/quality-tests.json` explicitly covers selected chat/token compatibility, selected-history reads, access isolation, automation state/admission/execution, document upload/version/attachments, connector permissions, chat components and readiness contracts. It is a regression slice, not a claim of full-product acceptance.

Run `npm run typecheck -- --incremental false`, `node .github/scripts/run-quality-tests.mjs` and `npm run build -- --webpack` on the exact source being reviewed. `.github/scripts/check-public-source.mjs` checks tracked paths and known credential shapes; it complements contextual review and does not certify absence of every possible secret.

Historical tests for retired private publication/activation infrastructure may depend on files not distributed here. They are not substitutes for the public quality manifest, and their absence does not authorize a production rollout. Native document conversion, AppArmor/worker sandbox execution, real identity-provider login and real connector effects require a compatible isolated Linux environment and owned accounts. Source tests do not establish those results.

Acceptance receipts for this preparation are kept outside the public source; final counts and exclusions must identify the exact reviewed revision. Never relabel tests from the full private preparation as tests of this exported tree.
