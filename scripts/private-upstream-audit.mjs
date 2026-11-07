import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function repositoryIdentity(url) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url.trim());
  if (!match) throw new Error('Unsupported GitHub remote; audit stopped.');
  return match[1].toLowerCase();
}

export function classifyBlob(base, destination, upstream) {
  if (destination === upstream) return 'already-present';
  if (destination === base) return 'needs-transfer';
  return 'needs-adaptation';
}

export function assertPushRemotes({ destination, originPushUrls, upstreamPushUrls }) {
  if (!originPushUrls.length || originPushUrls.some(url => repositoryIdentity(url) !== destination.toLowerCase())) {
    throw new Error('Private destination push URL mismatch; audit stopped.');
  }
  if (!upstreamPushUrls.length || upstreamPushUrls.some(url => !url.startsWith('disabled://'))) {
    throw new Error('Disable every upstream push URL before auditing.');
  }
}

export function auditUpstream({ cwd = process.cwd(), registry, upstreamRef = 'arnall/main', destinationRef = 'HEAD' }) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }).trim();
  if (repositoryIdentity(git('remote', 'get-url', 'origin')) !== registry.destination.toLowerCase() ||
      repositoryIdentity(git('remote', 'get-url', registry.upstreamRemote)) !== registry.upstream.toLowerCase()) {
    throw new Error('Repository identity mismatch; audit stopped.');
  }
  assertPushRemotes({
    destination: registry.destination,
    originPushUrls: git('remote', 'get-url', '--push', '--all', 'origin').split('\n'),
    upstreamPushUrls: git('remote', 'get-url', '--push', '--all', registry.upstreamRemote).split('\n'),
  });
  const upstreamSha = git('rev-parse', '--verify', `${upstreamRef}^{commit}`);
  const destinationSha = git('rev-parse', '--verify', `${destinationRef}^{commit}`);
  const baseline = git('rev-parse', '--verify', `${registry.importedUpstreamSha}^{commit}`);
  try { git('merge-base', '--is-ancestor', baseline, upstreamSha); }
  catch { throw new Error('Upstream history changed; baseline needs manual review.'); }
  const blob = (ref, path) => {
    try { return git('rev-parse', '--verify', `${ref}:${path}`); }
    catch { return null; }
  };
  const files = git('diff', '--name-only', baseline, upstreamSha).split('\n').filter(Boolean).map(path => {
    const protectedPath = registry.protectedPrefixes.some(prefix => path.startsWith(prefix));
    return { path, classification: protectedPath ? 'review-installation-boundary' : classifyBlob(blob(baseline, path), blob(destinationSha, path), blob(upstreamSha, path)) };
  });
  // Always list the whole interval and pending ledger entries. Observation
  // cursors never silently mark an unresolved change as transferred.
  const commits = git('log', '--reverse', '--format=%H%x09%s', `${baseline}..${upstreamSha}`).split('\n').filter(Boolean).map(line => {
    const [sha, ...subject] = line.split('\t');
    return { sha, subject: subject.join('\t'), decision: registry.decisions?.[sha] ?? 'pending-review' };
  });
  return { upstreamSha, destinationSha, baseline, commits, files, companies: registry.companies,
    warning: 'Source comparison only. Passing tests, CI and per-installation acceptance remain separate gates.' };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const registry = JSON.parse(readFileSync(new URL('../config/private-upstream-sync.json', import.meta.url), 'utf8'));
  process.stdout.write(`${JSON.stringify(auditUpstream({ registry }), null, 2)}\n`);
}
