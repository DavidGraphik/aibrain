import { shopifyFail } from "./shopify-contracts";

// Decimal strings stay exact throughout aggregation. No binary floating-point money or FX conversion.
const SCALE = 10n ** 18n;
const FIELDS = {
  orderValueBeforeReturns: "totalPriceSet",
  orderValueAfterReturns: "currentTotalPriceSet",
  amountReceived: "totalReceivedSet",
  amountRefunded: "totalRefundedSet",
  netPayments: "netPaymentSet",
} as const;
type Metric = keyof typeof FIELDS;
type Totals = Record<Metric, bigint>;
const zero = (): Totals => ({ orderValueBeforeReturns: 0n, orderValueAfterReturns: 0n, amountReceived: 0n, amountRefunded: 0n, netPayments: 0n });
export const SHOPIFY_ORDER_MONEY_SELECTION = Object.values(FIELDS).map(field => `${field} { shopMoney { amount currencyCode } }`).join(" ");
function decimal(value: unknown) {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d{0,17})(?:\.\d{1,18})?$/.test(value)) shopifyFail("MONEY_INVALID");
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  const units = BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, "0"));
  return value.startsWith("-") ? -units : units;
}
function text(units: bigint) {
  const sign = units < 0n ? "-" : "", absolute = units < 0n ? -units : units;
  const fraction = (absolute % SCALE).toString().padStart(18, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${sign}${absolute / SCALE}.${fraction}`;
}
export class ShopifyMoneySummary {
  private all = zero(); private nonCancelled = zero(); private cancelled = zero();
  constructor(private currency: string) {}
  add(row: Record<string, unknown>, isCancelled: boolean) {
    const values = zero();
    for (const [metric, field] of Object.entries(FIELDS) as [Metric, string][]) {
      const bag = row[field] as { shopMoney?: { amount?: unknown; currencyCode?: unknown } };
      if (!bag?.shopMoney || bag.shopMoney.currencyCode !== this.currency) shopifyFail("MONEY_CURRENCY_MISMATCH");
      values[metric] = decimal(bag.shopMoney.amount);
    }
    // Official netPaymentSet definition: received minus refunded. Inconsistent provider data is not a report.
    if (values.amountReceived - values.amountRefunded !== values.netPayments) shopifyFail("MONEY_RECONCILIATION_FAILED");
    const bucket = isCancelled ? this.cancelled : this.nonCancelled;
    for (const key of Object.keys(FIELDS) as Metric[]) { this.all[key] += values[key]; bucket[key] += values[key]; }
  }
  snapshot() {
    const serialize = (totals: Totals) => Object.fromEntries(Object.entries(totals).map(([key, amount]) => [key, text(amount)]));
    return {
      currency: this.currency, currencyBasis: "Shopify shopMoney only; never sum customer presentment currencies or apply our own FX rate.",
      amountFormat: "Exact decimal strings, not floating-point numbers. No rounding applied.",
      population: "All non-test orders created in the requested UTC period, including unpaid and cancelled orders. Buckets partition that population by current cancellation state.",
      allNonTestOrders: serialize(this.all), nonCancelledOrders: serialize(this.nonCancelled), cancelledOrders: serialize(this.cancelled),
      fieldSources: FIELDS,
      definitions: {
        orderValueBeforeReturns: "Order total before returns, with taxes and discounts already reflected; not gross merchandise sales, collections or profit.",
        orderValueAfterReturns: "Current order total after returns, with taxes and discounts reflected; not net cash collected or Shopify Analytics net sales.",
        amountReceived: "Provider total received from the customer before returns; not bank payouts or processor settlement.",
        amountRefunded: "Provider cumulative refunded amount for these orders; not just refunds transacted during the requested dates.",
        netPayments: "Provider net payment: amount received minus amount refunded. Not profit, payout or attributed revenue.",
      },
      eventTiming: "Creation-date cohort at read time, not a payment/refund-event ledger. Later payments, edits, cancellations and refunds on these orders affect the values. Payments/refunds on older orders are outside this cohort.",
      grossSales: null, netSales: null, profit: null,
    };
  }
}
