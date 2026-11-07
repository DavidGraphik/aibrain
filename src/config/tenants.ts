import "server-only";

import type { DemoAccount } from "@/auth/types";
import {
  baseBrainManifest,
  operationsBrainManifest,
  type BrainManifest,
} from "@/config/brain";

export type TenantDefinition = {
  id: string;
  name: string;
  manifest: BrainManifest;
};

const tenants: Record<string, TenantDefinition> = {
  studio: {
    id: "studio",
    name: "Example Laboratory",
    manifest: baseBrainManifest,
  },
  operations: {
    id: "operations",
    name: "Northstar Operations",
    manifest: operationsBrainManifest,
  },
};

const demoAccounts: DemoAccount[] = [
  {
    id: "example-user",
    name: "Alex Example",
    email: "alex@example.invalid",
    tenantId: "studio",
    tenantName: tenants.studio.name,
    productName: tenants.studio.manifest.identity.productName,
    description: "Entorn de desenvolupament amb marca i workbench propis",
  },
  {
    id: "operations-user",
    name: "Equip Ops",
    email: "equip@operations.demo",
    tenantId: "operations",
    tenantName: tenants.operations.name,
    productName: tenants.operations.manifest.identity.productName,
    description: "Segona instal·lació sintètica amb configuració independent",
  },
];

export function getTenantDefinition(tenantId: string) {
  return tenants[tenantId] ?? null;
}

export function getSeedManifest(tenantId: string) {
  return getTenantDefinition(tenantId)?.manifest ?? null;
}

export function listDemoAccounts() {
  return demoAccounts.map((account) => ({ ...account }));
}

export function getDemoAccount(userId: string) {
  return demoAccounts.find((account) => account.id === userId) ?? null;
}
