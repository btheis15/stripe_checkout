/**
 * Creates (or replaces) the Stripe webhook endpoint for a deployed site and
 * prints its signing secret, which Stripe shows only once.
 *
 *   npm run create-webhook -- https://your-site.com/webhooks/stripe
 *
 * Uses STRIPE_SECRET_KEY: run it once with the test key and once with the
 * live key (each mode has its own endpoint and secret).
 */
import Stripe from "stripe";
import { MODE, stripe, stripeMessage, WEBHOOK_EVENTS } from "../src/stripe.js";

const url = process.argv[2];
if (!/^https:\/\//.test(url ?? "")) {
  console.error("Usage: npm run create-webhook -- https://your-site.com/webhooks/stripe");
  process.exit(1);
}

try {
  const account = await stripe.accounts.retrieve();
  console.log(`Stripe account ${account.id} (${MODE} mode)${account.charges_enabled ? "" : ": payments not activated yet"}`);

  // Replace any endpoint already pointing here, so events aren't delivered twice.
  for await (const w of stripe.webhookEndpoints.list({ limit: 100 })) {
    if (w.url === url) {
      await stripe.webhookEndpoints.del(w.id);
      console.log(`Removed the old endpoint ${w.id}`);
    }
  }
  const hook = await stripe.webhookEndpoints.create({ url, enabled_events: WEBHOOK_EVENTS, api_version: Stripe.API_VERSION, description: "Website orders" });
  console.log(`Created ${hook.id} for ${url}\n\nSTRIPE_WEBHOOK_SECRET=${hook.secret}\n\nPut that in the server's environment (it isn't shown again).`);
} catch (e) {
  console.error(`Stripe said: ${stripeMessage(e)}`);
  process.exit(1);
}
