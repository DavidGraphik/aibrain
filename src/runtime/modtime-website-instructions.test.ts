import { expect, it } from "vitest";
import { modtimeWebsiteInstructions } from "./modtime-website-instructions";
it("keeps the unavailable MODTIME theme connection explicit without advertising browser writes", () => {
  const instruction = modtimeWebsiteInstructions("modtime", false, false);
  expect(instruction).toContain("chat cannot save theme changes yet");
  expect(instruction).toContain("Never open Shopify admin/login");
  expect(instruction).toContain("does not inherit the merchant's Shopify login");
  expect(instruction).toContain("Video heading");
  expect(instruction).toContain("Shopify catalogue variants govern price and stock");
});
it("uses direct chat authorization and a provider readback even when configuration exists", () => {
  expect(modtimeWebsiteInstructions("modtime", true, false)).toContain("@ selection is optional");
  const connected = modtimeWebsiteInstructions("modtime", true, true);
  expect(connected).toContain("First read the provider");
  expect(connected).toContain("user's concrete edit request or confirmation");
  expect(connected).toContain("Connection or authorization failures mean no change was saved");
  expect(connected).toContain("do not require a button");
  expect(connected).toContain("rebuild an expired/stale plan");
  expect(connected).toContain("never guess a filename, extension");
});
it("does not apply MODTIME instructions or identities to other clients", () => {
  expect(modtimeWebsiteInstructions("trinalum-production", false, false)).toBe("");
  expect(modtimeWebsiteInstructions("arnall", true, true)).toBe("");
});

it("explains full draft editing and keeps upload, pricing and visual verification boundaries explicit", () => {
  const instruction = modtimeWebsiteInstructions("modtime", true, true);
  for (const text of ["shopify_theme_files", "shopify_theme_plan", "video references", "layout, design", "configurator option blocks", "store-owner account", "Content → Files", "not visual rendering", "blocks and block_order together"]) expect(instruction).toContain(text);
});

it("uses general Shopify execution without the legacy authorization mechanism", () => {
  const text = modtimeWebsiteInstructions("modtime", true, true, true);
  expect(text).toContain("shopify_admin_graphql");
  expect(text).toContain("No approval card");
  expect(text).toContain("one-time store-owner consent");
  expect(text).toContain("actual Shopify checkout charge");
  expect(text).not.toContain("call shopify_theme_apply");
});
