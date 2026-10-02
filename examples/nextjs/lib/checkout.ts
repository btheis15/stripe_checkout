import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import type postgres from "postgres";
import type Stripe from "stripe";
import { sql } from "./db";
import { MODE, paidWith, stripe, stripeMessage } from "./stripe";

/**
 * The checkout, for Next.js route handlers. Same rules as the Express example
 * (examples/express/src/checkout.js, which also has refunds): prices from the
 * database only, the order saved before Stripe, "paid" only from Stripe's own
 * data, and every step safe to repeat.
 */

export class ShopError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export type CartLine = { productId: string; qty: number };

type Order = {
  id: string;
  token: string;
  mode: "test" | "live";
  status: "awaiting" | "paid" | "expired" | "failed" | "partly_refunded" | "refunded";
  currency: string;
  country: string;
  subtotal_cents: number;
  shipping_cents: number;
  tax_cents: number;
  total_cents: number;
  stripe_session_id: string | null;
  stripe_payment_intent: string | null;
  customer_email: string | null;
  problems: string;
  fulfilled: number;
};

// --- Your shop's settings ------------------------------------------------------------

const SHOP_NAME = "My Shop";
const CURRENCY = "usd";
const CHECKOUT_MINUTES = 60;
const MAX_QTY = 10;
const TAX = process.env.STRIPE_TAX === "true";

export const SHIPPING: Record<string, { label: string; cents: number; freeOverCents: number | null; minDays: number; maxDays: number }> = {
  US: { label: "Standard shipping", cents: 600, freeOverCents: 7500, minDays: 3, maxDays: 7 },
  CA: { label: "International shipping", cents: 1800, freeOverCents: null, minDays: 7, maxDays: 14 },
};

const siteUrl = () => (process.env.SITE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const now = () => new Date().toISOString();
const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

async function addProblem(tx: postgres.Sql | postgres.TransactionSql, id: string, text: string) {
  await tx`UPDATE orders SET problems = (problems::jsonb || ${sql.json([text])})::text WHERE id = ${id}`;
  console.warn(`[order ${id}] needs a look: ${text}`);
}

// --- Starting a checkout -------------------------------------------------------------

async function priceCart(lines: unknown) {
  if (!Array.isArray(lines) || !lines.length) throw new ShopError("Your cart is empty.");
  if (lines.length > 50) throw new ShopError("That's a lot of items: please split it into two orders.");
  const merged = new Map<string, number>();
  for (const l of lines as CartLine[]) {
    const qty = Math.floor(Number(l?.qty));
    if (!(qty >= 1 && qty <= MAX_QTY)) throw new ShopError(`Choose between 1 and ${MAX_QTY} of each item.`);
    const id = String(l?.productId ?? "");
    merged.set(id, (merged.get(id) ?? 0) + qty);
  }
  const items = [];
  for (const [id, qty] of merged) {
    const [p] = await sql`SELECT * FROM products WHERE id = ${id} AND active`;
    if (!p) throw new ShopError("An item in your cart is no longer available.", 409);
    if (p.stock !== null && qty > p.stock) throw new ShopError(p.stock > 0 ? `Only ${p.stock} ${p.title} left.` : `${p.title} just sold out.`, 409);
    items.push({ productId: p.id as string, title: p.title as string, description: p.description as string | null, image: p.image as string | null, qty, unitCents: p.price_cents as number });
  }
  return items;
}

/** Cart → order (awaiting) → Stripe Checkout Session. Returns the payment page's URL. */
export async function createCheckout(input: { lines?: unknown; country?: unknown }) {
  if (!MODE) throw new ShopError("Checkout isn't set up yet.", 503);
  const items = await priceCart(input.lines);
  const country = String(input.country ?? "US").toUpperCase().slice(0, 2);
  const subtotal = items.reduce((n, i) => n + i.unitCents * i.qty, 0);
  const rate = SHIPPING[country];
  if (!rate) throw new ShopError("We don't ship there yet.", 409);
  const shipping = rate.freeOverCents !== null && subtotal >= rate.freeOverCents ? 0 : rate.cents;

  const id = randomUUID();
  const token = randomBytes(18).toString("base64url");
  const expiresMs = Date.now() + CHECKOUT_MINUTES * 60_000;
  await sql.begin(async (tx) => {
    await tx`INSERT INTO orders (id, token, mode, currency, country, subtotal_cents, shipping_cents, total_cents, created_at, expires_at)
             VALUES (${id}, ${token}, ${MODE}, ${CURRENCY}, ${country}, ${subtotal}, ${shipping}, ${subtotal + shipping}, ${now()}, ${new Date(expiresMs).toISOString()})`;
    for (const [n, i] of items.entries())
      await tx`INSERT INTO order_items (order_id, position, product_id, title, quantity, unit_cents) VALUES (${id}, ${n}, ${i.productId}, ${i.title}, ${i.qty}, ${i.unitCents})`;
  });

  const taxBehavior = TAX ? ({ tax_behavior: "exclusive" } as const) : {};
  const params: Stripe.Checkout.SessionCreateParams = {
    mode: "payment",
    client_reference_id: id,
    metadata: { order_id: id },
    line_items: items.map((i) => ({
      quantity: i.qty,
      price_data: {
        currency: CURRENCY,
        unit_amount: i.unitCents,
        ...taxBehavior,
        product_data: { name: i.title, ...(i.description ? { description: i.description } : {}), ...(i.image ? { images: [i.image] } : {}), metadata: { product_id: i.productId } },
      },
    })),
    shipping_address_collection: { allowed_countries: [country as Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry] },
    shipping_options: [
      {
        shipping_rate_data: {
          type: "fixed_amount",
          display_name: rate.label,
          fixed_amount: { amount: shipping, currency: CURRENCY },
          delivery_estimate: { minimum: { unit: "business_day", value: rate.minDays }, maximum: { unit: "business_day", value: rate.maxDays } },
          ...taxBehavior,
        },
      },
    ],
    phone_number_collection: { enabled: true },
    billing_address_collection: "auto",
    adaptive_pricing: { enabled: true },
    automatic_tax: { enabled: TAX },
    payment_intent_data: { description: `${SHOP_NAME} order`, metadata: { order_id: id } },
    success_url: `${siteUrl()}/checkout/success?order=${token}`,
    cancel_url: `${siteUrl()}/checkout?cancelled=1`,
    expires_at: Math.floor(expiresMs / 1000),
  };

  try {
    const session = await stripe.checkout.sessions.create(params, { idempotencyKey: `checkout-${id}` });
    await sql`UPDATE orders SET stripe_session_id = ${session.id} WHERE id = ${id}`;
    return session.url!;
  } catch (e) {
    await sql`UPDATE orders SET status = 'failed' WHERE id = ${id}`;
    console.error(`[checkout] ${id}: ${stripeMessage(e)}`);
    throw new ShopError("Couldn't start the secure checkout. Please try again in a moment.", 502);
  }
}

// --- Marking paid (webhook and success page) -------------------------------------------

async function orderForSession(session: Stripe.Checkout.Session) {
  const [o] = await sql<Order[]>`SELECT * FROM orders WHERE stripe_session_id = ${session.id} OR id = ${session.metadata?.order_id ?? ""} LIMIT 1`;
  return o ?? null;
}

/** Records a paid session. Safe to call any number of times: returns true only for the call that changed the order. */
export async function applyPaid(order: Order, session: Stripe.Checkout.Session) {
  const ship = session.collected_information?.shipping_details ?? null;
  const cust = session.customer_details;
  const addr = ship?.address ?? cust?.address ?? null;
  const pi = typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent?.id ?? null);
  const note = session.custom_fields?.find((f) => f.key === "note")?.text?.value?.slice(0, 255) ?? null;
  return sql.begin(async (tx) => {
    const [o] = await tx<Order[]>`
      UPDATE orders SET status = 'paid', paid_at = ${now()}, stripe_session_id = ${session.id}, stripe_payment_intent = ${pi},
        customer_name = ${cust?.name ?? ship?.name ?? null}, customer_email = ${cust?.email ?? null}, customer_phone = ${cust?.phone ?? null},
        ship_to = ${JSON.stringify({ name: ship?.name ?? cust?.name ?? null, ...addr })}, tax_cents = ${session.total_details?.amount_tax ?? 0},
        total_cents = ${session.amount_total ?? order.total_cents}, note = ${note}
      WHERE id = ${order.id} AND status IN ('awaiting', 'expired', 'failed')
      RETURNING *`;
    if (!o) return false;
    if (order.status !== "awaiting") await addProblem(tx, o.id, "The payment arrived after the checkout had closed: check the stock.");
    if (session.currency !== o.currency || session.amount_subtotal !== o.subtotal_cents || (session.total_details?.amount_shipping ?? 0) !== o.shipping_cents)
      await addProblem(tx, o.id, `Stripe's amounts (${usd(session.amount_total ?? 0)}) don't match the order: check it in Stripe.`);
    if (addr?.country && addr.country !== o.country) await addProblem(tx, o.id, `The address is in ${addr.country}, but shipping was priced for ${o.country}.`);
    return true;
  });
}

/** Once per paid order: how it was paid, stock, emails. Run it with after() so the response isn't held up. */
export async function afterPayment(id: string) {
  const [o] = await sql<Order[]>`SELECT * FROM orders WHERE id = ${id}`;
  if (!o || o.fulfilled || !["paid", "partly_refunded"].includes(o.status)) return;
  if (o.stripe_payment_intent) {
    const method = await stripe.paymentIntents
      .retrieve(o.stripe_payment_intent, { expand: ["latest_charge"] })
      .then((pi) => paidWith(pi.latest_charge))
      .catch(() => null);
    if (method) await sql`UPDATE orders SET payment_method = ${method} WHERE id = ${id}`;
  }
  const claimed = await sql.begin(async (tx) => {
    const res = await tx`UPDATE orders SET fulfilled = 1 WHERE id = ${id} AND fulfilled = 0`;
    if (res.count === 0) return false;
    if (o.mode !== "live") return true; // test orders never touch real stock
    for (const i of await tx`SELECT * FROM order_items WHERE order_id = ${id}`) {
      const res2 = await tx`UPDATE products SET stock = stock - ${i.quantity} WHERE id = ${i.product_id} AND stock IS NOT NULL AND stock >= ${i.quantity}`;
      if (res2.count === 0 && (await tx`SELECT 1 FROM products WHERE id = ${i.product_id} AND stock IS NOT NULL`).length) {
        await tx`UPDATE products SET stock = 0 WHERE id = ${i.product_id}`;
        await addProblem(tx, id, `Not enough ${i.title} in stock (sold at the same moment): refund or contact the customer.`);
      }
    }
    return true;
  });
  // Plug in your email service here (Resend, Postmark, SES…).
  if (claimed) console.log(`[order ${id}] paid ${usd(o.total_cents)}: email ${o.customer_email ?? "the customer"} a receipt, and yourself a "new order" email.`);
}

// --- Success page ----------------------------------------------------------------------

/** What /checkout/success shows. Asks Stripe directly while the order still looks unpaid. */
export async function orderSummary(token: string) {
  let [o] = await sql<Order[]>`SELECT * FROM orders WHERE token = ${token}`;
  if (!o) return null;
  if ((o.status === "awaiting" || o.status === "expired") && o.stripe_session_id) {
    try {
      const session = await stripe.checkout.sessions.retrieve(o.stripe_session_id);
      if (session.status === "complete" && session.payment_status === "paid" && (await applyPaid(o, session))) await afterPayment(o.id);
      [o] = await sql<Order[]>`SELECT * FROM orders WHERE id = ${o.id}`;
    } catch {
      /* the webhook will bring it */
    }
  }
  const items = await sql<{ title: string; quantity: number; unit_cents: number }[]>`SELECT title, quantity, unit_cents FROM order_items WHERE order_id = ${o.id} ORDER BY position`;
  return {
    status: o.status === "partly_refunded" ? "paid" : o.status,
    test: o.mode === "test",
    email: o.customer_email?.replace(/^(.)[^@]*(@.*)$/, "$1•••$2") ?? null,
    items: items.map((i) => ({ title: i.title, quantity: i.quantity, unitCents: i.unit_cents })),
    subtotalCents: o.subtotal_cents,
    shippingCents: o.shipping_cents,
    taxCents: o.tax_cents,
    totalCents: o.total_cents,
  };
}

// --- Webhook events --------------------------------------------------------------------

/** Handles one verified event. Returns the id of an order that just became paid (to run afterPayment). */
export async function onEvent(event: Stripe.Event): Promise<string | null> {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const o = await orderForSession(event.data.object);
      if (o && event.data.object.payment_status === "paid" && (await applyPaid(o, event.data.object))) return o.id;
      return null;
    }
    case "checkout.session.async_payment_failed":
    case "checkout.session.expired": {
      const o = await orderForSession(event.data.object);
      const status = event.type === "checkout.session.expired" ? "expired" : "failed";
      if (o) await sql`UPDATE orders SET status = ${status} WHERE id = ${o.id} AND status = 'awaiting'`;
      return null;
    }
    case "charge.refunded": {
      // Includes refunds made in Stripe's dashboard: amount_refunded is the running total.
      const c = event.data.object;
      await sql`UPDATE orders SET refunded_cents = GREATEST(refunded_cents, ${c.amount_refunded}),
                  status = CASE WHEN ${c.amount_refunded} >= total_cents THEN 'refunded' ELSE 'partly_refunded' END
                WHERE stripe_payment_intent = ${String(c.payment_intent)} AND status IN ('paid', 'partly_refunded', 'refunded')`;
      return null;
    }
    case "refund.updated":
    case "refund.failed": {
      const r = event.data.object;
      if (r.status === "failed") {
        const [row] = await sql`UPDATE refunds SET status = 'failed', error = ${r.failure_reason ?? null}, updated_at = ${now()} WHERE stripe_refund_id = ${r.id} RETURNING order_id`;
        if (row) await addProblem(sql, row.order_id, `A refund of ${usd(r.amount)} failed (${r.failure_reason ?? "no reason given"}): refund the customer another way.`);
      }
      return null;
    }
    case "charge.dispute.created": {
      const d = event.data.object;
      const [o] = await sql`UPDATE orders SET disputed = 1 WHERE stripe_payment_intent = ${String(d.payment_intent)} RETURNING id`;
      if (o) await addProblem(sql, o.id, `The customer disputed the payment (${d.reason}): respond in Stripe → Disputes before the deadline.`);
      return null;
    }
    default:
      return null;
  }
}
