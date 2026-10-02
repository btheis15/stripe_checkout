"use client";

import { useState } from "react";

/**
 * Sends the cart (ids and quantities only) to /api/checkout and goes to
 * Stripe's payment page. Use it on your cart / checkout page.
 */
export function CheckoutButton({ lines, country }: { lines: { productId: string; qty: number }[]; country: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines, country }),
      });
      const data = (await res.json()) as { url?: string; error?: string };
      if (data.url) {
        window.location.href = data.url;
        return;
      }
      setError(data.error ?? "Something went wrong. Please try again.");
    } catch {
      setError("Couldn't reach checkout. Check your connection and try again.");
    }
    setLoading(false);
  }

  return (
    <div>
      {error && <p role="alert">{error}</p>}
      <button type="button" onClick={start} disabled={loading || !lines.length}>
        {loading ? "Starting secure checkout…" : "Continue to secure payment"}
      </button>
      <p>Payments are processed by Stripe. We never see your card details.</p>
    </div>
  );
}
