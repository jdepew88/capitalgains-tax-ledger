import { describe, expect, it } from "vitest";
import {
  centuryLabel, centuryOf, datePrecision, dateSortKey, decadeLabel, decadeStart, formatPartialDate, validatePartialDate,
} from "../shared/dates";
import { attachmentPath, csvCell, itemsToCsv, safeFilename } from "../shared/export";
import { buildGroups, computeTotals, filterItems, NO_FILTERS, sortItems, type GroupNode } from "../shared/ledger";
import { centsToInput, formatCents, parseMoneyToCents } from "../shared/money";
import type { Item } from "../shared/types";
import { validateItemInput } from "../shared/validate";
import { parseTranscript } from "../shared/voice";

const NOW = new Date("2026-10-27T12:00:00Z");
let seq = 0;
function item(p: Partial<Item>): Item {
  seq++;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`, title: `Item ${seq}`, category: "other",
    year: 1959, month: null, day: null, costCents: 100, vendor: null, notes: "", status: "needs_review",
    basisCents: null, adjustmentReason: null, version: 1, createdAt: "", updatedAt: "", createdBy: "a", updatedBy: "a",
    deletedAt: null, documents: [], ...p,
  };
}
const doc = (itemId = "x") => ({
  id: "11111111-1111-4111-8111-111111111111", itemId, filename: "Receipt.JPG", contentType: "image/jpeg" as const,
  sizeBytes: 10, createdAt: "2026-01-01T00:00:00Z", createdBy: "a", deletedAt: null,
});

describe("partial dates", () => {
  it("keeps precision without inventing parts", () => {
    expect(datePrecision({ year: 1959, month: null, day: null })).toBe("year");
    expect(datePrecision({ year: 1959, month: 2, day: null })).toBe("month");
    expect(datePrecision({ year: 1959, month: 2, day: 2 })).toBe("day");
    expect(formatPartialDate({ year: 1959, month: null, day: null })).toBe("1959");
    expect(formatPartialDate({ year: 1959, month: 2, day: null })).toBe("February 1959");
    expect(formatPartialDate({ year: 1959, month: 2, day: 2 })).toBe("February 2, 1959");
  });
  it("rejects impossible dates", () => {
    expect(validatePartialDate({ year: 1959, month: 2, day: 29 }, NOW)).toMatch(/only 28 days/);
    expect(validatePartialDate({ year: 1960, month: 2, day: 29 }, NOW)).toBeNull();
    expect(validatePartialDate({ year: 1900, month: 2, day: 29 }, NOW)).toMatch(/28/); // not a leap year
    expect(validatePartialDate({ year: 2000, month: 2, day: 29 }, NOW)).toBeNull(); // is a leap year
    expect(validatePartialDate({ year: 1959, month: 4, day: 31 }, NOW)).toMatch(/30 days/);
    expect(validatePartialDate({ year: 1959, month: 13, day: null }, NOW)).not.toBeNull();
    expect(validatePartialDate({ year: 1959, month: null, day: 5 }, NOW)).toMatch(/month/);
    expect(validatePartialDate({ year: 1799, month: null, day: null }, NOW)).not.toBeNull();
    expect(validatePartialDate({ year: 2028, month: null, day: null }, NOW)).not.toBeNull();
    expect(validatePartialDate({ year: 1959.5, month: null, day: null }, NOW)).not.toBeNull();
  });
  it("sorts year-only before month before exact date in the same year", () => {
    const a = dateSortKey({ year: 1959, month: null, day: null });
    const b = dateSortKey({ year: 1959, month: 2, day: null });
    const c = dateSortKey({ year: 1959, month: 2, day: 2 });
    expect(a < b && b < c).toBe(true);
    expect(c < dateSortKey({ year: 1960, month: null, day: null })).toBe(true);
  });
});

describe("decades and centuries", () => {
  it("uses ordinary decades", () => {
    expect(decadeStart(1950)).toBe(1950);
    expect(decadeStart(1959)).toBe(1950);
    expect(decadeStart(1960)).toBe(1960);
    expect(decadeLabel(1950)).toBe("1950–1959");
  });
  it("uses accurate century boundaries", () => {
    expect(centuryOf(1900)).toBe(19);
    expect(centuryOf(1901)).toBe(20);
    expect(centuryOf(2000)).toBe(20);
    expect(centuryOf(2001)).toBe(21);
    expect(centuryOf(2100)).toBe(21);
    expect(centuryLabel(20)).toBe("20th century (1901–2000)");
    expect(centuryLabel(21)).toBe("21st century (2001–2100)");
  });
});

describe("money", () => {
  it("parses typed amounts into integer cents", () => {
    expect(parseMoneyToCents("$7,200")).toBe(720000);
    expect(parseMoneyToCents("7200")).toBe(720000);
    expect(parseMoneyToCents("7200.5")).toBe(720050);
    expect(parseMoneyToCents("1,234.56")).toBe(123456);
    expect(parseMoneyToCents(".99")).toBe(99);
    expect(parseMoneyToCents("0.10")).toBe(10);
  });
  it("rejects invalid amounts", () => {
    for (const bad of ["", "-5", "abc", "1.234", "12,34", "1e5", "$", "7,2000", "100000000.01", "NaN"]) {
      expect(parseMoneyToCents(bad), bad).toBeNull();
    }
  });
  it("formats without float drift", () => {
    expect(formatCents(720000)).toBe("$7,200.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(10 + 20)).toBe("$0.30");
    expect(centsToInput(720050)).toBe("7200.50");
    expect(centsToInput(720000)).toBe("7200");
  });
});

describe("validation", () => {
  const ok = { title: " New roof ", category: "roofing", year: 1959, month: 2, day: 2, costCents: 720000, notes: "", status: "needs_review" };
  it("accepts a valid record and starts it as needs review", () => {
    const r = validateItemInput({ ...ok, status: undefined }, NOW);
    expect(r.ok && r.value.status).toBe("needs_review");
    expect(r.ok && r.value.title).toBe("New roof");
  });
  it("rejects invalid values", () => {
    const bad = (patch: object) => validateItemInput({ ...ok, ...patch }, NOW).ok;
    expect(bad({ title: "" })).toBe(false);
    expect(bad({ category: "spaceship" })).toBe(false);
    expect(bad({ day: 30 })).toBe(false); // Feb 30
    expect(bad({ costCents: 12.5 })).toBe(false);
    expect(bad({ costCents: -1 })).toBe(false);
    expect(bad({ costCents: "7200" })).toBe(false);
    expect(bad({ status: "irs_approved" })).toBe(false);
    expect(bad({ month: null, day: 2 })).toBe(false);
  });
  it("drops a basis amount unless the record is approved", () => {
    const r = validateItemInput({ ...ok, basisCents: 5000 }, NOW);
    expect(r.ok && r.value.basisCents).toBeNull();
    const r2 = validateItemInput({ ...ok, status: "approved", basisCents: 5000 }, NOW);
    expect(r2.ok && r2.value.basisCents).toBe(5000);
  });
});

describe("totals and grouping", () => {
  const items = [
    item({ year: 1900, costCents: 1000 }),
    item({ year: 1901, costCents: 2000, status: "approved" }),
    item({ year: 1959, costCents: 720000, status: "approved", basisCents: 700000, documents: [doc()] }),
    item({ year: 1959, month: 6, costCents: 333, status: "excluded" }),
    item({ year: 2000, costCents: 50000 }),
    item({ year: 2001, costCents: 1 }),
    item({ year: 2009, costCents: 2 }),
  ];

  it("computes separate totals by status", () => {
    const t = computeTotals(items);
    expect(t.count).toBe(7);
    expect(t.recordedCents).toBe(1000 + 2000 + 720000 + 333 + 50000 + 1 + 2);
    expect(t.awaitingCents).toBe(1000 + 50000 + 1 + 2);
    expect(t.awaitingCount).toBe(4);
    expect(t.approvedBasisCents).toBe(2000 + 700000); // basis amount when entered, otherwise cost
    expect(t.excludedCents).toBe(333);
    expect(t.missingDocsCount).toBe(6);
  });

  it("never double-counts the same record", () => {
    expect(computeTotals([...items, items[2]]).recordedCents).toBe(computeTotals(items).recordedCents);
  });

  const sumLeaves = (nodes: GroupNode[]): number =>
    nodes.reduce((n, g) => n + (g.children.length ? sumLeaves(g.children) : g.totals.recordedCents), 0);

  it("gives the same overall total under every grouping", () => {
    const overall = computeTotals(items).recordedCents;
    for (const g of ["year", "decade", "century"] as const) {
      const groups = buildGroups(items, g);
      expect(groups.reduce((n, x) => n + x.totals.recordedCents, 0), g).toBe(overall);
      expect(sumLeaves(groups), g).toBe(overall);
    }
    expect(buildGroups(items, "all")).toEqual([]);
  });

  it("puts boundary years in the correct century and decade", () => {
    const centuries = buildGroups(items, "century");
    expect(centuries.map((c) => c.label)).toEqual([
      "19th century (1801–1900)", "20th century (1901–2000)", "21st century (2001–2100)",
    ]);
    expect(centuries[0].totals.count).toBe(1); // 1900
    expect(centuries[1].totals.count).toBe(4); // 1901, 1959 x2, 2000
    expect(centuries[2].totals.count).toBe(2); // 2001, 2009
    // Drill down: century -> decade -> year -> items.
    const c20 = centuries[1];
    expect(c20.children.map((d) => d.label)).toEqual(["1900–1909", "1950–1959", "2000–2009"]);
    const d2000in20 = c20.children[2];
    expect(d2000in20.note).toBe("only 2000 falls in this century");
    expect(d2000in20.children[0].items.map((i) => i.year)).toEqual([2000]);
    const d1900in20 = c20.children[0];
    expect(d1900in20.note).toBe("only 1901–1909 fall in this century");
    const d2000in21 = centuries[2].children[0];
    expect(d2000in21.label).toBe("2000–2009");
    expect(d2000in21.note).toBe("only 2001–2009 fall in this century");
    expect(d2000in21.totals.count).toBe(2);
    // Decade grouping is computed independently: 2000–2009 holds all three years.
    const decades = buildGroups(items, "decade");
    expect(decades.find((d) => d.label === "2000–2009")!.totals.count).toBe(3);
    expect(decades.find((d) => d.label === "1900–1909")!.totals.count).toBe(2);
    expect(decades.find((d) => d.label === "1950–1959")!.children[0].items).toHaveLength(2);
  });
});

describe("filters and sorting", () => {
  const items = [
    item({ title: "New roof", category: "roofing", year: 1959, month: 2, day: 2, costCents: 720000 }),
    item({ title: "Water heater", category: "plumbing", year: 1972, costCents: 45000, vendor: "Acme Plumbing", documents: [doc()] }),
    item({ title: "Fence", category: "landscaping", year: 1951, notes: "cedar along the back", costCents: 90000, status: "approved" }),
  ];
  it("searches titles, notes, categories and vendors", () => {
    expect(filterItems(items, { ...NO_FILTERS, search: "roof" }).map((i) => i.title)).toEqual(["New roof"]);
    expect(filterItems(items, { ...NO_FILTERS, search: "cedar" }).map((i) => i.title)).toEqual(["Fence"]);
    expect(filterItems(items, { ...NO_FILTERS, search: "acme" }).map((i) => i.title)).toEqual(["Water heater"]);
    expect(filterItems(items, { ...NO_FILTERS, search: "landscaping" }).map((i) => i.title)).toEqual(["Fence"]);
  });
  it("filters by decade, year, status and missing documents", () => {
    expect(filterItems(items, { ...NO_FILTERS, decade: 1950 })).toHaveLength(2);
    expect(filterItems(items, { ...NO_FILTERS, year: 1972 })).toHaveLength(1);
    expect(filterItems(items, { ...NO_FILTERS, status: "approved" })).toHaveLength(1);
    expect(filterItems(items, { ...NO_FILTERS, missingDocsOnly: true })).toHaveLength(2);
  });
  it("sorts by date, amount, title and status", () => {
    expect(sortItems(items, { key: "date", dir: "asc" }).map((i) => i.year)).toEqual([1951, 1959, 1972]);
    expect(sortItems(items, { key: "amount", dir: "desc" }).map((i) => i.costCents)).toEqual([720000, 90000, 45000]);
    expect(sortItems(items, { key: "title", dir: "asc" }).map((i) => i.title)).toEqual(["Fence", "New roof", "Water heater"]);
    expect(sortItems(items, { key: "status", dir: "desc" })[0].status).toBe("approved");
  });
});

describe("voice transcript parsing", () => {
  it("parses the example sentence", () => {
    const d = parseTranscript("Home improvement, 1959, February 2nd, $7,200, new roof.", NOW);
    expect(d).toMatchObject({ category: "roofing", year: 1959, month: 2, day: 2, costCents: 720000, title: "New roof" });
    expect(d.missing).toEqual([]);
    expect(d.uncertain).toEqual([]);
  });
  it("handles speech without punctuation and spelled-out numbers", () => {
    const d = parseTranscript("home improvement nineteen fifty nine february second seven thousand two hundred dollars new roof", NOW);
    expect(d).toMatchObject({ year: 1959, month: 2, day: 2, costCents: 720000, category: "roofing", title: "New roof" });
  });
  it("handles cents and other date shapes", () => {
    const d = parseTranscript("water heater 3/15/1972 450 dollars and 25 cents", NOW);
    expect(d).toMatchObject({ year: 1972, month: 3, day: 15, costCents: 45025, category: "plumbing", title: "Water heater" });
    const e = parseTranscript("the 21st of June 1985, $1,200.50 for storm windows", NOW);
    expect(e).toMatchObject({ year: 1985, month: 6, day: 21, costCents: 120050, category: "windows_doors", title: "Storm windows" });
  });
  it("keeps month-only and year-only precision", () => {
    expect(parseTranscript("March 1961 new furnace $800", NOW)).toMatchObject({ year: 1961, month: 3, day: null, category: "heating_cooling" });
    expect(parseTranscript("1961 new furnace $800", NOW)).toMatchObject({ year: 1961, month: null, day: null });
  });
  it("does not invent missing amounts or dates", () => {
    const d = parseTranscript("new roof", NOW);
    expect(d.costCents).toBeNull();
    expect(d.year).toBeNull();
    expect(d.missing).toEqual(expect.arrayContaining(["date", "costCents"]));
  });
  it("flags an amount said without dollars as uncertain", () => {
    const d = parseTranscript("1959 new roof 7200", NOW);
    expect(d.costCents).toBe(720000);
    expect(d.uncertain).toContain("costCents");
  });
  it("flags an impossible day and drops it", () => {
    const d = parseTranscript("February 30th 1959 $100 roof repair", NOW);
    expect(d.day).toBeNull();
    expect(d.month).toBe(2);
    expect(d.uncertain).toContain("date");
  });
  it("flags generic 'home improvement' as an uncertain category", () => {
    const d = parseTranscript("home improvement 1980 $500 misc work", NOW);
    expect(d.category).toBe("general");
    expect(d.uncertain).toContain("category");
  });
  it("does not treat the word 'may' as a month without a year next to it", () => {
    const d = parseTranscript("1990 $300 may need new gutters", NOW);
    expect(d.month).toBeNull();
  });
});

describe("CSV export", () => {
  it("neutralises spreadsheet formulas", () => {
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tx")).toBe("'\tx");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell(42)).toBe("42");
  });
  it("includes record ids and attachment paths", () => {
    const it1 = item({ title: "New roof", year: 1959, month: 2, day: 2, costCents: 720000, notes: "=cmd", documents: [doc()] });
    const csv = itemsToCsv([it1]);
    expect(csv.startsWith("﻿record_id,")).toBe(true);
    expect(csv).toContain(it1.id);
    expect(csv).toContain("attachments/1950-1959/1959/1959-02-02 new-roof [00000000]/01 Receipt.jpg");
    expect(csv).toContain("'=cmd");
    expect(csv).toContain("7200.00");
    expect(csv).toContain("Exact date");
  });
  it("makes safe filenames", () => {
    expect(safeFilename("../../etc/passwd")).toBe("etc_passwd");
    expect(safeFilename("<script>.pdf")).toBe("script_.pdf");
    expect(safeFilename("")).toBe("document");
    const p = attachmentPath(item({ title: "Ünïcode / roof", year: 2001 }), { ...doc(), filename: "a\"b.pdf", contentType: "application/pdf" }, 2);
    expect(p).toMatch(/^attachments\/2000-2009\/2001\/2001 unicode-roof \[[0-9a-f]{8}\]\/03 a_b\.pdf$/);
  });
});
