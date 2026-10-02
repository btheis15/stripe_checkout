import { after, NextResponse } from "next/server";
import type Stripe from "stripe";
import { afterPayment, onEvent } from "@/lib/checkout";
import { sql } from "@/lib/db";
import { MODE, stripe } from "@/lib/stripe";

/**
 * Stripe's webhook: Stripe → Developers → Webhooks → endpoint
 * https://your-site.com/api/stripe/webhook (or `stripe listen --forward-to localhost:3000/api/stripe/webhook`).
 */
export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "Not set up" }, { status: 500 });

  // The signature is over the exact bytes: read the raw text, never request.json().
  const raw = await request.text();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(raw, request.headers.get("stripe-signature") ?? "", secret, 300);
  } catch {
    return NextResponse.json({ error: "Bad signature" }, { status: 400 });
  }
  // A test event can never touch a live order (and the reverse).
  if (event.livemode !== (MODE === "live")) return NextResponse.json({ error: "Wrong mode" }, { status: 400 });

  // Stripe delivers at least once: handle each event id once.
  const inserted = await sql`INSERT INTO webhook_events (id, type, received_at) VALUES (${event.id}, ${event.type}, ${new Date().toISOString()}) ON CONFLICT DO NOTHING`;
  if (inserted.count === 0) return NextResponse.json({ received: true, duplicate: true });

  try {
    const paidOrder = await onEvent(event);
    await sql`UPDATE webhook_events SET processed_at = ${new Date().toISOString()} WHERE id = ${event.id}`;
    // Stock and emails after answering Stripe (it wants a reply within seconds).
    if (paidOrder) after(() => afterPayment(paidOrder).catch((e) => console.error(`[order ${paidOrder}]`, e)));
    return NextResponse.json({ received: true });
  } catch (e) {
    // Forget it so Stripe's retry is handled.
    await sql`DELETE FROM webhook_events WHERE id = ${event.id}`;
    console.error("[webhook]", event.type, e);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
