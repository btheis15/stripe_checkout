/**
 *   GET  /api/products               the catalog (for the sample shop page)
 *   POST /api/checkout               { lines, country } → { url } on Stripe
 *   GET  /api/orders/:token          what the success page shows
 *   POST /webhooks/stripe            Stripe's signed events (raw body!)
 *   POST /admin/orders/:id/refund    { amountCents? } (Authorization: Bearer ADMIN_TOKEN)
 *   POST /admin/orders/:id/refunds/check
 *   /                                public/ (index.html, success.html)
 */
import { timingSafeEqual } from "node:crypto";
import express from "express";
import rateLimit from "express-rate-limit";
import { checkRefund, createCheckout, handleWebhook, orderSummary, refund, resumeUnfinished, SHIPPING, ShopError } from "./src/checkout.js";
import { db } from "./src/db.js";

const app = express();
app.set("trust proxy", 1); // behind one proxy (Render, Fly, a load balancer…): req.ip is the shopper's

// The webhook needs the exact bytes Stripe signed, so it's registered BEFORE express.json().
app.post("/webhooks/stripe", rateLimit({ windowMs: 60_000, limit: 300 }), express.raw({ type: () => true, limit: "512kb" }), async (req, res) => {
  try {
    res.json(await handleWebhook(req.body, req.get("stripe-signature") ?? ""));
  } catch (e) {
    if (e instanceof ShopError) return res.status(e.status).json({ error: e.message });
    console.error("[webhook]", e);
    res.status(500).json({ error: "Server error" }); // Stripe retries
  }
});

app.use(express.json({ limit: "32kb" }));

const send = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (e) {
    if (e instanceof ShopError) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
};
const limit = (perMinute) => rateLimit({ windowMs: 60_000, limit: perMinute, standardHeaders: "draft-8", legacyHeaders: false, message: { error: "Too many tries. Wait a minute and try again." } });

app.get("/api/products", (_req, res) => res.json({ products: db.prepare("SELECT id, title, description, price_cents, stock, image FROM products WHERE active = 1").all(), countries: Object.keys(SHIPPING) }));
app.post("/api/checkout", limit(10), send((req) => createCheckout(req.body ?? {})));
app.get("/api/orders/:token", limit(60), send((req) => orderSummary(req.params.token)));

// A minimal admin: in a real site this sits behind your admin login.
const admin = (req, res, next) => {
  const want = Buffer.from(`Bearer ${process.env.ADMIN_TOKEN ?? ""}`);
  const got = Buffer.from(req.get("authorization") ?? "");
  if (!process.env.ADMIN_TOKEN || got.length !== want.length || !timingSafeEqual(got, want)) return res.status(401).json({ error: "Unauthorized" });
  next();
};
app.post("/admin/orders/:id/refund", admin, send((req) => refund(req.params.id, { amountCents: req.body?.amountCents })));
app.post("/admin/orders/:id/refunds/check", admin, send((req) => checkRefund(req.params.id)));

app.use(express.static("public"));

const port = Number(process.env.PORT ?? 4242);
app.listen(port, () => {
  console.log(`Shop on http://localhost:${port}`);
  resumeUnfinished();
});
