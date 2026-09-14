-- Daily page-load totals. One row per day; nothing about any visitor.
-- Apply with: npx wrangler@4 d1 execute festrec-visits --remote --file schema/visits.sql
CREATE TABLE IF NOT EXISTS visits (
  day TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
);
