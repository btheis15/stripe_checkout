/**
 * The whole checkout:
 *
 *   createCheckout   cart → priced on the server → order saved (awaiting) → Stripe Checkout Session
 *   handleWebhook    Stripe's signed events → order paid / expired / failed / refunded / disputed
 *   orderSummary     the success page (asks Stripe directly if the webhook hasn't arrived yet)
 *   refund           refunds from your own admin
 *
 * Money is always in whole cents. Nothing about prices is ever read from the browser.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { db, transaction } from "./db.js";
import { lostResponse, MODE, paidWith, stripe, stripeMessage, verifyEvent } from "./stripe.js";

export class ShopError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// --- Your shop's settings ------------------------------------------------------------

const SHOP_NAME = "Example Shop";
const CURRENCY = "usd";
const CHECKOUT_MINUTES = 60; // Stripe allows 30 minutes to 24 hours
const MAX_QTY = 10;
const TAX = process.env.STRIPE_TAX === "true"; // Stripe Tax (set up in Stripe → Tax first)

/** Shipping by country: a flat rate, optionally free over an amount. */
export const SHIPPING = {
  US: { label: "Standard shipping", cents: 600, freeOverCents: 7500, minDays: 3, maxDays: 7 },
  CA: { label: "International shipping", cents: 1800, freeOverCents: null, minDays: 7, maxDays: 14 },
  GB: { label: "International shipping", cents: 2000, freeOverCents: null, minDays: 7, maxDays: 14 },
};

const siteUrl = () => (process.env.SITE_URL ?? "http://localhost:4242").replace(/\/$/, "");
const now = () => new Date().toISOString();
const usd = (cents) => `$${(cents / 100).toFixed(2)}`;
const getOrder = (id) => db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
const itemsOf = (id) => db.prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY position").all(id);

function addProblem(id, text) {
  const o = getOrder(id);
  const list = JSON.parse(o.problems);
  if (!list.includes(text)) db.prepare("UPDATE orders SET problems = ? WHERE id = ?").run(JSON.stringify([...list, text]), id);
  console.warn(`[order ${id}] needs a look: ${text}`);
}

// --- Starting a checkout -------------------------------------------------------------

/** The cart, priced from the database. Throws a shopper-friendly error for anything off. */
export function priceCart(lines) {
  if (!Array.isArray(lines) || !lines.length) throw new ShopError("Your cart is empty.");
  if (lines.length > 50) throw new ShopError("That's a lot of items: please split it into two orders.");
  const merged = new Map();
  for (const l of lines) {
    const qty = Math.floor(Number(l?.qty));
    if (!(qty >= 1 && qty <= MAX_QTY)) throw new ShopError(`Choose between 1 and ${MAX_QTY} of each item.`);
    const id = String(l?.productId ?? "");
    merged.set(id, (merged.get(id) ?? 0) + qty);
  }
  return [...merged].map(([id, qty]) => {
    const p = db.prepare("SELECT * FROM products WHERE id = ? AND active = 1").get(id);
    if (!p) throw new ShopError("An item in your cart is no longer available.", 409);
    if (p.stock !== null && qty > p.stock) throw new ShopError(p.stock > 0 ? `Only ${p.stock} ${p.title} left.` : `${p.title} just sold out.`, 409);
    return { productId: p.id, title: p.title, description: p.description, image: p.image, qty, unitCents: p.price_cents };
  });
}

export function shippingFor(country, subtotalCents) {
  const rate = SHIPPING[country];
  if (!rate) return null;
  const free = rate.freeOverCents !== null && subtotalCents >= rate.freeOverCents;
  return { ...rate, charge: free ? 0 : rate.cents };
}

/** POST /api/checkout { lines: [{ productId, qty }], country } → { url } (Stripe's payment page). */
export async function createCheckout(input = {}) {
  if (!MODE) throw new ShopError("Checkout isn't set up yet.", 503);
  const items = priceCart(input.lines);
  const country = String(input.country ?? "US").toUpperCase().slice(0, 2);
  const subtotal = items.reduce((n, i) => n + i.unitCents * i.qty, 0);
  const rate = shippingFor(country, subtotal);
  if (!rate) throw new ShopError("We don't ship there yet.", 409);

  const id = randomUUID();
  const token = randomBytes(18).toString("base64url");
  const expiresMs = Date.now() + CHECKOUT_MINUTES * 60_000;
  transaction(() => {
    db.prepare(
      `INSERT INTO orders (id, token, mode, currency, country, subtotal_cents, shipping_cents, total_cents, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, token, MODE, CURRENCY, country, subtotal, rate.charge, subtotal + rate.charge, now(), new Date(expiresMs).toISOString());
    const add = db.prepare("INSERT INTO order_items (order_id, position, product_id, title, quantity, unit_cents) VALUES (?, ?, ?, ?, ?, ?)");
    items.forEach((i, n) => add.run(id, n, i.productId, i.title, i.qty, i.unitCents));
  });

  const taxBehavior = TAX ? { tax_behavior: "exclusive" } : {};
  const params = {
    mode: "payment",
    client_reference_id: id,
    metadata: { order_id: id },
    line_items: items.map((i) => ({
      quantity: i.qty,
      price_data: {
        currency: CURRENCY,
        unit_amount: i.unitCents,
        ...taxBehavior,
        product_data: {
          name: i.title,
          ...(i.description ? { description: i.description } : {}),
          ...(i.image ? { images: [i.image] } : {}),
          metadata: { product_id: i.productId },
        },
      },
    })),
    shipping_address_collection: { allowed_countries: [country] },
    shipping_options: [
      {
        shipping_rate_data: {
          type: "fixed_amount",
          display_name: rate.label,
          fixed_amount: { amount: rate.charge, currency: CURRENCY },
          delivery_estimate: { minimum: { unit: "business_day", value: rate.minDays }, maximum: { unit: "business_day", value: rate.maxDays } },
          ...taxBehavior,
        },
      },
    ],
    phone_number_collection: { enabled: true },
    billing_address_collection: "auto",
    custom_fields: [{ key: "note", label: { type: "custom", custom: "Note for your order (optional)" }, type: "text", optional: true, text: { maximum_length: 255 } }],
    // Shoppers abroad see (and can pay in) their own currency; you're still paid in yours.
    adaptive_pricing: { enabled: true },
    automatic_tax: { enabled: TAX },
    ...(country !== "US" ? { custom_text: { shipping_address: { message: "Any import duty is paid on delivery." } } } : {}),
    payment_intent_data: { description: `${SHOP_NAME} order`, metadata: { order_id: id } },
    success_url: `${siteUrl()}/success.html?order=${token}`,
    cancel_url: `${siteUrl()}/?cancelled=1`,
    expires_at: Math.floor(expiresMs / 1000),
  };

  let session;
  try {
    session = await stripe.checkout.sessions.create(params, { idempotencyKey: `checkout-${id}` });
  } catch (e) {
    db.prepare("UPDATE orders SET status = 'failed' WHERE id = ?").run(id);
    console.error(`[checkout] couldn't create the session for ${id}: ${stripeMessage(e)}`);
    throw new ShopError("Couldn't start the secure checkout. Please try again in a moment.", 502);
  }
  db.prepare("UPDATE orders SET stripe_session_id = ? WHERE id = ?").run(session.id, id);
  return { url: session.url };
}

// --- Marking an order paid (from the webhook, or the success page's catch-up) --------

const orderForSession = (session) =>
  db.prepare("SELECT * FROM orders WHERE stripe_session_id = ?").get(session.id) ??
  (session.metadata?.order_id ? db.prepare("SELECT * FROM orders WHERE id = ?").get(session.metadata.order_id) : undefined);

/** Records a paid session on its order. Safe to call any number of times: only the first one changes anything. */
export function applyPaid(order, session) {
  const ship = session.collected_information?.shipping_details ?? session.shipping_details ?? null;
  const cust = session.customer_details ?? {};
  const addr = ship?.address ?? cust.address ?? {};
  const changed = transaction(() => {
    const o = getOrder(order.id);
    if (!["awaiting", "expired", "failed"].includes(o.status)) return false;
    db.prepare(
      `UPDATE orders SET status = 'paid', paid_at = ?, stripe_session_id = ?, stripe_payment_intent = ?,
         customer_name = ?, customer_email = ?, customer_phone = ?, ship_to = ?, tax_cents = ?, total_cents = ?, note = ?
       WHERE id = ?`,
    ).run(
      now(),
      session.id,
      typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent?.id ?? null),
      cust.name ?? ship?.name ?? null,
      cust.email ?? null,
      cust.phone ?? null,
      JSON.stringify({ name: ship?.name ?? cust.name ?? null, line1: addr.line1 ?? null, line2: addr.line2 ?? null, city: addr.city ?? null, state: addr.state ?? null, postal_code: addr.postal_code ?? null, country: addr.country ?? o.country }),
      session.total_details?.amount_tax ?? 0,
      session.amount_total ?? o.total_cents,
      (session.custom_fields ?? []).find((f) => f.key === "note")?.text?.value?.slice(0, 255) || null,
      o.id,
    );
    // The money is real either way; anything unexpected is flagged for a look before shipping.
    if (o.status !== "awaiting") addProblem(o.id, "The payment arrived after the checkout had closed: check the stock.");
    if (session.currency !== o.currency || session.amount_subtotal !== o.subtotal_cents || (session.total_details?.amount_shipping ?? 0) !== o.shipping_cents)
      addProblem(o.id, `Stripe's amounts (${usd(session.amount_total)}) don't match the order: check it in Stripe.`);
    if (addr.country && addr.country !== o.country) addProblem(o.id, `The address is in ${addr.country}, but shipping was priced for ${o.country}.`);
    return true;
  });
  if (changed) setImmediate(() => afterPayment(order.id).catch((e) => console.error(`[order ${order.id}] after payment:`, e.message)));
  return changed;
}

/**
 * Once per paid order: how it was paid, stock, emails. Called again for any
 * order left unfinished (e.g. at startup), so a crash halfway can't lose it.
 */
export async function afterPayment(id) {
  let o = getOrder(id);
  if (!o || o.fulfilled || !["paid", "partly_refunded"].includes(o.status)) return;

  if (!o.payment_method && o.stripe_payment_intent) {
    try {
      const pi = await stripe.paymentIntents.retrieve(o.stripe_payment_intent, { expand: ["latest_charge"] });
      const { method } = paidWith(pi.latest_charge);
      if (method) db.prepare("UPDATE orders SET payment_method = ? WHERE id = ?").run(method, id);
    } catch {
      /* not essential: shown as unknown */
    }
  }

  const items = itemsOf(id);
  const claimed = transaction(() => {
    if (db.prepare("UPDATE orders SET fulfilled = 1 WHERE id = ? AND fulfilled = 0").run(id).changes === 0) return false;
    // Test orders never touch real stock.
    if (o.mode === "live") {
      for (const i of items) {
        const p = db.prepare("SELECT stock FROM products WHERE id = ?").get(i.product_id);
        if (!p || p.stock === null) continue;
        const ok = db.prepare("UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?").run(i.quantity, i.product_id, i.quantity).changes;
        if (!ok) {
          db.prepare("UPDATE products SET stock = 0 WHERE id = ?").run(i.product_id);
          addProblem(id, `Not enough ${i.title} in stock (someone bought the last one at the same time): refund or contact the customer.`);
        }
      }
    }
    return true;
  });
  if (!claimed) return;

  o = getOrder(id);
  // Plug in your email service here (Resend, Postmark, SES, SMTP…), ideally through a queue table.
  console.log(`[order ${id}] paid ${usd(o.total_cents)}${o.payment_method ? ` (${o.payment_method})` : ""}: email ${o.customer_email ?? "the customer"} a receipt, and yourself a "new order" email.`);
}

/** Orders paid but not finished (e.g. the server stopped halfway). Run at startup. */
export function resumeUnfinished() {
  for (const { id } of db.prepare("SELECT id FROM orders WHERE status IN ('paid', 'partly_refunded') AND fulfilled = 0").all())
    afterPayment(id).catch((e) => console.error(`[order ${id}] after payment:`, e.message));
}

// --- The success page ------------------------------------------------------------------

const askedAt = new Map(); // ask Stripe at most every few seconds per order, however often the page reloads

/** GET /api/orders/:token → what the success page shows. */
export async function orderSummary(token) {
  let o = db.prepare("SELECT * FROM orders WHERE token = ?").get(String(token ?? ""));
  if (!o) throw new ShopError("Order not found.", 404);

  // The webhook may be a few seconds behind (or lost): ask Stripe directly.
  if (["awaiting", "expired"].includes(o.status) && o.stripe_session_id && Date.now() - (askedAt.get(o.id) ?? 0) > 3000) {
    askedAt.set(o.id, Date.now());
    if (askedAt.size > 1000) askedAt.delete(askedAt.keys().next().value);
    try {
      const session = await stripe.checkout.sessions.retrieve(o.stripe_session_id);
      if (session.status === "complete" && session.payment_status === "paid") applyPaid(o, session);
    } catch {
      /* the webhook will bring it */
    }
    o = getOrder(o.id);
  }

  const email = o.customer_email ? o.customer_email.replace(/^(.)[^@]*(@.*)$/, "$1•••$2") : null;
  return {
    status: o.status === "partly_refunded" ? "paid" : o.status,
    test: o.mode === "test",
    email,
    items: itemsOf(o.id).map((i) => ({ title: i.title, quantity: i.quantity, unitCents: i.unit_cents })),
    subtotalCents: o.subtotal_cents,
    shippingCents: o.shipping_cents,
    taxCents: o.tax_cents,
    totalCents: o.total_cents,
  };
}

// --- Webhooks --------------------------------------------------------------------------

/** POST /webhooks/stripe with the raw body and the Stripe-Signature header. */
export async function handleWebhook(rawBody, signature) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new ShopError("Webhook secret not set", 500);
  let event;
  try {
    event = verifyEvent(rawBody, signature, secret);
  } catch {
    throw new ShopError("Bad signature", 400);
  }
  // A test event can never touch a live order (and the reverse).
  if (event.livemode !== (MODE === "live")) throw new ShopError("Wrong mode", 400);

  const first = db.prepare("INSERT INTO webhook_events (id, type, received_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(event.id, event.type, now()).changes;
  if (!first) return { duplicate: true };
  try {
    await onEvent(event);
    db.prepare("UPDATE webhook_events SET processed_at = ? WHERE id = ?").run(now(), event.id);
  } catch (e) {
    // Forget it, so Stripe's retry is handled.
    db.prepare("DELETE FROM webhook_events WHERE id = ?").run(event.id);
    throw e;
  }
  return { ok: true };
}

async function onEvent(event) {
  const obj = event.data.object;
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const o = orderForSession(obj);
      // "unpaid" here means a delayed method (e.g. a bank debit): async_payment_succeeded/failed follows.
      if (o && obj.payment_status === "paid") applyPaid(o, obj);
      return;
    }
    case "checkout.session.async_payment_failed": {
      const o = orderForSession(obj);
      if (o) db.prepare("UPDATE orders SET status = 'failed' WHERE id = ? AND status = 'awaiting'").run(o.id);
      return;
    }
    case "checkout.session.expired": {
      const o = orderForSession(obj);
      if (o) db.prepare("UPDATE orders SET status = 'expired' WHERE id = ? AND status = 'awaiting'").run(o.id);
      return;
    }
    case "charge.refunded": {
      // Also covers refunds made in Stripe's dashboard: amount_refunded is the running total.
      const o = db.prepare("SELECT * FROM orders WHERE stripe_payment_intent = ?").get(obj.payment_intent);
      if (o) settleRefunds(o.id, { stripeTotal: obj.amount_refunded ?? 0 });
      return;
    }
    case "refund.updated":
    case "refund.failed": {
      const r = db.prepare("SELECT * FROM refunds WHERE stripe_refund_id = ?").get(obj.id);
      if (!r) return;
      const status = refundStatus(obj.status);
      if (status === r.status) return;
      db.prepare("UPDATE refunds SET status = ?, error = ?, updated_at = ? WHERE id = ?").run(status, obj.failure_reason ?? null, now(), r.id);
      if (status !== "failed") return;
      // A failed refund comes back to your balance, so the refunded total drops by it.
      settleRefunds(r.order_id, { failedCents: r.amount_cents });
      addProblem(r.order_id, `The refund of ${usd(r.amount_cents)} failed (${obj.failure_reason ?? "no reason given"}): refund the customer another way.`);
      return;
    }
    case "charge.dispute.created": {
      const o = db.prepare("SELECT * FROM orders WHERE stripe_payment_intent = ?").get(obj.payment_intent);
      if (!o) return;
      db.prepare("UPDATE orders SET disputed = 1 WHERE id = ?").run(o.id);
      addProblem(o.id, `The customer disputed the payment (${obj.reason ?? "no reason given"}): respond in Stripe → Disputes before the deadline.`);
      return;
    }
    default:
  }
}

// --- Refunds ---------------------------------------------------------------------------

const refundStatus = (s) => (s === "succeeded" ? "succeeded" : s === "failed" || s === "canceled" ? "failed" : "processing");

/**
 * The order's refunded total: refunds made here, or Stripe's own total if that's higher
 * (refunds made in Stripe's dashboard), less any refund that later failed.
 */
function settleRefunds(id, { stripeTotal = 0, failedCents = 0 } = {}) {
  const o = getOrder(id);
  const ours = db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS n FROM refunds WHERE order_id = ? AND status IN ('succeeded', 'processing')").get(id).n;
  const total = Math.min(o.total_cents, Math.max(ours, stripeTotal, o.refunded_cents - failedCents));
  const status = ["paid", "partly_refunded", "refunded"].includes(o.status) ? (total >= o.total_cents ? "refunded" : total > 0 ? "partly_refunded" : "paid") : o.status;
  db.prepare("UPDATE orders SET refunded_cents = ?, status = ? WHERE id = ?").run(total, status, id);
}

/** Refunds amountCents (or everything left). The refund row is saved first, so a double click can't refund twice. */
export async function refund(orderId, { amountCents } = {}) {
  const refundId = randomUUID();
  const r = transaction(() => {
    const o = getOrder(orderId);
    if (!o) throw new ShopError("Order not found.", 404);
    if (!["paid", "partly_refunded"].includes(o.status)) throw new ShopError("Only paid orders can be refunded.", 409);
    if (db.prepare("SELECT 1 FROM refunds WHERE order_id = ? AND status = 'uncertain'").get(orderId))
      throw new ShopError("A refund's answer from Stripe was lost: check it (POST …/refunds/check) first.", 409);
    const reserved = db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS n FROM refunds WHERE order_id = ? AND status IN ('pending', 'processing', 'succeeded')").get(orderId).n;
    const left = o.total_cents - Math.max(reserved, o.refunded_cents);
    const cents = amountCents === undefined || amountCents === null ? left : Math.round(Number(amountCents));
    if (!(cents >= 1 && cents <= left)) throw new ShopError(left > 0 ? `Refund up to ${usd(left)}.` : "Everything has been refunded already.");
    db.prepare("INSERT INTO refunds (id, order_id, amount_cents, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)").run(refundId, orderId, cents, now(), now());
    return { cents, paymentIntent: o.stripe_payment_intent };
  });
  await sendRefund(orderId, refundId, r.cents, r.paymentIntent);
  return getOrder(orderId);
}

async function sendRefund(orderId, refundId, cents, paymentIntent) {
  db.prepare("UPDATE refunds SET status = 'processing', updated_at = ? WHERE id = ?").run(now(), refundId);
  try {
    const res = await stripe.refunds.create(
      { payment_intent: paymentIntent, amount: cents, reason: "requested_by_customer", metadata: { order_id: orderId, refund_id: refundId } },
      { idempotencyKey: `refund-${refundId}` },
    );
    db.prepare("UPDATE refunds SET status = ?, stripe_refund_id = ?, error = NULL, updated_at = ? WHERE id = ?").run(refundStatus(res.status), res.id, now(), refundId);
    settleRefunds(orderId);
  } catch (e) {
    // Lost answer: Stripe may have refunded. Don't guess; checkRefund asks Stripe.
    const status = lostResponse(e) ? "uncertain" : "failed";
    db.prepare("UPDATE refunds SET status = ?, error = ?, updated_at = ? WHERE id = ?").run(status, stripeMessage(e), now(), refundId);
    throw new ShopError(status === "uncertain" ? "Stripe didn't answer. Check the refund before trying again." : `Stripe couldn't refund it: ${stripeMessage(e)}`, 502);
  }
}

/** For a refund whose answer was lost: finds it at Stripe, and only sends it (same idempotency key) if it isn't there. */
export async function checkRefund(orderId) {
  const o = getOrder(orderId);
  const r = db.prepare("SELECT * FROM refunds WHERE order_id = ? AND status = 'uncertain'").get(orderId);
  if (!o || !r) throw new ShopError("Nothing to check.", 409);
  const list = await stripe.refunds.list({ payment_intent: o.stripe_payment_intent, limit: 100 });
  const found = list.data.find((x) => x.metadata?.refund_id === r.id);
  if (!found) return sendRefund(orderId, r.id, r.amount_cents, o.stripe_payment_intent).then(() => getOrder(orderId));
  db.prepare("UPDATE refunds SET status = ?, stripe_refund_id = ?, error = NULL, updated_at = ? WHERE id = ?").run(refundStatus(found.status), found.id, now(), r.id);
  settleRefunds(orderId);
  return getOrder(orderId);
}
