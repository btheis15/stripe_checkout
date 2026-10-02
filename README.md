# stripe_checkout

A reusable recipe for adding **Stripe Checkout** (cards, Apple Pay, Google Pay,
Link, and any other method you switch on in Stripe) to a website, so shoppers
can pay on your own site.

It uses Stripe's **hosted** payment page: your server prices the cart, Stripe
shows the payment form, and Stripe tells your server when the money has
arrived. Card numbers never touch your site, which keeps you at the simplest
PCI level (SAQ A).

Everything here is taken from a Stripe checkout that is running in production
on a live shop (stripe-node 22, API version `2026-08-26.dahlia`), with the
site-specific parts removed. The flow, the session settings and the webhook
handling are the ones that site uses.

```
 browser ── cart (ids + quantities only) ──▶ your server
                                             · re-reads every price and stock count
                                             · saves the order as "awaiting payment"
                                             · creates a Stripe Checkout Session
 browser ◀── session.url ───────────────────┘
 browser ── pays on Stripe's page ─────────▶ Stripe
 Stripe ── signed webhook ─────────────────▶ your server: order "paid",
                                             stock lowered, emails sent
 browser ── back to /success?order=<token> ▶ your server reads the order back
                                             (and asks Stripe directly if the
                                             webhook hasn't arrived yet)
```

## What's in here

| Path | What it is |
|------|------------|
| [`docs/SETUP.md`](docs/SETUP.md) | Step by step: Stripe account, keys, webhook, testing, going live |
| [`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md) | The order flow and the rules that keep it safe (read once before building) |
| [`docs/EXTRAS.md`](docs/EXTRAS.md) | Optional pieces: sales tax, other currencies, branding, refunds, disputes, receipts, test/live switch, in-person sales |
| [`docs/schema.sql`](docs/schema.sql) | The tables you need (orders, items, webhook events, refunds) |
| [`examples/express/`](examples/express) | A complete, runnable Node + Express shop (SQLite, plain HTML front end). Start here to try it end to end. |
| [`examples/nextjs/`](examples/nextjs) | The same pieces as Next.js App Router route handlers and pages, to drop into a Next site |

## Quick start (about 15 minutes)

1. Make a free account at [stripe.com](https://stripe.com). Stay in **test mode**
   (no business details needed yet).
2. Copy the **Secret key** (`sk_test_…`) from **Developers → API keys**.
3. Run the example:

   ```bash
   cd examples/express
   cp .env.example .env          # paste STRIPE_SECRET_KEY
   npm install
   npm run dev                   # http://localhost:4242
   ```
4. In a second terminal, forward Stripe's webhooks to it with the
   [Stripe CLI](https://docs.stripe.com/stripe-cli):

   ```bash
   stripe login
   stripe listen --forward-to localhost:4242/webhooks/stripe
   ```
   Paste the `whsec_…` it prints into `.env` as `STRIPE_WEBHOOK_SECRET` and
   restart the server.
5. Add something to the cart, check out, and pay with the test card
   **4242 4242 4242 4242** (any future date, any CVC, any ZIP). The success
   page shows the order as paid.

To add it to a real site, follow [`docs/SETUP.md`](docs/SETUP.md) and copy the
pieces from whichever example matches your stack.

## The checklist for a new site

- [ ] Server-side product lookup: price and stock come from **your database**, never from the browser
- [ ] `orders` + `order_items` + `webhook_events` tables ([`docs/schema.sql`](docs/schema.sql))
- [ ] `POST /api/checkout`: price the cart, save the order, create the Checkout Session, return `session.url`
- [ ] `POST /webhooks/stripe`: **raw body**, verify the signature, record each event id once, mark the order paid
- [ ] Success page: `/success?order=<random token>` reads the order (and asks Stripe if it's still awaiting)
- [ ] Cancel URL back to the cart (nothing was charged)
- [ ] After payment, once per order: lower stock, email the customer and yourself
- [ ] Test: card `4242…`, a declined card `4000 0000 0000 0002`, a 3-D Secure card `4000 0027 6000 3184`
- [ ] Go live: activate the Stripe account, live key, **live webhook endpoint** (its own `whsec_`), sales tax decided, policies pages up

## Environment variables

| Name | Where it comes from |
|------|---------------------|
| `STRIPE_SECRET_KEY` | Stripe → Developers → API keys → Secret key (`sk_test_…` / `sk_live_…`). Server only. |
| `STRIPE_WEBHOOK_SECRET` | `stripe listen` (local) or the webhook endpoint's **Signing secret** (`whsec_…`). One per endpoint, and different in test and live. |
| `SITE_URL` | Your site's public address, for the success and cancel links (e.g. `https://example.com`). |

The publishable key (`pk_…`) is **not needed**: with the hosted page the browser
just follows a link to Stripe. Never put the secret key in front-end code or in
a `NEXT_PUBLIC_…` variable.
