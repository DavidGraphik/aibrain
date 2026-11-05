// @vitest-environment jsdom
import {afterEach, expect, it, vi} from 'vitest';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {OutreachWorkspacePanel} from '@/components/outreach-workspace-panel';
import {outreachProviderConnections} from '@/insijets/outreach-provider-connection-status';
import type {OutreachWorkspaceView} from '@/insijets/outreach-workspace-contracts';

const campaignA = '00000000-0000-4000-8000-000000000001';
const campaignB = '00000000-0000-4000-8000-000000000002';
const fixture = (overrides: Partial<OutreachWorkspaceView> = {}): OutreachWorkspaceView => ({
  source: 'Instantly', readOnly: true, checkedAt: '2026-10-15T15:00:00Z', section: 'overview', status: 'connected', errors: [],
  campaigns: {items: [{id: campaignA, name: 'Historical relationships', status: 'paused'}, {id: campaignB, name: 'Qualified owners', status: 'draft'}], nextCursor: null},
  accounts: {items: [{email: 'synthetic-sender@example.test', status: 'connected', warmup_status: 'running'}], nextCursor: null},
  metrics: {emails_sent_count: 27, emails_replied_count: 3}, campaign: null, replies: null, ...overrides,
});
const details = (id: string, name: string, email: string): OutreachWorkspaceView => fixture({
  section: 'campaign', campaigns: null, accounts: null, metrics: null,
  campaign: {details: {id, name, status: 'paused'}, sendingAccounts: ['bound-mailbox@example.test'], sequences: [{steps: [{type: 'email', delay: 0, delayUnit: 'days', variants: [{subject: 'A synthetic subject', body: '<img src=x onerror="alert(1)">A synthetic body'}]}]}], leads: {items: [{id: `${id}-contact`, first_name: 'Synthetic', email, company_name: 'Example Test'}], nextCursor: null}, metrics: {emails_sent_count: 7}},
});
const response = (data: unknown) => ({ok: true, status: 200, json: async () => data});
function deferred<T>() {let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}
afterEach(() => {cleanup(); vi.unstubAllGlobals();});

it('shows a connection pending state without inventing live activity or treating local templates as campaigns', async () => {
  const fetch = vi.fn().mockResolvedValue(response(fixture({status: 'not_configured', campaigns: null, accounts: null, metrics: null})));
  vi.stubGlobal('fetch', fetch);
  const onAsk = vi.fn(); const onClose = vi.fn();
  render(<OutreachWorkspacePanel onAsk={onAsk} onClose={onClose}/>);
  expect(await screen.findByRole('heading', {name: 'Connect Instantly to see live outreach'})).toBeInTheDocument();
  expect(screen.getByText('Results are unavailable. No activity total is assumed.')).toBeInTheDocument();
  expect(screen.queryByText('0')).toBeNull();
  expect(screen.queryByRole('button', {name: 'Research & leads'})).toBeNull();
  expect(screen.queryByRole('button', {name: /activate|send emails|enrich now/i})).toBeNull();
  for (const label of ['What campaigns are we running?', 'Prepare more qualified leads', 'What needs my attention?']) expect(screen.queryByRole('button', {name: `Ask Brain: ${label}`})).toBeNull();
  expect(onAsk).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][1]).not.toHaveProperty('method');
  fireEvent.click(screen.getByRole('button', {name: 'Close outreach'})); expect(onClose).toHaveBeenCalledTimes(1);
});

it('nests actual worked contacts, deployed copy and results inside the selected Instantly campaign', async () => {
  const fetch = vi.fn().mockImplementation((url: string) => Promise.resolve(response(url.includes('campaignId=') ? details(campaignA, 'Historical relationships', 'selected-only@example.test') : fixture())));
  vi.stubGlobal('fetch', fetch);
  const onAsk = vi.fn(); const onContextChange = vi.fn();
  render(<OutreachWorkspacePanel onAsk={onAsk} onClose={vi.fn()} initialSection="campaigns" onContextChange={onContextChange}/>);
  await screen.findByRole('button', {name: /Historical relationships/});
  expect(screen.queryByText('selected-only@example.test')).toBeNull();
  fireEvent.change(screen.getByLabelText('Campaign'), {target: {value: campaignA}});
  const contacts = await screen.findByRole('region', {name: 'Selected campaign contacts'});
  expect(within(contacts).getByText('selected-only@example.test')).toBeInTheDocument();
  expect(screen.getByText('A synthetic subject')).toBeInTheDocument();
  expect(screen.getByText('A synthetic body')).toBeInTheDocument();
  expect(document.querySelector('img')).toBeNull();
  expect(screen.getByText('7')).toBeInTheDocument();
  expect(screen.getByText('bound-mailbox@example.test')).toBeInTheDocument();
  expect(onContextChange).toHaveBeenLastCalledWith({section: 'campaigns', campaignId: campaignA});
  fireEvent.click(screen.getByRole('button', {name: 'Ask Brain: Find more for this ICP'}));
  expect(onAsk).toHaveBeenLastCalledWith(expect.stringContaining('for the selected campaign.'));
  expect(onAsk.mock.calls.at(-1)?.[0]).not.toContain(campaignA);
  expect(fetch.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
});

it('pages campaign lists separately from contacts without exposing a stand-alone lead table', async () => {
  const fetch = vi.fn().mockImplementation((url: string) => Promise.resolve(response(url.includes('cursor=campaign-page-2') ? fixture({campaigns: {items: [{id: campaignB, name: 'Next page campaign'}], nextCursor: null}}) : fixture({campaigns: {items: [{id: campaignA, name: 'First page campaign'}], nextCursor: 'campaign-page-2'}}))));
  vi.stubGlobal('fetch', fetch);
  render(<OutreachWorkspacePanel onAsk={vi.fn()} onClose={vi.fn()} initialSection="campaigns"/>);
  await screen.findByRole('button', {name: 'Next campaign page'});
  fireEvent.click(screen.getByRole('button', {name: 'Next campaign page'}));
  expect(await screen.findByRole('option', {name: 'Next page campaign'})).toBeInTheDocument();
  expect(screen.queryByRole('option', {name: 'First page campaign'})).toBeNull();
  expect(fetch).toHaveBeenLastCalledWith('/api/insijets/outreach/workspace?cursor=campaign-page-2', expect.any(Object));
  expect(screen.queryByRole('region', {name: 'Selected campaign contacts'})).toBeNull();
  fireEvent.click(screen.getByRole('button', {name: 'First campaign page'}));
  expect(await screen.findByRole('option', {name: 'First page campaign'})).toBeInTheDocument();
});

it('aborts old requests and prevents a late campaign response from exposing another selection’s contacts', async () => {
  const old = deferred<ReturnType<typeof response>>(); const next = deferred<ReturnType<typeof response>>();
  const fetch = vi.fn().mockImplementation((url: string) => url.includes(campaignA) ? old.promise : url.includes(campaignB) ? next.promise : Promise.resolve(response(fixture())));
  vi.stubGlobal('fetch', fetch);
  render(<OutreachWorkspacePanel onAsk={vi.fn()} onClose={vi.fn()} initialSection="campaigns"/>);
  await screen.findByLabelText('Campaign');
  fireEvent.change(screen.getByLabelText('Campaign'), {target: {value: campaignA}});
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  const oldSignal = fetch.mock.calls[1][1].signal as AbortSignal;
  fireEvent.change(screen.getByLabelText('Campaign'), {target: {value: campaignB}});
  expect(oldSignal.aborted).toBe(true);
  await act(async () => next.resolve(response(details(campaignB, 'Qualified owners', 'current@example.test'))));
  expect(await screen.findByText('current@example.test')).toBeInTheDocument();
  await act(async () => old.resolve(response(details(campaignA, 'Historical relationships', 'stale@example.test'))));
  expect(screen.queryByText('stale@example.test')).toBeNull();
  expect(screen.getByText('current@example.test')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', {name: 'Replies'}));
  expect(screen.queryByText('current@example.test')).toBeNull();
});

it('shows private access failure with retry and reports unavailable partial data instead of zeros', async () => {
  const fetch = vi.fn().mockResolvedValueOnce({ok: false, status: 401}).mockResolvedValueOnce(response(fixture({status: 'degraded', metrics: null, errors: [{section: 'metrics', code: 'PROVIDER_DENIED'}]})));
  vi.stubGlobal('fetch', fetch);
  render(<OutreachWorkspacePanel onAsk={vi.fn()} onClose={vi.fn()}/>);
  expect(await screen.findByRole('alert')).toHaveTextContent('Sign in again');
  fireEvent.click(screen.getByRole('button', {name: 'Try again'}));
  expect(await screen.findByText('Instantly · some data unavailable')).toBeInTheDocument();
  expect(screen.getByText('Results are unavailable. No activity total is assumed.')).toBeInTheDocument();
  expect(screen.queryByText('27')).toBeNull();
});

it('keeps local editorial templates under strategy, reserves Clay for Tier 1 and uses CRM as business record', async () => {
  const local = {campaigns: [{id: 'local-review-draft', name: 'Local editorial proposal', locale: 'EN', subject: 'Local subject', steps: [{offset: 0, body: 'Local review body'}]}], tier1: {day: '2026-10-15', timeZone: 'Europe/Madrid', items: []}, readiness: {gates: [{id: 'crm', label: 'CRM acceptance pending', state: 'pending'}]}, month: {icp: {mix: [{id: 'business-owners', percent: 18}]}}};
  const fetch = vi.fn().mockImplementation((url: string) => Promise.resolve(response(url.endsWith('/system') ? local : fixture())));
  vi.stubGlobal('fetch', fetch);
  render(<OutreachWorkspacePanel onAsk={vi.fn()} onClose={vi.fn()} initialSection="strategy"/>);
  expect(await screen.findByRole('heading', {name: 'Review draft library'})).toBeInTheDocument();
  expect(screen.getByText(/These are proposed templates, not campaigns running in Instantly/)).toBeInTheDocument();
  expect(screen.getByText(/Clay is reserved for Tier 1/)).toBeInTheDocument();
  expect(screen.getByText(/Owns durable business records/)).toBeInTheDocument();
  expect(screen.queryByRole('option', {name: 'Local editorial proposal'})).toBeNull();
  fireEvent.click(screen.getByRole('button', {name: 'Today’s LinkedIn Tier 1'}));
  expect(await screen.findByRole('heading', {name: 'No Tier 1 shortlist prepared'})).toBeInTheDocument();
  expect(screen.getByText(/No LinkedIn invitation or notification has been sent/)).toBeInTheDocument();
  expect(fetch.mock.calls.every(([, options]) => options?.method !== 'POST')).toBe(true);
});

it('shows Luca-owned Apollo/Prospeo/Clay account tasks with effects disabled in the actual Strategy pane',async()=>{
 const preparation={providerConnections:outreachProviderConnections({}),campaigns:[],finalCampaigns:[],tier1:{day:'2026-10-16',items:[]},readiness:{gates:[]},month:{icp:{mix:[]}}};
 const fetch=vi.fn(async(url:string,_options?:RequestInit)=>response(url.endsWith('/system')?preparation:fixture()));vi.stubGlobal('fetch',fetch);const onAsk=vi.fn();
 render(<OutreachWorkspacePanel onAsk={onAsk} onClose={vi.fn()} initialSection="strategy"/>);
 const region=await screen.findByRole('region',{name:'Provider account connections'});
 for(const provider of ['Apollo','Prospeo','Clay'])expect(within(region).getByText(provider)).toBeInTheDocument();
 expect(within(region).getAllByText('Waiting for Luca’s account')).toHaveLength(3);
 expect(within(region).getByText('Optional deeper enrichment for Tier 1 only')).toBeInTheDocument();
 fireEvent.click(within(region).getByRole('button',{name:'Ask Brain: Review account connection steps'}));expect(onAsk).toHaveBeenCalledWith(expect.stringContaining('do not extract leads, spend credits or send'));
 expect(fetch.mock.calls.every(([,options])=>!options?.method||options.method==='GET')).toBe(true);
});
