// @vitest-environment jsdom
import { cleanup, render, screen } from "../render-spanish";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DitheringShader } from "@/components/ui/dithering-shader";

vi.mock("@paper-design/shaders-react", () => ({
  Dithering: (props: Record<string, unknown>) => <div data-testid="paper-dithering" data-props={JSON.stringify(props)} />,
}));
afterEach(cleanup);

describe("DitheringShader demo adapter", () => {
  it("preserves the supplied Wave demo props and maps pxSize to size", () => {
    render(<DitheringShader shape="wave" type="8x8" pxSize={3} speed={0.6} colorBack="#001122" colorFront="#92bee2" />);
    expect(JSON.parse(screen.getByTestId("paper-dithering").dataset.props!)).toEqual({
      width: "100%", height: "100%", shape: "wave", type: "8x8", size: 3, speed: 0.6, colorBack: "#001122", colorFront: "#92bee2",
    });
  });
  it("retains explicit size, static frame and bounded rendering props", () => {
    render(<DitheringShader pxSize={3} size={4} speed={0} frame={1200} maxPixelCount={120000} minPixelRatio={1} />);
    expect(JSON.parse(screen.getByTestId("paper-dithering").dataset.props!)).toMatchObject({ size: 4, speed: 0, frame: 1200, maxPixelCount: 120000, minPixelRatio: 1 });
  });
});
