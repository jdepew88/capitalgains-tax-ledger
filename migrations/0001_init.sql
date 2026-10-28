-- Joyce's Home Ledger: one shared household dataset (no per-user partitioning).

CREATE TABLE items (
  id                TEXT PRIMARY KEY,                 -- client-generated UUID (makes "Save" idempotent)
  title             TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  category          TEXT NOT NULL,
  year              INTEGER NOT NULL CHECK (year BETWEEN 1800 AND 2200),
  month             INTEGER CHECK (month IS NULL OR month BETWEEN 1 AND 12),
  day               INTEGER CHECK (day IS NULL OR (month IS NOT NULL AND day BETWEEN 1 AND 31)),
  cost_cents        INTEGER NOT NULL CHECK (cost_cents >= 0),
  vendor            TEXT,
  notes             TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'needs_review'
                      CHECK (status IN ('needs_review', 'approved', 'excluded')),
  basis_cents       INTEGER CHECK (basis_cents IS NULL OR basis_cents >= 0),
  adjustment_reason TEXT,
  version           INTEGER NOT NULL DEFAULT 1,       -- optimistic concurrency for edits
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  created_by        TEXT NOT NULL,
  updated_by        TEXT NOT NULL,
  deleted_at        TEXT,                             -- soft delete ("Trash"); restorable
  deleted_by        TEXT
);

CREATE INDEX idx_items_year ON items (year);
CREATE INDEX idx_items_deleted ON items (deleted_at);

CREATE TABLE documents (
  id            TEXT PRIMARY KEY,                     -- client-generated UUID (makes upload retries idempotent)
  item_id       TEXT NOT NULL REFERENCES items (id),
  r2_key        TEXT NOT NULL UNIQUE,                 -- items/<item id>/<document id>.<ext>; never depends on the date
  filename      TEXT NOT NULL,
  content_type  TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'application/pdf')),
  size_bytes    INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  deleted_at    TEXT,
  deleted_by    TEXT
);

CREATE INDEX idx_documents_item ON documents (item_id);
CREATE INDEX idx_documents_hash ON documents (item_id, sha256);
