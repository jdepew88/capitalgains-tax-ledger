// Partial dates: old paperwork may only show a year, or a month and year.
// We store year (required), month and day (optional) and never invent the missing parts.

import { MIN_YEAR } from "./types";

export type DatePrecision = "year" | "month" | "day";

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export interface PartialDate {
  year: number;
  month: number | null;
  day: number | null;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function maxYear(now: Date = new Date()): number {
  return now.getUTCFullYear() + 1;
}

/** Returns an error message, or null when the date is possible. */
export function validatePartialDate(d: PartialDate, now: Date = new Date()): string | null {
  const { year, month, day } = d;
  if (!Number.isInteger(year)) return "Enter a four-digit year.";
  if (year < MIN_YEAR || year > maxYear(now)) return `Year must be between ${MIN_YEAR} and ${maxYear(now)}.`;
  if (month !== null) {
    if (!Number.isInteger(month) || month < 1 || month > 12) return "Month must be January through December.";
  }
  if (day !== null) {
    if (month === null) return "Choose a month before choosing a day.";
    if (!Number.isInteger(day) || day < 1) return "Day must be a positive number.";
    const max = daysInMonth(year, month!);
    if (day > max) return `${MONTH_NAMES[month! - 1]} ${year} has only ${max} days.`;
  }
  return null;
}

export function datePrecision(d: PartialDate): DatePrecision {
  if (d.month === null) return "year";
  if (d.day === null) return "month";
  return "day";
}

export const PRECISION_LABEL: Record<DatePrecision, string> = {
  year: "Year only",
  month: "Month and year",
  day: "Exact date",
};

/** Human-readable date that never implies more precision than we have. */
export function formatPartialDate(d: PartialDate, short = false): string {
  if (d.month === null) return String(d.year);
  const name = MONTH_NAMES[d.month - 1];
  const m = short ? name.slice(0, 3) : name;
  if (d.day === null) return `${m} ${d.year}`;
  return `${m} ${d.day}, ${d.year}`;
}

/** ISO-like text for spreadsheets: 1959, 1959-02 or 1959-02-02. */
export function isoPartialDate(d: PartialDate): string {
  const y = String(d.year).padStart(4, "0");
  if (d.month === null) return y;
  const m = String(d.month).padStart(2, "0");
  if (d.day === null) return `${y}-${m}`;
  return `${y}-${m}-${String(d.day).padStart(2, "0")}`;
}

/** Sort key: year-only records sort before month records in the same year, which sort before exact dates in that month. */
export function dateSortKey(d: PartialDate): number {
  return d.year * 10000 + (d.month ?? 0) * 100 + (d.day ?? 0);
}

// --- Decades and centuries -------------------------------------------------

export function decadeStart(year: number): number {
  return Math.floor(year / 10) * 10;
}

export function decadeLabel(start: number): string {
  return `${start}–${start + 9}`;
}

/** Ordinal century: 1901–2000 is the 20th century, 2001–2100 the 21st. */
export function centuryOf(year: number): number {
  return Math.floor((year - 1) / 100) + 1;
}

export function centuryRange(century: number): [number, number] {
  return [(century - 1) * 100 + 1, century * 100];
}

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

export function centuryLabel(century: number): string {
  const [a, b] = centuryRange(century);
  return `${ordinal(century)} century (${a}–${b})`;
}
