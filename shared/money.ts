// Money is always integer cents. Never use floating point for totals.

import { MAX_COST_CENTS } from "./types";

/**
 * Parses what a person types ("$7,200", "7200.5", "1,234.56") into integer cents.
 * Returns null for anything that isn't a clear, non-negative dollar amount.
 */
export function parseMoneyToCents(input: string): number | null {
  let s = input.trim().replace(/^\$\s*/, "").replace(/\s*(dollars?|usd)$/i, "").trim();
  if (s === "") return null;
  // Commas are allowed only as thousands separators.
  if (s.includes(",")) {
    if (!/^\d{1,3}(,\d{3})+(\.\d{0,2})?$/.test(s)) return null;
    s = s.replace(/,/g, "");
  }
  const m = /^(\d+)(?:\.(\d{0,2}))?$/.exec(s) ?? /^()\.(\d{1,2})$/.exec(s);
  if (!m) return null;
  const whole = m[1] === "" ? 0 : Number(m[1]);
  const frac = Number((m[2] ?? "").padEnd(2, "0") || "0");
  if (!Number.isSafeInteger(whole)) return null;
  const cents = whole * 100 + frac;
  if (!Number.isSafeInteger(cents) || cents > MAX_COST_CENTS) return null;
  return cents;
}

export function isValidCents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COST_CENTS;
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** "$7,200.00" — formats integer cents without float rounding drift. */
export function formatCents(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rem = abs % 100;
  const whole = usd.format(dollars).replace(/\.00$/, "");
  return `${negative ? "-" : ""}${whole}.${String(rem).padStart(2, "0")}`;
}

/** "7200.00" — plain number for spreadsheets. */
export function centsToPlain(cents: number): string {
  const dollars = Math.floor(Math.abs(cents) / 100);
  const rem = Math.abs(cents) % 100;
  return `${cents < 0 ? "-" : ""}${dollars}.${String(rem).padStart(2, "0")}`;
}

/** For pre-filling an input: "7200" or "7200.50". */
export function centsToInput(cents: number | null): string {
  if (cents === null) return "";
  return cents % 100 === 0 ? String(cents / 100) : centsToPlain(cents);
}
