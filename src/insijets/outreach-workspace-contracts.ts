/** Instantly is authoritative. These request-scoped views are never a lead database. */
export type OutreachWorkspaceSection = 'overview' | 'campaign' | 'replies';
export type OutreachWorkspaceError = { section: string; code: string };
export type OutreachWorkspaceRecord = Record<string, string | number | boolean | null>;
export type OutreachWorkspacePage = {
  items: OutreachWorkspaceRecord[];
  nextCursor: string | null;
};
export type OutreachWorkspaceCopyStep = {
  type: string | null;
  delay: number | null;
  delayUnit?: string | null;
  variants: { subject: string; body: string }[];
};
export type OutreachWorkspaceCampaign = OutreachWorkspaceRecord & { id: string; name: string };
export type OutreachWorkspaceView = {
  source: 'Instantly';
  readOnly: true;
  checkedAt: string;
  section: OutreachWorkspaceSection;
  status: 'connected' | 'degraded' | 'not_configured';
  errors: OutreachWorkspaceError[];
  /** Bounded pages, not installation-wide totals. */
  campaigns: { items: OutreachWorkspaceCampaign[]; nextCursor: string | null } | null;
  accounts: OutreachWorkspacePage | null;
  metrics: Record<string, number> | null;
  campaign: {
    details: OutreachWorkspaceCampaign;
    sendingAccounts?: string[];
    sequences: { steps: OutreachWorkspaceCopyStep[] }[];
    leads: OutreachWorkspacePage | null;
    metrics: Record<string, number> | null;
  } | null;
  replies: OutreachWorkspacePage | null;
};
