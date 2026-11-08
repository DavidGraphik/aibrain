// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {useEffect, useState} from 'react';
import {BrainApp} from '@/components/brain-app';
import {baseBrainManifest} from '@/config/brain';
import {initialRuntimeStatus} from '@/lib/runtime-status';
import type {AuthSession} from '@/auth/types';
import type {WorkbenchSnapshot} from '@/workbench/types';
import {UiLocaleProvider} from '@/i18n/provider';
import {isChatRequest} from '@/lib/demo-runtime';

const observed = vi.hoisted(() => ({mounts: 0, unmounts: 0, requests: [] as string[]}));
vi.mock('next/navigation', () => ({useRouter: () => ({push: vi.fn(), refresh: vi.fn()})}));
vi.mock('next/image', () => ({default: () => <span aria-hidden="true"/>}));
vi.mock('@/ui/use-runtime-status', () => ({useRuntimeStatus: () => ({...initialRuntimeStatus, mode: 'demo', ready: true, codex: 'connected'})}));
vi.mock('@/ui/use-stored-response', () => ({useStoredResponse: () => null}));
vi.mock('@/ui/recoverable-chat-stream', () => ({consumeRecoverableChatStream: async () => undefined}));
vi.mock('@/ui/chat-reattach-request', () => ({createChatReattachRequest: (body: string) => {observed.requests.push(body); return vi.fn();}}));
vi.mock('@/components/chat-workspace', () => ({ChatWorkspace: ({prompt, onPromptChange, onSend}: {prompt: string; onPromptChange: (value: string) => void; onSend: () => void}) => {
  const [instance] = useState(() => crypto.randomUUID());
  useEffect(() => {observed.mounts += 1; return () => {observed.unmounts += 1;};}, []);
  return <main data-testid="chat-workspace" data-instance={instance}><label>Normal Brain composer<textarea value={prompt} onChange={event => onPromptChange(event.target.value)}/></label><button type="button" onClick={() => onSend()}>Submit Brain request</button></main>;
}}));
vi.mock('@/components/customization-panel', () => ({CustomizationPanel: () => null}));
vi.mock('@/components/project-panel', () => ({ProjectPanel: () => null}));
vi.mock('@/components/task-center-panel', () => ({TaskCenterPanel: () => null}));
vi.mock('@/components/command-palette', () => ({CommandPalette: () => null}));
vi.mock('@/components/details-panel', () => ({DetailsPanel: () => null}));
vi.mock('@/components/document-preview-panel', () => ({DocumentPreviewPanel: () => null}));
vi.mock('@/components/insijets-directory-panel', () => ({InsiJetsDirectoryPanel: () => null}));
vi.mock('@/components/automations-panel', () => ({AutomationsPanel: () => null}));

const session: AuthSession = {provider: 'local', user: {id: 'synthetic-david', name: 'Synthetic reviewer', email: 'operator@example.invalid'}, tenant: {id: 'insijets-demo', name: 'InsiJets synthetic'}, expiresAt: '2099-01-01T00:00:00Z'};
const branding = {installationId: 'insijets-demo', companyName: 'InsiJets', companySlug: 'insijets', publicUrl: 'https://example.test', productName: 'InsiJets Brain', logoPath: '/synthetic.svg', faviconPath: '/synthetic.svg', accentColor: '#333333'};
const workbench: WorkbenchSnapshot = {persistence: 'browser-preview', threads: [], projects: [{id: 'synthetic-project', name: 'Outreach review', slug: 'aibrain-standalone-chats', status: 'active', pinned: false, instructions: '', sources: [], memory: {enabled: true, notes: '', updatedAt: null}, sharing: {visibility: 'private', members: []}, workspace: {id: 'synthetic-workspace', label: 'Review', hostType: 'managed', status: 'ready', isPrimary: true}, createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z'}]};
const campaignId = '00000000-0000-4000-8000-000000000001';
const overview = {source: 'Instantly', readOnly: true, checkedAt: '2026-10-15T14:00:00Z', section: 'overview', status: 'connected', errors: [], campaigns: {items: [{id: campaignId, name: 'Synthetic real-provider-shaped campaign', status: 'paused'}], nextCursor: null}, accounts: {items: [], nextCursor: null}, metrics: null, campaign: null, replies: null};
function app(access = true) {return <UiLocaleProvider locale="en"><BrainApp branding={branding} manifest={{...baseBrainManifest, identity: {...baseBrainManifest.identity, language: 'en'}}} session={session} initialWorkbench={workbench} insijetsWorkspaceAccess insijetsOutreachAccess={access}/></UiLocaleProvider>;}
beforeEach(() => {
  observed.mounts = 0; observed.unmounts = 0; observed.requests.length = 0; localStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.stubGlobal('ResizeObserver', class {observe() {} unobserve() {} disconnect() {}});
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  Object.defineProperty(window, 'matchMedia', {configurable: true, value: (query: string) => ({matches: query.includes('min-width'), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn()})});
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => ({ok: true, status: 200, json: async () => url.startsWith('/api/insijets/outreach/workspace') ? overview : {}})));
});
afterEach(() => {cleanup(); vi.unstubAllGlobals();});

it('opens from the actual sidebar on the same page and keeps the chat instance mounted across open, switch and close', async () => {
  render(app());
  const composer = await screen.findByLabelText('Normal Brain composer');
  expect(screen.queryByRole('button', {name: 'Website CMS', hidden: true})).toBeNull();
  expect(screen.queryByRole('button', {name: 'Contenido de la web', hidden: true})).toBeNull();
  expect(screen.getAllByRole('button', {name: 'Price Index', hidden: true}).length).toBeGreaterThan(0);
  expect(screen.getAllByRole('button', {name: 'Operator directory', hidden: true}).length).toBeGreaterThan(0);
  fireEvent.change(composer, {target: {value: 'Keep this unsent draft'}});
  const originalChat = screen.getByTestId('chat-workspace');
  const buttons = screen.getAllByRole('button', {name: 'Outreach System'});
  expect(screen.queryByRole('link', {name: 'Outreach System'})).toBeNull();
  fireEvent.click(buttons[buttons.length - 1]);
  expect(await screen.findByRole('region', {name: 'Outreach workspace'})).toBeInTheDocument();
  expect(window.location.pathname).toBe('/');
  expect(screen.getByTestId('chat-workspace')).toBe(originalChat);
  expect(screen.getByLabelText('Normal Brain composer')).toHaveValue('Keep this unsent draft');
  const switcher = screen.getByRole('navigation', {name: 'Outreach workspace view'});
  fireEvent.click(within(switcher).getByRole('button', {name: 'Chat'}));
  expect(within(switcher).getByRole('button', {name: 'Chat'})).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(within(switcher).getByRole('button', {name: 'Outreach'}));
  fireEvent.click(screen.getByRole('button', {name: 'Close outreach'}));
  expect(screen.getByTestId('chat-workspace')).toBe(originalChat);
  expect(observed.mounts).toBe(1); expect(observed.unmounts).toBe(0);
  expect(observed.requests).toEqual([]);
});

it('prepares a normal composer request without dispatch and attaches selected campaign references only upon explicit chat submission', async () => {
  render(app());
  const buttons = await screen.findAllByRole('button', {name: 'Outreach System'}); fireEvent.click(buttons[buttons.length - 1]);
  await screen.findByText('Instantly · read-only connection');
  fireEvent.click(screen.getByRole('button', {name: 'Campaigns'}));
  fireEvent.change(await screen.findByLabelText('Campaign'), {target: {value: campaignId}});
  fireEvent.change(screen.getByLabelText('Normal Brain composer'), {target: {value: 'Keep my prior question'+'. More detail about our agreed outreach strategy'.repeat(15)}});
  fireEvent.click(screen.getByRole('button', {name: 'Ask Brain: Find more for this ICP'}));
  const composer = screen.getByLabelText('Normal Brain composer');
  expect((composer as HTMLTextAreaElement).value).toContain('Prepare a proposal');
  expect((composer as HTMLTextAreaElement).value).toMatch(/^Keep my prior question/);
  expect((composer as HTMLTextAreaElement).value).toContain('\n\nPrepare a proposal');
  expect((composer as HTMLTextAreaElement).value).not.toContain(campaignId);
  fireEvent.click(screen.getByRole('button', {name: 'Ask Brain: Find more for this ICP'}));
  expect((composer as HTMLTextAreaElement).value.match(/Prepare a proposal/g)).toHaveLength(1);
  expect(observed.requests).toEqual([]);
  expect(within(screen.getByRole('navigation', {name: 'Outreach workspace view'})).getByRole('button', {name: 'Chat'})).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', {name: 'Submit Brain request'}));
  await waitFor(() => expect(observed.requests).toHaveLength(1));
  const request = JSON.parse(observed.requests[0]);
  expect(request.message).toContain(`"campaignId":"${campaignId}"`);
  expect(request.message).toContain('not permission to act');
  expect(request.displayMessage).toContain('Prepare a proposal');
  expect(request.displayMessage).not.toContain('Selected Outreach workspace references');
  expect(request.displayMessage).not.toContain(campaignId);
  expect(request.displayMessage.length).toBeGreaterThan(500);
  expect(isChatRequest(request)).toBe(true);
});

it('honours the legacy same-page deep link only for authorized Outreach UI access', async () => {
  window.history.replaceState(null, '', '/?workspace=outreach');
  const mounted = render(app(false));
  await waitFor(() => expect(screen.getByLabelText('Normal Brain composer')).toBeInTheDocument());
  expect(screen.queryByRole('region', {name: 'Outreach workspace'})).toBeNull();
  expect(screen.queryByRole('button', {name: 'Outreach System'})).toBeNull();
  mounted.unmount();
  render(app());
  expect(await screen.findByRole('region', {name: 'Outreach workspace'})).toBeInTheDocument();
});

it('prepares a source-backed Price Index draft without sending, then submits the complete context only on explicit send', async () => {
  const priorFetch=vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
    if(url==='/api/insijets/cms/api/auth/session') return {ok:true,status:200,json:async()=>({user:{id:'synthetic-owner'}})} as Response;
    if(url==='/api/insijets/cms/api/admin/content') return {ok:true,status:200,json:async()=>({records:[{id:'synthetic-route',title:'Synthetic Nice to London',type:'route',locale:'en',status:'draft',revision:1,data:{}}]})} as Response;
    return priorFetch(url,init);
  });
  window.history.replaceState(null, '', '/?workspace=outreach');
  render(app());
  await screen.findByRole('region', {name: 'Outreach workspace'});
  fireEvent.change(await screen.findByLabelText('Normal Brain composer'),{target:{value:'Keep my unsent context'}});
  const entries=screen.getAllByRole('button',{name:'Price Index'});fireEvent.click(entries[entries.length-1]);
  fireEvent.click(await screen.findByRole('button',{name:'Synthetic Nice to London'}));
  fireEvent.change(screen.getByLabelText('What would you like to compare?'),{target:{value:'Review this charter quote'}});
  fireEvent.click(screen.getByRole('button',{name:'Prepare in chat'}));
  const composer=await screen.findByLabelText('Normal Brain composer');
  expect((composer as HTMLTextAreaElement).value).toContain('Keep my unsent context');
  expect((composer as HTMLTextAreaElement).value).toContain('Review this charter quote');
  expect((composer as HTMLTextAreaElement).value).toContain('synthetic-route');
  await waitFor(() => expect(localStorage.getItem('aibrain.insijets-demo.synthetic-david.composer-drafts.v1')).toContain('synthetic-route'));
  expect(observed.requests).toHaveLength(0);
  expect(vi.mocked(fetch).mock.calls.some(([url,init])=>url==='/api/chat'&&init?.method==='POST')).toBe(false);
  fireEvent.click(screen.getByRole('button', {name: 'Submit Brain request'}));
  await waitFor(() => expect(observed.requests).toHaveLength(1));
  const request = JSON.parse(observed.requests[0]);
  expect(request.message).toContain('Keep my unsent context');
  expect(request.message).toContain('Review this charter quote');
  expect(request.message).toContain('synthetic-route');
  expect(request.projectId).toBe('synthetic-project');
  expect(isChatRequest(request)).toBe(true);
});
