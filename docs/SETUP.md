# Setting it up, step by step

## 1. Stripe account (test mode)

1. Sign up at [stripe.com](https://stripe.com). Test mode needs no business
   details, bank account or ID.
2. Make sure **Test mode** is on (toggle in the dashboard).
3. **Developers → API keys** → copy the **Secret key** (`sk_test_…`).
   - Optional, safer: create a **restricted key** (`rk_test_…`) with write access
     to Checkout Sessions, Payment Intents, Refunds and Webhook Endpoints, and
     read access to everything else you use (Tax, Accounts). It works anywhere
     the secret key does.
4. Put it in your server's environment as `STRIPE_SECRET_KEY`. It must stay on
   the server: never in the browser, a public env var, or git.

Tip: tell test and live keys apart in code so a test key can never be used where
a live one is expected:

```js
const keyMode = (key) =>
  /^(sk|rk)_test_\w{10,}$/.test(key) ? "test" : /^(sk|rk)_live_\w{10,}$/.test(key) ? "live" : null;
```

## 2. Install the library

```bash
npm install stripe
```

```js
import Stripe from "stripe";

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  maxNetworkRetries: 2, // safe because every write sends an idempotency key
  timeout: 20_000,
  appInfo: { name: "my-shop" },
});
```

The library pins the API version it was built for (`Stripe.API_VERSION`), so
upgrading the package is how you move to a newer API. Read Stripe's changelog
when you do.

## 3. Your database

You need somewhere to keep orders **before** they're paid, so the webhook has
something to mark paid. [`schema.sql`](schema.sql) has the tables:

- `orders`: one row per checkout attempt, with a random public `token` for the
  success page and the Stripe Checkout Session id.
- `order_items`: what was bought, at the price you charged.
- `webhook_events`: Stripe event ids already handled (Stripe delivers *at least*
  once, so the same event can arrive twice).
- `refunds`: optional, if you refund from your own admin.

Any database works (SQLite, Postgres, Supabase, MySQL…).

## 4. The checkout endpoint

`POST /api/checkout` receives `{ lines: [{ productId, qty }], country }` and:

1. Looks up each product **in your database**: price, whether it's for sale,
   stock. Rejects bad quantities, unknown products, sold-out items.
2. Works out shipping for the country (your own table of rates).
3. Saves the order as `awaiting` with a random `token`.
4. Creates the Checkout Session with `price_data` built from **your** prices,
   `metadata.order_id`, `success_url` = `/success?order=<token>`, and an
   `idempotencyKey` of `checkout-<orderId>`.
5. Saves `session.id` on the order and returns `{ url: session.url }`.

The browser then does `window.location.href = url`.

See `createCheckout` in
[`examples/express/src/checkout.js`](../examples/express/src/checkout.js) or
[`examples/nextjs/app/api/checkout/route.ts`](../examples/nextjs/app/api/checkout/route.ts).

## 5. The webhook

### Locally

```bash
stripe listen --forward-to localhost:4242/webhooks/stripe
```

It prints a `whsec_…` secret: that's `STRIPE_WEBHOOK_SECRET` while developing.
`stripe trigger checkout.session.completed` sends a sample event (it won't match
one of your orders, which is fine: unknown sessions are ignored).

### On a deployed site

Stripe → **Developers → Webhooks → Add endpoint**:

- URL: `https://your-site.com/webhooks/stripe` (or `/api/stripe/webhook` in Next.js)
- Events:
  - `checkout.session.completed`
  - `checkout.session.async_payment_succeeded`
  - `checkout.session.async_payment_failed`
  - `checkout.session.expired`
  - `charge.refunded`
  - `charge.dispute.created`
  - `refund.updated`
  - `refund.failed`
- Copy the endpoint's **Signing secret** (`whsec_…`) into `STRIPE_WEBHOOK_SECRET`.

Or create it from code (the secret is returned only once, so store it):
[`examples/express/scripts/create-webhook.js`](../examples/express/scripts/create-webhook.js).

### What the handler must do

1. Read the **raw** request body (not parsed JSON: the signature is over the
   exact bytes). Express: `express.raw({ type: "*/*" })` on that route, before
   any `express.json()`. Next.js: `await request.text()`.
2. `stripe.webhooks.constructEvent(rawBody, req.headers["stripe-signature"], secret)`.
   If it throws, answer 400 and stop.
3. Check `event.livemode` matches the key you're running with.
4. Insert `event.id` into `webhook_events`. If it was already there, answer 200
   and stop (a duplicate).
5. Handle it (below). If handling throws, delete the event row and answer 500,
   so Stripe retries later.
6. Answer 200 quickly. Do slow things (emails, stock sync) after answering, or
   in a background job.

On `checkout.session.completed` / `async_payment_succeeded` with
`payment_status === "paid"`: find the order by `session.id` (or
`session.metadata.order_id`), and **only if it's still awaiting** mark it paid
and copy over what Stripe collected (email, name, phone, shipping address, tax,
total). Then, once, lower stock and send emails.

## 6. The success page

`/success?order=<token>` asks your server for the order by token:

- `paid`: thank-you message, clear the cart.
- still `awaiting`: the webhook may simply be a few seconds behind. Your server
  calls `stripe.checkout.sessions.retrieve(order.stripe_session_id)`; if it's
  `complete` and `paid`, apply exactly the same "mark paid" code the webhook
  uses. The page re-checks every few seconds for a minute or two.
- `expired` / `failed`: "Nothing was charged", link back to the cart.

Never trust the fact that the shopper landed on the success URL: anyone can
type it. Only the order's status (set from Stripe) counts.

## 7. Test it

| Card | What happens |
|------|--------------|
| `4242 4242 4242 4242` | Pays |
| `4000 0027 6000 3184` | Asks for 3-D Secure authentication |
| `4000 0000 0000 0002` | Declined |
| `4000 0000 0000 9995` | Declined: insufficient funds |

Any future expiry, any CVC, any postal code. Also try:

- Cancel on Stripe's page → back to your cart, order stays `awaiting` until the
  session expires (`checkout.session.expired`).
- Stop the webhook forwarder, pay, then open the success page: it should still
  show "paid" (the catch-up call).
- Send the same webhook twice (`stripe events resend evt_…`): stock should only
  drop once.

## 8. Going live

1. In Stripe, **Activate payments**: legal name, SSN or EIN, date of birth,
   address, bank account for payouts. This is Stripe's identity check on *you*;
   shoppers aren't checked.
2. Switch the dashboard to live, copy the live secret key (`sk_live_…`).
3. Create the **live** webhook endpoint (test endpoints don't receive live
   events) and copy its own signing secret.
4. Set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` to the live values in
   production (keep the test ones for staging/preview deploys).
5. Payment methods: **Settings → Payment methods** decides what shoppers see
   (cards, Apple Pay, Google Pay, Link, Klarna, Affirm, Cash App Pay…). No code
   change needed. For Apple Pay on the hosted page, no domain verification is
   needed (it's Stripe's domain).
6. Sales tax: decide before launch ([`EXTRAS.md`](EXTRAS.md#sales-tax)).
7. Receipts: either Stripe's (**Settings → Customer emails → Successful
   payments**) or your own.
8. Have returns, shipping, privacy and contact pages up: Stripe and card
   networks expect them.
9. Make one small real purchase and refund it.
