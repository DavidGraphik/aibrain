import 'server-only';
import { getSession } from '@/auth/session';
import { isWorkspaceAdmin } from '@/admin/server-service';
import { loadInstallationConfig } from '@/config/installation';
import { instantlyReadForIdentity } from '@/connectors/instantly-service';
import { handleOutreachWorkspaceRequest } from './outreach-workspace-http';

export const handleOutreachWorkspace = (request: Request) => handleOutreachWorkspaceRequest(request, {
  session: getSession,
  admin: isWorkspaceAdmin,
  configuration: async () => {
    const config = await loadInstallationConfig();
    return { installationId: config.installationId, enabled: process.env.AIBRAIN_INSIJETS_OPERATOR_ENABLED === 'true' && process.env.AIBRAIN_INSIJETS_OUTREACH_SYSTEM_ENABLED === 'true' };
  },
  read: async (userId, operation, args) => {
    const config = await loadInstallationConfig();
    if (config.installationId !== 'insijets-demo' || process.env.AIBRAIN_INSIJETS_OPERATOR_ENABLED !== 'true' || process.env.AIBRAIN_INSIJETS_OUTREACH_SYSTEM_ENABLED !== 'true') throw Error('Outreach unavailable');
    return instantlyReadForIdentity(config, userId, operation, args);
  },
});
