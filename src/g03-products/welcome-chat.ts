import 'server-only';
import { createHash } from 'node:crypto';
import type { AuthSession } from '@/auth/types';
import { loadInstallationConfig } from '@/config/installation';
import { FileWorkbenchStore } from '@/workbench/filesystem-store';
import { STANDALONE_PROJECT_SLUG } from '@/workbench/types';
import { requireProduct } from './contracts';
import { welcomeProfile } from './welcome-profile';

/** Seed a private assistant message atomically; retries never duplicate or reset the chat. */
export async function createWelcomeChat(session: AuthSession) {
  const installation = await loadInstallationConfig();
  requireProduct(session.provider === 'local' && session.tenant.id === installation.installationId, 'No autenticat.', 403);
  const store = FileWorkbenchStore.fromInstallation(installation);
  const snapshot = await store.load(session.user.id);
  const project = snapshot.projects.find(p => p.slug === STANDALONE_PROJECT_SLUG && p.status === 'active');
  requireProduct(project, 'No es pot preparar la conversa.', 503);
  const hex = createHash('sha256').update(`${installation.installationId}:${session.user.id}:g03-welcome-v1`).digest('hex');
  const id = `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
  const profile = welcomeProfile(session.user.email, session.user.name);
  const content = [
    `Hola, ${profile.name}. Comencem amb ${profile.department}.`,
    'Això és el que tinc preparat per ajudar-te:',
    profile.ready.map(item => `- ${item}`).join('\n'),
    '**Per completar-ho:**',
    profile.pending.map(item => `- ${item}`).join('\n'),
    'Quan tinguis una idea, explica-me-la al xat. Podrem preparar una eina o automatització i concretar les dades i connexions que necessita.',
  ].join('\n\n');
  return store.createThread(session.user.id, project.id, 'Benvinguda a G03 AI', id, content);
}
