// Authentication: every request must carry a valid Cloudflare Access JWT for an allowlisted email.
// The Worker verifies the token itself (signature, issuer, audience, expiry) instead of trusting
// that Access is in front of it, so a misconfigured route can't expose the data.

export interface AuthEnv {
  AUTH_MODE?: string;
  DEV_USER_EMAIL?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ALLOWED_EMAILS?: string;
}

export interface User {
  email: string;
}

export class AuthError extends Error {
  constructor(public status: 401 | 403 | 500, message: string) {
    super(message);
  }
}

export function allowedEmails(env: AuthEnv): Set<string> {
  return new Set(
    (env.ALLOWED_EMAILS ?? "").split(/[,\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean),
  );
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export async function authenticate(request: Request, env: AuthEnv, fetchCerts: typeof fetch = fetch): Promise<User> {
  const allow = allowedEmails(env);
  if (allow.size === 0) throw new AuthError(500, "ALLOWED_EMAILS is not configured.");

  // Local development only: never honoured on a real hostname.
  if (env.AUTH_MODE === "dev") {
    const host = new URL(request.url).hostname;
    if (!LOCAL_HOSTS.has(host)) throw new AuthError(500, "AUTH_MODE=dev is only allowed on localhost.");
    const email = (env.DEV_USER_EMAIL ?? "").toLowerCase();
    if (!allow.has(email)) throw new AuthError(403, "DEV_USER_EMAIL is not in ALLOWED_EMAILS.");
    return { email };
  }

  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    throw new AuthError(500, "Cloudflare Access is not configured (ACCESS_TEAM_DOMAIN / ACCESS_AUD).");
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion") ?? cookie(request, "CF_Authorization");
  if (!token) throw new AuthError(401, "Not signed in.");

  const claims = await verifyAccessJwt(token, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD, fetchCerts);
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
  if (!email) throw new AuthError(403, "This sign-in has no email address.");
  if (!allow.has(email)) throw new AuthError(403, "This account is not on the allowlist.");
  return { email };
}

function cookie(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

// --- JWT verification (RS256, Cloudflare Access certs) ----------------------

interface Jwk { kid: string; kty: string; n: string; e: string; alg?: string }
let certCache: { domain: string; keys: Map<string, CryptoKey>; fetchedAt: number } | null = null;
const CERT_TTL_MS = 60 * 60 * 1000;

export function resetCertCache() {
  certCache = null;
}

function normalizeTeamDomain(domain: string): string {
  return domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

async function getKey(kid: string, teamDomain: string, fetchCerts: typeof fetch): Promise<CryptoKey | undefined> {
  const domain = normalizeTeamDomain(teamDomain);
  const fresh = certCache && certCache.domain === domain && Date.now() - certCache.fetchedAt < CERT_TTL_MS;
  if (fresh && certCache!.keys.has(kid)) return certCache!.keys.get(kid);
  // Unknown kid or stale cache: refetch (keys rotate).
  const res = await fetchCerts(`https://${domain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new AuthError(500, "Could not load Cloudflare Access signing keys.");
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (jwk.kty !== "RSA") continue;
    const key = await crypto.subtle.importKey(
      "jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
    );
    keys.set(jwk.kid, key);
  }
  certCache = { domain, keys, fetchedAt: Date.now() };
  return keys.get(kid);
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function verifyAccessJwt(
  token: string, teamDomain: string, audience: string, fetchCerts: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError(401, "Malformed sign-in token.");
  let header: { alg?: string; kid?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
  } catch {
    throw new AuthError(401, "Malformed sign-in token.");
  }
  if (header.alg !== "RS256" || !header.kid) throw new AuthError(401, "Unsupported sign-in token.");
  const key = await getKey(header.kid, teamDomain, fetchCerts);
  if (!key) throw new AuthError(401, "Unknown signing key.");
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64urlDecode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) throw new AuthError(401, "Invalid sign-in token.");

  const now = Math.floor(Date.now() / 1000);
  const skew = 60;
  if (typeof payload.exp !== "number" || payload.exp + skew < now) throw new AuthError(401, "Sign-in expired. Reload the page.");
  if (typeof payload.nbf === "number" && payload.nbf - skew > now) throw new AuthError(401, "Sign-in token not valid yet.");
  const expectedIss = `https://${normalizeTeamDomain(teamDomain)}`;
  if (payload.iss !== expectedIss) throw new AuthError(401, "Sign-in token from the wrong team.");
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(audience)) throw new AuthError(401, "Sign-in token for a different application.");
  return payload;
}
