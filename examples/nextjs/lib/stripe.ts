import "server-only";
import Stripe from "stripe";

/** "test" for sk_test_/rk_test_ keys, "live" for sk_live_/rk_live_, otherwise null. */
export const keyMode = (k: string) => (/^(sk|rk)_test_\w{10,}$/.test(k) ? "test" : /^(sk|rk)_live_\w{10,}$/.test(k) ? "live" : null);

export const MODE = keyMode(process.env.STRIPE_SECRET_KEY ?? "");

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? "", {
  // Every write sends an idempotency key, so these retries can't charge twice.
  maxNetworkRetries: 2,
  timeout: 20_000,
  appInfo: { name: "my-shop" },
});

/** Subscribe the webhook endpoint to exactly these. */
export const WEBHOOK_EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "charge.refunded",
  "charge.dispute.created",
  "refund.updated",
  "refund.failed",
];

export const stripeMessage = (e: unknown) => (e as { raw?: { message?: string } })?.raw?.message || (e as Error)?.message || "Stripe didn't answer.";

/** How the shopper paid, from a charge: card, apple_pay, google_pay, link, upi… */
export function paidWith(charge: Stripe.Charge | string | null | undefined): string | null {
  if (!charge || typeof charge === "string") return null;
  const d = charge.payment_method_details;
  if (!d) return null;
  return d.type === "card" ? d.card?.wallet?.type || "card" : d.type;
}
