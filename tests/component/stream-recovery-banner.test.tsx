// @vitest-environment jsdom

import { cleanup, render, screen } from "../render-spanish";
import { afterEach, describe, expect, it } from "vitest";
import { StreamRecoveryBanner } from "@/components/stream-recovery-banner";

afterEach(cleanup);

describe("StreamRecoveryBanner", () => {
  it("appears only after recovery has stalled and keeps the message accessible", () => {
    const { rerender } = render(<StreamRecoveryBanner attempt={null} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    rerender(<StreamRecoveryBanner attempt={2} />);
    expect(screen.getByRole("status")).toHaveTextContent("Reconectando la respuesta (intento 2)");
    expect(screen.getByRole("status")).toHaveTextContent("El historial se conserva");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
