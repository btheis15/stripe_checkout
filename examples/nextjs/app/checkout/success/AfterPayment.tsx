"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Empties the cart once the order is paid, and re-checks the order while the payment is still confirming. */
export function AfterPayment({ clearCart, keepChecking }: { clearCart: boolean; keepChecking: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!clearCart) return;
    try {
      localStorage.removeItem("cart"); // or your cart store's clear()
    } catch {
      /* private mode */
    }
  }, [clearCart]);
  useEffect(() => {
    if (!keepChecking) return;
    // Every 3 seconds for a minute, then every 15, for about five minutes in all.
    let n = 0;
    let t: ReturnType<typeof setTimeout>;
    const next = () => {
      t = setTimeout(() => {
        n++;
        router.refresh();
        if (n < 36) next();
      }, n < 20 ? 3000 : 15_000);
    };
    next();
    return () => clearTimeout(t);
  }, [keepChecking, router]);
  return null;
}
