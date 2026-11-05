# Future migration boundary

Preparing or publishing this source does not migrate any installation. The previous repository, images, services, data, sessions, secrets and recovery paths stay in place.

Before a future migration:

1. Pin a reviewed source commit and one built image digest. Complete native Linux worker, document, sandbox and egress acceptance on that exact artifact.
2. Supply the installation's protected configuration, identity mapping, provider connections and external ownership registry. Verify owner/source/destination bindings without printing secrets.
3. Verify an independent compatible backup and recovery path. Preserve current data formats and the existing signed session/history contracts.
4. Run affected authenticated UI flows and negative cross-user checks with an owned internal identity. Include scheduled work and real reversible connector readback where relevant; unknown external effects must not be replayed.
5. Obtain the migration authorization, activate the same tested artifact, verify the installed revision and user-visible behavior, and retain rollback recovery.

A source build, public CI pass or HTTP health response cannot replace these installation checks. Production activation is deliberately absent from this repository's CI.
