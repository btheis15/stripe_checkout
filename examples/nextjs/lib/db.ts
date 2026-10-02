import "server-only";
import postgres from "postgres";

/**
 * Postgres via the `postgres` package. Tables: docs/schema.sql (orders,
 * order_items, webhook_events, refunds) plus your own products table:
 *
 *   CREATE TABLE products (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
 *     price_cents INTEGER NOT NULL, stock INTEGER, image TEXT, active BOOLEAN NOT NULL DEFAULT TRUE);
 */
export const sql = postgres(process.env.DATABASE_URL ?? "", {
  max: 5,
  // Needed behind transaction-mode poolers (Supabase :6543, PgBouncer).
  prepare: false,
});
