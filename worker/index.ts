// Worker entry: authenticates every request (API, files and the app's own HTML/JS),
// then routes /api/* or serves the built frontend from static assets.

import { safeFilename, extensionFor } from "../shared/export";
import { ALLOWED_CONTENT_TYPES, MAX_DOCUMENTS_PER_ITEM, MAX_UPLOAD_BYTES, type AllowedContentType } from "../shared/types";
import { validateItemInput } from "../shared/validate";
import { AuthError, authenticate, type AuthEnv, type User } from "./auth";
import * as db from "./db";
import { csvResponse, zipResponse, type ExportScope } from "./exports";
import { contentDisposition, isUuid, sha256Hex, sniffContentType } from "./files";

export interface Env extends AuthEnv {
  DB: D1Database;
  DOCS: R2Bucket;
  ASSETS: Fetcher;
}

class HttpError extends Error {
  constructor(public status: number, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(self), microphone=(self), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; " +
    "form-action 'self'; frame-ancestors 'none'",
};

function withSecurityHeaders(res: Response, isApi: boolean): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!out.headers.has(k)) out.headers.set(k, v);
  }
  if (isApi) out.headers.set("Cache-Control", "private, no-store");
  else if (!out.headers.has("Cache-Control") || (out.headers.get("Content-Type") ?? "").includes("text/html")) {
    // Private data behind auth: never let shared caches keep it.
    out.headers.set("Cache-Control", "private, no-cache");
  }
  return out;
}

/** Cross-site request protection for anything that changes data or produces an export. */
function checkSameOrigin(request: Request) {
  if (request.method === "GET" || request.method === "HEAD") return;
  const origin = request.headers.get("Origin");
  const expected = new URL(request.url).origin;
  if (origin) {
    if (origin !== expected) throw new HttpError(403, "Cross-site request blocked.");
    return;
  }
  const site = request.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin") throw new HttpError(403, "Cross-site request blocked.");
  if (!site) throw new HttpError(403, "Request is missing its Origin header.");
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get("Content-Type") ?? "";
  if (!type.includes("application/json")) throw new HttpError(415, "Expected JSON.");
  try {
    const body = await request.json();
    if (!body || typeof body !== "object") throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Request body is not valid JSON.");
  }
}

function validated(body: Record<string, unknown>) {
  const result = validateItemInput(body);
  if (!result.ok) throw new HttpError(422, "Please fix the highlighted fields.", { fieldErrors: result.errors });
  return result.value;
}

async function readExportForm(request: Request): Promise<{ ids: string[] | null; scope: ExportScope }> {
  const form = await request.formData();
  const kind = form.get("scope") === "all" ? "all" : "selected";
  const description = String(form.get("description") ?? "").slice(0, 500);
  if (kind === "all") return { ids: null, scope: { kind, description } };
  const ids = String(form.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) throw new HttpError(400, "No records were selected for export.");
  if (ids.length > 5000 || !ids.every(isUuid)) throw new HttpError(400, "Invalid record selection.");
  return { ids, scope: { kind, description } };
}

// --- API -----------------------------------------------------------------

async function handleApi(request: Request, env: Env, ctx: ExecutionContext, user: User): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;
  const now = () => new Date().toISOString();
  checkSameOrigin(request);

  if (path === "/api/me" && method === "GET") return json({ email: user.email });

  if (path === "/api/items" && method === "GET") {
    const items = await db.listItems(env.DB, { deleted: url.searchParams.get("deleted") === "1" });
    return json({ items });
  }

  if (path === "/api/items" && method === "POST") {
    const body = await readJson(request);
    const id = typeof body.id === "string" ? body.id.toLowerCase() : "";
    if (!isUuid(id)) throw new HttpError(400, "Missing item id.");
    const value = validated(body);
    const created = await db.insertItem(env.DB, id, value, user.email, now());
    const item = await db.getItem(env.DB, id);
    // A repeated Save with the same id returns the existing record instead of creating a duplicate.
    return json({ item, created }, created ? 201 : 200);
  }

  let m: RegExpMatchArray | null;
  if ((m = path.match(/^\/api\/items\/([0-9a-f-]{36})$/))) {
    const id = m[1];
    if (method === "GET") {
      const item = await db.getItem(env.DB, id);
      if (!item) throw new HttpError(404, "Item not found.");
      return json({ item });
    }
    if (method === "PUT") {
      const body = await readJson(request);
      const value = validated(body);
      if (typeof body.version !== "number") throw new HttpError(400, "Missing version.");
      const ok = await db.updateItem(env.DB, id, value, body.version, user.email, now());
      const item = await db.getItem(env.DB, id);
      if (!item) throw new HttpError(404, "Item not found.");
      if (!ok) {
        if (item.deletedAt) throw new HttpError(409, "This item was moved to the Trash.", { item });
        throw new HttpError(409, "Someone else changed this item while you were editing.", { item });
      }
      return json({ item });
    }
    if (method === "DELETE") {
      const ok = await db.setItemDeleted(env.DB, id, true, user.email, now());
      if (!ok && !(await db.getItem(env.DB, id))) throw new HttpError(404, "Item not found.");
      return json({ ok: true });
    }
  }

  if ((m = path.match(/^\/api\/items\/([0-9a-f-]{36})\/restore$/)) && method === "POST") {
    await db.setItemDeleted(env.DB, m[1], false, user.email, now());
    return json({ item: await db.getItem(env.DB, m[1]) });
  }

  if ((m = path.match(/^\/api\/items\/([0-9a-f-]{36})\/permanent$/)) && method === "DELETE") {
    // Remove the database rows first; only then delete the files. If the file delete fails we
    // leave an unreferenced object (harmless) rather than a record pointing at a missing file.
    const keys = await db.purgeItem(env.DB, m[1]);
    if (keys === null) throw new HttpError(409, "Only items already in the Trash can be deleted forever.");
    if (keys.length) {
      ctx.waitUntil(env.DOCS.delete(keys).catch((e) => console.error("R2 delete failed", keys, e)));
    }
    return json({ ok: true, filesDeleted: keys.length });
  }

  if ((m = path.match(/^\/api\/items\/([0-9a-f-]{36})\/documents\/([0-9a-f-]{36})$/)) && method === "PUT") {
    return uploadDocument(request, env, user, m[1], m[2]);
  }

  if ((m = path.match(/^\/api\/documents\/([0-9a-f-]{36})\/file$/)) && (method === "GET" || method === "HEAD")) {
    return serveDocument(env, m[1], url.searchParams.get("download") === "1");
  }

  if ((m = path.match(/^\/api\/documents\/([0-9a-f-]{36})$/)) && method === "DELETE") {
    const ok = await db.setDocumentDeleted(env.DB, m[1], true, user.email, now());
    if (!ok && !(await db.getDocument(env.DB, m[1]))) throw new HttpError(404, "Document not found.");
    return json({ ok: true });
  }

  if ((m = path.match(/^\/api\/documents\/([0-9a-f-]{36})\/restore$/)) && method === "POST") {
    const doc = await db.getDocument(env.DB, m[1]);
    if (!doc) throw new HttpError(404, "Document not found.");
    await db.setDocumentDeleted(env.DB, m[1], false, user.email, now());
    return json({ item: await db.getItem(env.DB, doc.item_id) });
  }

  if (path === "/api/export/csv" && method === "POST") {
    const { ids } = await readExportForm(request);
    const items = await db.listItems(env.DB, { deleted: false, ids: ids ?? undefined });
    return csvResponse(items, new Date());
  }

  if (path === "/api/export/zip" && method === "POST") {
    const { ids, scope } = await readExportForm(request);
    const items = await db.listItems(env.DB, { deleted: false, ids: ids ?? undefined });
    const rows = await env.DB
      .prepare("SELECT d.* FROM documents d JOIN items i ON i.id = d.item_id WHERE i.deleted_at IS NULL AND d.deleted_at IS NULL")
      .all<db.DocumentRow>();
    const docRows = new Map(rows.results.map((r) => [r.id, r]));
    return zipResponse(items, docRows, env.DOCS, scope, user.email, new Date(), (p) => ctx.waitUntil(p));
  }

  throw new HttpError(404, "Not found.");
}

async function uploadDocument(request: Request, env: Env, user: User, itemId: string, docId: string): Promise<Response> {
  const item = await db.getItem(env.DB, itemId);
  if (!item) throw new HttpError(404, "Save the item before adding documents.");
  if (item.deletedAt) throw new HttpError(409, "This item is in the Trash.");

  // Retrying an upload that already finished returns the existing document.
  const existing = await db.getDocument(env.DB, docId);
  if (existing) {
    if (existing.item_id !== itemId) throw new HttpError(409, "Document id already used.");
    return json({ document: db.rowToDocument(existing), duplicate: true });
  }

  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_UPLOAD_BYTES) throw new HttpError(413, tooLargeMessage());
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) throw new HttpError(400, "The file is empty.");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new HttpError(413, tooLargeMessage());

  const sniffed = sniffContentType(new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 1024)));
  if (sniffed === "heic") {
    throw new HttpError(415, "This is an iPhone HEIC photo. Please upload it as JPEG: use “Take photo” in Safari, or on the iPhone choose Settings › Camera › Formats › Most Compatible, or export the photo as JPEG.");
  }
  if (sniffed === "unknown" || !(ALLOWED_CONTENT_TYPES as readonly string[]).includes(sniffed)) {
    throw new HttpError(415, "Only JPEG, PNG and PDF files can be stored.");
  }
  const contentType = sniffed as AllowedContentType;

  if ((await db.countActiveDocuments(env.DB, itemId)) >= MAX_DOCUMENTS_PER_ITEM) {
    throw new HttpError(409, `An item can have at most ${MAX_DOCUMENTS_PER_ITEM} documents.`);
  }

  const sha256 = await sha256Hex(bytes);
  const dupe = await db.findDocumentByHash(env.DB, itemId, sha256);
  if (dupe) return json({ document: db.rowToDocument(dupe), duplicate: true });

  const rawName = new URL(request.url).searchParams.get("filename") ?? "";
  let filename = safeFilename(rawName, `document.${extensionFor(contentType)}`);
  // The stored type wins over the name: never label a PNG ".jpg" or similar.
  const ext = extensionFor(contentType);
  filename = filename.replace(/\.[a-z0-9]{1,5}$/i, "") + "." + ext;

  // Object keys depend only on ids, so editing the item's date or title never breaks a link.
  const key = `items/${itemId}/${docId}.${ext}`;
  const createdAt = new Date().toISOString();
  await env.DOCS.put(key, bytes, {
    httpMetadata: { contentType },
    customMetadata: { itemId, documentId: docId, uploadedBy: user.email, sha256 },
    sha256,
  });
  const row: db.DocumentRow = {
    id: docId, item_id: itemId, r2_key: key, filename, content_type: contentType, size_bytes: bytes.byteLength,
    sha256, created_at: createdAt, created_by: user.email, deleted_at: null,
  };
  try {
    await db.insertDocument(env.DB, row);
  } catch (e) {
    // Don't leave a stored file that no record knows about, and tell the person to retry.
    await env.DOCS.delete(key).catch(() => {});
    console.error("document insert failed", e);
    throw new HttpError(500, "The file was received but could not be recorded. Please retry.");
  }
  return json({ document: db.rowToDocument(row) }, 201);
}

function tooLargeMessage() {
  return `Files must be ${MAX_UPLOAD_BYTES / 1024 / 1024} MB or smaller. Try a lower-resolution photo or split the PDF.`;
}

async function serveDocument(env: Env, docId: string, download: boolean): Promise<Response> {
  const doc = await db.getDocument(env.DB, docId);
  if (!doc) throw new HttpError(404, "Document not found.");
  const obj = await env.DOCS.get(doc.r2_key);
  if (!obj) throw new HttpError(404, "This document's file is missing from storage.");
  const headers = new Headers({
    "Content-Type": doc.content_type,
    "Content-Length": String(obj.size),
    "Content-Disposition": contentDisposition(download ? "attachment" : "inline", doc.filename),
    // Files are shown as-is and can never run scripts on our origin. (Images are fully sandboxed;
    // a sandbox would stop browsers' built-in PDF viewers, so PDFs just get a no-resources policy.)
    "Content-Security-Policy": doc.content_type === "application/pdf"
      ? "default-src 'none'; frame-ancestors 'none'"
      : "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    "Cache-Control": "private, max-age=3600",
    ETag: obj.httpEtag,
  });
  return new Response(obj.body, { headers });
}

// --- Entry -----------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith("/api/");
    let user: User;
    try {
      user = await authenticate(request, env);
    } catch (e) {
      const err = e instanceof AuthError ? e : new AuthError(500, "Sign-in check failed.");
      if (!(e instanceof AuthError)) console.error(e);
      const body = isApi
        ? JSON.stringify({ error: err.message })
        : `<!doctype html><meta charset="utf-8"><title>Sign in required</title><body style="font:18px system-ui;padding:2rem;max-width:40rem">` +
          `<h1>Joyce’s Home Ledger</h1><p>${escapeHtml(err.message)}</p><p>If you should have access, sign in again or ask for your email to be added.</p></body>`;
      return withSecurityHeaders(new Response(body, {
        status: err.status,
        headers: { "Content-Type": isApi ? "application/json" : "text/html; charset=utf-8" },
      }), true);
    }

    if (!isApi) return withSecurityHeaders(await env.ASSETS.fetch(request), false);

    try {
      return withSecurityHeaders(await handleApi(request, env, ctx, user), true);
    } catch (e) {
      if (e instanceof HttpError) return withSecurityHeaders(json({ error: e.message, ...e.extra }, e.status), true);
      console.error(e);
      return withSecurityHeaders(json({ error: "Something went wrong on the server. Please try again." }, 500), true);
    }
  },
} satisfies ExportedHandler<Env>;

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
