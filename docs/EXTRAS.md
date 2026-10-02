# Optional pieces

Each of these is independent; add the ones a site needs.

- [Sales tax](#sales-tax)
- [Shoppers abroad: their own currency (and UPI in India)](#shoppers-abroad)
- [Shipping rates](#shipping-rates)
- [Your logo and colors on Stripe's page](#branding)
- [Extra fields and notes on Stripe's page](#extra-fields-and-notes)
- [Refunds](#refunds)
- [Disputes](#disputes)
- [Receipts and order emails](#receipts-and-order-emails)
- [A private test mode on the live site](#a-private-test-mode-on-the-live-site)
- [Connecting Stripe from an admin screen](#connecting-stripe-from-an-admin-screen)
- [Rate limiting](#rate-limiting)
- [Selling in person (Tap to Pay)](#selling-in-person-tap-to-pay)
- [More than one way to pay](#more-than-one-way-to-pay)

---

## Sales tax

Selling on your own site (unlike a marketplace such as Amazon or eBay), **you**
collect and file sales tax where you're registered. Check with your state's
department of revenue or an accountant what applies to you.

**Stripe Tax** works it out by the shopper's address:

1. Stripe → **Tax**: add your origin address and the registrations you hold.
2. On the session:

   ```js
   automatic_tax: { enabled: true },
   line_items: [{ price_data: { …, tax_behavior: "exclusive" } }],      // tax added on top
   shipping_options: [{ shipping_rate_data: { …, tax_behavior: "exclusive" } }],
   ```
   Use `"inclusive"` instead if your prices already include tax.
3. The tax charged comes back as `session.total_details.amount_tax`. Save it on
   the order (your tax reports need it).

If you take some payments **outside** Stripe's page (PayPal, crypto, in
person…) but still want Stripe Tax's numbers, ask for them directly:

```js
const calc = await stripe.tax.calculations.create({
  currency: "usd",
  line_items: lines.map((l, n) => ({ amount: l.amountCents, quantity: l.qty, reference: `line-${n}`, tax_behavior: "exclusive" })),
  shipping_cost: { amount: shippingCents, tax_behavior: "exclusive" },
  customer_details: { address: { line1, city, state, postal_code, country }, address_source: "shipping" },
});
// calc.tax_amount_exclusive, calc.id
```

Things to know:

- Don't add a "card fee" or surcharge on top: card networks forbid it on debit
  cards (and the hosted page can't tell debit from credit), and some states
  restrict it. Build the fee into your prices.
- Some states don't let you advertise that you'll "pay the sales tax for" the
  buyer. Again: adjust prices instead.

## Shoppers abroad

**Adaptive Pricing** shows shoppers abroad the price in their own currency
(Stripe converts; you're still paid in yours):

```js
adaptive_pricing: { enabled: true },
```

Turn on local payment methods in **Settings → Payment methods**. Example: UPI
for shoppers in India can be accepted by US businesses, but only in rupees,
which Adaptive Pricing provides.

- Testing as a shopper from another country: in test mode, set
  `customer_email: "test+location_IN@example.com"` (any two-letter country
  code) and Stripe's page behaves as if the shopper is there.
- The shopper's currency comes back in `session.presentment_details`
  (`presentment_currency`, `presentment_amount`). Your own totals stay in your
  currency.
- Check whether a method is actually available on the account (turned on *and*
  approved by Stripe) with `stripe.paymentMethodConfigurations.list()`: the
  default configuration has e.g. `upi.available` and
  `upi.display_preference.value`.
- Tell international shoppers about import duty on the address step:

  ```js
  custom_text: { shipping_address: { message: "Any import duty is paid on delivery." } },
  ```

## Shipping rates

Price shipping yourself, by country, before checkout (so the cart page can show
it), then hand Stripe one fixed rate and allow only that country:

```js
shipping_address_collection: { allowed_countries: [country] },
shipping_options: [{
  shipping_rate_data: {
    type: "fixed_amount",
    display_name: "Standard",
    fixed_amount: { amount: shippingCents, currency: "usd" },
    delivery_estimate: { minimum: { unit: "business_day", value: 3 }, maximum: { unit: "business_day", value: 7 } },
  },
}],
```

Common rules, all simple to compute server-side: a flat rate per country, free
over a threshold, a different price for one item vs. two or more. You can also
pass several `shipping_options` (e.g. Standard and Express) and let the shopper
choose on Stripe's page; the chosen one is `session.shipping_cost`.

## Branding

Easiest: Stripe → **Settings → Branding** (logo, icon, colors, fonts). Applies
to every session, no code.

Per session (useful if one Stripe account serves several sites),
`branding_settings` (in use in production with API `2026-08-26.dahlia`):

```js
branding_settings: {
  display_name: "My Shop",
  background_color: "#ffffff",
  button_color: "#111111",
  border_style: "pill",
  icon: { type: "url", url: "https://example.com/icon.png" },
  logo: { type: "url", url: "https://example.com/logo.png" },
},
```

Images must be `https`. If Stripe can't load them it rejects the whole session,
so retry once without `branding_settings` (with a different idempotency key)
rather than showing no checkout:

```js
try {
  session = await stripe.checkout.sessions.create({ ...params, branding_settings }, { idempotencyKey: `checkout-${id}` });
} catch (e) {
  if (!/branding_settings/.test(`${e?.param ?? ""} ${e?.message ?? ""}`)) throw e;
  session = await stripe.checkout.sessions.create(params, { idempotencyKey: `checkout-${id}-plain` });
}
```

Product images on the page: `price_data.product_data.images: ["https://…"]`
(public https URLs).

### Checkout Studio settings

If you set up the page in Stripe's **Checkout Studio**, it gives you fields
that tie each session to those settings. The production shop this guide comes
from sends these (alongside the fields in the examples):

```js
ui_mode: "hosted_page",
origin_context: "web",
integration_identifier: "hosted_web_0002", // the identifier Studio shows for your integration
billing_address_collection: "auto",
submit_type: "auto",
allow_promotion_codes: false,
```

They're optional: without them you get the default hosted page, which is what
the examples use. Copy the exact values Studio shows for your own account.

## Extra fields and notes

Up to three custom fields, e.g. a gift note:

```js
custom_fields: [{
  key: "giftnote",
  label: { type: "custom", custom: "Gift note (optional)" },
  type: "text",
  optional: true,
  text: { maximum_length: 255 },
}],
```

Read it back: `session.custom_fields.find((f) => f.key === "giftnote")?.text?.value`.

Other useful session options:

- `phone_number_collection: { enabled: true }`: carriers (and customs abroad)
  want a phone number.
- `billing_address_collection: "auto"`: only when the payment method needs it.
- `allow_promotion_codes: true`: shoppers can enter codes you create in Stripe
  → Products → Coupons. (Or apply your own: `discounts: [{ coupon: "…" }]`.)
- `submit_type: "pay"` / `"auto"`: the button's wording.
- `consent_collection: { terms_of_service: "required" }` with your terms URL
  set in Stripe's settings.

## Refunds

From your own admin:

```js
const refund = await stripe.refunds.create(
  { payment_intent: order.stripe_payment_intent, amount: cents, reason: "requested_by_customer", metadata: { order_id, refund_id } },
  { idempotencyKey: `refund-${refundId}` },
);
// refund.status: "succeeded" | "pending" | "failed" | "canceled" | "requires_action"
```

- Save a `refunds` row (status `pending`) **before** calling Stripe, inside a
  transaction that checks the amount left, so a double click can't refund twice.
- Omit `amount` for a full refund. Card refunds take 5–10 days to reach the
  shopper.
- If the answer is lost: list `stripe.refunds.list({ payment_intent })`, look for
  your `metadata.refund_id`, and only re-send if it isn't there.
- Refunds made in Stripe's dashboard arrive as `charge.refunded`:
  `charge.amount_refunded` is the running total. Use the larger of that and your
  own refunds as the order's refunded amount.
- `refund.updated` / `refund.failed`: a refund that later fails (closed card
  account) comes back to your balance: flag the order and refund another way.
- Putting items back in stock is a separate choice (only on a full refund, and
  only once per refund).

## Disputes

`charge.dispute.created` means the shopper disputed the charge with their bank.
Flag the order, email yourself, and respond in Stripe → **Disputes** before the
deadline (with tracking, photos, messages). Stripe charges a dispute fee
whatever the outcome.

## Receipts and order emails

Two options, or both:

- **Stripe's receipts**: Stripe → Settings → **Customer emails** → Successful
  payments (and Refunds). Live mode only; no code.
- **Your own**: send from the "after payment" step (once per order), from an
  email service (Resend, Postmark, SES) or your own mailbox over SMTP with an
  app password. Queue them in a table so a failed send can be retried and is
  never sent twice.

Only tell the shopper "your receipt is on its way" when one of these is
actually set up. Also send yourself a "new order" email with a link to the
order.

## A private test mode on the live site

To try checkout on the real site before anyone else can:

- A setting with three states: **off** (no checkout shown), **test** (only
  testers, with the test key), **live** (everyone, with the live key).
- A "tester link" such as `/api/tester?key=<random>`, which sets a cookie. The
  server compares the cookie's SHA-256 with the stored hash; only matching
  browsers see the test checkout. Making a new link retires the old one.
- Keep test and live keys and webhook secrets side by side
  (`stripe_test_key`, `stripe_live_key`…) and pick by the order's `mode`. Have
  a separate webhook URL per mode (`/webhooks/stripe/test`, `/webhooks/stripe/live`)
  and check `event.livemode` matches.
- Test orders must never lower real stock or sync to other channels: record
  what *would* have happened instead.
- Show a banner in test mode with the test card number.
- Refuse to switch to live until the live key and webhook are connected (and
  `account.charges_enabled` is true).

## Connecting Stripe from an admin screen

Instead of env vars, a site can have a "paste your Stripe key" box:

1. Check the key's format (`sk_test_`/`sk_live_`) and that it matches the mode.
2. `stripe.accounts.retrieve()`: proves the key works; gives `charges_enabled`,
   `details_submitted`, the business name and country.
3. Create the webhook endpoint for this site
   (`stripe.webhookEndpoints.create({ url, enabled_events, api_version: Stripe.API_VERSION })`),
   first deleting any existing endpoint with the same URL so events aren't sent
   twice. Save the returned `secret`: Stripe only shows it once.
4. Store the key and webhook secret **encrypted** (e.g. AES-256-GCM with a key
   file that isn't in the database or its backups). Show only the last 4
   characters in the admin.
5. A "Check again" button re-reads the account (after the owner activates
   payments, or turns on a payment method) and re-applies the event list
   (`stripe.webhookEndpoints.update(id, { enabled_events })`) so endpoints made
   before you added an event get it too.
6. "Disconnect" deletes the webhook endpoint and the stored secrets.

See [`examples/express/scripts/create-webhook.js`](../examples/express/scripts/create-webhook.js)
for steps 2–3.

## Rate limiting

Checkout and order-lookup endpoints create Stripe objects and hit your
database: limit them per IP (e.g. 10 checkouts a minute) plus an overall
ceiling. If your front end calls a separate backend server-to-server, forward
the shopper's IP in a header (from `x-real-ip` / the first `x-forwarded-for`
hop) so the limit is per shopper, not per front-end server. Webhooks get a
generous limit of their own (a few hundred a minute).

## Selling in person (Tap to Pay)

Stripe's own Dashboard app on an iPhone/Android can take contactless payments
(Tap to Pay), but only for an amount. To tie such a sale to your products:

1. In your admin, pick the items; it shows the total (with your local sales tax
   rate added) and saves an open "in person" order.
2. Charge exactly that amount in Stripe's app.
3. Listen for `payment_intent.succeeded` (and, while a sale is open, poll
   `stripe.paymentIntents.list({ created: { gte: … } })` every few seconds).
   A payment intent **without** your `metadata.order_id` and with
   `payment_method_details.type === "card_present"` is an in-person tap: match
   it to the open sale with the same amount. If two open sales share the amount,
   ask which.
4. Then the usual: paid, stock lowered, receipt emailed.

## More than one way to pay

If you might add PayPal, crypto or bank transfer later, keep a `provider`
column on orders and route by it (`provider === "stripe" ? … : …`) for: starting
the payment, catching up on the success page, refunds, and webhooks (one route
per provider, each with its own signature check). Everything after "paid"
(stock, emails, shipping labels) stays shared. For methods that don't use
Stripe's page, collect the shipping address on your own checkout page first.
