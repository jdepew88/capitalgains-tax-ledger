// Types and constants shared by the Worker API and the browser app.

export const CATEGORIES = [
  { value: "roofing", label: "Roofing" },
  { value: "plumbing", label: "Plumbing" },
  { value: "electrical", label: "Electrical" },
  { value: "heating_cooling", label: "Heating & cooling" },
  { value: "windows_doors", label: "Windows & doors" },
  { value: "addition", label: "Addition" },
  { value: "kitchen_bath", label: "Kitchen & bath" },
  { value: "flooring", label: "Flooring" },
  { value: "landscaping", label: "Landscaping & yard" },
  { value: "general", label: "General home improvement" },
  { value: "other", label: "Other" },
] as const;

export type Category = (typeof CATEGORIES)[number]["value"];

export const STATUSES = [
  { value: "needs_review", label: "Needs review" },
  { value: "approved", label: "Approved for basis" },
  { value: "excluded", label: "Excluded" },
] as const;

export type ReviewStatus = (typeof STATUSES)[number]["value"];

export const ALLOWED_CONTENT_TYPES = ["image/jpeg", "image/png", "application/pdf"] as const;
export type AllowedContentType = (typeof ALLOWED_CONTENT_TYPES)[number];

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_DOCUMENTS_PER_ITEM = 60;
export const MAX_COST_CENTS = 10_000_000_000; // $100 million: anything larger is a typo.
export const MIN_YEAR = 1800;

export interface DocumentMeta {
  id: string;
  itemId: string;
  filename: string;
  contentType: AllowedContentType;
  sizeBytes: number;
  createdAt: string;
  createdBy: string;
  deletedAt: string | null;
}

/** Fields a person edits. */
export interface ItemInput {
  title: string;
  category: Category;
  year: number;
  month: number | null;
  day: number | null;
  costCents: number;
  vendor: string | null;
  notes: string;
  status: ReviewStatus;
  basisCents: number | null;
  adjustmentReason: string | null;
}

export interface Item extends ItemInput {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
  deletedAt: string | null;
  documents: DocumentMeta[];
}

export function categoryLabel(value: string): string {
  return CATEGORIES.find((c) => c.value === value)?.label ?? value;
}

export function statusLabel(value: string): string {
  return STATUSES.find((s) => s.value === value)?.label ?? value;
}

export function isCategory(value: unknown): value is Category {
  return CATEGORIES.some((c) => c.value === value);
}

export function isStatus(value: unknown): value is ReviewStatus {
  return STATUSES.some((s) => s.value === value);
}

export function activeDocuments(item: Pick<Item, "documents">): DocumentMeta[] {
  return item.documents.filter((d) => !d.deletedAt);
}
