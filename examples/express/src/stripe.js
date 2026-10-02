/**
 * The Stripe client and small helpers around it. Nothing here knows about
 * your shop; copy it as is.
 */
import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY ?? "";

/** "test" for sk_test_/rk_test_ keys, "live" for sk_live_/rk_live_, otherwise null. */
export const keyMode = (k) => (/^(sk|rk)_test_\w{10,}$/.test(k) ? "test" : /^(sk|rk)_live_\w{10,}$/.test(k) ? "live" : null);

export const MODE = keyMode(key);
if (!MODE) console.warn("[stripe] STRIPE_SECRET_KEY is missing or isn't a Stripe secret key (sk_test_… / sk_live_…): checkout won't work.");

export const stripe = new Stripe(key || "sk_test_missing", {
  // Every write sends an idempotency key, so these retries can't charge or refund twice.
  maxNetworkRetries: 2,
  timeout: 20_000,
  appInfo: { name: "stripe-checkout-example" },
});

/** The webhook events this integration handles (subscribe the endpoint to exactly these). */
export const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "charge.refunded",
  "charge.dispute.created",
  "refund.updated",
  "refund.failed",
];

/** Throws unless the body was signed by Stripe with this endpoint's secret (and is under 5 minutes old). */
export const verifyEvent = (rawBody, signature, secret) => stripe.webhooks.constructEvent(rawBody, signature, secret, 300);

/** True when Stripe may or may not have acted (the answer never arrived): check before retrying. */
export const lostResponse = (e) => e?.type === "StripeConnectionError" || e?.type === "StripeAPIError" || e?.code === "ETIMEDOUT";

export const stripeMessage = (e) => e?.raw?.message || e?.message || "Stripe didn't answer.";

/** How the shopper paid, from a charge: { method: card | apple_pay | google_pay | link | upi | …, detail }. */
export function paidWith(charge) {
  const d = charge?.payment_method_details;
  if (!d) return { method: null, detail: {} };
  if (d.type === "card") {
    return { method: d.card?.wallet?.type || "card", detail: { brand: d.card?.brand ?? null, last4: d.card?.last4 ?? null } };
  }
  return { method: d.type, detail: {} };
}
