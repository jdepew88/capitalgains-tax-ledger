// D1 access. All queries are parameterised. There is one household dataset: no per-user filters.

import type { DocumentMeta, Item, ItemInput } from "../shared/types";

interface ItemRow {
  id: string; title: string; category: string; year: number; month: number | null; day: number | null;
  cost_cents: number; vendor: string | null; notes: string; status: string; basis_cents: number | null;
  adjustment_reason: string | null; version: number; created_at: string; updated_at: string;
  created_by: string; updated_by: string; deleted_at: string | null;
}

export interface DocumentRow {
  id: string; item_id: string; r2_key: string; filename: string; content_type: string;
  size_bytes: number; sha256: string; created_at: string; created_by: string; deleted_at: string | null;
}

export function rowToDocument(r: DocumentRow): DocumentMeta {
  return {
    id: r.id, itemId: r.item_id, filename: r.filename, contentType: r.content_type as DocumentMeta["contentType"],
    sizeBytes: r.size_bytes, createdAt: r.created_at, createdBy: r.created_by, deletedAt: r.deleted_at,
  };
}

function rowToItem(r: ItemRow, docs: DocumentMeta[]): Item {
  return {
    id: r.id, title: r.title, category: r.category as Item["category"], year: r.year, month: r.month, day: r.day,
    costCents: r.cost_cents, vendor: r.vendor, notes: r.notes, status: r.status as Item["status"],
    basisCents: r.basis_cents, adjustmentReason: r.adjustment_reason, version: r.version,
    createdAt: r.created_at, updatedAt: r.updated_at, createdBy: r.created_by, updatedBy: r.updated_by,
    deletedAt: r.deleted_at, documents: docs,
  };
}

export async function listItems(db: D1Database, opts: { deleted: boolean; ids?: string[] }): Promise<Item[]> {
  const where = [opts.deleted ? "i.deleted_at IS NOT NULL" : "i.deleted_at IS NULL"];
  const params: unknown[] = [];
  if (opts.ids) {
    if (opts.ids.length === 0) return [];
    // Use json_each to keep the query parameterised for any number of ids.
    where.push("i.id IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(opts.ids));
  }
  const whereSql = where.join(" AND ");
  const [items, docs] = await db.batch([
    db.prepare(`SELECT i.* FROM items i WHERE ${whereSql} ORDER BY i.year, i.month, i.day, i.title`).bind(...params),
    db.prepare(
      `SELECT d.* FROM documents d JOIN items i ON i.id = d.item_id WHERE ${whereSql} ORDER BY d.created_at, d.id`,
    ).bind(...params),
  ]);
  const byItem = new Map<string, DocumentMeta[]>();
  for (const d of docs.results as unknown as DocumentRow[]) {
    const list = byItem.get(d.item_id) ?? [];
    list.push(rowToDocument(d));
    byItem.set(d.item_id, list);
  }
  return (items.results as unknown as ItemRow[]).map((r) => rowToItem(r, byItem.get(r.id) ?? []));
}

export async function getItem(db: D1Database, id: string): Promise<Item | null> {
  const [items, docs] = await db.batch([
    db.prepare("SELECT * FROM items WHERE id = ?").bind(id),
    db.prepare("SELECT * FROM documents WHERE item_id = ? ORDER BY created_at, id").bind(id),
  ]);
  const row = items.results[0] as unknown as ItemRow | undefined;
  if (!row) return null;
  return rowToItem(row, (docs.results as unknown as DocumentRow[]).map(rowToDocument));
}

/** Inserts a new item. Returns false if the id already exists (a repeated Save). */
export async function insertItem(db: D1Database, id: string, v: ItemInput, email: string, now: string): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT INTO items (id, title, category, year, month, day, cost_cents, vendor, notes, status, basis_cents,
         adjustment_reason, version, created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
    )
    .bind(id, v.title, v.category, v.year, v.month, v.day, v.costCents, v.vendor, v.notes, v.status, v.basisCents,
      v.adjustmentReason, now, now, email, email)
    .run();
  return res.meta.changes === 1;
}

/** Updates an item if its version still matches. Returns false on a version conflict. */
export async function updateItem(
  db: D1Database, id: string, v: ItemInput, expectedVersion: number, email: string, now: string,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE items SET title = ?, category = ?, year = ?, month = ?, day = ?, cost_cents = ?, vendor = ?, notes = ?,
         status = ?, basis_cents = ?, adjustment_reason = ?, version = version + 1, updated_at = ?, updated_by = ?
       WHERE id = ? AND version = ? AND deleted_at IS NULL`,
    )
    .bind(v.title, v.category, v.year, v.month, v.day, v.costCents, v.vendor, v.notes, v.status, v.basisCents,
      v.adjustmentReason, now, email, id, expectedVersion)
    .run();
  return res.meta.changes === 1;
}

export async function setItemDeleted(db: D1Database, id: string, deleted: boolean, email: string, now: string) {
  const res = await db
    .prepare(
      deleted
        ? "UPDATE items SET deleted_at = ?, deleted_by = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ? AND deleted_at IS NULL"
        : "UPDATE items SET deleted_at = NULL, deleted_by = NULL, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ? AND deleted_at IS NOT NULL",
    )
    .bind(...(deleted ? [now, email, now, email, id] : [now, email, id]))
    .run();
  return res.meta.changes === 1;
}

/** Permanently removes an item that is already in the trash, with its document rows. Returns the R2 keys to delete. */
export async function purgeItem(db: D1Database, id: string): Promise<string[] | null> {
  const keys = await db.prepare("SELECT r2_key FROM documents WHERE item_id = ?").bind(id).all<{ r2_key: string }>();
  const [, del] = await db.batch([
    db.prepare("DELETE FROM documents WHERE item_id = ? AND EXISTS (SELECT 1 FROM items WHERE id = ? AND deleted_at IS NOT NULL)").bind(id, id),
    db.prepare("DELETE FROM items WHERE id = ? AND deleted_at IS NOT NULL").bind(id),
  ]);
  if (del.meta.changes !== 1) return null;
  return keys.results.map((r) => r.r2_key);
}

export async function getDocument(db: D1Database, id: string): Promise<DocumentRow | null> {
  return db.prepare("SELECT * FROM documents WHERE id = ?").bind(id).first<DocumentRow>();
}

export async function findDocumentByHash(db: D1Database, itemId: string, sha256: string): Promise<DocumentRow | null> {
  return db
    .prepare("SELECT * FROM documents WHERE item_id = ? AND sha256 = ? AND deleted_at IS NULL LIMIT 1")
    .bind(itemId, sha256)
    .first<DocumentRow>();
}

export async function countActiveDocuments(db: D1Database, itemId: string): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM documents WHERE item_id = ? AND deleted_at IS NULL")
    .bind(itemId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export async function insertDocument(db: D1Database, d: DocumentRow): Promise<void> {
  // Touch the parent item so other open screens notice the change.
  await db.batch([
    db.prepare(
      `INSERT INTO documents (id, item_id, r2_key, filename, content_type, size_bytes, sha256, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(d.id, d.item_id, d.r2_key, d.filename, d.content_type, d.size_bytes, d.sha256, d.created_at, d.created_by),
    db.prepare("UPDATE items SET updated_at = ?, updated_by = ? WHERE id = ?").bind(d.created_at, d.created_by, d.item_id),
  ]);
}

export async function setDocumentDeleted(db: D1Database, id: string, deleted: boolean, email: string, now: string) {
  const res = await db
    .prepare(
      deleted
        ? "UPDATE documents SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL"
        : "UPDATE documents SET deleted_at = NULL, deleted_by = NULL WHERE id = ? AND deleted_at IS NOT NULL",
    )
    .bind(...(deleted ? [now, email, id] : [id]))
    .run();
  return res.meta.changes === 1;
}
