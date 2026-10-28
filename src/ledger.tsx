import { useMemo, useState } from "preact/hooks";
import { decadeLabel, decadeStart } from "../shared/dates";
import {
  buildGroups, computeTotals, describeFilters, effectiveBasisCents, filterItems, NO_FILTERS, sortItems,
  type GroupNode, type Grouping, type SortKey, type Totals,
} from "../shared/ledger";
import { formatCents } from "../shared/money";
import { activeDocuments, CATEGORIES, categoryLabel, STATUSES, statusLabel, type Item, type ReviewStatus } from "../shared/types";
import { submitExport } from "./api";
import type { ViewState } from "./app";
import { DateText, Money, StatusBadge } from "./ui";

export function LedgerPage(props: { items: Item[]; view: ViewState; setView: (p: Partial<ViewState>) => void; refresh: () => void }) {
  const { items, view, setView } = props;
  const f = view.filters;
  const setFilters = (patch: Partial<typeof f>) => setView({ filters: { ...f, ...patch } });

  const filtered = useMemo(() => sortItems(filterItems(items, f), view.sort), [items, f, view.sort]);
  const totals = useMemo(() => computeTotals(filtered), [filtered]);
  const groups = useMemo(
    () => buildGroups(filtered, view.grouping, view.sort.key === "date" ? view.sort.dir : "asc"),
    [filtered, view.grouping, view.sort],
  );
  const isFiltered = JSON.stringify(f) !== JSON.stringify(NO_FILTERS);
  const filterParts = describeFilters(f, statusLabel);

  if (items.length === 0) return <><Workflow items={items} view={view} setFilters={setFilters} /><EmptyState /></>;

  const defaultOpen = filtered.length <= 40 || f.year !== null || f.decade !== null;
  const isOpen = (key: string) => view.expanded[key] ?? defaultOpen;
  const toggle = (key: string) => setView({ expanded: { ...view.expanded, [key]: !isOpen(key) } });
  const setAll = (open: boolean) => {
    const all: Record<string, boolean> = {};
    const walk = (nodes: GroupNode[]) => nodes.forEach((n) => { all[n.key] = open; walk(n.children); });
    walk(groups);
    setView({ expanded: all });
  };
  const sortBy = (key: SortKey) =>
    setView({ sort: { key, dir: view.sort.key === key && view.sort.dir === "asc" ? "desc" : "asc" } });

  return (
    <>
      <Workflow items={items} view={view} setFilters={setFilters} />

      <section class="panel" aria-labelledby="totals-h">
        <h2 id="totals-h">{isFiltered ? "Totals for the records shown" : "Totals for all records"}</h2>
        <p class="scope-note">
          {isFiltered
            ? <>Showing <strong>{filtered.length}</strong> of {items.length} record{items.length === 1 ? "" : "s"}: {filterParts.join(", ")}. These totals include only the records shown.</>
            : <>Including {items.length === 1 ? "the only" : "all"} <strong>{items.length}</strong> record{items.length === 1 ? "" : "s"}. Items in the Trash are never counted.</>}
        </p>
        <TotalsGrid t={totals} />
      </section>

      <section class="panel" aria-labelledby="browse-h">
        <h2 id="browse-h">Find and browse</h2>
        <div class="toolbar">
          <label class="field grow">
            <span class="label">Search</span>
            <input type="search" value={f.search} placeholder="Title, notes, category or vendor" onInput={(e) => setFilters({ search: e.currentTarget.value })} />
          </label>
          <label class="field">
            <span class="label">Category</span>
            <select value={f.category ?? ""} onChange={(e) => setFilters({ category: e.currentTarget.value || null })}>
              <option value="">All categories</option>
              {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </label>
          <label class="field">
            <span class="label">Review status</span>
            <select value={f.status ?? ""} onChange={(e) => setFilters({ status: (e.currentTarget.value || null) as ReviewStatus | null })}>
              <option value="">Any status</option>
              {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
          <label class="field">
            <span class="label">Sort by</span>
            <select value={`${view.sort.key}:${view.sort.dir}`} onChange={(e) => {
              const [key, dir] = e.currentTarget.value.split(":") as [SortKey, "asc" | "desc"];
              setView({ sort: { key, dir } });
            }}>
              <option value="date:asc">Date (oldest first)</option>
              <option value="date:desc">Date (newest first)</option>
              <option value="amount:desc">Amount (largest first)</option>
              <option value="amount:asc">Amount (smallest first)</option>
              <option value="title:asc">Name (A–Z)</option>
              <option value="title:desc">Name (Z–A)</option>
              <option value="status:asc">Review status</option>
            </select>
          </label>
          <label class="check toolbar-check">
            <input type="checkbox" checked={f.missingDocsOnly} onChange={(e) => setFilters({ missingDocsOnly: e.currentTarget.checked })} />
            Only items missing documents
          </label>
          {isFiltered && <button type="button" class="btn btn-quiet" onClick={() => setView({ filters: NO_FILTERS })}>Clear all filters</button>}
        </div>

        <div class="group-controls">
          <span class="label" id="group-label">Group by</span>
          <div class="segmented" role="radiogroup" aria-labelledby="group-label">
            {(["year", "decade", "century", "all"] as Grouping[]).map((g) => (
              <button type="button" key={g} role="radio" aria-checked={view.grouping === g} class={view.grouping === g ? "on" : ""} onClick={() => setView({ grouping: g })}>
                {g === "all" ? "No grouping" : g[0].toUpperCase() + g.slice(1)}
              </button>
            ))}
          </div>
          {view.grouping !== "all" && (
            <span class="expand-all">
              <button type="button" class="link-btn" onClick={() => setAll(true)}>Expand all</button>
              <button type="button" class="link-btn" onClick={() => setAll(false)}>Collapse all</button>
            </span>
          )}
        </div>

        {filtered.length === 0 ? (
          <p class="empty-filter">No records match these filters. <button class="link-btn" onClick={() => setView({ filters: NO_FILTERS })}>Clear filters</button></p>
        ) : view.grouping === "all" ? (
          <ItemTable items={filtered} sort={view.sort} sortBy={sortBy} />
        ) : (
          <div class="groups">
            {groups.map((g) => <Group key={g.key} node={g} isOpen={isOpen} toggle={toggle} sort={view.sort} sortBy={sortBy} />)}
          </div>
        )}
      </section>

      <ExportPanel all={items} filtered={filtered} isFiltered={isFiltered} description={filterParts.join(", ")} />
    </>
  );
}

function Workflow(props: { items: Item[]; view: ViewState; setFilters: (p: Partial<ViewState["filters"]>) => void }) {
  const { items, view, setFilters } = props;
  const [showOlder, setShowOlder] = useState(false);
  const thisYear = new Date().getFullYear();
  const counts = useMemo(() => {
    const byDecade = new Map<number, number>();
    const byYear = new Map<number, number>();
    for (const i of items) {
      byDecade.set(decadeStart(i.year), (byDecade.get(decadeStart(i.year)) ?? 0) + 1);
      byYear.set(i.year, (byYear.get(i.year) ?? 0) + 1);
    }
    return { byDecade, byYear };
  }, [items]);

  const decades: number[] = [];
  for (let d = 1900; d <= decadeStart(thisYear); d += 10) decades.push(d);
  const older: number[] = [];
  for (let d = 1800; d < 1900; d += 10) older.push(d);
  const olderWithRecords = older.filter((d) => counts.byDecade.has(d));
  const shownOlder = showOlder ? older : olderWithRecords;
  const selDecade = view.filters.year !== null ? decadeStart(view.filters.year) : view.filters.decade;

  return (
    <section class="panel workflow" aria-labelledby="wf-h">
      <h1 id="wf-h" class="visually-hidden">Ledger</h1>
      <h2 class="step"><span class="step-n">1</span> Choose a decade</h2>
      <div class="chips" role="group" aria-label="Decades">
        {[...shownOlder, ...decades].map((d) => (
          <button type="button" key={d} class={`chip${selDecade === d ? " on" : ""}`} aria-pressed={selDecade === d}
            onClick={() => setFilters(selDecade === d ? { decade: null, year: null } : { decade: d, year: null })}>
            {d}s{counts.byDecade.get(d) ? <span class="chip-count">{counts.byDecade.get(d)}</span> : null}
          </button>
        ))}
        {!showOlder && <button type="button" class="chip chip-quiet" onClick={() => setShowOlder(true)}>1800s…</button>}
      </div>

      {selDecade !== null && (
        <>
          <h2 class="step"><span class="step-n">2</span> Choose a year in {decadeLabel(selDecade)}</h2>
          <div class="chips" role="group" aria-label="Years">
            {Array.from({ length: 10 }, (_, i) => selDecade + i).filter((y) => y <= thisYear + 1).map((y) => (
              <button type="button" key={y} class={`chip${view.filters.year === y ? " on" : ""}`} aria-pressed={view.filters.year === y}
                onClick={() => setFilters(view.filters.year === y ? { year: null, decade: selDecade } : { year: y, decade: null })}>
                {y}{counts.byYear.get(y) ? <span class="chip-count">{counts.byYear.get(y)}</span> : null}
              </button>
            ))}
          </div>
        </>
      )}

      <h2 class="step"><span class="step-n">{selDecade !== null ? 3 : 2}</span> Add an item</h2>
      <a class="btn btn-primary btn-big" href={view.filters.year ? `#/new?year=${view.filters.year}` : "#/new"}>
        + New item{view.filters.year ? ` for ${view.filters.year}` : ""}
      </a>
      {selDecade !== null && view.filters.year === null && <p class="muted small">Pick a year above to fill it in automatically, or enter it on the form.</p>}
    </section>
  );
}

function EmptyState() {
  return (
    <section class="panel empty-state">
      <h2>No records yet</h2>
      <p>This ledger keeps home improvement records and their receipts together for the tax preparer.</p>
      <ol>
        <li>Pick the decade and year of the paperwork above (or skip this).</li>
        <li>Tap <strong>New item</strong> and enter a short name, the date (just the year is fine), the amount and a category.</li>
        <li>Tap <strong>Take photo</strong> to photograph the receipt, or <strong>Add files</strong> for existing photos or PDFs.</li>
        <li>Tap <strong>Save</strong>. You can come back to fix anything or add more documents.</li>
      </ol>
      <p><a href="#/about">Why we keep these records →</a></p>
    </section>
  );
}

export function TotalsGrid({ t }: { t: Totals }) {
  return (
    <dl class="totals">
      <div><dt>All recorded costs</dt><dd><Money cents={t.recordedCents} /></dd><dd class="sub">{t.count} item{t.count === 1 ? "" : "s"}</dd></div>
      <div><dt>Awaiting review</dt><dd><Money cents={t.awaitingCents} /></dd><dd class="sub">{t.awaitingCount} item{t.awaitingCount === 1 ? "" : "s"}</dd></div>
      <div><dt>Approved basis amounts</dt><dd><Money cents={t.approvedBasisCents} /></dd><dd class="sub">{t.approvedCount} item{t.approvedCount === 1 ? "" : "s"} · our review</dd></div>
      <div><dt>Excluded costs</dt><dd><Money cents={t.excludedCents} /></dd><dd class="sub">{t.excludedCount} item{t.excludedCount === 1 ? "" : "s"}</dd></div>
      <div class={t.missingDocsCount ? "warn" : ""}><dt>Items missing documents</dt><dd>{t.missingDocsCount}</dd><dd class="sub">of {t.count}</dd></div>
      <p class="totals-note">Recorded costs are what was paid — not tax savings. “Approved basis” uses the basis amount entered, or the amount paid if none was entered.</p>
    </dl>
  );
}

function GroupSummary({ t }: { t: Totals }) {
  return (
    <span class="group-summary">
      <span>{t.count} item{t.count === 1 ? "" : "s"}</span>
      <span>Recorded {formatCents(t.recordedCents)}</span>
      {t.approvedCount > 0 && <span>Approved basis {formatCents(t.approvedBasisCents)}</span>}
      {t.awaitingCount > 0 && <span class="awaiting">{t.awaitingCount} to review</span>}
      {t.missingDocsCount > 0 && <span class="missing">{t.missingDocsCount} missing docs</span>}
    </span>
  );
}

function Group(props: { node: GroupNode; isOpen: (k: string) => boolean; toggle: (k: string) => void; sort: ViewState["sort"]; sortBy: (k: SortKey) => void }) {
  const { node, isOpen, toggle } = props;
  const open = isOpen(node.key);
  const id = `g-${node.key.replace(/\//g, "-")}`;
  return (
    <div class={`group group-${node.level}`}>
      <button type="button" class="group-head" aria-expanded={open} aria-controls={id} onClick={() => toggle(node.key)}>
        <span class="chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span class="group-label">{node.label}{node.note && <span class="group-note"> ({node.note})</span>}</span>
        <GroupSummary t={node.totals} />
      </button>
      {open && (
        <div id={id} class="group-body">
          {node.children.length > 0
            ? node.children.map((c) => <Group key={c.key} {...props} node={c} />)
            : <ItemTable items={node.items} sort={props.sort} sortBy={props.sortBy} />}
        </div>
      )}
    </div>
  );
}

function ItemTable({ items, sort, sortBy }: { items: Item[]; sort: ViewState["sort"]; sortBy: (k: SortKey) => void }) {
  const th = (key: SortKey, label: string, cls = "") => (
    <th scope="col" class={cls} aria-sort={sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
      <button type="button" class="th-sort" onClick={() => sortBy(key)}>
        {label}{sort.key === key ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
      </button>
    </th>
  );
  return (
    <div class="table-wrap">
      <table class="ledger-table">
        <thead>
          <tr>
            {th("date", "Date")}
            {th("title", "Item")}
            <th scope="col">Category</th>
            <th scope="col">Vendor</th>
            {th("amount", "Amount paid", "num")}
            {th("status", "Review")}
            <th scope="col" class="num">Approved basis</th>
            <th scope="col" class="num">Docs</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => {
            const nDocs = activeDocuments(i).length;
            const basis = effectiveBasisCents(i);
            return (
              <tr key={i.id} onClick={(e) => { if (!(e.target as HTMLElement).closest("a")) location.hash = `#/item/${i.id}`; }}>
                <td data-label="Date"><DateText d={i} short /></td>
                <td data-label="Item" class="title-cell"><a href={`#/item/${i.id}`}>{i.title}</a></td>
                <td data-label="Category">{categoryLabel(i.category)}</td>
                <td data-label="Vendor">{i.vendor ?? <span class="muted">—</span>}</td>
                <td data-label="Amount paid" class="num"><Money cents={i.costCents} /></td>
                <td data-label="Review"><StatusBadge status={i.status} /></td>
                <td data-label="Approved basis" class="num">{basis === null ? <span class="muted">—</span> : <Money cents={basis} />}</td>
                <td data-label="Docs" class="num">{nDocs === 0 ? <span class="missing-badge">None</span> : nDocs}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ExportPanel(props: { all: Item[]; filtered: Item[]; isFiltered: boolean; description: string }) {
  const [scope, setScope] = useState<"filtered" | "all">(props.isFiltered ? "filtered" : "all");
  const effective = props.isFiltered ? scope : "all";
  const chosen = effective === "all" ? props.all : props.filtered;
  const docCount = chosen.reduce((n, i) => n + activeDocuments(i).length, 0);
  const desc = effective === "all" ? "All records" : `Filtered: ${props.description}`;
  const run = (kind: "csv" | "zip") =>
    submitExport(kind, effective === "all" ? "all" : "selected", effective === "all" ? [] : chosen.map((i) => i.id), desc);
  return (
    <section class="panel no-print" aria-labelledby="export-h">
      <h2 id="export-h">Export for the tax preparer</h2>
      {props.isFiltered ? (
        <fieldset class="export-scope">
          <legend class="label">What to include</legend>
          <label class="check"><input type="radio" name="scope" checked={scope === "filtered"} onChange={() => setScope("filtered")} />
            Only the {props.filtered.length} records shown ({props.description})</label>
          <label class="check"><input type="radio" name="scope" checked={scope === "all"} onChange={() => setScope("all")} />
            All {props.all.length} records</label>
        </fieldset>
      ) : (
        <p>Exports will include all <strong>{props.all.length}</strong> record{props.all.length === 1 ? "" : "s"}. Use the filters above to export fewer.</p>
      )}
      <div class="export-buttons">
        <button type="button" class="btn" onClick={() => run("csv")} disabled={chosen.length === 0}>Download spreadsheet (CSV)</button>
        <button type="button" class="btn" onClick={() => run("zip")} disabled={chosen.length === 0}>Download ZIP with documents ({docCount} files)</button>
        <a class="btn" href={`#/print?scope=${effective}`}>Printable summary</a>
      </div>
      <p class="muted small">
        The CSV lists each record’s ID and the file names of its documents. The ZIP adds the original documents in
        folders by decade, year and item, plus a report listing anything missing or that failed to copy.
      </p>
    </section>
  );
}
