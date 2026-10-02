import type { Metadata } from "next";
import Link from "next/link";
import { orderSummary } from "@/lib/checkout";
import { AfterPayment } from "./AfterPayment";

export const metadata: Metadata = { title: "Thank you", robots: { index: false } };

type Props = { searchParams: Promise<{ order?: string }> };

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export default async function SuccessPage({ searchParams }: Props) {
  const { order } = await searchParams;
  const summary = order && /^[\w-]{10,64}$/.test(order) ? await orderSummary(order).catch(() => null) : null;

  if (!summary) {
    return (
      <main>
        <h1>Thank you</h1>
        <p>We couldn&apos;t show your order just now, but if your payment went through you&apos;ll get a confirmation email shortly.</p>
        <Link href="/">Continue shopping</Link>
      </main>
    );
  }

  const paid = summary.status === "paid" || summary.status === "refunded";
  const waiting = summary.status === "awaiting";
  return (
    <main>
      <AfterPayment clearCart={paid} keepChecking={waiting} />
      {summary.test && <p>Test order: no real payment was taken.</p>}
      <h1>{paid ? "Thank you for your order" : waiting ? "Confirming your payment…" : "Your payment didn't go through"}</h1>
      <p>
        {paid
          ? summary.email
            ? `We've received your payment. A receipt is on its way to ${summary.email}.`
            : "We've received your payment."
          : waiting
            ? "This usually takes a few seconds. This page updates by itself."
            : "Nothing was charged. Your cart is still saved, so you can try again."}
      </p>
      <ul>
        {summary.items.map((i, n) => (
          <li key={n}>
            {i.quantity} × {i.title}: {dollars(i.unitCents * i.quantity)}
          </li>
        ))}
      </ul>
      <p>Shipping: {summary.shippingCents ? dollars(summary.shippingCents) : "Free"}</p>
      {summary.taxCents > 0 && <p>Tax: {dollars(summary.taxCents)}</p>}
      <p>
        <strong>Total: {dollars(summary.totalCents)}</strong>
      </p>
      <Link href="/">Continue shopping</Link>
      {!paid && !waiting && <Link href="/checkout">Back to checkout</Link>}
    </main>
  );
}
