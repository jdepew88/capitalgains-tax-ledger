import { useEffect, useState } from "preact/hooks";
import { datePrecision, formatPartialDate, type PartialDate } from "../shared/dates";
import { formatCents } from "../shared/money";
import { statusLabel, type ReviewStatus } from "../shared/types";

// --- Toasts (saved confirmations etc.) -----------------------------------

type ToastMsg = { id: number; text: string; kind: "ok" | "error" };
let listeners: ((t: ToastMsg[]) => void)[] = [];
let toasts: ToastMsg[] = [];
let nextId = 1;

export function toast(text: string, kind: "ok" | "error" = "ok") {
  const t = { id: nextId++, text, kind };
  toasts = [...toasts, t];
  listeners.forEach((l) => l(toasts));
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    listeners.forEach((l) => l(toasts));
  }, kind === "error" ? 8000 : 4500);
}

export function Toasts() {
  const [list, setList] = useState<ToastMsg[]>(toasts);
  useEffect(() => {
    listeners.push(setList);
    return () => { listeners = listeners.filter((l) => l !== setList); };
  }, []);
  return (
    <div class="toasts no-print" role="status" aria-live="polite">
      {list.map((t) => <div key={t.id} class={`toast toast-${t.kind}`}>{t.kind === "ok" ? "✓ " : "⚠ "}{t.text}</div>)}
    </div>
  );
}

// --- Small display helpers -----------------------------------------------

export const Money = ({ cents }: { cents: number }) => <span class="money">{formatCents(cents)}</span>;

export function DateText({ d, short }: { d: PartialDate; short?: boolean }) {
  const p = datePrecision(d);
  return (
    <span class="date-text">
      {formatPartialDate(d, short)}
      {p !== "day" && <span class={`precision precision-${p}`} title={p === "year" ? "Only the year is known" : "Only the month and year are known"}>{p === "year" ? "year only" : "month only"}</span>}
    </span>
  );
}

export function StatusBadge({ status }: { status: ReviewStatus }) {
  return <span class={`badge badge-${status}`}>{statusLabel(status)}</span>;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
