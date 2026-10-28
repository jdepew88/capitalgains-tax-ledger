// Validation used by both the server (authoritative) and the form (for friendly messages).

import { validatePartialDate } from "./dates";
import { isValidCents } from "./money";
import { isCategory, isStatus, type ItemInput } from "./types";

export type FieldErrors = Partial<Record<keyof ItemInput | "date", string>>;

export type ValidationResult =
  | { ok: true; value: ItemInput }
  | { ok: false; errors: FieldErrors };

const LIMITS = { title: 200, vendor: 200, notes: 10_000, adjustmentReason: 2_000 };

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return null;
  // Strip control characters other than newlines and tabs.
  return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
}

function intOrNull(v: unknown): number | null | undefined {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" && Number.isInteger(v)) return v;
  return undefined; // invalid
}

export function validateItemInput(raw: unknown, now: Date = new Date()): ValidationResult {
  const errors: FieldErrors = {};
  const r = (raw ?? {}) as Record<string, unknown>;

  const title = text(r.title) ?? "";
  if (!title) errors.title = "Enter a short name, like “New roof.”";
  else if (title.length > LIMITS.title) errors.title = `Keep the name under ${LIMITS.title} characters.`;

  const category = r.category;
  if (!isCategory(category)) errors.category = "Choose a category.";

  const year = typeof r.year === "number" ? r.year : NaN;
  const month = intOrNull(r.month);
  const day = intOrNull(r.day);
  if (month === undefined) errors.month = "Month is not valid.";
  if (day === undefined) errors.day = "Day is not valid.";
  if (month !== undefined && day !== undefined) {
    const dateError = validatePartialDate({ year, month, day }, now);
    if (dateError) errors.date = dateError;
  }

  const costCents = r.costCents;
  if (!isValidCents(costCents)) errors.costCents = "Enter the amount paid, like 7200 or 7,200.50.";

  const vendor = text(r.vendor) || null;
  if (vendor && vendor.length > LIMITS.vendor) errors.vendor = `Keep the vendor under ${LIMITS.vendor} characters.`;

  const notes = text(r.notes) ?? "";
  if (notes.length > LIMITS.notes) errors.notes = `Notes are limited to ${LIMITS.notes} characters.`;

  const status = r.status ?? "needs_review";
  if (!isStatus(status)) errors.status = "Choose a review status.";

  let basisCents: number | null = null;
  if (r.basisCents !== null && r.basisCents !== undefined) {
    if (!isValidCents(r.basisCents)) errors.basisCents = "Enter a valid basis amount, or leave it blank.";
    else basisCents = r.basisCents;
  }
  // A basis amount only means something for approved records; don't keep a stale one around.
  if (status !== "approved") basisCents = null;

  const adjustmentReason = text(r.adjustmentReason) || null;
  if (adjustmentReason && adjustmentReason.length > LIMITS.adjustmentReason) {
    errors.adjustmentReason = `Keep the reason under ${LIMITS.adjustmentReason} characters.`;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      title,
      category: category as ItemInput["category"],
      year,
      month: month as number | null,
      day: day as number | null,
      costCents: costCents as number,
      vendor,
      notes,
      status: status as ItemInput["status"],
      basisCents,
      adjustmentReason,
    },
  };
}
