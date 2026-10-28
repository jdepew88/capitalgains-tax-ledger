// CSV and ZIP exports. The ZIP streams attachments straight from R2 (stored, not recompressed),
// then writes the CSV and a report last so they can say exactly which files made it in.

import { Zip, ZipPassThrough, strToU8 } from "fflate";
import { attachmentPath, itemsToCsv } from "../shared/export";
import { computeTotals } from "../shared/ledger";
import { formatCents } from "../shared/money";
import { activeDocuments, type Item } from "../shared/types";
import type { DocumentRow } from "./db";

export interface ExportScope {
  kind: "all" | "selected";
  description: string; // human description from the app, e.g. "Filtered: 1950–1959 decade"
}

export function exportBaseName(now: Date): string {
  return `joyces-home-ledger-${now.toISOString().slice(0, 10)}`;
}

function scopeLines(items: Item[], scope: ExportScope, user: string, now: Date): string[] {
  const t = computeTotals(items);
  return [
    "Joyce's Home Ledger - export",
    `Exported: ${now.toISOString()} by ${user}`,
    `Scope: ${scope.kind === "all" ? "All records (deleted items in Trash are not included)" : "Selected records only"}`,
    scope.description ? `Selection: ${scope.description}` : "",
    `Records: ${t.count}`,
    `Recorded costs (all statuses): ${formatCents(t.recordedCents)}`,
    `Awaiting review: ${formatCents(t.awaitingCents)} (${t.awaitingCount} items)`,
    `Approved basis (our review, not an IRS determination): ${formatCents(t.approvedBasisCents)} (${t.approvedCount} items)`,
    `Excluded: ${formatCents(t.excludedCents)} (${t.excludedCount} items)`,
    `Items with no documents: ${t.missingDocsCount}`,
    "",
    "Recorded costs are not tax savings. The tax preparer decides how each item is treated.",
  ].filter((l, i, a) => l !== "" || a[i - 1] !== "");
}

export function csvResponse(items: Item[], now: Date): Response {
  return new Response(itemsToCsv(items), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportBaseName(now)}.csv"`,
    },
  });
}

export function zipResponse(
  items: Item[], docRows: Map<string, DocumentRow>, bucket: R2Bucket, scope: ExportScope, user: string, now: Date,
  waitUntil: (p: Promise<unknown>) => void,
): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  let failed = false;
  const zip = new Zip((err, chunk, final) => {
    if (err) { failed = true; writer.abort(err).catch(() => {}); return; }
    writer.write(chunk).catch(() => {});
    if (final) writer.close().catch(() => {});
  });
  const root = exportBaseName(now);

  const addText = (path: string, text: string) => {
    const f = new ZipPassThrough(`${root}/${path}`);
    zip.add(f);
    f.push(strToU8(text), true);
  };

  const run = async () => {
    const problems: string[] = [];
    const statuses = new Map<string, string>();
    let copied = 0;
    for (const item of items) {
      const docs = activeDocuments(item);
      const itemProblems: string[] = [];
      for (const [i, doc] of docs.entries()) {
        if (failed) return;
        const path = attachmentPath(item, doc, i);
        const row = docRows.get(doc.id);
        const obj = row ? await bucket.get(row.r2_key) : null;
        if (!obj) {
          itemProblems.push(`${path}: MISSING from storage`);
          continue;
        }
        const entry = new ZipPassThrough(`${root}/${path}`);
        entry.mtime = new Date(doc.createdAt);
        zip.add(entry);
        const reader = obj.body.getReader();
        try {
          for (;;) {
            await writer.ready; // backpressure: don't read faster than the browser downloads
            const { value, done } = await reader.read();
            if (done) break;
            entry.push(value, false);
          }
          entry.push(new Uint8Array(0), true);
          copied++;
        } catch (e) {
          entry.push(new Uint8Array(0), true);
          itemProblems.push(`${path}: FAILED while copying (file in ZIP is incomplete): ${String(e)}`);
        }
      }
      problems.push(...itemProblems);
      statuses.set(item.id, itemProblems.length ? `PROBLEM: ${itemProblems.join(" | ")}` : "ok — included in ZIP");
    }
    const totalDocs = items.reduce((n, i) => n + activeDocuments(i).length, 0);
    addText("records.csv", itemsToCsv(items, statuses));
    const report = [
      ...scopeLines(items, scope, user, now),
      "",
      `Attachments listed: ${totalDocs}`,
      `Attachments copied into this ZIP: ${copied}`,
      problems.length ? `PROBLEMS (${problems.length}):` : "No missing or failed attachments.",
      ...problems.map((p) => `  - ${p}`),
      "",
      "records.csv has one row per record. Its attachment_files column lists the paths of that",
      "record's documents inside the attachments/ folder, and record_id matches the folder suffix.",
    ].join("\r\n");
    addText("EXPORT-REPORT.txt", "﻿" + report + "\r\n"); // BOM so Windows Notepad reads UTF-8
    zip.end();
  };

  waitUntil(run().catch((e) => { failed = true; writer.abort(e).catch(() => {}); }));
  return new Response(readable, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${root}.zip"`,
    },
  });
}
