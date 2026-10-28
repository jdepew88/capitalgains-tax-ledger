import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { datePrecision, daysInMonth, formatPartialDate, MONTH_NAMES, PRECISION_LABEL } from "../shared/dates";
import { centsToInput, formatCents, parseMoneyToCents } from "../shared/money";
import { CATEGORIES, STATUSES, type DocumentMeta, type Item, type ItemInput, type ReviewStatus } from "../shared/types";
import { validateItemInput, type FieldErrors } from "../shared/validate";
import { parseTranscript, type DraftField } from "../shared/voice";
import { api, ApiError, fileUrl, uploadDocument } from "./api";
import { go, replaceHash } from "./app";
import { prepareFile } from "./images";
import { listen, speechSupported, type Listening } from "./speech";
import { formatBytes, toast } from "./ui";

interface Fields {
  title: string; category: string; year: string; month: string; day: string; cost: string;
  vendor: string; notes: string; status: ReviewStatus; basis: string; reason: string;
}

function fieldsFrom(item: Item | undefined, year: number | null): Fields {
  if (!item) {
    return { title: "", category: "", year: year ? String(year) : "", month: "", day: "", cost: "", vendor: "", notes: "", status: "needs_review", basis: "", reason: "" };
  }
  return {
    title: item.title, category: item.category, year: String(item.year), month: item.month ? String(item.month) : "",
    day: item.day ? String(item.day) : "", cost: centsToInput(item.costCents), vendor: item.vendor ?? "", notes: item.notes,
    status: item.status, basis: centsToInput(item.basisCents), reason: item.adjustmentReason ?? "",
  };
}

type FieldKey = keyof FieldErrors;

/** Turns the form's text fields into an API input, with friendly messages for anything that won't parse. */
function toInput(f: Fields): { input?: ItemInput; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const year = /^\d{4}$/.test(f.year.trim()) ? Number(f.year.trim()) : NaN;
  if (Number.isNaN(year)) errors.date = "Enter the four-digit year, like 1959.";
  const cost = parseMoneyToCents(f.cost);
  if (cost === null) errors.costCents = f.cost.trim() ? "That doesn’t look like an amount. Use digits, like 7200 or 7,200.50." : "Enter the amount paid.";
  let basis: number | null = null;
  if (f.status === "approved" && f.basis.trim()) {
    basis = parseMoneyToCents(f.basis);
    if (basis === null) errors.basisCents = "That doesn’t look like an amount.";
  }
  const raw = {
    title: f.title, category: f.category || undefined, year, month: f.month ? Number(f.month) : null,
    day: f.day ? Number(f.day) : null, costCents: cost ?? undefined, vendor: f.vendor, notes: f.notes,
    status: f.status, basisCents: basis, adjustmentReason: f.reason,
  };
  const v = validateItemInput(raw);
  if (!v.ok) {
    // Prefer our own more specific messages for parse errors.
    for (const [k, msg] of Object.entries(v.errors)) if (!(k in errors)) errors[k as FieldKey] = msg;
    return { errors };
  }
  if (Object.keys(errors).length) return { errors };
  return { input: v.value, errors };
}

interface Upload {
  key: string;
  docId: string;
  original: File;
  source: "camera" | "files";
  blob?: Blob;
  filename: string;
  contentType?: string;
  previewUrl?: string;
  note?: string;
  status: "preparing" | "queued" | "uploading" | "error" | "done";
  progress: number;
  error?: string;
}

const FIELD_FOR_DRAFT: Record<DraftField, FieldKey> = { title: "title", category: "category", date: "date", costCents: "costCents" };

export function ItemForm(props: {
  items: Item[];
  existing?: Item;
  initialYear?: number | null;
  onSaved: (item: Item) => void;
  onRemoved: (id: string) => void;
  setDirty: (d: boolean) => void;
}) {
  const { existing, onSaved, setDirty } = props;
  const id = useMemo(() => existing?.id ?? crypto.randomUUID(), []);
  const [saved, setSaved] = useState<Item | null>(existing ?? null);
  const [fields, setFields] = useState<Fields>(() => fieldsFrom(existing, props.initialYear ?? null));
  const [baseline, setBaseline] = useState<Fields>(fields);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Item | null>(null);
  const [justSaved, setJustSaved] = useState<string | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [highlight, setHighlight] = useState<Partial<Record<FieldKey, string>>>({});
  const savingRef = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);

  const docs: DocumentMeta[] = saved?.documents ?? [];
  const activeDocs = docs.filter((d) => !d.deletedAt);
  const removedDocs = docs.filter((d) => d.deletedAt);

  const fieldsDirty = JSON.stringify(fields) !== JSON.stringify(baseline);
  const pendingUploads = uploads.some((u) => u.status !== "done");
  useEffect(() => { setDirty(fieldsDirty || pendingUploads); }, [fieldsDirty, pendingUploads]);
  useEffect(() => () => setDirty(false), []);

  const set = (patch: Partial<Fields>) => {
    setFields((f) => ({ ...f, ...patch }));
    setJustSaved(null);
    // Editing a highlighted field means the person has looked at it.
    const keys = Object.keys(patch);
    setHighlight((h) => {
      const next = { ...h };
      for (const k of keys) {
        const fk = (["year", "month", "day"].includes(k) ? "date" : k === "cost" ? "costCents" : k) as FieldKey;
        delete next[fk];
      }
      return next;
    });
  };

  // --- Uploads -------------------------------------------------------------

  const patchUpload = (key: string, patch: Partial<Upload>) =>
    setUploads((list) => list.map((u) => (u.key === key ? { ...u, ...patch } : u)));

  const uploadOne = async (u: Upload, itemId: string): Promise<DocumentMeta | null> => {
    if (!u.blob) return null;
    patchUpload(u.key, { status: "uploading", progress: 0, error: undefined });
    try {
      const res = await uploadDocument(itemId, u.docId, u.blob, u.filename, (p) => patchUpload(u.key, { progress: p }));
      patchUpload(u.key, { status: "done", progress: 1 });
      if (res.duplicate && res.document.id !== u.docId) toast(`“${u.filename}” was already attached, so it wasn’t added twice.`);
      return res.document;
    } catch (e) {
      patchUpload(u.key, { status: "error", error: e instanceof ApiError ? e.message : String(e) });
      return null;
    }
  };

  const latestSaved = useRef<Item | null>(saved);
  latestSaved.current = saved;

  const addDocToItem = (doc: DocumentMeta) => {
    const cur = latestSaved.current;
    if (!cur) return;
    if (cur.documents.some((d) => d.id === doc.id)) return;
    const next = { ...cur, documents: [...cur.documents, doc] };
    latestSaved.current = next;
    setSaved(next);
    onSaved(next);
  };

  const runUploads = async (list: Upload[], itemId: string) => {
    for (const u of list) {
      if (u.status !== "queued" && u.status !== "error") continue;
      const doc = await uploadOne(u, itemId);
      if (doc) addDocToItem(doc);
    }
    // Clear finished ones after a moment so the list shows the stored documents instead.
    setTimeout(() => setUploads((l) => {
      l.filter((x) => x.status === "done").forEach((x) => x.previewUrl && URL.revokeObjectURL(x.previewUrl));
      return l.filter((x) => x.status !== "done");
    }), 1200);
  };

  const addFiles = async (files: FileList | File[] | null, source: "camera" | "files") => {
    if (!files || files.length === 0) return;
    const fresh: Upload[] = [...files].map((f) => ({
      key: crypto.randomUUID(), docId: crypto.randomUUID(), original: f, source, filename: f.name || "photo",
      status: "preparing", progress: 0,
    }));
    setUploads((l) => [...l, ...fresh]);
    const ready: Upload[] = [];
    for (const u of fresh) {
      const p = await prepareFile(u.original, source);
      if (!p.ok) {
        patchUpload(u.key, { status: "error", error: p.error, blob: undefined });
        continue;
      }
      const previewUrl = p.contentType.startsWith("image/") ? URL.createObjectURL(p.blob) : undefined;
      const next = { ...u, blob: p.blob, filename: p.filename, contentType: p.contentType, previewUrl, note: p.note, status: "queued" as const };
      patchUpload(u.key, next);
      ready.push(next);
    }
    // Existing items upload right away; new items upload after the first Save.
    if (latestSaved.current && ready.length) runUploads(ready, latestSaved.current.id);
  };

  const retryUpload = (u: Upload) => {
    if (!u.blob) {
      // Preparation failed (e.g. unconvertible HEIC): nothing to retry; the message explains what to do.
      return;
    }
    if (!latestSaved.current) {
      patchUpload(u.key, { status: "queued", error: undefined });
      return;
    }
    runUploads([{ ...u, status: "error" }], latestSaved.current.id);
  };

  const dropUpload = (u: Upload) => {
    if (u.previewUrl) URL.revokeObjectURL(u.previewUrl);
    setUploads((l) => l.filter((x) => x.key !== u.key));
  };

  // --- Save ----------------------------------------------------------------

  const save = async (e?: Event) => {
    e?.preventDefault();
    if (savingRef.current) return; // a second tap while saving does nothing
    const { input, errors: errs } = toInput(fields);
    setErrors(errs);
    setSaveError(null);
    if (!input) {
      setTimeout(() => formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus(), 0);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    const snapshot = fields;
    try {
      let item: Item;
      if (!latestSaved.current) {
        const r = await api.createItem(id, input);
        // If an earlier tap already created it, apply the current form on top.
        item = r.created ? r.item : (await api.updateItem(id, input, r.item.version)).item;
      } else {
        item = (await api.updateItem(id, input, conflict?.version ?? latestSaved.current.version)).item;
      }
      setConflict(null);
      latestSaved.current = item;
      setSaved(item);
      setBaseline(snapshot);
      onSaved(item);
      replaceHash(`#/item/${item.id}`);
      const label = `${item.title} (${formatPartialDate(item)})`;
      setJustSaved(label);
      toast(`Saved “${label}”`);
      const queued = uploads.filter((u) => u.status === "queued" || (u.status === "error" && u.blob));
      if (queued.length) await runUploads(queued, item.id);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.body.item) {
        setConflict(err.body.item as Item);
      } else if (err instanceof ApiError && err.fieldErrors) {
        setErrors(err.fieldErrors);
        setSaveError(err.message);
      } else {
        setSaveError(`${err instanceof Error ? err.message : String(err)} Your entries are still here — tap Save to try again.`);
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const loadTheirs = () => {
    if (!conflict) return;
    latestSaved.current = conflict;
    setSaved(conflict);
    const f = fieldsFrom(conflict, null);
    setFields(f);
    setBaseline(f);
    setConflict(null);
    onSaved(conflict);
  };

  const moveToTrash = async () => {
    if (!saved) return;
    if (!confirm(`Move “${saved.title}” to the Trash? You can restore it from the Trash later.`)) return;
    try {
      await api.deleteItem(saved.id);
      setDirty(false);
      props.onRemoved(saved.id);
      toast(`Moved “${saved.title}” to the Trash.`);
      go("#/");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  const removeDoc = async (d: DocumentMeta) => {
    if (!confirm(`Remove “${d.filename}” from this item? It can be restored below.`)) return;
    try {
      await api.deleteDocument(d.id);
      const cur = latestSaved.current!;
      const next = { ...cur, documents: cur.documents.map((x) => (x.id === d.id ? { ...x, deletedAt: new Date().toISOString() } : x)) };
      latestSaved.current = next;
      setSaved(next);
      onSaved(next);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  const restoreDoc = async (d: DocumentMeta) => {
    try {
      const { item } = await api.restoreDocument(d.id);
      latestSaved.current = item;
      setSaved(item);
      onSaved(item);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  // --- Voice ---------------------------------------------------------------

  const [transcript, setTranscript] = useState("");
  const [listening, setListening] = useState<Listening | null>(null);
  const [speechMsg, setSpeechMsg] = useState<string | null>(null);
  const [keepTranscript, setKeepTranscript] = useState(true);
  const [draftSummary, setDraftSummary] = useState<string | null>(null);
  const canSpeak = useMemo(speechSupported, []);

  const toggleListening = () => {
    if (listening) { listening.stop(); return; }
    setSpeechMsg(null);
    const l = listen({
      onText: (t) => setTranscript(t),
      onError: (m) => setSpeechMsg(m),
      onEnd: () => setListening(null),
    });
    setListening(l);
  };
  useEffect(() => () => listening?.stop(), [listening]);

  const applyTranscript = () => {
    const text = transcript.trim();
    if (!text) return;
    const d = parseTranscript(text);
    const patch: Partial<Fields> = {};
    if (d.title) patch.title = d.title;
    if (d.category) patch.category = d.category;
    if (d.year !== null) {
      patch.year = String(d.year);
      patch.month = d.month ? String(d.month) : "";
      patch.day = d.day ? String(d.day) : "";
    }
    if (d.costCents !== null) patch.cost = centsToInput(d.costCents);
    if (keepTranscript) {
      const line = `Voice entry: “${text}”`;
      if (!fields.notes.includes(line)) patch.notes = fields.notes ? `${fields.notes}\n${line}` : line;
    }
    setFields((f) => ({ ...f, ...patch }));
    const h: Partial<Record<FieldKey, string>> = {};
    for (const f of d.uncertain) h[FIELD_FOR_DRAFT[f]] = d.hints[f] ?? "Please check this.";
    for (const f of d.missing) h[FIELD_FOR_DRAFT[f]] = "Not heard — please fill this in.";
    setHighlight(h);
    setErrors({});
    const n = Object.keys(h).length;
    setDraftSummary(
      n === 0
        ? "Filled in from what was said. Please look over the fields, then tap Save. Nothing is saved until you do."
        : `Filled in what could be understood. ${n} field${n === 1 ? " needs" : "s need"} a look (highlighted in yellow). Nothing is saved until you tap Save.`,
    );
  };

  // --- Render --------------------------------------------------------------

  const year = /^\d{4}$/.test(fields.year) ? Number(fields.year) : null;
  const month = fields.month ? Number(fields.month) : null;
  const maxDay = year && month ? daysInMonth(year, month) : 31;
  const precision = datePrecision({ year: year ?? 0, month, day: fields.day ? Number(fields.day) : null });
  const costCents = parseMoneyToCents(fields.cost);
  const takePhotoRef = useRef<HTMLInputElement>(null);
  const addFilesRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const fieldClass = (k: FieldKey) => `field${errors[k] ? " has-error" : ""}${highlight[k] ? " needs-check" : ""}`;
  const message = (k: FieldKey) => (
    <>
      {errors[k] && <p class="field-error" id={`err-${k}`}>{errors[k]}</p>}
      {!errors[k] && highlight[k] && <p class="field-hint-check" id={`err-${k}`}>{highlight[k]}</p>}
    </>
  );
  const describedBy = (k: FieldKey) => (errors[k] || highlight[k] ? `err-${k}` : undefined);

  return (
    <form class="item-form" ref={formRef} onSubmit={save} noValidate>
      <div class="form-head">
        <a class="back-link" href="#/">← Back to the ledger</a>
        <h1>{saved ? "Edit item" : "New item"}</h1>
        {saved && <p class="muted small">Record ID {saved.id.slice(0, 8)} · last changed {new Date(saved.updatedAt).toLocaleString()} by {saved.updatedBy}</p>}
      </div>

      {justSaved && (
        <div class="banner banner-ok" role="status">
          <strong>✓ Saved:</strong> {justSaved}.
          <div class="banner-actions">
            <a class="btn" href={`#/new?year=${saved?.year ?? ""}`}>+ Add another for {saved?.year}</a>
            <a class="btn btn-quiet" href="#/">Back to the ledger</a>
          </div>
        </div>
      )}

      {conflict && (
        <div class="banner banner-warn" role="alert">
          <strong>Someone else changed this item</strong> ({conflict.updatedBy}, {new Date(conflict.updatedAt).toLocaleString()}).
          {conflict.deletedAt ? " It was moved to the Trash." : " Your edits are still in the form."}
          <div class="banner-actions">
            {!conflict.deletedAt && <button type="button" class="btn" onClick={() => save()}>Save mine over theirs</button>}
            <button type="button" class="btn btn-quiet" onClick={loadTheirs}>Show their version (discard my edits)</button>
          </div>
        </div>
      )}

      {/* Voice entry */}
      <section class="panel voice-panel" aria-labelledby="voice-h">
        <h2 id="voice-h">Say it or type it (optional)</h2>
        <p class="muted">For example: “Home improvement, 1959, February 2nd, $7,200, new roof.”</p>
        <div class="voice-row">
          {canSpeak ? (
            <button type="button" class={`btn btn-mic${listening ? " listening" : ""}`} onClick={toggleListening} aria-pressed={!!listening}>
              {listening ? "■ Stop listening" : "🎤 Speak"}
            </button>
          ) : (
            <p class="muted small">Voice input isn’t available in this browser. Tap in the box and use the keyboard’s microphone key, or type.</p>
          )}
        </div>
        {listening && <p class="listening-note" aria-live="polite">Listening… speak now, then tap Stop.</p>}
        {speechMsg && <p class="field-error" role="alert">{speechMsg}</p>}
        <label class="field">
          <span class="label">What was said (you can correct it)</span>
          <textarea rows={2} value={transcript} onInput={(e) => setTranscript(e.currentTarget.value)} placeholder="Type or dictate here" />
        </label>
        <label class="check">
          <input type="checkbox" checked={keepTranscript} onChange={(e) => setKeepTranscript(e.currentTarget.checked)} />
          Keep what was said in the notes
        </label>
        <button type="button" class="btn" onClick={applyTranscript} disabled={!transcript.trim()}>Fill in the form from this</button>
        {draftSummary && <p class="banner banner-info" role="status">{draftSummary}</p>}
      </section>

      <section class="panel" aria-labelledby="details-h">
        <h2 id="details-h">Details</h2>

        <label class={fieldClass("title")}>
          <span class="label">Name of the item <span class="req">required</span></span>
          <input type="text" value={fields.title} onInput={(e) => set({ title: e.currentTarget.value })} placeholder="e.g. New roof" maxLength={200}
            aria-invalid={errors.title ? "true" : undefined} aria-describedby={describedBy("title")} autoComplete="off" />
          {message("title")}
        </label>

        <label class={fieldClass("category")}>
          <span class="label">Category <span class="req">required</span></span>
          <select value={fields.category} onChange={(e) => set({ category: e.currentTarget.value })}
            aria-invalid={errors.category ? "true" : undefined} aria-describedby={describedBy("category")}>
            <option value="">Choose a category…</option>
            {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          {message("category")}
        </label>

        <fieldset class={fieldClass("date")}>
          <legend class="label">Date <span class="req">year required</span></legend>
          <div class="date-row">
            <label>
              <span class="sublabel">Year</span>
              <input type="text" inputMode="numeric" pattern="[0-9]*" maxLength={4} value={fields.year} placeholder="1959"
                onInput={(e) => set({ year: e.currentTarget.value.replace(/\D/g, "") })}
                aria-invalid={errors.date ? "true" : undefined} aria-describedby={describedBy("date")} />
            </label>
            <label>
              <span class="sublabel">Month</span>
              <select value={fields.month} onChange={(e) => set({ month: e.currentTarget.value, ...(e.currentTarget.value ? {} : { day: "" }) })}>
                <option value="">Not known</option>
                {MONTH_NAMES.map((m, i) => <option key={m} value={String(i + 1)}>{m}</option>)}
              </select>
            </label>
            <label>
              <span class="sublabel">Day</span>
              <select value={fields.day} disabled={!fields.month} onChange={(e) => set({ day: e.currentTarget.value })}>
                <option value="">Not known</option>
                {Array.from({ length: Math.max(maxDay, Number(fields.day) || 0) }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={String(d)}>{d}</option>
                ))}
              </select>
            </label>
          </div>
          <p class="precision-note">
            Date precision: <strong>{PRECISION_LABEL[precision]}</strong>
            {precision !== "day" && " — that’s fine if the paperwork doesn’t show more."}
          </p>
          {message("date")}
        </fieldset>

        <label class={fieldClass("costCents")}>
          <span class="label">Amount paid <span class="req">required</span></span>
          <span class="money-input">
            <span aria-hidden="true">$</span>
            <input type="text" inputMode="decimal" value={fields.cost} placeholder="7,200.00" onInput={(e) => set({ cost: e.currentTarget.value })}
              aria-invalid={errors.costCents ? "true" : undefined} aria-describedby={describedBy("costCents")} autoComplete="off" />
          </span>
          {costCents !== null && <span class="muted small">Will be recorded as {formatCents(costCents)}</span>}
          {message("costCents")}
        </label>

        <label class={fieldClass("vendor")}>
          <span class="label">Contractor or store <span class="opt">optional</span></span>
          <input type="text" value={fields.vendor} onInput={(e) => set({ vendor: e.currentTarget.value })} maxLength={200} autoComplete="off" />
          {message("vendor")}
        </label>

        <label class={fieldClass("notes")}>
          <span class="label">Notes <span class="opt">optional</span></span>
          <textarea rows={3} value={fields.notes} onInput={(e) => set({ notes: e.currentTarget.value })} />
          {message("notes")}
        </label>
      </section>

      <section class="panel" aria-labelledby="docs-h">
        <h2 id="docs-h">Receipts and documents</h2>
        <p class="muted">Photos (JPEG or PNG) and PDFs. You can save without a document and add one later.</p>
        <div class="doc-buttons">
          <button type="button" class="btn btn-big btn-primary" onClick={() => takePhotoRef.current?.click()}>📷 Take photo</button>
          <button type="button" class="btn btn-big" onClick={() => addFilesRef.current?.click()}>📎 Add files</button>
          <input ref={takePhotoRef} type="file" accept="image/*" capture="environment" hidden
            onChange={(e) => { addFiles(e.currentTarget.files, "camera"); e.currentTarget.value = ""; }} />
          <input ref={addFilesRef} type="file" multiple accept="image/jpeg,image/png,application/pdf,.jpg,.jpeg,.png,.pdf" hidden
            onChange={(e) => { addFiles(e.currentTarget.files, "files"); e.currentTarget.value = ""; }} />
        </div>
        <div class={`dropzone${dragOver ? " over" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer?.files ?? null, "files"); }}>
          On a computer you can also drag files here.
        </div>
        {!saved && uploads.some((u) => u.status === "queued") && (
          <p class="banner banner-info">These will upload when you tap <strong>Save</strong>.</p>
        )}

        <ul class="doc-grid">
          {activeDocs.map((d) => (
            <li key={d.id} class="doc-card">
              <a href={fileUrl(d.id)} target="_blank" rel="noopener" class="doc-thumb" aria-label={`View ${d.filename}`}>
                {d.contentType === "application/pdf" ? <span class="pdf-icon">PDF</span> : <img src={fileUrl(d.id)} alt="" loading="lazy" />}
              </a>
              <div class="doc-meta">
                <span class="doc-name">{d.filename}</span>
                <span class="muted small">{formatBytes(d.sizeBytes)} · added {new Date(d.createdAt).toLocaleDateString()}</span>
                <span class="doc-actions">
                  <a href={fileUrl(d.id)} target="_blank" rel="noopener">View</a>
                  <a href={fileUrl(d.id, true)}>Download</a>
                  <button type="button" class="link-btn danger" onClick={() => removeDoc(d)}>Remove</button>
                </span>
              </div>
            </li>
          ))}
          {uploads.map((u) => (
            <li key={u.key} class={`doc-card upload-${u.status}`}>
              <span class="doc-thumb">
                {u.previewUrl ? <img src={u.previewUrl} alt="" /> : <span class="pdf-icon">{u.contentType === "application/pdf" ? "PDF" : "…"}</span>}
              </span>
              <div class="doc-meta">
                <span class="doc-name">{u.filename}</span>
                {u.note && <span class="muted small">{u.note}</span>}
                {u.status === "preparing" && <span class="small">Preparing…</span>}
                {u.status === "queued" && <span class="small">{saved ? "Waiting to upload…" : "Will upload after Save"}</span>}
                {u.status === "uploading" && (
                  <span class="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(u.progress * 100)}>
                    <span style={{ width: `${Math.round(u.progress * 100)}%` }} /> <span class="small">Uploading {Math.round(u.progress * 100)}%</span>
                  </span>
                )}
                {u.status === "done" && <span class="small ok">✓ Uploaded</span>}
                {u.status === "error" && <span class="field-error" role="alert">{u.error}</span>}
                {u.status === "error" && (
                  <span class="doc-actions">
                    {u.blob && <button type="button" class="btn btn-small" onClick={() => retryUpload(u)}>Retry</button>}
                    <button type="button" class="link-btn" onClick={() => dropUpload(u)}>Remove from list</button>
                  </span>
                )}
                {(u.status === "queued" && !saved) && <button type="button" class="link-btn" onClick={() => dropUpload(u)}>Remove</button>}
              </div>
            </li>
          ))}
        </ul>
        {saved && activeDocs.length === 0 && uploads.length === 0 && <p class="muted">No documents yet.</p>}
        {removedDocs.length > 0 && (
          <details class="removed-docs">
            <summary>Removed documents ({removedDocs.length})</summary>
            <ul>
              {removedDocs.map((d) => (
                <li key={d.id}>
                  {d.filename} <a href={fileUrl(d.id)} target="_blank" rel="noopener">View</a>{" "}
                  <button type="button" class="link-btn" onClick={() => restoreDoc(d)}>Restore</button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section class="panel" aria-labelledby="review-h">
        <h2 id="review-h">Review for the tax preparer</h2>
        <fieldset class={fieldClass("status")}>
          <legend class="label">Review status</legend>
          <div class="status-options">
            {STATUSES.map((s) => (
              <label key={s.value} class={`status-option${fields.status === s.value ? " selected" : ""}`}>
                <input type="radio" name="status" value={s.value} checked={fields.status === s.value} onChange={() => set({ status: s.value })} />
                <span>
                  <strong>{s.label}</strong>
                  <span class="muted small">
                    {s.value === "needs_review" && "Not reviewed yet."}
                    {s.value === "approved" && "We reviewed it and think it adds to the home’s basis. This is our call for the preparer to confirm — not an IRS approval."}
                    {s.value === "excluded" && "Not counted — for example an ordinary repair, or something later replaced or reimbursed."}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {fields.status === "approved" && (
          <label class={fieldClass("basisCents")}>
            <span class="label">Approved basis amount <span class="opt">optional</span></span>
            <span class="money-input">
              <span aria-hidden="true">$</span>
              <input type="text" inputMode="decimal" value={fields.basis} onInput={(e) => set({ basis: e.currentTarget.value })}
                placeholder={costCents !== null ? centsToInput(costCents) : ""} aria-invalid={errors.basisCents ? "true" : undefined} />
            </span>
            <span class="muted small">Leave blank to use the amount paid{costCents !== null ? ` (${formatCents(costCents)})` : ""}. Enter a different amount if only part counts.</span>
            {message("basisCents")}
          </label>
        )}
        {fields.status !== "needs_review" && (
          <label class={fieldClass("adjustmentReason")}>
            <span class="label">{fields.status === "excluded" ? "Why it’s excluded" : "Reason for any adjustment"} <span class="opt">optional</span></span>
            <textarea rows={2} value={fields.reason} onInput={(e) => set({ reason: e.currentTarget.value })} />
            {message("adjustmentReason")}
          </label>
        )}
      </section>

      {saveError && <p class="banner banner-error" role="alert">{saveError}</p>}

      <div class="save-bar">
        <button type="submit" class="btn btn-primary btn-big btn-save" disabled={saving} aria-busy={saving}>
          {saving ? "Saving…" : saved ? "Save changes" : "Save"}
        </button>
        {fieldsDirty && !saving && <span class="unsaved">Unsaved changes</span>}
        {!fieldsDirty && saved && !saving && <span class="saved-state">✓ All changes saved</span>}
        {saved && <button type="button" class="btn btn-quiet danger push-right" onClick={moveToTrash}>Move to Trash</button>}
      </div>
    </form>
  );
}
