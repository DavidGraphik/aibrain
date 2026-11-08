import { describe, expect, it } from "vitest";
import { capacityFallback, isRejectedModelAdmission, isModelCapacityError, isModelRateLimitError } from "./model-capacity-retry";
import type { RuntimeModelOption } from "@/lib/runtime-status";

const rejection = { id: "turn-1", status: "failed", error: { codexErrorInfo: "serverOverloaded" },
  items: [{ type: "userMessage", clientId: "user-1" }] };

describe("empty model admission rejection", () => {
  it("retains medium reasoning when Terra falls back to an available Sol", () => {
    const sol: RuntimeModelOption = {
      id: "gpt-6.1-sol", label: "Sol", description: "", isDefault: false,
      inputModalities: ["text", "image"], supportedReasoningEfforts: ["medium"],
      defaultReasoningEffort: "medium", supportsPersonality: false,
    };
    const input = { originalModel: "gpt-6.1-terra", currentModel: "gpt-6.1-terra",
      effort: "medium" as const, models: [sol], requiresImages: true, imageGeneration: false };
    expect(capacityFallback(input)).toEqual({ model: "gpt-6.1-sol", effort: "medium" });
    expect(capacityFallback({ ...input, models: [] })).toBeNull();
    expect(capacityFallback({ ...input, currentModel: "gpt-6.1-sol" })).toBeNull();
    expect(capacityFallback({ ...input, imageGeneration: true })).toBeNull();
  });
  it("selects only available compatible alternatives, retaining effort or their supported default", () => {
    const models: RuntimeModelOption[] = ["gpt-5.6-sol", "gpt-6-astra", "gpt-5.6-terra"].map(id => ({
      id, label: id, description: "", isDefault: false, inputModalities: ["text", "image"],
      supportedReasoningEfforts: ["low", "medium"], defaultReasoningEffort: "low", supportsPersonality: false,
    }));
    const input = { originalModel: "gpt-6-astra", currentModel: "gpt-6-astra", effort: "medium" as const,
      models, requiresImages: true, imageGeneration: false };
    expect(capacityFallback(input)).toEqual({ model: "gpt-5.6-sol", effort: "medium" });
    expect(capacityFallback({ ...input, currentModel: "gpt-5.6-sol" })).toEqual({ model: "gpt-5.6-terra", effort: "medium" });
    expect(capacityFallback({ ...input, effort: "ultra" })).toEqual({ model: "gpt-5.6-sol", effort: "low" });
    for (const override of [{ models: [] }, { originalModel: "custom-model" }, { imageGeneration: true },
      { models: models.map(model => ({ ...model, inputModalities: ["text" as const] })) }]) {
      expect(capacityFallback({ ...input, ...override })).toBeNull();
    }
  });
  it("can reroute the current server-selected 6.1 model only to fresh catalog-compatible families", () => {
    const models: RuntimeModelOption[] = ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-6-astra"].map(id => ({
      id, label: id, description: "", isDefault: false, inputModalities: ["text", "image"],
      supportedReasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "low", supportsPersonality: false,
    }));
    const input = { originalModel: "gpt-6.1-sol", currentModel: "gpt-6.1-sol", effort: "high" as const,
      models, requiresImages: true, imageGeneration: false };
    expect(capacityFallback(input)).toEqual({ model: "gpt-6-sol", effort: "high" });
  });
  it.each(["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"])("requires positive current catalog access and compatible modality for %s", originalModel => {
    const models: RuntimeModelOption[] = ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-6-astra"].map(id => ({
      id, label: id, description: "", isDefault: false, inputModalities: ["text", "image"],
      supportedReasoningEfforts: ["low"], defaultReasoningEffort: "low", supportsPersonality: false,
    }));
    const input = { originalModel, currentModel: originalModel, effort: "high" as const,
      models, requiresImages: true, imageGeneration: false };
    const before = JSON.stringify(input);
    const fallback = capacityFallback(input);
    expect(fallback).not.toBeNull();
    expect(fallback!.model).not.toBe(originalModel);
    expect(fallback!.effort).toBe("low");
    expect(models.some(model => model.id === fallback!.model)).toBe(true);
    expect(JSON.stringify(input)).toBe(before);
    for (const override of [{ models: [] }, { models: models.filter(model => model.id === originalModel) },
      { models: models.map(model => ({ ...model, inputModalities: ["text" as const] })) },
      { models: models.map(model => ({ ...model, inputModalities: ["image" as const] })) },
      { models: models.map(model => ({ ...model, defaultReasoningEffort: "medium" as const })) },
      { imageGeneration: true }, { originalModel: null }, { originalModel: "future-unreviewed-model" }]) {
      expect(capacityFallback({ ...input, ...override })).toBeNull();
    }
    const textOnly = models.map(model => ({ ...model, inputModalities: ["text" as const] }));
    expect(capacityFallback({ ...input, requiresImages: false, models: textOnly })).not.toBeNull();
  });
  it("skips the current alternative and incompatible advertised models without selecting an unlisted name", () => {
    const model = (id: string, inputModalities: RuntimeModelOption["inputModalities"]): RuntimeModelOption => ({
      id, label: id, description: "", isDefault: false, inputModalities,
      supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "low", supportsPersonality: false,
    });
    const input = { originalModel: "gpt-6.1-sol", currentModel: "gpt-6-sol", effort: "high" as const,
      models: [model("gpt-6-sol", ["text", "image"]), model("gpt-6-astra", ["text"]), model("gpt-6-luna", ["text", "image"])],
      requiresImages: true, imageGeneration: false };
    expect(capacityFallback(input)).toEqual({ model: "gpt-6-luna", effort: "high" });
    expect(capacityFallback({ ...input, models: [model("unreviewed-compatible", ["text", "image"])] })).toBeNull();
  });
  it("requires an exact failed turn, structured capacity code and sole matching user input", () => {
    expect(isRejectedModelAdmission(rejection, "turn-1", "user-1")).toBe(true);
    for (const turn of [null, { ...rejection, id: "foreign-turn" }, { ...rejection, status: "inProgress" },
      { ...rejection, error: { message: "Selected model is at capacity. Please try a different model." } },
      { ...rejection, error: { codexErrorInfo: "usageLimitExceeded" } },
      { ...rejection, items: [] }, { ...rejection, items: [{ type: "userMessage", clientId: "other-user" }] },
      ...["agentMessage", "reasoning", "commandExecution", "dynamicToolCall", "fileChange"].map(type =>
        ({ ...rejection, items: [...rejection.items, { type }] }))]) {
      expect(isRejectedModelAdmission(turn, "turn-1", "user-1")).toBe(false);
    }
  });
});

describe("structured provider rate-limit errors", () => {
  it.each(["rateLimitExceeded", ...["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts"].map(key => ({ [key]: { httpStatusCode: 429 } }))])("identifies %j without authorizing capacity rerouting", codexErrorInfo => {
    const error = { message: "private provider details", codexErrorInfo };
    expect(isModelRateLimitError(error)).toBe(true);
    expect(isModelCapacityError(error)).toBe(false);
    expect(isRejectedModelAdmission({ ...rejection, error }, "turn-1", "user-1")).toBe(false);
  });
  it("does not infer rate limits or Retry-After from log/message text or unrelated quota errors", () => {
    for (const error of [null, { message: "429 TooManyRequests Retry-After: 317" }, { status: 429 },
      { codexErrorInfo: "usageLimitExceeded" }, { codexErrorInfo: "sessionBudgetExceeded" },
      { codexErrorInfo: "serverOverloaded" }, { codexErrorInfo: { unknown: { httpStatusCode: 429 } } },
      ...[null, 503, "429"].map(httpStatusCode => ({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode } } }))]) {
      expect(isModelRateLimitError(error)).toBe(false);
    }
  });
});
