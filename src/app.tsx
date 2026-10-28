import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { NO_FILTERS, type Filters, type Grouping, type Sort } from "../shared/ledger";
import type { Item } from "../shared/types";
import { api, ApiError } from "./api";
import { AboutPage } from "./about";
import { ItemForm } from "./item-form";
import { LedgerPage } from "./ledger";
import { PrintPage } from "./print";
import { TrashPage } from "./trash";
import { Toasts, toast } from "./ui";

export interface Route {
  page: "ledger" | "new" | "item" | "trash" | "about" | "print";
  id?: string;
  params: URLSearchParams;
}

export function parseHash(hash: string): Route {
  const [path, query = ""] = hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(query);
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "new") return { page: "new", params };
  if (parts[0] === "item" && parts[1]) return { page: "item", id: parts[1], params };
  if (parts[0] === "trash") return { page: "trash", params };
  if (parts[0] === "about") return { page: "about", params };
  if (parts[0] === "print") return { page: "print", params };
  return { page: "ledger", params };
}

export function go(hash: string) {
  location.hash = hash;
}

let lastHash = location.hash;
let navCount = 0;

/** Changes the address without navigating (e.g. a new item becomes an existing one after saving). */
export function replaceHash(hash: string) {
  history.replaceState(null, "", hash);
  lastHash = hash;
}

/** View settings worth keeping while moving between screens (per browser tab, best effort). */
export interface ViewState {
  filters: Filters;
  sort: Sort;
  grouping: Grouping;
  expanded: Record<string, boolean>;
}

const DEFAULT_VIEW: ViewState = { filters: NO_FILTERS, sort: { key: "date", dir: "asc" }, grouping: "decade", expanded: {} };

function loadView(): ViewState {
  try {
    const raw = sessionStorage.getItem("ledger-view");
    if (raw) return { ...DEFAULT_VIEW, ...JSON.parse(raw) };
  } catch { /* storage unavailable */ }
  return DEFAULT_VIEW;
}

export function App() {
  const [route, setRoute] = useState<Route & { n: number }>(() => ({ ...parseHash(location.hash), n: navCount }));
  const [items, setItems] = useState<Item[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [me, setMe] = useState<string>("");
  const [view, setViewState] = useState<ViewState>(loadView);
  const dirty = useRef(false);

  const setView = useCallback((patch: Partial<ViewState>) => {
    setViewState((v) => {
      const next = { ...v, ...patch };
      try { sessionStorage.setItem("ledger-view", JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { items } = await api.listItems();
      setItems(items);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : String(e));
    }
  }, []);

  const upsert = useCallback((item: Item) => {
    setItems((list) => {
      if (!list) return list;
      const others = list.filter((i) => i.id !== item.id);
      return item.deletedAt ? others : [...others, item];
    });
  }, []);

  const remove = useCallback((id: string) => setItems((list) => list?.filter((i) => i.id !== id) ?? list), []);

  useEffect(() => {
    refresh();
    api.me().then((r) => setMe(r.email)).catch(() => {});
  }, [refresh]);

  // Reload when coming back to the tab, so Joyce and helper see each other's changes.
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === "visible" && !dirty.current) refresh(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [refresh]);

  // Hash routing with an "unsaved changes" guard.
  useEffect(() => {
    const onHash = () => {
      if (dirty.current && !confirm("You have changes that aren’t saved. Leave without saving?")) {
        history.replaceState(null, "", lastHash || "#/");
        return;
      }
      dirty.current = false;
      lastHash = location.hash;
      setRoute({ ...parseHash(location.hash), n: ++navCount });
      window.scrollTo(0, 0);
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirty.current) { e.preventDefault(); e.returnValue = ""; }
    };
    window.addEventListener("hashchange", onHash);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, []);

  const setDirty = useCallback((d: boolean) => { dirty.current = d; }, []);

  const newItemHref = (() => {
    const y = view.filters.year;
    return y ? `#/new?year=${y}` : "#/new";
  })();

  let body;
  if (route.page === "about") body = <AboutPage />;
  else if (route.page === "trash") body = <TrashPage onChanged={refresh} />;
  else if (loadError && !items) {
    body = (
      <div class="panel error-panel" role="alert">
        <h2>Couldn’t load the records</h2>
        <p>{loadError}</p>
        <button class="btn" onClick={refresh}>Try again</button>
      </div>
    );
  } else if (!items) body = <p class="loading" aria-live="polite">Loading records…</p>;
  else if (route.page === "new") {
    const y = Number(route.params.get("year"));
    body = <ItemForm key={`new-${route.n}`} items={items} initialYear={Number.isInteger(y) && y > 0 ? y : null} onSaved={upsert} onRemoved={remove} setDirty={setDirty} />;
  } else if (route.page === "item") {
    const item = items.find((i) => i.id === route.id);
    body = item
      ? <ItemForm key={item.id} items={items} existing={item} onSaved={upsert} onRemoved={remove} setDirty={setDirty} />
      : <div class="panel"><h2>Item not found</h2><p>It may have been moved to the Trash.</p><a class="btn" href="#/">Back to the ledger</a></div>;
  } else if (route.page === "print") body = <PrintPage items={items} view={view} params={route.params} />;
  else body = <LedgerPage items={items} view={view} setView={setView} refresh={refresh} />;

  return (
    <>
      <a class="skip" href="#main">Skip to content</a>
      <header class="site-header no-print">
        <a class="brand" href="#/">Joyce’s Home Ledger</a>
        <nav aria-label="Main">
          <a href="#/" aria-current={route.page === "ledger" ? "page" : undefined}>Ledger</a>
          <a href="#/trash" aria-current={route.page === "trash" ? "page" : undefined}>Trash</a>
          <a href="#/about" aria-current={route.page === "about" ? "page" : undefined}>Why we keep these</a>
        </nav>
        <a class="btn btn-primary btn-new" href={newItemHref}>+ New item</a>
        {me && <span class="whoami" title="Signed in with Cloudflare Access">Signed in as {me}</span>}
      </header>
      <main id="main" tabIndex={-1}>{body}</main>
      <Toasts />
    </>
  );
}

export { toast };
