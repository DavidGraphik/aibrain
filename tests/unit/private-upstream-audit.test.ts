import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error Operator-only JavaScript utility.
import { assertPushRemotes, auditUpstream, classifyBlob, repositoryIdentity } from '../../scripts/private-upstream-audit.mjs';

const destination = 'example-owner/aibrain';
const privateUrl = `https://github.com/${destination}.git`;
const upstreamUrl = 'https://github.com/upstream-example/aibrain.git';

describe('private upstream transfer classification', () => {
  it('recognizes HTTPS and SSH without accepting alternate hosts or suffixes', () => {
    expect(repositoryIdentity('https://github.com/example-owner/aibrain.git')).toBe('example-owner/aibrain');
    expect(repositoryIdentity('git@github.com:upstream-example/aibrain.git')).toBe('upstream-example/aibrain');
    expect(() => repositoryIdentity('https://github.com.evil.test/david/repo')).toThrow();
    expect(() => repositoryIdentity('https://github.com/david/repo/pulls')).toThrow();
  });
  it('does not treat destination modifications or deletions as transferred', () => {
    expect(classifyBlob('base', 'new', 'new')).toBe('already-present');
    expect(classifyBlob('base', 'base', 'new')).toBe('needs-transfer');
    expect(classifyBlob('base', 'private', 'new')).toBe('needs-adaptation');
    expect(classifyBlob('base', null, 'new')).toBe('needs-adaptation');
    expect(classifyBlob(null, null, 'new')).toBe('needs-transfer');
    expect(classifyBlob('base', 'private', null)).toBe('needs-adaptation');
  });
  it('accepts multiple destination URLs only when all identify the private destination', () => {
    expect(() => assertPushRemotes({ destination,
      originPushUrls: [privateUrl, `git@github.com:${destination}.git`],
      upstreamPushUrls: ['disabled://read-only-upstream', 'disabled://second-url'],
    })).not.toThrow();
  });
  it.each([upstreamUrl, 'https://github.com/example-owner/unknown.git', 'https://github.com.evil.test/david/repo'])('rejects unsafe secondary destination %s', url => {
    expect(() => assertPushRemotes({ destination, originPushUrls: [privateUrl, url], upstreamPushUrls: ['disabled://read-only-upstream'] })).toThrow();
  });
  it('rejects an enabled secondary upstream URL and missing push URLs', () => {
    expect(() => assertPushRemotes({ destination, originPushUrls: [privateUrl], upstreamPushUrls: ['disabled://read-only-upstream', upstreamUrl] })).toThrow();
    expect(() => assertPushRemotes({ destination, originPushUrls: [], upstreamPushUrls: ['disabled://read-only-upstream'] })).toThrow();
    expect(() => assertPushRemotes({ destination, originPushUrls: [privateUrl], upstreamPushUrls: [] })).toThrow();
  });
  it.each(['origin', 'arnall'])('reads every configured %s push URL before comparing source commits', remote => {
    const cwd = mkdtempSync(join(tmpdir(), 'private-upstream-urls-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
    try {
      git('init');
      git('remote', 'add', 'origin', privateUrl);
      git('remote', 'add', 'arnall', upstreamUrl);
      git('config', 'remote.origin.pushurl', privateUrl);
      git('config', 'remote.arnall.pushurl', 'disabled://read-only-upstream');
      git('config', '--add', `remote.${remote}.pushurl`, upstreamUrl);
      expect(() => auditUpstream({ cwd, registry: { destination, upstream: 'upstream-example/aibrain', upstreamRemote: 'arnall' } })).toThrow(remote === 'origin' ? /destination push URL mismatch/ : /every upstream push URL/);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
