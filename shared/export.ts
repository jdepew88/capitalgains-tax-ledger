// CSV generation and export file naming, shared by the Worker exports and tests.

import { datePrecision, decadeLabel, decadeStart, formatPartialDate, isoPartialDate, PRECISION_LABEL } from "./dates";
import { effectiveBasisCents } from "./ledger";
import { centsToPlain } from "./money";
import { activeDocuments, categoryLabel, statusLabel, type DocumentMeta, type Item } from "./types";

/**
 * Escapes one CSV cell. Cells that a spreadsheet could treat as a formula
 * (starting with = + - @, tab or carriage return) are prefixed with an apostrophe.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(rows: (string | number | null)[][]): string {
  // BOM so Excel opens UTF-8 correctly; CRLF line endings for spreadsheets.
  return "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** Lower-case, filesystem-safe slug. */
export function slug(text: string, max = 40): string {
  const s = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
  return s || "item";
}

/** Safe version of an original filename: keeps letters, digits, dot, dash, underscore, space. */
export function safeFilename(name: string, fallback = "document"): string {
  const cleaned = name
    .normalize("NFKC")
    .replace(/[\\/]/g, "_")
    .replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^[.\s_-]+/, "")
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

export function extensionFor(contentType: string): string {
  return contentType === "application/pdf" ? "pdf" : contentType === "image/png" ? "png" : "jpg";
}

/** Folder for an item inside exports, e.g. "1950-1959/1959/1959-02-02 new-roof [3f9a1c2e]". */
export function itemFolder(item: Pick<Item, "id" | "title" | "year" | "month" | "day">): string {
  const decade = decadeLabel(decadeStart(item.year)).replace("–", "-");
  const date = isoPartialDate(item);
  return `${decade}/${item.year}/${date} ${slug(item.title)} [${item.id.slice(0, 8)}]`;
}

/** Path of one attachment inside the export ZIP. Uses the record's current date, so editing a date only renames export paths. */
export function attachmentPath(item: Item, doc: DocumentMeta, index: number): string {
  const ext = extensionFor(doc.contentType);
  let base = safeFilename(doc.filename).replace(/\.(jpe?g|png|pdf|heic|heif)$/i, "");
  base = base.slice(0, 80) || "document";
  return `attachments/${itemFolder(item)}/${String(index + 1).padStart(2, "0")} ${base}.${ext}`;
}

export const CSV_HEADER = [
  "record_id", "title", "category", "date", "date_precision", "year", "month", "day",
  "recorded_cost", "review_status", "approved_basis", "adjustment_or_exclusion_reason",
  "vendor", "notes", "document_count", "attachment_files", "attachment_ids", "attachment_status",
  "created_at", "updated_at", "last_updated_by",
];

/**
 * One CSV row per record. `attachmentStatus` is filled in by the ZIP export after it has
 * actually tried to copy each file; the plain CSV export leaves it as "not checked".
 */
export function itemCsvRow(item: Item, attachmentStatus = "not checked (CSV only)"): (string | number | null)[] {
  const docs = activeDocuments(item);
  const basis = effectiveBasisCents(item);
  return [
    item.id,
    item.title,
    categoryLabel(item.category),
    formatPartialDate(item),
    PRECISION_LABEL[datePrecision(item)],
    item.year,
    item.month,
    item.day,
    centsToPlain(item.costCents),
    statusLabel(item.status),
    basis === null ? "" : centsToPlain(basis),
    item.adjustmentReason ?? "",
    item.vendor ?? "",
    item.notes,
    docs.length,
    docs.map((d, i) => attachmentPath(item, d, i)).join("; "),
    docs.map((d) => d.id).join("; "),
    docs.length === 0 ? "no documents" : attachmentStatus,
    item.createdAt,
    item.updatedAt,
    item.updatedBy,
  ];
}

export function itemsToCsv(items: Item[], statuses?: Map<string, string>): string {
  return toCsv([CSV_HEADER, ...items.map((i) => itemCsvRow(i, statuses?.get(i.id)))]);
}
