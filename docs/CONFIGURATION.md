# Installation configuration

Keep installation JSON and all secrets outside the public repository. Set `AIBRAIN_INSTALLATION_CONFIG` to the reviewed local configuration path. The examples use synthetic companies, example domains and temporary data roots. Provider credentials belong in the installation's protected secret store, not in committed examples.

## Deployment identity mapping

Some existing adapter policies bind operations to designated employees. Public source uses synthetic identities. Preserve the policy while supplying the installation's reviewed identities through the server-only `AIBRAIN_DEPLOYMENT_IDENTITIES` JSON environment variable. Supported keys are `operator`, `cmsOwner`, `manager`, `sales`, `administration`, `quality`, `production`, `office` and `hostOwnerId`. Use an email for each named identity and a UUID for `hostOwnerId`. Unknown keys, malformed JSON and invalid requested values are rejected. Missing keys retain the synthetic default, so migrations must supply every key their installation uses.

This mapping does not grant OAuth scopes, workspace roles, provider permissions or cross-user access. Existing session, membership, role, operation and installation checks remain authoritative. Do not expose this variable to the browser or log its contents.

The provisioning tools require caller-supplied identities. Keep the private mapping and ownership registry alongside the installation's other protected configuration. The default release ownership registry enrolls no production destinations; unknown installations fail closed.

## Business service endpoints

`AIBRAIN_SIBEMA_ORIGIN` supplies the protected ERP service origin. It must be HTTPS without credentials, path, query or fragment; the public default is a non-operational example domain. `AIBRAIN_ATTIO_WORKSPACE` supplies the installation's external CRM workspace selector where required. Keep actual values in private deployment configuration and verify them against the connected account.

## Approved private artwork

Default brand assets and profile examples are synthetic. A deployment can supply a reviewed design-asset registry with `AIBRAIN_DESIGN_BRAND_ASSETS_FILE` and its protected asset directory with `AIBRAIN_BRAND_ASSET_ROOT`. Each registry entry binds an installation/company to an exact asset hash. Invalid or absent artwork does not authorize a foreign asset or block unrelated work. Original artwork and identity data belong in private deployment storage.

## Host-loss decisions

Offline host preflight requires a fresh `AIBRAIN_HOST_LOSS_ACCEPTANCE_ID` matching the reviewed host configuration, plus the exact HTTPS `AIBRAIN_EXPECTED_PUBLIC_ORIGIN`. Old historical approvals are not inherited by this preparation. Installation scope, replica/alert policy and token checks remain enforced. Supplying an example value is not evidence that a real host has been accepted.
