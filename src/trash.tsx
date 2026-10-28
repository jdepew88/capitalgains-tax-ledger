import { useEffect, useState } from "preact/hooks";
import type { Item } from "../shared/types";
import { activeDocuments } from "../shared/types";
import { api } from "./api";
import { DateText, Money, toast } from "./ui";

export function TrashPage({ onChanged }: { onChanged: () => void }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.listItems(true).then((r) => setItems(r.items)).catch((e) => setError(String(e.message ?? e)));
  useEffect(() => { load(); }, []);

  const restore = async (i: Item) => {
    try {
      await api.restoreItem(i.id);
      toast(`Restored “${i.title}”.`);
      load();
      onChanged();
    } catch (e) { toast(String((e as Error).message), "error"); }
  };

  const purge = async (i: Item) => {
    const n = i.documents.length;
    if (!confirm(`Delete “${i.title}” forever${n ? ` and its ${n} document${n === 1 ? "" : "s"}` : ""}? This can’t be undone.`)) return;
    if (!confirm("Are you sure? The record and its files will be permanently erased.")) return;
    try {
      await api.purgeItem(i.id);
      toast(`Deleted “${i.title}” permanently.`);
      load();
    } catch (e) { toast(String((e as Error).message), "error"); }
  };

  return (
    <section class="panel">
      <a class="back-link" href="#/">← Back to the ledger</a>
      <h1>Trash</h1>
      <p>Items moved to the Trash are kept, with their documents, until they’re restored or deleted forever. They aren’t counted in any totals or exports.</p>
      {error && <p class="banner banner-error">{error}</p>}
      {items === null && !error && <p>Loading…</p>}
      {items?.length === 0 && <p class="muted">The Trash is empty.</p>}
      <ul class="trash-list">
        {items?.map((i) => (
          <li key={i.id} class="trash-item">
            <div>
              <strong>{i.title}</strong> · <DateText d={i} short /> · <Money cents={i.costCents} />
              <div class="muted small">{activeDocuments(i).length} documents · moved to Trash {i.deletedAt ? new Date(i.deletedAt).toLocaleString() : ""}</div>
            </div>
            <div class="trash-actions">
              <button class="btn" onClick={() => restore(i)}>Restore</button>
              <button class="btn btn-quiet danger" onClick={() => purge(i)}>Delete forever</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
