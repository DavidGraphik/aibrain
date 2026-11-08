/**
 * Reader-first rollout completed in 0c0782d8: activated with unchanged v1 data
 * and retained as the v2-capable recovery image. This gate permits v1 migration;
 * disabling it later never disables reads/writes of existing v2.
 */
export const WORKBENCH_HISTORY_MIGRATION_ENABLED = true;
