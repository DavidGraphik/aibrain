// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { UiLocaleProvider } from "@/i18n/provider";
import { InsiJetsPriceIndex, type InsiJetsPriceRecord } from "@/components/insijets-price-index";
import { InsiJetsCMSPanel } from "@/components/insijets-cms-panel";

const record = (id: string, type: string, title: string, data: Record<string, unknown> = {}): InsiJetsPriceRecord => ({ id, type, title, data, locale: "en", status: "draft", revision: 3 });
const route = record("route-nice", "route", "Nice to London", { fieldData: { "departure-airports": ["airport-nice"], "recommended-aircraft-models": ["aircraft-1"] } });
const category = record("category-light", "category", "Light Jet");
const price = record("price-nice", "price", "Nice to London – Light Jet", { fieldData: { route: route.id, "aircraft-cabin-category": category.id, price: 12000, currency: "d9c61905bac69f49e26bf3b6d194c3ff", passengers: 6, "flight-time-minutes": 105 }, updatedAt: "2026-09-14T22:42:02.292Z", provenance: [{ path: "source/webflow/cms/route-pricing.json" }] });
const source = [route, category, price, record("airport-nice", "airport", "Nice Côte d’Azur", { fieldData: { "icao-code": "LFMN", "iata-code": "NCE" } }), record("aircraft-1", "aircraft", "Citation CJ3")];
const callbacks = () => ({ onReload: vi.fn(), onToggleSidebar: vi.fn(), onEditSource: vi.fn(), onRequestChat: vi.fn() });
const view = (records = source, props = callbacks()) => { render(<UiLocaleProvider locale="en"><InsiJetsPriceIndex records={records} state="ready" {...props}/></UiLocaleProvider>); return props; };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("bounds a large catalogue, counts source identities once and searches airports across route records", () => {
  const many = Array.from({ length: 1000 }, (_, index) => record("route-" + index, "route", "Synthetic route " + index));
  const translated = { ...route, locale: "es", title: "Niza a Londres" };
  view([...source, translated, ...many]);
  const table = screen.getByRole("table");
  expect(within(table).getAllByRole("row")).toHaveLength(9);
  expect(screen.getByText("1001 matching routes · select one to compare categories")).toBeInTheDocument();
  expect(screen.queryByText("Niza a Londres")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.queryByRole("button", { name: "Nice to London" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Search route or airport"), { target: { value: "LFMN" } });
  expect(screen.getByText("1 matching routes · select one to compare categories")).toBeInTheDocument();
  expect(within(table).getAllByRole("row")).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Nice to London" })).toBeInTheDocument();
});

it("shows historical source amounts and genuine source dates without inventing review, validity or availability", () => {
  const props = view();
  fireEvent.click(screen.getByRole("button", { name: "Nice to London" }));
  const detail = screen.getByRole("region", { name: "Selected route comparison" });
  expect(within(detail).getByText("€12,000")).toBeInTheDocument();
  expect(within(detail).getByText("Historical source amount")).toBeInTheDocument();
  expect(within(detail).getByText("6 · 105")).toBeInTheDocument();
  expect(detail).toHaveTextContent("Reviewed: not supplied");
  expect(detail).toHaveTextContent("Valid until: not supplied");
  expect(detail).toHaveTextContent("Source updated: 2026-09-14");
  expect(detail).toHaveTextContent("Citation CJ3");
  expect(detail).toHaveTextContent("Availability and suitability require confirmation.");
  fireEvent.click(within(detail).getByRole("button", { name: "Edit source" }));
  expect(props.onEditSource).toHaveBeenCalledWith(route);
  fireEvent.click(within(detail).getByRole("button", { name: "Edit price source" }));
  expect(props.onEditSource).toHaveBeenLastCalledWith(price);
});

it("passes selected source evidence and the received quote into a chat draft, with no side effects", () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const props = view();
  expect(screen.getByRole("button", { name: "Prepare in chat" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Nice to London" }));
  fireEvent.change(screen.getByLabelText("What would you like to compare?"), { target: { value: "Check my €14,000 quote for six passengers on 28 October." } });
  fireEvent.click(screen.getByRole("button", { name: "Prepare in chat" }));
  expect(props.onRequestChat).toHaveBeenCalledTimes(1);
  const prompt = props.onRequestChat.mock.calls[0][0];
  expect(prompt).toContain("Check my €14,000 quote for six passengers on 28 October.");
  expect(prompt).toContain('"sourceAmount":12000');
  expect(prompt).toContain('"currency":"EUR"');
  expect(prompt).toContain('"reviewedAt":null');
  expect(prompt).toContain('"validUntil":null');
  expect(prompt).toContain('"revision":3');
  expect(prompt).toContain("Do not invent prices, live availability");
  expect(prompt).toContain("do not contact operators, send messages, book or purchase");
  expect(fetch).not.toHaveBeenCalled();
});

it("filters by category and keeps unknown currency and incomplete review explicit", () => {
  const invalid = record("price-unknown", "price", "Unmapped price", { fieldData: { route: route.id, "aircraft-cabin-category": category.id, price: 9500, currency: "unknown-option-id" }, min: 11000, max: 9000, reviewedAt: "2026-10-12" });
  view([route, category, invalid, record("other-route", "route", "Paris to Madrid")]);
  fireEvent.change(screen.getByLabelText("Aircraft category"), { target: { value: category.id } });
  expect(screen.queryByRole("button", { name: "Paris to Madrid" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Nice to London" }));
  const detail = screen.getByRole("region", { name: "Selected route comparison" });
  expect(detail).toHaveTextContent("9,500 · currency unknown");
  expect(detail).toHaveTextContent("Needs review");
  expect(within(detail).queryByText("Recorded range")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Search route or airport"), { target: { value: "unmatched airport" } });
  expect(screen.getByText(/No source routes match/)).toBeInTheDocument();
});

it("distinguishes a published recorded range and its actual review and validity dates", () => {
  const reviewed = { ...price, status: "published", data: { routeId: route.id, min: 13000, max: 15000, currency: "EUR", reviewedAt: "2026-10-12", priceValidUntil: "2026-10-20" } };
  view([route, reviewed]);
  fireEvent.click(screen.getByRole("button", { name: "Nice to London" }));
  const detail = screen.getByRole("region", { name: "Selected route comparison" });
  expect(detail).toHaveTextContent("€13,000 – €15,000");
  expect(detail).toHaveTextContent("Review recorded");
  expect(detail).toHaveTextContent("Reviewed: 2026-10-12");
  expect(detail).toHaveTextContent("Valid until: 2026-10-20");
});

it("loads the connected source data in pricing mode without mounting the legacy editor or writing records", async () => {
  const fetch = vi.fn().mockImplementation(async (url: string) => ({ ok: true, json: async () => url.endsWith("/session") ? { user: { id: "synthetic" } } : { records: source } }));
  vi.stubGlobal("fetch", fetch);
  const onRequestChat = vi.fn();
  render(<UiLocaleProvider locale="en"><InsiJetsCMSPanel mode="pricing" onToggleSidebar={vi.fn()} onRequestChat={onRequestChat}/></UiLocaleProvider>);
  await waitFor(() => expect(screen.getByRole("button", { name: "Nice to London" })).toBeInTheDocument());
  expect(document.querySelector("iframe")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Nice to London" }));
  expect(screen.getByText("€12,000")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Prepare in chat" }));
  expect(onRequestChat).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls.every(([, init]) => !init.method)).toBe(true);
});

it("does not offer stale selected price evidence when a reload fails", () => {
  const props = callbacks();
  const { rerender } = render(<UiLocaleProvider locale="en"><InsiJetsPriceIndex records={source} state="ready" {...props}/></UiLocaleProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Nice to London" }));
  expect(screen.getByRole("button", { name: "Prepare in chat" })).toBeEnabled();
  rerender(<UiLocaleProvider locale="en"><InsiJetsPriceIndex records={source} state="error" {...props}/></UiLocaleProvider>);
  expect(screen.getByRole("alert")).toHaveTextContent("Source data unavailable");
  expect(screen.getByRole("button", { name: "Prepare in chat" })).toBeDisabled();
  expect(screen.queryByRole("region", { name: "Selected route comparison" })).not.toBeInTheDocument();
});
