import type { ChatMessage } from "@/lib/chat-contract";

/** Synthetic only: resembles an image-heavy tool turn without customer data. */
export function largeChatFixture(status: ChatMessage["status"] = "streaming"): ChatMessage {
  return {
    id: "00000000-0000-4000-8000-000000000014", role: "assistant", status,
    content: status === "streaming" ? "" : "Thirteen dial images saved and checked.",
    createdAt: "2026-10-20T12:00:00.000Z", plan: [], approvals: [], diff: "", attachments: [], sources: [],
    activity: [{ id: "image-command", kind: "command", label: "Prepare original images", status: "complete", sequence: 17,
      output: `data:image/jpeg;base64,${"A".repeat(2_350_000)}\\n\"🙂` }],
    artifacts: [{ id: "00000000-0000-4000-8000-000000000015", type: "image", name: "dial.png",
      url: "/api/projects/00000000-0000-4000-8000-000000000011/artifacts/00000000-0000-4000-8000-000000000015", prompt: null, width: 864, height: 864 }],
    toolResults: Array.from({ length: 80 }, (_, index) => ({ id: `tool-${index}`, kind: "app", title: "Shopify readback", status: "complete",
      summary: "Verified", output: `${index}:` + "B".repeat(63_990), sourceIds: [], createdAt: "2026-10-20T12:00:00.000Z", sequence: index + 20 })),
  };
}
