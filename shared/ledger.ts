// Filtering, sorting, grouping and totals for the ledger. Pure functions, shared and unit-tested.

import {
  centuryLabel, centuryOf, centuryRange, dateSortKey, decadeLabel, decadeStart,
} from "./dates";
import { activeDocuments, categoryLabel, type Item, type ReviewStatus } from "./types";

export interface Totals {
  count: number;
  recordedCents: number;
  awaitingCount: number;
  awaitingCents: number;
  approvedCount: number;
  approvedBasisCents: number;
  excludedCount: number;
  excludedCents: number;
  missingDocsCount: number;
}

/** Basis used for "approved" records: the entered basis amount, or the recorded cost when none was entered. */
export function effectiveBasisCents(item: Pick<Item, "status" | "basisCents" | "costCents">): number | null {
  if (item.status !== "approved") return null;
  return item.basisCents ?? item.costCents;
}

export function emptyTotals(): Totals {
  return {
    count: 0, recordedCents: 0, awaitingCount: 0, awaitingCents: 0, approvedCount: 0,
    approvedBasisCents: 0, excludedCount: 0, excludedCents: 0, missingDocsCount: 0,
  };
}

export function computeTotals(items: readonly Item[]): Totals {
  const t = emptyTotals();
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) continue; // never double-count
    seen.add(item.id);
    t.count++;
    t.recordedCents += item.costCents;
    if (item.status === "needs_review") {
      t.awaitingCount++;
      t.awaitingCents += item.costCents;
    } else if (item.status === "approved") {
      t.approvedCount++;
      t.approvedBasisCents += effectiveBasisCents(item)!;
    } else {
      t.excludedCount++;
      t.excludedCents += item.costCents;
    }
    if (activeDocuments(item).length === 0) t.missingDocsCount++;
  }
  return t;
}

// --- Filters --------------------------------------------------------------

export interface Filters {
  search: string;
  decade: number | null;
  year: number | null;
  category: string | null;
  status: ReviewStatus | null;
  missingDocsOnly: boolean;
}

export const NO_FILTERS: Filters = {
  search: "", decade: null, year: null, category: null, status: null, missingDocsOnly: false,
};

export function filterItems(items: readonly Item[], f: Filters): Item[] {
  const words = f.search.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    if (f.year !== null && item.year !== f.year) return false;
    if (f.decade !== null && decadeStart(item.year) !== f.decade) return false;
    if (f.category !== null && item.category !== f.category) return false;
    if (f.status !== null && item.status !== f.status) return false;
    if (f.missingDocsOnly && activeDocuments(item).length > 0) return false;
    if (words.length) {
      const hay = [item.title, item.notes, item.vendor ?? "", categoryLabel(item.category), item.category]
        .join(" ").toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

/** Plain-English description of what a filtered subtotal includes. */
export function describeFilters(f: Filters, statusLabel: (s: string) => string): string[] {
  const parts: string[] = [];
  if (f.year !== null) parts.push(`year ${f.year}`);
  else if (f.decade !== null) parts.push(`the ${decadeLabel(f.decade)} decade`);
  if (f.category !== null) parts.push(`category “${categoryLabel(f.category)}”`);
  if (f.status !== null) parts.push(`status “${statusLabel(f.status)}”`);
  if (f.missingDocsOnly) parts.push("items with no documents attached");
  if (f.search.trim()) parts.push(`text matching “${f.search.trim()}”`);
  return parts;
}

// --- Sorting --------------------------------------------------------------

export type SortKey = "date" | "amount" | "title" | "status";
export interface Sort { key: SortKey; dir: "asc" | "desc" }

const STATUS_ORDER: Record<ReviewStatus, number> = { needs_review: 0, approved: 1, excluded: 2 };

export function sortItems(items: readonly Item[], sort: Sort): Item[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  const byDate = (a: Item, b: Item) => dateSortKey(a) - dateSortKey(b);
  const tie = (a: Item, b: Item) => byDate(a, b) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
  const primary: Record<SortKey, (a: Item, b: Item) => number> = {
    date: byDate,
    amount: (a, b) => a.costCents - b.costCents,
    title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
    status: (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
  };
  return [...items].sort((a, b) => sign * primary[sort.key](a, b) || tie(a, b));
}

// --- Grouping -------------------------------------------------------------

export type Grouping = "all" | "century" | "decade" | "year";
export type GroupLevel = "century" | "decade" | "year";

export interface GroupNode {
  key: string; // unique path, e.g. "c20/d1950/y1959"
  level: GroupLevel;
  label: string;
  note?: string;
  totals: Totals;
  children: GroupNode[];
  items: Item[]; // only filled at the deepest level
}

const LEVELS: Record<Grouping, GroupLevel[]> = {
  all: [],
  century: ["century", "decade", "year"],
  decade: ["decade", "year"],
  year: ["year"],
};

function groupValue(level: GroupLevel, year: number): number {
  if (level === "century") return centuryOf(year);
  if (level === "decade") return decadeStart(year);
  return year;
}

/**
 * Builds nested groups. Every level is calculated from each record's own year, so a record is
 * in exactly one group per level. Items keep the order they were given in (already sorted).
 * Groups are ordered by time in the direction given.
 */
export function buildGroups(items: readonly Item[], grouping: Grouping, dir: "asc" | "desc" = "asc"): GroupNode[] {
  return build(items, LEVELS[grouping], "", null, dir);
}

function build(
  items: readonly Item[], levels: GroupLevel[], parentKey: string, parentCentury: number | null, dir: "asc" | "desc",
): GroupNode[] {
  if (levels.length === 0) return [];
  const [level, ...rest] = levels;
  const buckets = new Map<number, Item[]>();
  for (const item of items) {
    const v = groupValue(level, item.year);
    const list = buckets.get(v);
    if (list) list.push(item);
    else buckets.set(v, [item]);
  }
  const values = [...buckets.keys()].sort((a, b) => (dir === "asc" ? a - b : b - a));
  return values.map((v) => {
    const groupItems = buckets.get(v)!;
    const key = `${parentKey}${parentKey ? "/" : ""}${level[0]}${v}`;
    const node: GroupNode = {
      key,
      level,
      label: level === "century" ? centuryLabel(v) : level === "decade" ? decadeLabel(v) : String(v),
      totals: computeTotals(groupItems),
      children: build(groupItems, rest, key, level === "century" ? v : parentCentury, dir),
      items: rest.length === 0 ? groupItems : [],
    };
    // A decade like 2000–2009 straddles two centuries (2000 is in the 20th, 2001+ in the 21st).
    if (level === "decade" && parentCentury !== null) {
      const [cStart, cEnd] = centuryRange(parentCentury);
      const from = Math.max(v, cStart);
      const to = Math.min(v + 9, cEnd);
      if (from !== v || to !== v + 9) {
        node.note = from === to ? `only ${from} falls in this century` : `only ${from}–${to} fall in this century`;
      }
    }
    return node;
  });
}
