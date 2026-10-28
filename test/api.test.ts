// Integration tests: real Worker, local D1 and R2 (Miniflare), and real JWT signature checks
// against a signing key generated here and served as the fake Access team's certs.

import { env, exports } from "cloudflare:workers";
import { unzipSync, strFromU8 } from "fflate";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCertCache } from "../worker/auth";

const ORIGIN = "https://ledger.example.com";
const TEAM = "test-team.cloudflareaccess.com";
let keyPair: CryptoKeyPair;
let otherKeyPair: CryptoKeyPair;
let jwk: JsonWebKey;

const b64url = (data: Uint8Array | string) => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function token(claims: Record<string, unknown> = {}, opts: { key?: CryptoKey; kid?: string } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", kid: opts.kid ?? "kid-1", typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    aud: ["test-audience"], email: "helper@example.com", exp: now + 600, iat: now, iss: `https://${TEAM}`, ...claims,
  }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", opts.key ?? keyPair.privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

let jwt: string;
let joyceJwt: string;

async function call(path: string, init: RequestInit & { auth?: string | null } = {}) {
  const headers = new Headers(init.headers);
  const auth = init.auth === undefined ? jwt : init.auth;
  if (auth) headers.set("Cf-Access-Jwt-Assertion", auth);
  if (init.method && init.method !== "GET" && !headers.has("Origin")) headers.set("Origin", ORIGIN);
  return (exports as unknown as { default: Fetcher }).default.fetch(new Request(ORIGIN + path, { ...init, headers }));
}

const sendJson = (path: string, method: string, body: unknown, auth?: string) =>
  call(path, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" }, auth });

const uuid = () => crypto.randomUUID();
const roof = { title: "New roof", category: "roofing", year: 1959, month: 2, day: 2, costCents: 720000, notes: "" };

// Tiny valid files.
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
const HEIC = new Uint8Array([0, 0, 0, 24, ...new TextEncoder().encode("ftypheic"), 0, 0, 0, 0]);

beforeAll(async () => {
  const gen = () => crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  ) as Promise<CryptoKeyPair>;
  keyPair = await gen();
  otherKeyPair = await gen();
  jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `https://${TEAM}/cdn-cgi/access/certs`) {
      return Response.json({ keys: [{ ...jwk, kid: "kid-1", alg: "RS256" }] });
    }
    return realFetch(input as RequestInfo, init);
  });
  jwt = await token();
  joyceJwt = await token({ email: "joyce@example.com" });
});

afterAll(() => vi.restoreAllMocks());
beforeEach(() => resetCertCache());

describe("authentication and authorization", () => {
  it("rejects requests without a token, for API, files and the app itself", async () => {
    for (const p of ["/api/items", "/api/me", `/api/documents/${uuid()}/file`, "/", "/index.html"]) {
      const res = await call(p, { auth: null });
      expect(res.status, p).toBe(401);
    }
  });

  it("rejects tokens with a bad signature, wrong audience, wrong issuer, expired, or unknown key", async () => {
    const bad = [
      await token({}, { key: otherKeyPair.privateKey }),
      await token({ aud: ["someone-else"] }),
      await token({ iss: "https://evil.cloudflareaccess.com" }),
      await token({ exp: Math.floor(Date.now() / 1000) - 3600 }),
      await token({}, { kid: "kid-unknown" }),
      jwt.slice(0, -4) + "AAAA",
      "not-a-jwt",
    ];
    for (const t of bad) expect((await call("/api/me", { auth: t })).status).toBe(401);
  });

  it("rejects valid tokens for emails not on the allowlist", async () => {
    const res = await call("/api/me", { auth: await token({ email: "stranger@example.com" }) });
    expect(res.status).toBe(403);
  });

  it("accepts allowlisted users (case-insensitive) and the cookie form of the token", async () => {
    expect(await (await call("/api/me")).json()).toEqual({ email: "helper@example.com" });
    const res = await call("/api/me", { auth: null, headers: { Cookie: `CF_Authorization=${joyceJwt}` } });
    expect(await res.json()).toEqual({ email: "joyce@example.com" });
  });

  it("blocks cross-site writes", async () => {
    const res = await call("/api/items", {
      method: "POST", body: JSON.stringify({ ...roof, id: uuid() }),
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  it("refuses dev auth mode on a non-local hostname", async () => {
    const { authenticate } = await import("../worker/auth");
    await expect(authenticate(new Request("https://ledger.example.com/"), {
      AUTH_MODE: "dev", DEV_USER_EMAIL: "helper@example.com", ALLOWED_EMAILS: "helper@example.com",
    })).rejects.toThrow(/localhost/);
    const ok = await authenticate(new Request("http://localhost:5173/"), {
      AUTH_MODE: "dev", DEV_USER_EMAIL: "helper@example.com", ALLOWED_EMAILS: "helper@example.com",
    });
    expect(ok.email).toBe("helper@example.com");
  });

  it("shares one household dataset between both users", async () => {
    const id = uuid();
    await sendJson("/api/items", "POST", { ...roof, id }, jwt);
    const seenByJoyce = (await (await call("/api/items", { auth: joyceJwt })).json()) as { items: { id: string }[] };
    expect(seenByJoyce.items.some((i) => i.id === id)).toBe(true);
    // Joyce can edit what the helper created.
    const res = await sendJson(`/api/items/${id}`, "PUT", { ...roof, title: "New roof (Joyce)", version: 1 }, joyceJwt);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { item: { updatedBy: string } }).item.updatedBy).toBe("joyce@example.com");
  });
});

describe("records", () => {
  it("creates idempotently: a double-tapped Save makes one record", async () => {
    const id = uuid();
    const [a, b] = await Promise.all([
      sendJson("/api/items", "POST", { ...roof, id }),
      sendJson("/api/items", "POST", { ...roof, id }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE id = ?").bind(id).first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  it("starts as needs review and preserves date precision", async () => {
    const id = uuid();
    const res = await sendJson("/api/items", "POST", { ...roof, id, month: 2, day: null, status: undefined });
    const { item } = (await res.json()) as { item: Record<string, unknown> };
    expect(item).toMatchObject({ status: "needs_review", year: 1959, month: 2, day: null, costCents: 720000 });
  });

  it("rejects impossible dates and invalid amounts with field errors", async () => {
    for (const patch of [{ month: 2, day: 30 }, { costCents: 1.5 }, { costCents: -100 }, { year: 1700 }, { title: "" }]) {
      const res = await sendJson("/api/items", "POST", { ...roof, ...patch, id: uuid() });
      expect(res.status, JSON.stringify(patch)).toBe(422);
      expect(((await res.json()) as { fieldErrors: object }).fieldErrors).toBeTruthy();
    }
  });

  it("edits with version checks, so a stale edit can't overwrite a newer one", async () => {
    const id = uuid();
    await sendJson("/api/items", "POST", { ...roof, id });
    const first = await sendJson(`/api/items/${id}`, "PUT", { ...roof, status: "approved", basisCents: 700000, adjustmentReason: "Part was a repair", version: 1 });
    expect(first.status).toBe(200);
    const { item } = (await first.json()) as { item: Record<string, unknown> };
    expect(item).toMatchObject({ version: 2, status: "approved", basisCents: 700000 });
    const stale = await sendJson(`/api/items/${id}`, "PUT", { ...roof, title: "stale", version: 1 });
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as { item: { title: string } };
    expect(body.item.title).toBe("New roof"); // current version returned so the form can show it
  });

  it("soft-deletes, restores and only purges from the Trash", async () => {
    const id = uuid();
    await sendJson("/api/items", "POST", { ...roof, id });
    expect((await call(`/api/items/${id}/permanent`, { method: "DELETE" })).status).toBe(409);
    expect((await call(`/api/items/${id}`, { method: "DELETE" })).status).toBe(200);
    const live = (await (await call("/api/items")).json()) as { items: { id: string }[] };
    expect(live.items.some((i) => i.id === id)).toBe(false);
    const trash = (await (await call("/api/items?deleted=1")).json()) as { items: { id: string }[] };
    expect(trash.items.some((i) => i.id === id)).toBe(true);
    expect((await call(`/api/items/${id}/restore`, { method: "POST" })).status).toBe(200);
    await call(`/api/items/${id}`, { method: "DELETE" });
    expect((await call(`/api/items/${id}/permanent`, { method: "DELETE" })).status).toBe(200);
    expect((await call(`/api/items/${id}`)).status).toBe(404);
  });
});

describe("documents", () => {
  async function newItem() {
    const id = uuid();
    await sendJson("/api/items", "POST", { ...roof, id });
    return id;
  }
  const upload = (itemId: string, docId: string, bytes: Uint8Array, filename: string, type = "application/octet-stream") =>
    call(`/api/items/${itemId}/documents/${docId}?filename=${encodeURIComponent(filename)}`, {
      method: "PUT", body: bytes, headers: { "Content-Type": type },
    });

  it("stores JPEG, PNG and PDF in R2 with metadata in D1, keyed by record id", async () => {
    const itemId = await newItem();
    for (const [bytes, name, type] of [[JPEG, "receipt.jpg", "image/jpeg"], [PNG, "scan.png", "image/png"], [PDF, "invoice.pdf", "application/pdf"]] as const) {
      const docId = uuid();
      const res = await upload(itemId, docId, bytes, name);
      expect(res.status, name).toBe(201);
      const row = await env.DB.prepare("SELECT * FROM documents WHERE id = ?").bind(docId).first<{ r2_key: string; content_type: string }>();
      expect(row!.content_type).toBe(type);
      expect(row!.r2_key).toMatch(new RegExp(`^items/${itemId}/${docId}\\.(jpg|png|pdf)$`));
      expect(await env.DOCS.head(row!.r2_key)).not.toBeNull();
    }
  });

  it("detects type from the bytes and fixes misleading extensions", async () => {
    const itemId = await newItem();
    const res = await upload(itemId, uuid(), PNG, "photo.jpg", "image/jpeg");
    const { document } = (await res.json()) as { document: { contentType: string; filename: string } };
    expect(document).toMatchObject({ contentType: "image/png", filename: "photo.png" });
  });

  it("rejects HEIC with instructions, and other file types", async () => {
    const itemId = await newItem();
    const heic = await upload(itemId, uuid(), HEIC, "IMG_0001.HEIC");
    expect(heic.status).toBe(415);
    expect(((await heic.json()) as { error: string }).error).toMatch(/HEIC.*JPEG/);
    const html = await upload(itemId, uuid(), new TextEncoder().encode("<html><script>alert(1)</script>"), "x.pdf", "application/pdf");
    expect(html.status).toBe(415);
    const empty = await upload(itemId, uuid(), new Uint8Array(0), "x.pdf");
    expect(empty.status).toBe(400);
  });

  it("enforces the size limit", async () => {
    const itemId = await newItem();
    const big = new Uint8Array(20 * 1024 * 1024 + 1);
    big.set(JPEG.subarray(0, 4));
    expect((await upload(itemId, uuid(), big, "big.jpg")).status).toBe(413);
  });

  it("doesn't duplicate on retry or double upload", async () => {
    const itemId = await newItem();
    const docId = uuid();
    expect((await upload(itemId, docId, JPEG, "r.jpg")).status).toBe(201);
    const retry = await upload(itemId, docId, JPEG, "r.jpg");
    expect(((await retry.json()) as { duplicate: boolean }).duplicate).toBe(true);
    const sameBytesNewId = await upload(itemId, uuid(), JPEG, "r.jpg");
    expect(((await sameBytesNewId.json()) as { duplicate: boolean }).duplicate).toBe(true);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM documents WHERE item_id = ?").bind(itemId).first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it("requires a saved item", async () => {
    expect((await upload(uuid(), uuid(), JPEG, "r.jpg")).status).toBe(404);
  });

  it("serves files only through the authorized endpoint with safe headers", async () => {
    const itemId = await newItem();
    const docId = uuid();
    await upload(itemId, docId, PDF, 'bad"name;\r\n.pdf');
    const res = await call(`/api/documents/${docId}/file?download=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const cd = res.headers.get("Content-Disposition")!;
    expect(cd.startsWith("attachment;")).toBe(true);
    expect(cd).not.toMatch(/[\r\n]/);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PDF);
    expect((await call(`/api/documents/${docId}/file`, { auth: null })).status).toBe(401);
  });

  it("keeps attachments working after the item's date and title change", async () => {
    const itemId = await newItem();
    const docId = uuid();
    await upload(itemId, docId, JPEG, "r.jpg");
    await sendJson(`/api/items/${itemId}`, "PUT", { ...roof, title: "Roof (corrected)", year: 1961, month: null, day: null, version: 1 });
    expect((await call(`/api/documents/${docId}/file`)).status).toBe(200);
  });

  it("removes and restores a document without losing the file", async () => {
    const itemId = await newItem();
    const docId = uuid();
    await upload(itemId, docId, JPEG, "r.jpg");
    expect((await call(`/api/documents/${docId}`, { method: "DELETE" })).status).toBe(200);
    const after = (await (await call(`/api/items/${itemId}`)).json()) as { item: { documents: { deletedAt: string | null }[] } };
    expect(after.item.documents[0].deletedAt).not.toBeNull();
    expect((await call(`/api/documents/${docId}/restore`, { method: "POST" })).status).toBe(200);
    expect((await call(`/api/documents/${docId}/file`)).status).toBe(200);
  });

  it("purging an item deletes its rows and its files", async () => {
    const itemId = await newItem();
    const docId = uuid();
    await upload(itemId, docId, JPEG, "r.jpg");
    await call(`/api/items/${itemId}`, { method: "DELETE" });
    await call(`/api/items/${itemId}/permanent`, { method: "DELETE" });
    expect(await env.DB.prepare("SELECT 1 FROM documents WHERE id = ?").bind(docId).first()).toBeNull();
    // The R2 delete runs after the response; give it a moment.
    await new Promise((r) => setTimeout(r, 50));
    expect(await env.DOCS.head(`items/${itemId}/${docId}.jpg`)).toBeNull();
  });
});

describe("exports", () => {
  const form = (fields: Record<string, string>) => {
    const body = new URLSearchParams(fields);
    return { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } };
  };

  it("exports only the selected records to CSV", async () => {
    const a = uuid();
    const b = uuid();
    await sendJson("/api/items", "POST", { ...roof, id: a, title: "=EVIL()" });
    await sendJson("/api/items", "POST", { ...roof, id: b, title: "Other" });
    const res = await call("/api/export/csv", form({ scope: "selected", ids: a }));
    expect(res.headers.get("Content-Type")).toMatch(/text\/csv/);
    const text = await res.text();
    expect(text).toContain(a);
    expect(text).not.toContain(b);
    expect(text).toContain("'=EVIL()");
  });

  it("builds a ZIP with CSV, attachments in folders, and a report of missing files", async () => {
    const id = uuid();
    await sendJson("/api/items", "POST", { ...roof, id });
    const okDoc = uuid();
    const lostDoc = uuid();
    const put = (docId: string, bytes: Uint8Array, name: string) =>
      call(`/api/items/${id}/documents/${docId}?filename=${name}`, { method: "PUT", body: bytes });
    await put(okDoc, JPEG, "receipt.jpg");
    await put(lostDoc, PDF, "invoice.pdf");
    // Simulate a file lost from storage.
    await env.DOCS.delete(`items/${id}/${lostDoc}.pdf`);

    const res = await call("/api/export/zip", form({ scope: "selected", ids: id, description: "test selection" }));
    expect(res.status).toBe(200);
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const names = Object.keys(files);
    const root = names[0].split("/")[0];
    expect(names).toContain(`${root}/records.csv`);
    expect(names).toContain(`${root}/EXPORT-REPORT.txt`);
    const jpgPath = names.find((n) => n.endsWith("01 receipt.jpg"))!;
    expect(jpgPath).toMatch(/attachments\/1950-1959\/1959\/1959-02-02 new-roof \[[0-9a-f]{8}\]\//);
    expect(files[jpgPath]).toEqual(JPEG);
    expect(names.some((n) => n.endsWith("invoice.pdf"))).toBe(false);
    const report = strFromU8(files[`${root}/EXPORT-REPORT.txt`]);
    expect(report).toMatch(/PROBLEMS \(1\)/);
    expect(report).toMatch(/invoice\.pdf: MISSING/);
    expect(report).toContain("Selected records only");
    const csv = strFromU8(files[`${root}/records.csv`]);
    expect(csv).toContain(id);
    expect(csv).toMatch(/PROBLEM: .*invoice\.pdf: MISSING/);
  });

  it("requires authentication and same-origin for exports", async () => {
    expect((await call("/api/export/csv", { ...form({ scope: "all" }), auth: null })).status).toBe(401);
    const cross = form({ scope: "all" });
    expect((await call("/api/export/csv", { ...cross, headers: { ...cross.headers, Origin: "https://evil.example" } })).status).toBe(403);
  });
});
