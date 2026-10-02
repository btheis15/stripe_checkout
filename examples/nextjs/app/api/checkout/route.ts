import { NextResponse } from "next/server";
import { createCheckout, ShopError } from "@/lib/checkout";

/**
 * POST { lines: [{ productId, qty }], country } → { url } (Stripe's payment page).
 * Add a per-IP rate limit in front of this (e.g. Vercel's firewall, or Upstash).
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { lines?: unknown; country?: unknown } | null;
  try {
    const url = await createCheckout({ lines: body?.lines, country: body?.country });
    return NextResponse.json({ url });
  } catch (e) {
    if (e instanceof ShopError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("[checkout]", e);
    return NextResponse.json({ error: "Checkout isn't available right now. Please try again in a few minutes." }, { status: 503 });
  }
}
