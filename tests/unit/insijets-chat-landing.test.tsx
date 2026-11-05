// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {useState, type ComponentProps} from 'react';
import {ChatWorkspace} from '@/components/chat-workspace';
import {baseBrainManifest, defaultPreferences} from '@/config/brain';
import {initialRuntimeStatus} from '@/lib/runtime-status';
import {UiLocaleProvider} from '@/i18n/provider';
import type {WorkbenchProject} from '@/workbench/types';

vi.mock('next/image', () => ({default: () => <span aria-hidden="true"/>}));
vi.mock('use-stick-to-bottom', () => ({useStickToBottom: () => ({scrollRef: {current: null}, contentRef: {current: null}, scrollToBottom: vi.fn(), stopScroll: vi.fn(), isAtBottom: true, state: {}})}));
vi.mock('@/components/voice-controls', () => ({VoiceDictationControl: () => null}));

const project: WorkbenchProject = {id: 'synthetic-project', name: 'InsiJets', slug: 'aibrain-standalone-chats', status: 'active', pinned: false, instructions: '', sources: [], memory: {enabled: true, notes: '', updatedAt: null}, sharing: {visibility: 'private', members: []}, workspace: {id: 'synthetic-workspace', label: 'Review', hostType: 'managed', status: 'ready', isPrimary: true}, createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:00Z'};
const props = (): ComponentProps<typeof ChatWorkspace> => ({
 manifest: baseBrainManifest, preferences: defaultPreferences, project, thread: null, projects: [project], userName: 'Luca', companyName: 'InsiJets', installationId: 'insijets-demo', assistantName: 'InsiJets Brain', hydrated: true, prompt: '', composerExperience: 'smart', imageGeneration: false,
 connectorMentions: [], selectedConnectorMentionIds: [], serverReferences: [], attachments: [], documents: [], publications: [], documentUploading: false, sending: false, stopping: false, queuedMessages: [], runtimeStatus: {...initialRuntimeStatus, codex: 'connected', ready: true}, networkOnline: true, streamRecovery: null,
 onRetryRuntime: vi.fn(), onPromptChange: vi.fn(), onComposerExperienceChange: vi.fn(), onImageGenerationChange: vi.fn(), onDestinationChange: vi.fn(), onConnectorMentionIdsChange: vi.fn(), onAttachmentsChange: vi.fn(), onDocumentsChange: vi.fn(), onAddDocuments: vi.fn(async () => undefined), onServerReferencesChange: vi.fn(), onFreezePublication: vi.fn(async () => undefined), onDecidePublication: vi.fn(async () => undefined), onComposerNotice: vi.fn(), onSend: vi.fn(), onStop: vi.fn(), onCancelQueuedMessage: vi.fn(), sidebarOpen: true, onToggleSidebar: vi.fn(), onResolveApproval: vi.fn(async () => undefined), onEditMessage: vi.fn(), managedAppActionEnabled: false, managedAppApprovalKeys: [], onManagedAppPrepared: vi.fn(), onPreviewDocument: vi.fn(), onOpenReview: vi.fn(),
});
function Harness({settings}: {settings: ComponentProps<typeof ChatWorkspace>}) {
 const [prompt, setPrompt] = useState('');
 return <UiLocaleProvider locale="en"><ChatWorkspace {...settings} prompt={prompt} onPromptChange={value => {settings.onPromptChange(value); setPrompt(value);}}/></UiLocaleProvider>;
}
beforeEach(() => {
 vi.stubGlobal('ResizeObserver', class {observe() {} unobserve() {} disconnect() {}});
 vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
 vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
 Object.defineProperty(window, 'matchMedia', {configurable: true, value: () => ({matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn()})});
});
afterEach(() => {cleanup(); vi.unstubAllGlobals();});

it('prepares each Luca landing request in the normal editable composer without sending it', () => {
 const settings = props(); render(<Harness settings={settings}/>);
 for (const [label, prompt] of [
  ['What campaigns are we running?', 'What campaigns are we running?'],
  ['Prepare more qualified leads', 'Prepare 1000 more qualified leads using the agreed ICP mix. Propose the plan and estimated cost first; do not source, spend, upload or send without the required approval.'],
  ['What needs my attention?', 'What needs my attention in outreach today?'],
 ]) {
  fireEvent.click(screen.getByRole('button', {name: label}));
  expect(screen.getByRole('textbox')).toHaveValue(prompt);
  expect(settings.onPromptChange).toHaveBeenLastCalledWith(prompt);
  expect(settings.onSend).not.toHaveBeenCalled();
 }
});

it.each([['insijets-demo', false], ['trinalum-production', false], ['arnall', true], ['modtime', true], ['unknown', true]])('keeps Server files visibility scoped to installation %s', (installationId, visible) => {
 const settings = {...props(), installationId}; render(<Harness settings={settings}/>);
 expect(screen.queryByRole('button', {name: 'Server files'}) !== null).toBe(visible);
 fireEvent.click(screen.getByRole('button', {name: 'Add to message'}));
 const menu = screen.getByRole('menu', {name: 'Add to message'});
 expect(within(menu).queryByRole('menuitem', {name: 'Server files'}) !== null).toBe(visible);
 expect(within(menu).getByRole('menuitem', {name: 'Attach files'})).toBeInTheDocument();
});
