import { inspectOggOpus as inspect, MAX_AUDIO_BYTES, MAX_AUDIO_SECONDS, oggPageChecksum } from "../../infra/shared/audio-validation.mjs";
import { UploadValidationError } from "./upload-validation";
export { MAX_AUDIO_BYTES, MAX_AUDIO_SECONDS, oggPageChecksum };
/** Shared structural policy also runs in the fixed host broker. */
export function inspectOggOpus(data: Buffer) {
  try { inspect(data); }
  catch (error) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "UPLOAD_AUDIO_INVALID";
    throw new UploadValidationError(code, "Audio is not a bounded Ogg Opus recording.");
  }
}
