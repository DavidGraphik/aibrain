// @vitest-environment jsdom
import { cleanup, render, screen } from "../render-spanish";
import { afterEach, expect, it, vi } from "vitest";
import { StreamRecoveryBanner } from "@/components/stream-recovery-banner";
afterEach(cleanup);

it("labels an unconfirmed submission truthfully and offers no action that can resubmit it", () => {
  render(<StreamRecoveryBanner attempt={null} paused admissionUnconfirmed onRetry={vi.fn()} />);
  expect(screen.getByRole("status")).toHaveTextContent("Los reintentos están pausados");
  expect(screen.getByRole("status")).toHaveTextContent("la parada del servidor no está confirmada");
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(screen.getByRole("status")).not.toHaveTextContent("resultados guardados");
});
