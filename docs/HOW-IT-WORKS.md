# How it works, and the rules that keep it safe

## The order's life

```
            POST /api/checkout                    webhook / catch-up
  (cart) ─────────────────────▶ awaiting ─────────────────────────▶ paid ──▶ partly_refunded ──▶ refunded
                                   │  ╲
              session expired ─────┘   ╲─── async payment failed
                    ▼                          ▼
                 expired                     failed
```

| Status | Meaning |
|--------|---------|
| `awaiting` | Order saved, shopper sent to Stripe, no money yet |
| `paid` | Stripe confirmed the payment |
| `expired` | The Checkout Session closed unpaid (shopper left, or you expired it) |
| `failed` | A delayed payment method (bank debit, some wallets) didn't go through |
| `partly_refunded` / `refunded` | Money sent back |

Keep a separate flag (or column) for "after-payment work done" (stock lowered,
emails sent), so it runs exactly once and can be retried if it fails halfway.

## The rules

### 1. The browser only sends ids and quantities

Everything about money is worked out on the server from your database: unit
price, sale price, shipping, tax, currency. A cart that says
`{ price: 0.01 }` must make no difference. Build `line_items` with
`price_data` from your own numbers (no need to create Products/Prices in
Stripe's dashboard).

### 2. Save the order before sending the shopper to Stripe

The webhook needs an order to mark paid, and you want a record of abandoned
checkouts. Put your order id in `metadata.order_id` and `client_reference_id`,
and on `payment_intent_data.metadata` too, so it shows on the payment in
Stripe's dashboard.

### 3. Only Stripe can say an order is paid

The order becomes `paid` from exactly two places, both reading Stripe's own data:

- the **signed** webhook (`checkout.session.completed` /
  `checkout.session.async_payment_succeeded`, with `payment_status: "paid"`), and
- the success page's catch-up, which **retrieves the session from Stripe**
  with your secret key.

Never from the success URL alone, a query parameter, or anything the browser
sends.

### 4. Verify every webhook, on the raw body

`stripe.webhooks.constructEvent(rawBody, signatureHeader, endpointSecret)`
checks the signature and rejects events older than 5 minutes (replays). A
body that was parsed and re-serialized won't verify, so the webhook route must
get the raw bytes. Also check `event.livemode` against the mode you're running
in, so a test event can never touch a live order.

### 5. Handle each event once, and each order once

Stripe delivers at least once, sometimes out of order, and the webhook and the
catch-up can race each other. So:

- Record `event.id` (unique). A repeat is answered 200 and skipped.
- "Mark paid" is a conditional update:
  `UPDATE orders SET status='paid' … WHERE id=? AND status IN ('awaiting','expired','failed')`.
  Only the call that changed a row goes on to lower stock and send emails.
- If handling an event throws, delete its row and return 500 so Stripe retries.

### 6. Check what was actually paid

When marking paid, compare Stripe's numbers with the order:
`session.currency`, `session.amount_subtotal`,
`session.total_details.amount_shipping`, and the shipping address's country.
If anything differs, still record the payment (the money is real) but flag
the order for a human look before shipping.

A payment that arrives after the session was marked `expired` (it can happen
at the edge) is also flagged: check stock before shipping.

### 7. Idempotency keys on every write

Pass `{ idempotencyKey }` on every create call that moves money:
`checkout-<orderId>` for sessions, `refund-<refundId>` for refunds. Then the
library's automatic retries, a double click, or your own retry can never
create two of them.

If a call's answer is lost (timeout, `StripeConnectionError`,
`StripeAPIError`), Stripe may or may not have done it. Mark it "uncertain",
and before trying again **ask Stripe** (e.g. list refunds for the payment
intent and look for your `metadata.refund_id`). Re-sending with the same
idempotency key within 24 hours is also safe.

### 8. Sessions expire, and stock is only taken when paid

Set `expires_at` (between 30 minutes and 24 hours from now; 60 minutes is a
good default). Stock is lowered when an order is **paid**, not when checkout
starts, so abandoned carts don't hold anything. The price of that: two people
can pay for the last one at the same moment. Lower stock in a transaction; if
there wasn't enough, flag the order (refund or contact the customer). When
something sells out, you can close other open sessions for it with
`stripe.checkout.sessions.expire(id)`.

### 9. The success page is found by a random token, not the order id

`success_url: ${SITE_URL}/success?order=<token>` with an unguessable token
(e.g. 18 random bytes, base64url). The page shows only what the shopper needs
(items, totals, a masked email), never the full address. Rate-limit the lookup.

### 10. Secrets stay on the server

Secret key and webhook secret in server environment variables (or encrypted in
your database), never in the browser, a public env var, logs, or git. The
hosted page needs no publishable key at all.

## What Stripe collects for you

With the settings in the examples, Stripe's page asks for and returns:

- email, name, phone (`phone_number_collection`)
- shipping address, limited to the countries you allow
  (`shipping_address_collection.allowed_countries`)
- billing address only when the card needs it (`billing_address_collection: "auto"`)
- optional custom fields (e.g. a gift note), up to 3

They arrive on the completed session: `session.customer_details`,
`session.collected_information.shipping_details` (older API versions:
`session.shipping_details`), `session.custom_fields`,
`session.total_details.amount_tax`, `session.amount_total`.

## How the shopper paid

The session has a `payment_intent` id. Retrieve it with
`expand: ["latest_charge"]` and read
`latest_charge.payment_method_details`: `type` is `card`, `upi`, `link`,
`klarna`…; for cards, `card.wallet.type` is `apple_pay` / `google_pay` when a
wallet was used, plus `card.brand` and `card.last4`. Useful for the order page
and receipts. See `paidWith()` in
[`examples/express/src/stripe.js`](../examples/express/src/stripe.js).
