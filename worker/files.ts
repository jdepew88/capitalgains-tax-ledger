// Server-side upload validation: the file's own bytes decide its type, not its name or the browser's label.

import type { AllowedContentType } from "../shared/types";

function ascii(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

export type SniffResult = AllowedContentType | "heic" | "unknown";

export function sniffContentType(bytes: Uint8Array): SniffResult {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  // %PDF- may be preceded by a little junk in some scanners' output; check the first 1 KB.
  const head = ascii(b.subarray(0, 1024));
  if (head.includes("%PDF-")) return "application/pdf";
  if (b.length >= 12) {
    const box = ascii(b.subarray(4, 12));
    if (/^ftyp(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif)$/.test(box)) return "heic";
  }
  return "unknown";
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Content-Disposition value that is safe for any filename (ASCII fallback + RFC 5987 UTF-8). */
export function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\;]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}
