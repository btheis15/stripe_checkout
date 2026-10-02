/**
 * SQLite through Node's built-in node:sqlite (no native build). The order
 * tables are the same as docs/schema.sql; `products` stands in for your own
 * catalog. Swap in any database: the checkout code only needs these queries.
 */
import { DatabaseSync } from "node:sqlite";

export const db = new DatabaseSync(process.env.DB_FILE ?? "shop.db");
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT,
  price_cents INTEGER NOT NULL,
  stock       INTEGER,                -- NULL: not tracked
  image       TEXT,                   -- public https URL (shown on Stripe's page)
  active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS orders (
  id                    TEXT PRIMARY KEY,
  token                 TEXT NOT NULL UNIQUE,
  mode                  TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  status                TEXT NOT NULL DEFAULT 'awaiting'
                        CHECK (status IN ('awaiting', 'paid', 'expired', 'failed', 'partly_refunded', 'refunded')),
  currency              TEXT NOT NULL DEFAULT 'usd',
  country               TEXT NOT NULL,
  subtotal_cents        INTEGER NOT NULL,
  shipping_cents        INTEGER NOT NULL,
  tax_cents             INTEGER NOT NULL DEFAULT 0,
  total_cents           INTEGER NOT NULL,
  refunded_cents        INTEGER NOT NULL DEFAULT 0,
  stripe_session_id     TEXT UNIQUE,
  stripe_payment_intent TEXT,
  payment_method        TEXT,
  customer_name         TEXT,
  customer_email        TEXT,
  customer_phone        TEXT,
  ship_to               TEXT,
  note                  TEXT,
  problems              TEXT NOT NULL DEFAULT '[]',
  fulfilled             INTEGER NOT NULL DEFAULT 0,
  disputed              INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL,
  expires_at            TEXT NOT NULL,
  paid_at               TEXT
);

CREATE TABLE IF NOT EXISTS order_items (
  order_id    TEXT NOT NULL REFERENCES orders (id),
  position    INTEGER NOT NULL,
  product_id  TEXT NOT NULL,
  title       TEXT NOT NULL,
  quantity    INTEGER NOT NULL CHECK (quantity > 0),
  unit_cents  INTEGER NOT NULL,
  PRIMARY KEY (order_id, position)
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  received_at   TEXT NOT NULL,
  processed_at  TEXT
);

CREATE TABLE IF NOT EXISTS refunds (
  id                TEXT PRIMARY KEY,
  order_id          TEXT NOT NULL REFERENCES orders (id),
  amount_cents      INTEGER NOT NULL CHECK (amount_cents > 0),
  status            TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'uncertain')),
  stripe_refund_id  TEXT,
  error             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS orders_payment_intent ON orders (stripe_payment_intent);
CREATE INDEX IF NOT EXISTS refunds_order ON refunds (order_id);
`);

// Sample products, so the example works out of the box.
if (!db.prepare("SELECT 1 FROM products LIMIT 1").get()) {
  const add = db.prepare("INSERT INTO products (id, title, description, price_cents, stock, image) VALUES (?, ?, ?, ?, ?, ?)");
  add.run("tee", "Cotton T-shirt", "Soft organic cotton.", 2500, 10, null);
  add.run("mug", "Ceramic mug", "Holds 12 oz.", 1800, 3, null);
  add.run("print", "Art print", "A3, signed.", 4000, null, null);
}

/** Runs fn inside one transaction (all or nothing). */
export function transaction(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
