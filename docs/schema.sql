-- Tables for a Stripe Checkout integration. Written for SQLite; for Postgres
-- use TIMESTAMPTZ for the *_at columns, JSONB for ship_to / problems, and
-- INTEGER/BIGINT stays the same for money (always whole cents).

CREATE TABLE orders (
  id                    TEXT PRIMARY KEY,               -- your id (e.g. a UUID)
  token                 TEXT NOT NULL UNIQUE,           -- random, for /success?order=<token>
  mode                  TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  status                TEXT NOT NULL DEFAULT 'awaiting'
                        CHECK (status IN ('awaiting', 'paid', 'expired', 'failed', 'partly_refunded', 'refunded')),
  currency              TEXT NOT NULL DEFAULT 'usd',
  country               TEXT NOT NULL,                  -- shipping was priced for this country
  subtotal_cents        INTEGER NOT NULL,
  shipping_cents        INTEGER NOT NULL,
  tax_cents             INTEGER NOT NULL DEFAULT 0,
  total_cents           INTEGER NOT NULL,
  refunded_cents        INTEGER NOT NULL DEFAULT 0,
  stripe_session_id     TEXT UNIQUE,                    -- cs_…
  stripe_payment_intent TEXT,                           -- pi_… (for refunds)
  payment_method        TEXT,                           -- card, apple_pay, google_pay, link, upi…
  customer_name         TEXT,
  customer_email        TEXT,
  customer_phone        TEXT,
  ship_to               TEXT,                           -- JSON address
  note                  TEXT,                           -- e.g. a gift note from a custom field
  problems              TEXT NOT NULL DEFAULT '[]',     -- JSON list of things to check before shipping
  fulfilled             INTEGER NOT NULL DEFAULT 0,     -- after-payment work (stock, emails) done
  disputed              INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL,
  expires_at            TEXT NOT NULL,
  paid_at               TEXT
);

CREATE TABLE order_items (
  order_id    TEXT NOT NULL REFERENCES orders (id),
  position    INTEGER NOT NULL,
  product_id  TEXT NOT NULL,
  title       TEXT NOT NULL,
  quantity    INTEGER NOT NULL CHECK (quantity > 0),
  unit_cents  INTEGER NOT NULL,                         -- the price actually charged
  PRIMARY KEY (order_id, position)
);

-- Stripe delivers each event at least once: remember the ones handled.
CREATE TABLE webhook_events (
  id            TEXT PRIMARY KEY,                       -- evt_…
  type          TEXT NOT NULL,
  received_at   TEXT NOT NULL,
  processed_at  TEXT
);

CREATE TABLE refunds (
  id                TEXT PRIMARY KEY,                   -- your id; also the idempotency key
  order_id          TEXT NOT NULL REFERENCES orders (id),
  amount_cents      INTEGER NOT NULL CHECK (amount_cents > 0),
  status            TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'uncertain')),
  stripe_refund_id  TEXT,                               -- re_…
  error             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX orders_payment_intent ON orders (stripe_payment_intent);
CREATE INDEX refunds_order ON refunds (order_id);
