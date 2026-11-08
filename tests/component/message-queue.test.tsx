// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "../render-spanish";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageQueue } from "@/components/assistant-ui/elements/message-queue";

afterEach(cleanup);

describe("message queue", () => {
  it("shows the running message and lets the user remove a queued message", () => {
    const onCancel = vi.fn();

    render(
      <MessageQueue
        running="Analitza el document"
        queued={[{ id: "queued-1", text: "Prepara el resum" }]}
        onCancel={onCancel}
        language="en"
      />,
    );

    expect(screen.getByText("Analitza el document")).toBeInTheDocument();
    expect(screen.getByText("Prepara el resum")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: 'Remove "Prepara el resum" from the queue',
      }),
    );
    expect(onCancel).toHaveBeenCalledWith("queued-1");
  });
});
