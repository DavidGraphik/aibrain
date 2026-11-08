import { waitForHostAnalysis } from "../src/automations/host-analysis/wait";
import { loadInstallationConfig } from "../src/config/installation";
import { HostAnalysisStore } from "../src/automations/host-analysis/store";
import { parseHostEnvelope } from "../src/automations/host-analysis/contracts";
import { hostAnalysisFailure } from "../src/automations/host-analysis/failure";

async function main() {
  if (process.argv.length !== 2) throw Error("HOST_ARGUMENTS_INVALID");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > 32 * 1024 * 1024) throw Error("HOST_INPUT_TOO_LARGE"); chunks.push(bytes);
  }
  const envelope = parseHostEnvelope(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  const installation = await loadInstallationConfig();
  if (installation.installationId !== "trinalum-production") throw Error("HOST_INSTALLATION_DENIED");
  const store = new HostAnalysisStore(installation);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try {
    const { requestId } = await store.submit(envelope);
    const result = await waitForHostAnalysis({ store, job: envelope.job, requestId, signal: controller.signal });
    process.stdout.write(JSON.stringify(result) + "\n");
  } finally {
    process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop);
  }
}
main().catch(error => {
  const failure = hostAnalysisFailure(error);
  process.stderr.write(failure.code + "\n"); process.exitCode = failure.exitCode;
});
