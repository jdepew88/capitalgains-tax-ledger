import { Fragment } from "preact";
import { useMemo } from "preact/hooks";
import { formatPartialDate } from "../shared/dates";
import { buildGroups, computeTotals, describeFilters, filterItems, sortItems } from "../shared/ledger";
import { formatCents } from "../shared/money";
import { activeDocuments, categoryLabel, statusLabel, type Item } from "../shared/types";
import type { ViewState } from "./app";
import { TotalsGrid } from "./ledger";

export function PrintPage({ items, view, params }: { items: Item[]; view: ViewState; params: URLSearchParams }) {
  const scope = params.get("scope") === "filtered" ? "filtered" : "all";
  const chosen = useMemo(
    () => sortItems(scope === "all" ? items : filterItems(items, view.filters), { key: "date", dir: "asc" }),
    [items, view.filters, scope],
  );
  const totals = computeTotals(chosen);
  const decades = buildGroups(chosen, "decade");
  const outstanding = chosen.filter((i) => i.status === "needs_review" || activeDocuments(i).length === 0);
  const scopeText = scope === "all"
    ? "All records (items in the Trash are not included)."
    : `Only records matching: ${describeFilters(view.filters, statusLabel).join(", ") || "no filters"}.`;

  return (
    <article class="print-page">
      <div class="no-print print-actions">
        <a href="#/" class="back-link">← Back to the ledger</a>
        <button class="btn btn-primary" onClick={() => window.print()}>Print</button>
      </div>
      <h1>Joyce’s Home Ledger — summary</h1>
      <p>Prepared {new Date().toLocaleDateString(undefined, { dateStyle: "long" })}. <strong>Scope:</strong> {scopeText} {chosen.length} record{chosen.length === 1 ? "" : "s"}.</p>
      <p class="small">Recorded costs are amounts paid, not tax savings. “Approved for basis” reflects our own review for the tax preparer to confirm; it is not an IRS determination.</p>

      <h2>Totals</h2>
      <TotalsGrid t={totals} />

      <h2>By decade and year</h2>
      <table class="print-table">
        <thead>
          <tr><th>Period</th><th class="num">Items</th><th class="num">Recorded</th><th class="num">Awaiting review</th><th class="num">Approved basis</th><th class="num">Excluded</th><th class="num">Missing docs</th></tr>
        </thead>
        <tbody>
          {decades.map((d) => (
            <Fragment key={d.key}>
              <tr class="decade-row">
                <th scope="row">{d.label}</th>
                <Cells t={d.totals} />
              </tr>
              {d.children.map((y) => (
                <tr key={y.key} class="year-row">
                  <th scope="row">&nbsp;&nbsp;{y.label}</th>
                  <Cells t={y.totals} />
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>

      <h2>Outstanding: needs review or missing documents ({outstanding.length})</h2>
      {outstanding.length === 0 ? <p>None.</p> : (
        <table class="print-table">
          <thead><tr><th>Date</th><th>Item</th><th>Category</th><th class="num">Amount</th><th>Status</th><th>Documents</th><th>Record ID</th></tr></thead>
          <tbody>
            {outstanding.map((i) => (
              <tr key={i.id}>
                <td>{formatPartialDate(i, true)}</td>
                <td>{i.title}</td>
                <td>{categoryLabel(i.category)}</td>
                <td class="num">{formatCents(i.costCents)}</td>
                <td>{statusLabel(i.status)}</td>
                <td>{activeDocuments(i).length || "None"}</td>
                <td class="mono">{i.id.slice(0, 8)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </article>
  );
}

function Cells({ t }: { t: ReturnType<typeof computeTotals> }) {
  return (
    <>
      <td class="num">{t.count}</td>
      <td class="num">{formatCents(t.recordedCents)}</td>
      <td class="num">{formatCents(t.awaitingCents)}</td>
      <td class="num">{formatCents(t.approvedBasisCents)}</td>
      <td class="num">{formatCents(t.excludedCents)}</td>
      <td class="num">{t.missingDocsCount}</td>
    </>
  );
}
