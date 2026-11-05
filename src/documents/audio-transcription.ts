import { inspectOggOpus, MAX_AUDIO_SECONDS } from "./audio-validation";
import type { DocumentToolchain, DocumentToolRunner } from "./preview-service";
import { StorageError } from "@/storage/errors";

export async function transcribeAudio(input: {
  source: Buffer;
  inputPath: string;
  work: string;
  tools: DocumentToolchain;
  runner: DocumentToolRunner;
  signal?: AbortSignal;
}) {
  inspectOggOpus(input.source);
  if (!input.tools.ffprobe || !input.tools.audioTranscriber) {
    throw new StorageError("DOCUMENT_AUDIO_UNAVAILABLE", "The existing local audio toolchain is not configured.");
  }
  const env = {
    HOME: input.work, TMPDIR: input.work, LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
    HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", PYTHONDONTWRITEBYTECODE: "1",
    OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1",
  };
  const probe = await input.runner.run(input.tools.ffprobe, [
    "-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries",
    "format=format_name,duration:stream=codec_type,codec_name,channels,sample_rate",
    "-of", "json", input.inputPath,
  ], { cwd: input.work, env, timeoutMs: 15_000, signal: input.signal });
  try {
    const metadata = JSON.parse(probe.stdout);
    const stream = metadata.streams?.[0];
    const duration = Number(metadata.format?.duration);
    if (metadata.format?.format_name !== "ogg" || metadata.streams?.length !== 1 ||
        stream?.codec_type !== "audio" || stream?.codec_name !== "opus" ||
        ![1, 2].includes(stream?.channels) || Number(stream?.sample_rate) !== 48000 ||
        !Number.isFinite(duration) || duration <= 0 || duration > MAX_AUDIO_SECONDS) throw new Error("invalid stream");
  } catch {
    throw new StorageError("DOCUMENT_AUDIO_INVALID", "Audio metadata is invalid or exceeds the safety limit.");
  }
  const result = await input.runner.run(input.tools.audioTranscriber, [input.inputPath], {
    cwd: input.work, env, timeoutMs: 5 * 60_000, signal: input.signal,
  });
  if (input.signal?.aborted) throw new StorageError("DOCUMENT_OPERATION_ABORTED", "Audio transcription was aborted.");
  const text = result.stdout.trim();
  if (!text || Buffer.byteLength(text, "utf8") > 1024 * 1024 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/u.test(text)) {
    throw new StorageError("DOCUMENT_AUDIO_EMPTY", "No usable bounded transcript was returned.");
  }
  return text;
}
