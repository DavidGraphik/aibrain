import { deploymentIdentity } from "@/deployment/identities";
import type { AuthSession } from '../auth/types';
import type { InstantlyOperation } from '../connectors/instantly-contracts';
import type { OutreachWorkspaceCampaign, OutreachWorkspacePage, OutreachWorkspaceSection, OutreachWorkspaceView } from './outreach-workspace-contracts';

export type OutreachWorkspaceDependencies = {
  session: () => Promise<AuthSession | null>;
  admin: (session: AuthSession) => Promise<boolean>;
  configuration: () => Promise<{ enabled: boolean; installationId: string }>;
  read: (userId: string, operation: InstantlyOperation, args: Record<string, unknown>) => Promise<unknown>;
  now?: () => number;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const reply = (status: number, data: unknown) => Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
function errorCode(error: unknown) {
  return record(error) && typeof error.code === 'string' && /^INSTANTLY_[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'INSTANTLY_UNAVAILABLE';
}
function page(value: Record<string, unknown>): OutreachWorkspacePage {
  if (!Array.isArray(value.items)) throw Error('Invalid connector page');
  return { items: value.items as OutreachWorkspacePage['items'], nextCursor: typeof value.nextCursor === 'string' ? value.nextCursor : null };
}
function metrics(value: Record<string, unknown>) {
  if (!record(value.metrics)) throw Error('Invalid connector metrics');
  return Object.fromEntries(Object.entries(value.metrics).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])));
}

/** Request-only Instantly projection. No lead store, extraction, provider spend or mutations. */
export async function handleOutreachWorkspaceRequest(request: Request, deps: OutreachWorkspaceDependencies) {
  try {
    if (request.method !== 'GET') return reply(405, { error: 'METHOD_DENIED' });
    const session = await deps.session();
    if (!session) return reply(401, { error: 'AUTH_REQUIRED' });
    if (session.provider !== 'local' || session.tenant.id !== 'insijets-demo' ||
      !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= (deps.now ?? Date.now)() ||
      !/^[a-zA-Z0-9_:-]{1,100}$/.test(session.user.id) ||
      ![deploymentIdentity("operator"), deploymentIdentity("cmsOwner")].includes(session.user.email.toLowerCase()) || !await deps.admin(session)) {
      return reply(403, { error: 'OUTREACH_ACCESS_DENIED' });
    }
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].some(key => !['section', 'campaignId', 'limit', 'cursor'].includes(key) || query.getAll(key).length !== 1)) return reply(400, { error: 'INPUT_DENIED' });
    const section = (query.get('section') ?? 'overview') as OutreachWorkspaceSection;
    const campaignId = query.get('campaignId');
    const limitText = query.get('limit') ?? '25';
    const cursor = query.get('cursor');
    if (!['overview', 'campaign', 'replies'].includes(section) || !/^[1-9]\d?$/.test(limitText) || Number(limitText) > 50 ||
      (cursor !== null && (cursor.length < 1 || cursor.length > 250 || /[\r\n]/.test(cursor))) ||
      (section === 'overview' ? campaignId !== null : !campaignId || !UUID.test(campaignId))) return reply(400, { error: 'INPUT_DENIED' });
    const configuration = await deps.configuration();
    if (!configuration.enabled || configuration.installationId !== session.tenant.id) return reply(404, { error: 'OUTREACH_NOT_CONFIGURED' });
    const view: OutreachWorkspaceView = { source: 'Instantly', readOnly: true, checkedAt: new Date((deps.now ?? Date.now)()).toISOString(), section,
      status: 'connected', errors: [], campaigns: null, accounts: null, metrics: null, campaign: null, replies: null };
    async function read(area: string, operation: InstantlyOperation, args: Record<string, unknown>) {
      try {
        const value = await deps.read(session!.user.id, operation, args);
        if (!record(value)) throw Error('Invalid connector response');
        return value;
      } catch (error) { view.errors.push({ section: area, code: errorCode(error) }); return null; }
    }
    const pagination = { limit: Number(limitText), ...(cursor ? { cursor } : {}) };
    if (section === 'overview') {
      const [campaigns, accounts, totals] = await Promise.all([
        read('campaigns', 'campaigns', pagination), read('accounts', 'accounts', { limit: Number(limitText) }), read('metrics', 'metrics', {}),
      ]);
      if (campaigns) view.campaigns = page(campaigns) as NonNullable<OutreachWorkspaceView['campaigns']>;
      if (accounts) view.accounts = page(accounts);
      if (totals) view.metrics = metrics(totals);
    } else {
      // Establish campaign ownership before requesting contacts or replies.
      const selected = await read('campaign', 'campaign', { campaignId });
      if (selected && record(selected.campaign) && selected.campaign.id === campaignId && typeof selected.campaign.name === 'string' && Array.isArray(selected.sequences)) {
        view.campaign = { details: selected.campaign as OutreachWorkspaceCampaign, sendingAccounts: Array.isArray(selected.sendingAccounts) ? selected.sendingAccounts as string[] : [], sequences: selected.sequences as NonNullable<OutreachWorkspaceView['campaign']>['sequences'], leads: null, metrics: null };
        if (section === 'campaign') {
          const [leads, totals] = await Promise.all([read('leads', 'leads', { campaignId, ...pagination }), read('metrics', 'metrics', { campaignId })]);
          if (leads) view.campaign.leads = page(leads);
          if (totals) view.campaign.metrics = metrics(totals);
        } else {
          const replies = await read('replies', 'replies', { campaignId, ...pagination });
          if (replies) view.replies = page(replies);
        }
      } else if (selected) view.errors.push({ section: 'campaign', code: 'INSTANTLY_RESPONSE_INVALID' });
    }
    if (view.errors.length) view.status = view.errors.every(error => ['INSTANTLY_NOT_CONFIGURED', 'INSTANTLY_CREDENTIAL_NOT_CONFIGURED'].includes(error.code)) ? 'not_configured' : 'degraded';
    return reply(200, view);
  } catch { return reply(503, { error: 'OUTREACH_WORKSPACE_UNAVAILABLE' }); }
}
