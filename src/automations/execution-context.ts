import type { TurnOptions } from "@/lib/chat-contract";
import { resolveInstallationModelPolicy } from "@/runtime/composer-experience";

export function scheduledTurnOptions(input: {
  skillsAuthorized: boolean;
  connectorMentions: string[];
}): TurnOptions {
  const policy = resolveInstallationModelPolicy();
  return {
    mode: "agent",
    model: policy?.model ?? null,
    effort: policy?.effort ?? null,
    webSearch: true,
    imageGeneration: false,
    skill: null,
    inheritAuthorizedSkills: input.skillsAuthorized,
    connectorMentions: [...input.connectorMentions],
    attachments: [],
  };
}
