# Express version (complete and runnable)

A tiny shop that does the whole flow: product list, cart, Stripe's hosted
payment page, signed webhooks, success page, stock, refunds. Node 22.13+
(uses the built-in `node:sqlite`, so there's nothing native to compile).

```
server.js                 routes (the webhook is registered before express.json(): it needs the raw body)
src/stripe.js             Stripe client, webhook event list, signature check, how-paid helper
src/checkout.js           everything else: price the cart, create the session, mark paid,
                          after-payment (stock, emails), success summary, webhook events, refunds
src/db.js                 SQLite tables (same as docs/schema.sql) + sample products
public/index.html         sample shop page + cart (localStorage)
public/success.html       thank-you page (polls while the payment confirms)
scripts/create-webhook.js creates the webhook endpoint for a deployed site and prints its secret
```

## Run it

```bash
cp .env.example .env      # STRIPE_SECRET_KEY=sk_test_…
npm install
npm run dev               # http://localhost:4242

# second terminal
stripe listen --forward-to localhost:4242/webhooks/stripe
# copy the whsec_… into .env as STRIPE_WEBHOOK_SECRET, then restart npm run dev
```

Pay with `4242 4242 4242 4242`. The server log shows the order being paid and
where your receipt email would go.

Refund (set `ADMIN_TOKEN` in `.env` first; the order id is in the log or `shop.db`):

```bash
curl -X POST localhost:4242/admin/orders/<order-id>/refund \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"amountCents": 500}'      # omit the body for a full refund
```

## Deploying

- Any Node host (Render, Fly.io, Railway, a VPS). SQLite needs a persistent
  disk; otherwise move `src/db.js` to Postgres (the queries are plain SQL).
- Set `SITE_URL` to the public address, then
  `npm run create-webhook -- https://your-site.com/webhooks/stripe` and put the
  printed secret in `STRIPE_WEBHOOK_SECRET`.
- `app.set("trust proxy", 1)` assumes one proxy in front (so rate limits see
  the shopper's IP). Adjust for your host.

## Making it yours

- Replace the sample `products` table with your catalog (`priceCart()` is the
  only place that reads it) and the stock update in `afterPayment()`.
- Edit `SHOP_NAME`, `CURRENCY` and `SHIPPING` at the top of `src/checkout.js`.
- Plug your email service into `afterPayment()`.
- Turn on Stripe Tax with `STRIPE_TAX=true` once it's set up in Stripe.
