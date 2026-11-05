import { AppServerRequestTimeoutError } from "./transport/app-server-rpc-router";

/** An optional picker inventory must not block reconciliation of an already
 * dispatched turn. Explicit skill selections still require current inventory. */
export async function optionalTurnSkills<T>(options: {
  explicit: boolean; inherit: boolean; recovering: boolean;
  load(): Promise<T[]>; unavailable(): void;
}): Promise<T[]> {
  if (!options.explicit && (!options.inherit || options.recovering)) return [];
  try { return await options.load(); }
  catch (error) {
    if (options.explicit || !(error instanceof AppServerRequestTimeoutError) || error.method !== "skills/list") throw error;
    options.unavailable();
    return [];
  }
}
