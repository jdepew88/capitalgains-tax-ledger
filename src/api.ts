// Thin client for the Worker API. Auth is handled by Cloudflare Access cookies; nothing secret lives here.

import type { DocumentMeta, Item, ItemInput } from "../shared/types";
import type { FieldErrors } from "../shared/validate";

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: Record<string, unknown> = {}) {
    super(message);
  }
  get fieldErrors(): FieldErrors | undefined {
    return this.body.fieldErrors as FieldErrors | undefined;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(0, "Couldn’t reach the server. Check the internet connection and try again.");
  }
  let data: Record<string, unknown> = {};
  try {
    data = await res.json();
  } catch {
    // Access may answer an expired session with an HTML login page.
    if (!res.ok || res.redirected) throw new ApiError(res.status, "Your sign-in may have expired. Reload the page to sign in again.");
  }
  if (!res.ok) throw new ApiError(res.status, String(data.error ?? `Request failed (${res.status}).`), data);
  return data as T;
}

export const api = {
  me: () => request<{ email: string }>("GET", "/api/me"),
  listItems: (deleted = false) => request<{ items: Item[] }>("GET", `/api/items${deleted ? "?deleted=1" : ""}`),
  getItem: (id: string) => request<{ item: Item }>("GET", `/api/items/${id}`),
  createItem: (id: string, input: ItemInput) => request<{ item: Item; created: boolean }>("POST", "/api/items", { id, ...input }),
  updateItem: (id: string, input: ItemInput, version: number) =>
    request<{ item: Item }>("PUT", `/api/items/${id}`, { ...input, version }),
  deleteItem: (id: string) => request<{ ok: true }>("DELETE", `/api/items/${id}`),
  restoreItem: (id: string) => request<{ item: Item }>("POST", `/api/items/${id}/restore`),
  purgeItem: (id: string) => request<{ ok: true }>("DELETE", `/api/items/${id}/permanent`),
  deleteDocument: (id: string) => request<{ ok: true }>("DELETE", `/api/documents/${id}`),
  restoreDocument: (id: string) => request<{ item: Item }>("POST", `/api/documents/${id}/restore`),
};

export const fileUrl = (docId: string, download = false) => `/api/documents/${docId}/file${download ? "?download=1" : ""}`;

/** Uploads one file with progress. Uses XHR because fetch has no upload progress events. */
export function uploadDocument(
  itemId: string, docId: string, file: Blob, filename: string, onProgress: (fraction: number) => void,
): Promise<{ document: DocumentMeta; duplicate?: boolean }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/items/${itemId}/documents/${docId}?filename=${encodeURIComponent(filename)}`);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onerror = () => reject(new ApiError(0, "The upload was interrupted. Check the connection and tap Retry."));
    xhr.onload = () => {
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as { document: DocumentMeta });
      else reject(new ApiError(xhr.status, String(data.error ?? `Upload failed (${xhr.status}).`), data));
    };
    xhr.send(file);
  });
}

/** Submits an export as a normal form POST so the browser streams the download to disk. */
export function submitExport(kind: "csv" | "zip", scope: "all" | "selected", ids: string[], description: string) {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = `/api/export/${kind}`;
  form.style.display = "none";
  const add = (name: string, value: string) => {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  };
  add("scope", scope);
  add("ids", ids.join(","));
  add("description", description);
  document.body.appendChild(form);
  form.submit();
  form.remove();
}
