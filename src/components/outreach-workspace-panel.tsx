'use client';

import {useEffect, useState} from 'react';
import {ArrowClockwise, ArrowLeft, ArrowUpRight, ChatCircle, X} from '@phosphor-icons/react';
import type {OutreachWorkspacePage, OutreachWorkspaceView} from '@/insijets/outreach-workspace-contracts';
import type {outreachProviderConnections} from '@/insijets/outreach-provider-connection-status';
import type {CampaignDraft} from '@/insijets/outreach-campaigns';
import type {Tier1Digest} from '@/insijets/outreach-tier1-store';
import styles from './outreach-workspace.module.css';
import {outreachMessageText} from '@/insijets/outreach-message-text';
import {OutreachFinalContentPanel} from './outreach-final-content-panel';

export type OutreachWorkspaceSection = 'overview' | 'campaigns' | 'replies' | 'tier1' | 'strategy';
export type OutreachWorkspaceContext = {section: OutreachWorkspaceSection; campaignId?: string};
export type OutreachWorkspacePanelProps = {
  onClose: () => void;
  onAsk: (prompt: string) => void;
  initialSection?: OutreachWorkspaceSection;
  onContextChange?: (context: OutreachWorkspaceContext) => void;
};
type PreparationView = {
  providerConnections?: ReturnType<typeof outreachProviderConnections>;
  campaigns: CampaignDraft[];
  finalCampaigns?: CampaignDraft[];
  tier1: Tier1Digest;
  readiness: {gates: {id: string; label: string; state: string}[]};
  month: {icp: {mix: {id: string; percent: number}[]}};
};
const tabs: {id: OutreachWorkspaceSection; label: string}[] = [
  {id: 'overview', label: 'Overview'}, {id: 'campaigns', label: 'Campaigns'},
  {id: 'replies', label: 'Replies'}, {id: 'tier1', label: 'Today’s LinkedIn Tier 1'},
  {id: 'strategy', label: 'Strategy & controls'},
];
const labels: Record<string, string> = {
  emails_sent_count: 'Emails sent', emails_read_count: 'Emails opened',
  emails_replied_count: 'Replies', bounced_count: 'Bounces',
  leads_count: 'Campaign contacts', total_leads: 'Campaign contacts',
  completed_count: 'Completed', new_leads_contacted_count: 'New contacts reached',
  total_opportunities: 'Opportunities', opportunities: 'Opportunities',
};
const humanize = (value: string) => labels[value] ?? value.replaceAll('_', ' ').replace(/^./, c => c.toUpperCase());
const number = (value: number) => new Intl.NumberFormat('en-GB').format(value);
const date = (value: string) => Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('en-GB', {dateStyle: 'medium', timeStyle: 'short'}).format(new Date(value)) : 'Not available';

/** Fetches are scoped to their URL; an old response can never render under a new campaign. */
function usePrivateView<T>(url: string | null, revision: number) {
  const [state, setState] = useState<{url: string; revision: number; data?: T; error?: string}>();
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    let active = true;
    void (async () => {
      try {
        const response = await fetch(url, {signal: controller.signal, cache: 'no-store', credentials: 'same-origin'});
        if (!response.ok) throw new Error(response.status === 401 ? 'Sign in again to view this private workspace.' : response.status === 403 ? 'This account cannot access the outreach workspace.' : 'This view could not be loaded. Try again.');
        const data = await response.json() as T;
        if (active) setState({url, revision, data});
      } catch (error) {
        if (active && !controller.signal.aborted) setState({url, revision, error: error instanceof Error ? error.message : 'This view could not be loaded.'});
      }
    })();
    return () => {active = false; controller.abort();};
  }, [url, revision]);
  const current = state?.url === url && state?.revision === revision ? state : undefined;
  return {data: current?.data, error: current?.error, loading: Boolean(url && !current)};
}

function Empty({title, children}: {title: string; children: React.ReactNode}) {
  return <div className={styles.empty}><h3>{title}</h3><p>{children}</p></div>;
}
function Metrics({values}: {values: Record<string, number> | null}) {
  if (values === null) return <p className={styles.muted}>Results are unavailable. No activity total is assumed.</p>;
  const entries = Object.entries(values);
  if (!entries.length) return <p className={styles.muted}>Instantly returned no results for this view.</p>;
  return <dl className={styles.metrics}>{entries.map(([key, value]) => <div key={key}><dt>{humanize(key)}</dt><dd>{number(value)}</dd></div>)}</dl>;
}
const preferredColumns = ['first_name', 'last_name', 'email', 'company_name', 'from_address_email', 'subject', 'bodyText', 'timestamp_email', 'timestamp_created', 'status'];
function Records({page, label, onNext}: {page: OutreachWorkspacePage | null; label: string; onNext?: (cursor: string) => void}) {
  if (!page) return <p className={styles.muted}>{label} are unavailable.</p>;
  if (!page.items.length) return <p className={styles.muted}>No {label.toLowerCase()} returned by Instantly.</p>;
  const fields = new Set(page.items.flatMap(item => Object.keys(item)));
  const columns = preferredColumns.filter(field => fields.has(field));
  if (!columns.length) columns.push(...[...fields].filter(field => field !== 'id').slice(0, 5));
  return <><div className={styles.table}><table><caption>{label} · current page from Instantly</caption><thead><tr>{columns.map(field => <th key={field} scope="col">{field === 'bodyText' ? 'Message' : humanize(field)}</th>)}</tr></thead><tbody>{page.items.map((item, index) => <tr key={String(item.id ?? index)}>{columns.map(field => <td key={field}>{item[field] === null || item[field] === undefined ? '—' : String(item[field])}</td>)}</tr>)}</tbody></table></div>{page.nextCursor && onNext && <button type="button" className={styles.secondary} onClick={() => onNext(page.nextCursor!)}>Next page of {label.toLowerCase()}</button>}</>;
}
function Mailboxes({view}: {view: OutreachWorkspaceView}) {
  return <section className={styles.card}><h3>Sending mailboxes</h3>{view.accounts === null ? <p className={styles.muted}>Mailbox connection and readiness are unavailable.</p> : !view.accounts.items.length ? <p className={styles.muted}>No mailboxes returned by Instantly.</p> : <ul className={styles.rows}>{view.accounts.items.map((account, i) => <li key={String(account.email ?? account.id ?? i)}><strong>{String(account.email ?? 'Unnamed mailbox')}</strong><span>{account.status === null || account.status === undefined ? 'Status unavailable' : `Provider status: ${account.status}`}</span>{account.warmup_status !== undefined && <span>Warm-up: {String(account.warmup_status ?? 'unavailable')}</span>}{account.stat_warmup_score !== undefined && <span>Provider warm-up score: {String(account.stat_warmup_score ?? 'unavailable')}</span>}</li>)}</ul>}{view.accounts?.nextCursor && <p className={styles.muted}>This is a bounded mailbox page; more mailboxes may exist.</p>}</section>;
}
function Ask({children, onClick}: {children: React.ReactNode; onClick: () => void}) {
  return <button type="button" className={styles.ask} onClick={onClick} title="Prepare a request in the Brain chat"><ChatCircle size={15} aria-hidden="true"/><span>Ask Brain: {children}</span><ArrowUpRight size={14} aria-hidden="true"/></button>;
}

export function OutreachWorkspacePanel({onClose, onAsk, initialSection = 'overview', onContextChange}: OutreachWorkspacePanelProps) {
  const [privateDraftDirty,setPrivateDraftDirty]=useState(false);
  const [section, setSection] = useState<OutreachWorkspaceSection>(initialSection);
  const [campaignId, setCampaignId] = useState<string>();
  const [campaignCursor, setCampaignCursor] = useState<string>();
  const [cursor, setCursor] = useState<string>();
  const [revision, setRevision] = useState(0);
  const overview = usePrivateView<OutreachWorkspaceView>(`/api/insijets/outreach/workspace${campaignCursor ? `?cursor=${encodeURIComponent(campaignCursor)}` : ''}`, revision);
  const query = campaignId && (section === 'campaigns' || section === 'replies') ? new URLSearchParams({section: section === 'campaigns' ? 'campaign' : 'replies', campaignId, ...(cursor ? {cursor} : {})}) : null;
  const detail = usePrivateView<OutreachWorkspaceView>(query ? `/api/insijets/outreach/workspace?${query}` : null, revision);
  const preparation = usePrivateView<PreparationView>(section === 'strategy' || section === 'tier1' ? '/api/insijets/outreach/system' : null, revision);
  useEffect(() => {onContextChange?.({section, ...(campaignId ? {campaignId} : {})});}, [section, campaignId, onContextChange]);
  const chooseSection = (next: OutreachWorkspaceSection) => {setSection(next); setCursor(undefined);};
  const chooseCampaign = (id?: string) => {setCampaignId(id); setCursor(undefined);};
  const current = section === 'tier1' || section === 'strategy' ? preparation : campaignId && (section === 'campaigns' || section === 'replies') ? detail : overview;
  const chosen = overview.data?.campaigns?.items.find(item => item.id === campaignId);
  const selectedCampaign = detail.data?.campaign;
  const campaignName = chosen?.name ?? (selectedCampaign && selectedCampaign.details.id === campaignId ? selectedCampaign.details.name : 'Selected campaign');
  const askCampaign = (prompt: string) => onAsk(`${prompt} for the selected campaign.`);
  const refresh = () => setRevision(value => value + 1);
  return <section aria-label="Outreach workspace" className={styles.panel}>
    <header className={styles.header}><div><span className={styles.eyebrow}>InsiJets</span><h2>Outreach</h2></div><div className={styles.headerActions}><button type="button" title="Refresh outreach" aria-label="Refresh outreach" disabled={privateDraftDirty} onClick={refresh}><ArrowClockwise size={18}/></button><button type="button" title="Close outreach" aria-label="Close outreach" disabled={privateDraftDirty} onClick={onClose}><X size={18}/></button></div></header>
    <nav aria-label="Outreach sections" className={styles.tabs}>{tabs.map(tab => <button type="button" key={tab.id} aria-pressed={section === tab.id} disabled={privateDraftDirty&&section!==tab.id} onClick={() => chooseSection(tab.id)}>{tab.label}</button>)}</nav>
    <div className={styles.content}>
      {current.loading && <p role="status" className={styles.loading}>Loading {section === 'tier1' ? 'today’s LinkedIn Tier 1' : section}…</p>}
      {current.error && <div role="alert" className={styles.notice}><p>{current.error}</p><button type="button" onClick={refresh}>Try again</button></div>}
      {overview.data && <div className={styles.connection}><span className={styles.dot} data-connected={overview.data.status === 'connected'}/><span>{overview.data.status === 'not_configured' ? 'Instantly connection pending' : overview.data.status === 'degraded' ? 'Instantly · some data unavailable' : 'Instantly · read-only connection'}</span><small>Checked {date(overview.data.checkedAt)}</small></div>}
      {overview.data?.status === 'not_configured' && section !== 'strategy' && section !== 'tier1' && <Empty title="Connect Instantly to see live outreach">Campaigns, deployed copy, campaign contacts and results will appear here after the read-only connection is configured. Local review drafts are separate.</Empty>}
      {section === 'overview' && <>
        <div className={styles.intro}><h3>Your outreach, with the Brain</h3><p>Ask in chat. Follow campaigns, results and the next actions here.</p></div>
        {overview.data && <><section className={styles.card}><h3>Campaign results</h3><Metrics values={overview.data.metrics}/></section><section className={styles.card}><div className={styles.sectionHeading}><h3>Campaigns in Instantly</h3><button type="button" onClick={() => chooseSection('campaigns')}>View campaigns</button></div>{overview.data.campaigns === null ? <p className={styles.muted}>Campaigns are unavailable.</p> : <p>{overview.data.campaigns.items.length ? `${number(overview.data.campaigns.items.length)} campaigns on the current page` : 'No campaigns returned by Instantly.'}</p>}</section><Mailboxes view={overview.data}/></>}
        <section className={styles.card}><h3>Ready for the next step</h3><p>The Brain researches and qualifies accounts and people. Selected contacts are prepared for their Instantly campaign. Your CRM remains the business record; temporary research documents support the work.</p><p className={styles.muted}>CRM acceptance, provider permissions and sending readiness still need verification. Clay is reserved for Tier 1.</p></section>
      </>}
      {(section === 'campaigns' || section === 'replies') && <>
        <div className={styles.intro}><h3>{section === 'campaigns' ? 'Campaigns in Instantly' : 'Campaign replies'}</h3><p>{section === 'campaigns' ? 'Actual campaign copy, contacts and results from your sending platform.' : 'Select a campaign to read its replies. The Brain can help review and prepare a response.'}</p></div>
        {overview.data?.campaigns && <label className={styles.selectLabel}>Campaign<select value={campaignId ?? ''} onChange={event => chooseCampaign(event.target.value || undefined)}><option value="">Choose a campaign</option>{overview.data.campaigns.items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
        {!campaignId && overview.data?.status !== 'not_configured' && (overview.data?.campaigns?.items.length ? <div className={styles.campaignList}>{overview.data.campaigns.items.map(item => <button type="button" key={item.id} onClick={() => chooseCampaign(item.id)}><strong>{item.name}</strong><span>{item.status === undefined || item.status === null ? 'Status unavailable' : `Provider status: ${item.status}`}</span><ArrowUpRight size={16} aria-hidden="true"/></button>)}</div> : !overview.loading && !overview.error && <Empty title="No campaigns available">Create or connect the campaign in Instantly before reviewing its contacts and results here.</Empty>)}
        <div className={styles.pagination}>{campaignCursor && <button type="button" className={styles.secondary} onClick={() => {chooseCampaign(undefined); setCampaignCursor(undefined);}}>First campaign page</button>}{overview.data?.campaigns?.nextCursor && <button type="button" className={styles.secondary} onClick={() => {chooseCampaign(undefined); setCampaignCursor(overview.data!.campaigns!.nextCursor!);}}>Next campaign page</button>}</div>
        {campaignId && <><button type="button" className={styles.back} onClick={() => chooseCampaign(undefined)}><ArrowLeft size={14} aria-hidden="true"/>All campaigns</button><div className={styles.chips}><Ask onClick={() => askCampaign('Explain the current results and next steps')}>Review this campaign</Ask><Ask onClick={() => askCampaign('Prepare a proposal to find more qualified contacts for the same ICP; first show sources, estimated cost and approvals needed')}>Find more for this ICP</Ask></div></>}
        {campaignId && detail.data && <>
          <p className={styles.muted}>Read from Instantly · {date(detail.data.checkedAt)}</p>
          {detail.data.errors.length > 0 && <div role="status" className={styles.notice}>Some campaign data is unavailable: {[...new Set(detail.data.errors.map(error => humanize(error.section)))].join(', ')}. <button type="button" onClick={refresh}>Retry</button></div>}
          {section === 'campaigns' && (selectedCampaign ? <>
            <section className={styles.card}><h3>{selectedCampaign.details.name}</h3><p className={styles.muted}>{selectedCampaign.details.status === undefined || selectedCampaign.details.status === null ? 'Campaign status unavailable' : `Provider campaign status: ${selectedCampaign.details.status}`}</p><Metrics values={selectedCampaign.metrics}/></section>
            <section className={styles.card}><h3>Campaign sending mailboxes</h3>{selectedCampaign.sendingAccounts?.length ? <ul className={styles.rows}>{selectedCampaign.sendingAccounts.map(email => <li key={email}><strong>{email}</strong></li>)}</ul> : <p className={styles.muted}>No sending mailbox bindings returned by Instantly.</p>}</section>
            <section className={styles.card}><h3>Campaign copy</h3>{selectedCampaign.sequences.length ? selectedCampaign.sequences.map((sequence, index) => <div key={index}>{selectedCampaign.sequences.length > 1 && <h4>Sequence {index + 1}</h4>}{sequence.steps.map((step, stepIndex) => <details className={styles.copy} key={stepIndex}><summary>Step {stepIndex + 1}{step.delay === null ? '' : ` · provider delay ${step.delay}${step.delayUnit ? ` ${step.delayUnit}` : ''}`}{step.type ? ` · ${step.type}` : ''}</summary>{step.variants.map((variant, variantIndex) => <div key={variantIndex}>{step.variants.length > 1 && <h4>Variant {variantIndex + 1}</h4>}<strong>{variant.subject || 'No subject returned'}</strong><pre>{variant.body ? outreachMessageText(variant.body) : 'No body returned'}</pre></div>)}</details>)}</div>) : <p className={styles.muted}>No sequence copy returned by Instantly.</p>}</section>
            <section className={styles.card} aria-label="Selected campaign contacts"><h3>Contacts in this campaign</h3><p className={styles.muted}>Selected contacts already uploaded to this Instantly campaign. Unworked prospects are not listed here.</p><Records page={selectedCampaign.leads} label="Campaign contacts" onNext={setCursor}/></section>
          </> : <Empty title="Campaign details unavailable">No contacts or results are shown without access to this campaign.</Empty>)}
          {section === 'replies' && <section className={styles.card}><h3>Replies · {campaignName}</h3><Records page={detail.data.replies} label="Replies" onNext={setCursor}/><Ask onClick={() => askCampaign('Review replies and identify urgent requests, opt-outs and responses to prepare; do not send any response')}>Review replies with the Brain</Ask></section>}
        </>}
      </>}
      {section === 'tier1' && <>
        <div className={styles.intro}><h3>Today’s LinkedIn Tier 1</h3><p>Your manual LinkedIn actions, coordinated with outreach. Clay is used only for Tier 1 research and enrichment.</p></div>
        <Ask onClick={() => onAsk('Prepare my daily Tier 1 LinkedIn shortlist from eligible reviewed contacts. Use Clay only for Tier 1 and show the rationale, evidence and email coordination before any new paid lookup. Do not contact anyone.')}>Prepare today’s shortlist</Ask>
        {preparation.data && <><p className={styles.muted}>{preparation.data.tier1.day} · {preparation.data.tier1.timeZone}</p>{preparation.data.tier1.items.length ? preparation.data.tier1.items.map(item => <article className={styles.card} key={item.draftId}><h3>Tier 1 contact · {item.status}</h3><p>{item.reason}</p><div className={styles.links}><a href={item.linkedinUrl} target="_blank" rel="noopener noreferrer">Open LinkedIn profile <ArrowUpRight size={14} aria-hidden="true"/></a><a href={item.evidenceUrl} target="_blank" rel="noopener noreferrer">Review evidence</a></div><p className={styles.muted}>Evidence checked {date(item.evidenceCheckedAt)}</p></article>) : <Empty title="No Tier 1 shortlist prepared">Ask the Brain to prepare the daily list once eligible, reviewed contacts are available. No LinkedIn invitation or notification has been sent.</Empty>}</>}
      </>}
      {section === 'strategy' && <>
        <div className={styles.intro}><h3>Strategy & controls</h3><p>Review the source-specific targeting, messages and controls that guide the Brain’s work.</p></div>
        <section className={styles.card}><h3>How the system works</h3><ol className={styles.workflow}><li><strong>AI Brain</strong><span>Plans research, calls approved search and enrichment APIs, checks evidence and scores fit. Clay is reserved for Tier 1.</span></li><li><strong>Your CRM</strong><span>Owns durable business records, relationships and approved outcomes. Temporary research documents are working material.</span></li><li><strong>Instantly</strong><span>Holds selected campaign contacts, deployed copy, sending configuration and email results.</span></li></ol><p className={styles.muted}>Research preparation does not approve spending, campaign changes or sending. Exact audience, sending account, copy and required approvals are checked before live effects.</p></section>
        {preparation.data?.providerConnections && <section className={styles.card} aria-label="Provider account connections"><h3>Provider account connections</h3><p>Prepared for Luca to connect the InsiJets-owned accounts. Extraction and spending remain disabled.</p><ul className={styles.rows}>{preparation.data.providerConnections.items.map(provider=><li key={provider.provider}><strong>{provider.name}</strong><span>{provider.use}</span><span className={styles.tag}>{provider.status==='awaiting-client-account'?'Waiting for Luca’s account':'Connection verification pending'}</span><p>{provider.nextAction}</p></li>)}</ul><p className={styles.muted}>{preparation.data.providerConnections.independentVerification}</p><Ask onClick={()=>onAsk('Show the prepared Apollo, Prospeo and Clay connection checklist. Luca will connect his own accounts. Keep Clay for Tier 1 and distinguish prepared configuration from verified connections; do not extract leads, spend credits or send.')}>Review account connection steps</Ask></section>}
        <OutreachFinalContentPanel campaigns={preparation.data?.finalCampaigns} onAsk={onAsk} onSaved={refresh} onDirtyChange={setPrivateDraftDirty}/>
        {preparation.data && <><section className={styles.card}><h3>ICP allocation</h3><p className={styles.muted}>Working mix from the annotated documents, pending final confirmation. Historical eligibility stays with Luca.</p><dl className={styles.mix}>{preparation.data.month.icp.mix.map(item => <div key={item.id}><dt>{humanize(item.id.replaceAll('-', ' '))}</dt><dd>{item.percent}%</dd></div>)}</dl></section><section className={styles.card}><h3>Review draft library</h3><p>{preparation.data.campaigns.length} earlier local review sequences · {preparation.data.campaigns.reduce((total, campaign) => total + campaign.steps.length, 0)} messages. These are proposed templates, not campaigns running in Instantly. The final Phase 1 source library above is authoritative for the new review; earlier private edits remain preserved here.</p>{preparation.data.campaigns.map(campaign => <details className={styles.copy} key={campaign.id}><summary>{campaign.name} · {campaign.locale}</summary>{campaign.steps.map((step, index) => <div key={index}><h4>Message {index + 1} · {index === 0 ? 'first contact' : `+${step.offset} calendar days`}</h4><strong>{step.subject || (index === 0 ? campaign.subject : 'Continue existing thread')}</strong><pre>{step.body}</pre></div>)}<Ask onClick={() => onAsk(`Review the proposed local outreach sequence “${campaign.name}” (draft ID: ${campaign.id}). Explain its audience, evidence requirements and any unresolved placeholders. Do not publish or send it.`)}>Review this draft</Ask></details>)}</section><section className={styles.card}><h3>Connection and launch checks</h3><ul className={styles.gates}>{preparation.data.readiness.gates.map(gate => <li key={gate.id}><span className={styles.tag}>{gate.state}</span>{gate.label}</li>)}</ul></section></>}
        <Ask onClick={() => onAsk('Review our outreach strategy, ICP allocation, provider permissions, cost limits and CRM connection. Explain what is configured and what still needs approval. Keep Clay restricted to Tier 1.')}>Review strategy with the Brain</Ask>
      </>}
    </div>
    <footer className={styles.footer}><ChatCircle size={14} aria-hidden="true"/><span>Keep working in chat. This workspace shows the context.</span></footer>
  </section>;
}
