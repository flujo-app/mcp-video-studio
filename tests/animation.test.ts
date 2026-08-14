import { describe, expect, it } from "vitest";
import { defaultTransform, secondsToTicks, type AnimationDocument } from "@mcp-video-studio/contracts";
import { evaluateAnimation } from "@mcp-video-studio/animation";

describe("animation evaluator", () => {
  it("evaluates declarative operations deterministically", () => {
    const document: AnimationDocument = {
      id: "animation", name: "test", durationTick: secondsToTicks(2), canvas: { width: 320, height: 180, background: "transparent" }, seed: 7, mode: "declarative",
      nodes: [{ id: "title", type: "text", name: "Title", properties: { text: "Hello" }, transform: { ...defaultTransform(), position: [0, 0] } }],
      operations: [
        { id: "create", type: "create", targetId: "title", startTick: 0, durationTick: 0, easing: "hold", parameters: {} },
        { id: "move", type: "transform", targetId: "title", startTick: 0, durationTick: secondsToTicks(1), easing: "linear", parameters: { to: { position: [100, 50] } } }
      ]
    };
    expect(evaluateAnimation(document, secondsToTicks(0.5))).toEqual(evaluateAnimation(document, secondsToTicks(0.5)));
    const title = evaluateAnimation(document, secondsToTicks(0.5))[0]!;
    expect(title.visible).toBe(true);
    expect(title.transform.position[0]).toBeCloseTo(50);
    expect(title.transform.position[1]).toBeCloseTo(25);
  });
});
