import "server-only";

import { readdir } from "node:fs/promises";
import { FileLocalUserStore } from "@/auth/local-user-store";
import { loadInstallationConfig } from "@/config/installation";

const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type TeamMember = {
  userId: string;
  displayName: string;
  email: string;
  workerId: string;
};

export async function activeTeamMembers(): Promise<TeamMember[]> {
  const installation = await loadInstallationConfig();
  const store = new FileLocalUserStore(installation.paths.usersRoot);
  const entries = await readdir(installation.paths.usersRoot, { withFileTypes: true });
  const users = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && USER_ID_PATTERN.test(entry.name))
    .map((entry) => store.read(entry.name)));
  return users
    .filter((user): user is NonNullable<typeof user> => Boolean(user?.enabled))
    .map(({ userId, displayName, email, workerId }) => ({ userId, displayName, email, workerId }))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}
