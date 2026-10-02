# Next.js (App Router) version

The same checkout as the Express example, as files to drop into a Next.js
site (written against Next 16; `searchParams` is a Promise, `after()` runs
work once the response is sent).

```
lib/stripe.ts                      Stripe client, webhook event list, how-paid helper
lib/db.ts                          Postgres connection (Supabase, Neon, Vercel Postgres…)
lib/checkout.ts                    price the cart, create the session, mark paid, after-payment, success summary, webhook events
app/api/checkout/route.ts          POST { lines, country } → { url }
app/api/stripe/webhook/route.ts    Stripe's signed events (raw body, once per event id)
app/checkout/success/page.tsx      the thank-you page (asks Stripe if the webhook is late)
app/checkout/success/AfterPayment.tsx   clears the cart, refreshes while confirming
components/CheckoutButton.tsx      the "Continue to secure payment" button
.env.example
```

## Steps

1. `npm install stripe postgres server-only`
2. Create the tables: [`../../docs/schema.sql`](../../docs/schema.sql) runs on
   Postgres as is, plus a `products` table (see the comment in `lib/db.ts`), or
   change `priceCart()` in `lib/checkout.ts` to read your existing catalog.
3. Copy the files in (they import with `@/…`, the default Next alias for the
   project root; adjust if yours points at `src/`).
4. Set the env vars from `.env.example` locally (`.env.local`) and in Vercel →
   Settings → Environment Variables. Use the test key and a test webhook secret
   for Preview, the live ones for Production.
5. Edit the settings at the top of `lib/checkout.ts`: shop name, currency,
   shipping table.
6. Put `<CheckoutButton lines={…} country={…} />` on your cart page. `lines` is
   `[{ productId, qty }]` from your cart store; the success page clears
   `localStorage["cart"]`, so change that to your store's clear function.
7. Webhook:
   - local: `stripe listen --forward-to localhost:3000/api/stripe/webhook`
   - deployed: Stripe → Developers → Webhooks → `https://your-site.com/api/stripe/webhook`
     with the events listed in `lib/stripe.ts`.
8. Test with `4242 4242 4242 4242`.

Refunds from your own admin: see `refund()` / `checkRefund()` in
[`../express/src/checkout.js`](../express/src/checkout.js) and
[`../../docs/EXTRAS.md#refunds`](../../docs/EXTRAS.md#refunds); the same code
works here with `sql` queries. Refunds made in Stripe's dashboard are already
picked up by the `charge.refunded` event.

## Notes for Vercel

- Route handlers run on the Node.js runtime by default, which the `stripe`
  library needs. Don't set `runtime = "edge"` on the webhook.
- Rate-limit `/api/checkout` (Vercel Firewall rules, or a small Upstash/Redis
  limiter): each call creates a Stripe session.
- If the site's catalog lives on a separate backend, keep all of
  `lib/checkout.ts` on that backend and have `/api/checkout` forward the cart
  to it server-to-server with a shared token (plus the shopper's IP from
  `x-real-ip` for per-shopper rate limits). The website then holds no Stripe
  keys at all.
