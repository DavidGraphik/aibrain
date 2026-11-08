import { createHash } from 'node:crypto';
import { lstat, open, mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { inspectOggOpus, MAX_AUDIO_BYTES, MAX_AUDIO_SECONDS } from './audio-validation.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const abortCheck = signal => { if (signal?.aborted) throw Error('AUDIO_CANCELLED'); };

export function authorizeAudio(binding, input) {
  if (binding?.installationId !== 'trinalum-production' || binding.status !== 'active' ||
      !UUID.test(binding.userId ?? '') || !['trini', 'miguel', 'nerea', 'tristan', 'david'].includes(binding.owner)) throw Error('ACCESS_DENIED');
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== 'installationId,sha256,size,threadId,uploadId' ||
      input.installationId !== binding.installationId || !UUID.test(input.threadId ?? '') ||
      !UUID.test(input.uploadId ?? '') || !SHA.test(input.sha256 ?? '') || !Number.isSafeInteger(input.size) ||
      input.size < 1 || input.size > MAX_AUDIO_BYTES) throw Error('INVALID_ARGUMENTS');
}

/** No client path is opened. Receive only bounded bytes into a new broker-owned file. */
async function privateSnapshot(stream, file, input, signal) {
  const handle = await open(file, 'wx+', 0o600);
  let size = 0; const hash = createHash('sha256');
  try {
    for await (const value of stream) {
      abortCheck(signal);
      if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) throw Error('AUDIO_INVALID');
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (size + chunk.length > input.size || size + chunk.length > MAX_AUDIO_BYTES) throw Error('AUDIO_SIZE_INVALID');
      let written = 0;
      while (written < chunk.length) {
        const result = await handle.write(chunk, written, chunk.length - written, size + written);
        if (!result.bytesWritten) throw Error('AUDIO_UNAVAILABLE');
        written += result.bytesWritten;
      }
      hash.update(chunk); size += chunk.length;
    }
    abortCheck(signal);
    if (size !== input.size || hash.digest('hex') !== input.sha256) throw Error('AUDIO_SOURCE_CHANGED');
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.uid !== process.getuid() || metadata.nlink !== 1 || (metadata.mode & 0o077) || metadata.size !== size) throw Error('AUDIO_SOURCE_UNSAFE');
    // Bounded structural inspection allocates <=20 MiB only after streamed receipt.
    const bytes = await handle.readFile();
    try { inspectOggOpus(bytes); } catch { throw Error('AUDIO_INVALID'); }
  } finally { await handle.close(); }
}

// Measured reference audio fixture, uid999/offline/int8, 2026-10-14. RSS alone
// is not cgroup acceptance; reserve broker peak plus two input-size allowances.
export const OBSERVED_ASR_RSS_BYTES = 650231808;
export const AUDIO_REQUIRED_HEADROOM_BYTES = OBSERVED_ASR_RSS_BYTES + 96 * 1024 * 1024 + 2 * MAX_AUDIO_BYTES;
export const AUDIO_HOST_RESERVE_BYTES = 256 * 1024 * 1024;
export function assertAudioHostBudget(meminfo) {
  const entries = String(meminfo).split('\n').filter(line => line.startsWith('MemAvailable:'));
  const value = entries.length === 1 && /^MemAvailable:\s+([0-9]+) kB\s*$/.exec(entries[0]);
  const bytes = value ? Number(value[1]) * 1024 : NaN;
  if (!Number.isSafeInteger(bytes) || bytes < AUDIO_REQUIRED_HEADROOM_BYTES + AUDIO_HOST_RESERVE_BYTES) throw Error('AUDIO_BUDGET_UNVERIFIED');
}
export function assertAudioBudget(maximum, current) {
  if (!Number.isSafeInteger(maximum) || !Number.isSafeInteger(current) || current < 0 ||
      maximum - current < AUDIO_REQUIRED_HEADROOM_BYTES) throw Error('AUDIO_BUDGET_UNVERIFIED');
}
export async function verifyAudioBudget(readText = readFile) {
  const records = await readText('/proc/self/cgroup', 'utf8');
  const group = records.split('\n').find(line => line.startsWith('0::'))?.slice(3);
  if (!group || !group.startsWith('/') || posix.normalize(group) !== group || !/^[a-zA-Z0-9._/\-]+$/.test(group)) throw Error('AUDIO_BUDGET_UNVERIFIED');
  let relative = group; let finite = false;
  for (;;) {
    const directory = join('/sys/fs/cgroup', relative);
    let maximum;
    try { maximum = (await readText(join(directory, 'memory.max'), 'utf8')).trim(); }
    catch (error) {
      // Unified hierarchy root has no memory.max; finite child/ancestor limits
      // still must be present and verified. Other missing paths fail closed.
      if (relative === '/' && error?.code === 'ENOENT') break;
      throw error;
    }
    if (maximum !== 'max') {
      if (!/^[1-9][0-9]*$/.test(maximum)) throw Error('AUDIO_BUDGET_UNVERIFIED');
      const current = (await readText(join(directory, 'memory.current'), 'utf8')).trim();
      if (!/^[0-9]+$/.test(current)) throw Error('AUDIO_BUDGET_UNVERIFIED');
      assertAudioBudget(Number(maximum), Number(current)); finite = true;
    }
    if (relative === '/') break;
    relative = posix.dirname(relative);
  }
  if (!finite) throw Error('AUDIO_BUDGET_UNVERIFIED');
  assertAudioHostBudget(await readText('/proc/meminfo', 'utf8'));
}

async function verifyLocalAudioTools() {
  const trustedOwner = process.getuid();
  for (const file of ['/usr/bin/ffprobe', '/opt/trinalum/bin/trinalum-transcribe', '/opt/trinalum/audio-model', '/opt/trinalum/audio-model/model.bin']) {
    const metadata = await lstat(file);
    if (file.endsWith('/model.bin') && metadata.size !== 483546902) throw Error('AUDIO_BUDGET_UNVERIFIED');
    if (metadata.isSymbolicLink() || (metadata.uid !== 0 && metadata.uid !== trustedOwner) || (metadata.mode & 0o022) ||
        (file.endsWith('/audio-model') ? !metadata.isDirectory() : !metadata.isFile() || (!file.endsWith('/model.bin') && !(metadata.mode & 0o111)))) throw Error('AUDIO_UNAVAILABLE');
  }
}

/** Fixed tools only; process groups are killed on every terminal path, including cancellation. */
export function runAudioTool(command, args, { cwd, env, signal, timeoutMs, maxBytes }) {
  abortCheck(signal);
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = []; let stdoutBytes = 0; let stderrBytes = 0; let reason = null; let spawnFailure = null; let forceKill;
    const kill = kind => {
      if (!child.pid) return;
      try { if (process.platform === 'win32') child.kill(kind); else process.kill(-child.pid, kind); } catch { /* already exited */ }
    };
    const terminate = code => {
      if (reason) return;
      reason = code; kill('SIGTERM'); forceKill = setTimeout(() => kill('SIGKILL'), 250); forceKill.unref();
    };
    child.stdout.on('data', bytes => {
      stdoutBytes += bytes.length;
      if (stdoutBytes > maxBytes) terminate('AUDIO_OUTPUT_INVALID'); else stdout.push(bytes);
    });
    child.stderr.on('data', bytes => { stderrBytes += bytes.length; if (stderrBytes > 32768) terminate('AUDIO_OUTPUT_INVALID'); });
    const cancel = () => terminate('AUDIO_CANCELLED');
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const timeout = setTimeout(() => terminate('AUDIO_TIMEOUT'), timeoutMs); timeout.unref();
    child.once('error', error => { spawnFailure = error; });
    child.once('close', code => {
      clearTimeout(timeout); clearTimeout(forceKill); signal?.removeEventListener('abort', cancel); kill('SIGKILL');
      if (reason || spawnFailure || code !== 0) {
        const busy = !spawnFailure && code === 75 && command === '/opt/trinalum/bin/trinalum-transcribe';
        reject(Error(reason ?? (busy ? 'AUDIO_BUSY' : 'AUDIO_UNAVAILABLE'))); return;
      }
      try { resolveResult({ stdout: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(stdout)) }); }
      catch { reject(Error('AUDIO_OUTPUT_INVALID')); }
    });
  });
}

/** One slot in the existing, single-process broker. Test options never come from HTTP/config. */
export function createAudioTranscriber({ runner = runAudioTool, temporaryRoot = tmpdir(), verifyTools = verifyLocalAudioTools, verifyBudget = verifyAudioBudget } = {}) {
  let occupied = false;
  return async (binding, input, stream, { signal, authorize = async () => {} } = {}) => {
    authorizeAudio(binding, input); abortCheck(signal);
    if (occupied) throw Error('AUDIO_BUSY');
    occupied = true;
    let work;
    try {
      await authorize();
      try { await verifyBudget(); } catch { throw Error("AUDIO_BUDGET_UNVERIFIED"); }
      await verifyTools();
      abortCheck(signal);
      work = await mkdtemp(join(temporaryRoot, 'trinalum-audio-'));
      const file = join(work, 'input.ogg');
      await privateSnapshot(stream, file, input, signal);
      const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: work, TMPDIR: work, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
        HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', PYTHONDONTWRITEBYTECODE: '1', OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1' };
      const probe = await runner('/usr/bin/ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries',
        'format=format_name,duration:stream=codec_type,codec_name,channels,sample_rate', '-of', 'json', file],
      { cwd: work, env, signal, timeoutMs: 15000, maxBytes: 16384 });
      try {
        const metadata = JSON.parse(probe.stdout), stream = metadata.streams?.[0], duration = Number(metadata.format?.duration);
        if (metadata.streams?.length !== 1 || metadata.format?.format_name !== 'ogg' || stream?.codec_name !== 'opus' ||
            stream?.codec_type !== 'audio' || ![1, 2].includes(stream?.channels) || Number(stream?.sample_rate) !== 48000 ||
            !Number.isFinite(duration) || duration <= 0 || duration > MAX_AUDIO_SECONDS) throw Error('invalid');
      } catch { throw Error('AUDIO_INVALID'); }
      await authorize(); abortCheck(signal);
      try { await verifyBudget(); } catch { throw Error("AUDIO_BUDGET_UNVERIFIED"); }
      const result = await runner('/opt/trinalum/bin/trinalum-transcribe', [file],
        { cwd: work, env, signal, timeoutMs: 300000, maxBytes: 1024 * 1024 });
      const text = result.stdout?.trim();
      if (!text || Buffer.byteLength(text, 'utf8') > 1024 * 1024 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/u.test(text)) throw Error('AUDIO_OUTPUT_INVALID');
      await authorize(); abortCheck(signal);
      return { installationId: binding.installationId, userId: binding.userId, threadId: input.threadId,
        uploadId: input.uploadId, sha256: input.sha256, text };
    } finally {
      // Keep the slot until private temporary content and converter descendants are gone.
      try { if (work) await rm(work, { recursive: true, force: true }); } finally { occupied = false; }
    }
  };
}
