import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  parseAutomationInput,
  type AutomationTaskInput,
} from "@/automations/contracts";
import { atomicWriteFile, ResourceLockManager } from "@/storage";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type Proposal = {
  schemaVersion: 1;
  id: string;
  taskId: string;
  installationId: string;
  userId: string;
  sourceThreadId: string;
  sourceTurnId: string;
  callId: string;
  input: AutomationTaskInput;
  status: "pending" | "confirming" | "confirmed";
  createdAt: string;
  confirmationTurnId: string | null;
  confirmedAt: string | null;
};

function strictObject(value: unknown, keys: readonly string[]) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"));
}

function parseProposal(value: unknown): Proposal | null {
  if (!strictObject(value, [
    "schemaVersion", "id", "taskId", "installationId", "userId", "sourceThreadId",
    "sourceTurnId", "callId", "input", "status", "createdAt", "confirmationTurnId", "confirmedAt",
  ])) return null;
  const proposal = value as Record<string, unknown>;
  const input = parseAutomationInput(proposal.input);
  const validLifecycle = proposal.status === "pending"
    ? proposal.confirmationTurnId === null && proposal.confirmedAt === null
    : proposal.status === "confirming"
      ? typeof proposal.confirmationTurnId === "string" && proposal.confirmedAt === null
      : proposal.status === "confirmed"
        ? typeof proposal.confirmationTurnId === "string" && typeof proposal.confirmedAt === "string"
        : false;
  if (proposal.schemaVersion !== 1 || !UUID.test(String(proposal.id)) || !UUID.test(String(proposal.taskId)) ||
      typeof proposal.installationId !== "string" || typeof proposal.userId !== "string" ||
      typeof proposal.sourceThreadId !== "string" || typeof proposal.sourceTurnId !== "string" ||
      typeof proposal.callId !== "string" || !input ||
      (proposal.status !== "pending" && proposal.status !== "confirming" && proposal.status !== "confirmed") ||
      typeof proposal.createdAt !== "string" || !Number.isFinite(Date.parse(proposal.createdAt)) ||
      (proposal.confirmationTurnId !== null && typeof proposal.confirmationTurnId !== "string") ||
      (proposal.confirmedAt !== null && (typeof proposal.confirmedAt !== "string" || !Number.isFinite(Date.parse(proposal.confirmedAt)))) ||
      !validLifecycle) return null;
  return { ...(proposal as Omit<Proposal, "input">), input } as Proposal;
}

export function isExplicitAutomationConfirmation(message: string) {
  const normalized = message.trim().replace(/[.!]+$/u, "").trim();
  return /^(?:(?:sí|si|yes|ok)(?:,\s*)?(?:confírmala|confirmala|créala|creala|actívala|activala|adelante)?|confirmo(?:,\s*adelante)?|confirmar|confírmala|confirmala|adelante|créala|creala|actívala|activala)$/iu.test(normalized);
}

export class FileAutomationProposalStore {
  private readonly root: string;
  private readonly filePath: string;
  private readonly locks: ResourceLockManager;

  constructor(private readonly options: { installationId: string; userId: string; usersRoot: string }) {
    if (!IDENTITY.test(options.installationId) || !IDENTITY.test(options.userId) || !path.isAbsolute(options.usersRoot)) {
      throw new Error("La identidad de las propuestas de automatización no es válida.");
    }
    this.root = path.join(path.resolve(options.usersRoot), options.userId, "automations");
    this.filePath = path.join(this.root, "chat-proposals.json");
    this.locks = new ResourceLockManager({ rootDirectory: path.join(this.root, "locks") });
  }

  private async prepare() {
    for (const directory of [this.root, path.join(this.root, "locks")]) {
      try {
        const metadata = await lstat(directory);
        if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
          throw new Error("El directorio de propuestas de automatización no es privado.");
        }
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
        await mkdir(directory, { recursive: true, mode: 0o700 });
      }
    }
  }

  private async read() {
    try {
      const value: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          !Array.isArray((value as { proposals?: unknown }).proposals)) throw new Error("Automation proposals are corrupt.");
      const proposals = (value as { proposals: unknown[] }).proposals.map(parseProposal);
      if (proposals.some((proposal) => !proposal)) throw new Error("Automation proposals are corrupt.");
      return proposals as Proposal[];
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
  }

  private async write(proposals: Proposal[]) {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    await atomicWriteFile(this.filePath, `${JSON.stringify({ schemaVersion: 1, proposals }, null, 2)}\n`, { mode: 0o600 });
  }

  async propose(input: AutomationTaskInput, binding: { sourceThreadId: string; sourceTurnId: string; callId: string }) {
    await this.prepare();
    return this.locks.withLock("automation-chat-proposals", async () => {
      const proposals = await this.read();
      const replay = proposals.find((item) => item.sourceTurnId === binding.sourceTurnId && item.callId === binding.callId);
      if (replay) return replay;
      const proposal: Proposal = {
        schemaVersion: 1, id: randomUUID(), taskId: randomUUID(),
        installationId: this.options.installationId, userId: this.options.userId,
        ...binding, input, status: "pending", createdAt: new Date().toISOString(),
        confirmationTurnId: null, confirmedAt: null,
      };
      proposals.push(proposal);
      await this.write(proposals.slice(-200));
      return proposal;
    });
  }

  async confirm(proposalId: string | null, binding: { sourceThreadId: string; currentTurnId: string; currentMessage: string }, create: (proposal: Proposal) => Promise<void>) {
    await this.prepare();
    return this.locks.withLock("automation-chat-proposals", async () => {
      const proposals = await this.read();
      const available = proposals.filter((item) => item.installationId === this.options.installationId &&
        item.userId === this.options.userId && item.sourceThreadId === binding.sourceThreadId);
      const pending = available.filter((item) => item.status !== "confirmed");
      if (!proposalId && pending.length > 1) {
        throw new Error("Hay varias propuestas pendientes en esta conversación; indica cuál quieres confirmar.");
      }
      const proposal = proposalId
        ? available.find((item) => item.id === proposalId)
        : pending[0] ?? available.filter((item) => item.status === "confirmed").at(-1);
      if (!proposal || proposal.sourceThreadId !== binding.sourceThreadId) throw new Error("La propuesta de automatización no está disponible en esta conversación.");
      if (proposal.status === "confirmed") return proposal;
      if (proposal.status === "pending") {
        if (proposal.sourceTurnId === binding.currentTurnId || !isExplicitAutomationConfirmation(binding.currentMessage)) {
          throw new Error("La automatización requiere una confirmación explícita en un mensaje posterior.");
        }
        // Persist the user's consent before the external create effect. If the
        // process stops after creation, retrying the fixed taskId reconciles
        // idempotently and closes the durable receipt.
        proposal.status = "confirming";
        proposal.confirmationTurnId = binding.currentTurnId;
        await this.write(proposals);
      }
      await create(proposal);
      proposal.status = "confirmed";
      proposal.confirmedAt = new Date().toISOString();
      await this.write(proposals);
      return proposal;
    });
  }
}
