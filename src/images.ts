// Prepares a picked or captured file for upload. JPEG/PNG/PDF pass through untouched (except camera
// photos, which are re-encoded as JPEG). Other images (HEIC, WebP…) are converted to real JPEG when this
// browser can decode them; otherwise we explain how to get a compatible file. Nothing is just renamed.

import { MAX_UPLOAD_BYTES } from "../shared/types";

export type Prepared =
  | { ok: true; blob: Blob; filename: string; contentType: "image/jpeg" | "image/png" | "application/pdf"; note?: string }
  | { ok: false; error: string };

type Kind = "jpeg" | "png" | "pdf" | "heic" | "image-other" | "unknown";

async function sniff(file: Blob): Promise<Kind> {
  const b = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  const ascii = String.fromCharCode(...b);
  if (ascii.includes("%PDF-")) return "pdf";
  if (/^ftyp(heic|heix|hevc|hevx|heim|heis|mif1|msf1)/.test(ascii.slice(4, 12))) return "heic";
  if (file.type.startsWith("image/")) return "image-other";
  return "unknown";
}

const HEIC_HELP =
  "This photo is in Apple’s HEIC format, and this browser can’t convert it. Options: on the iPhone, add it with " +
  "“Take photo” or “Add files” in Safari (Safari usually converts automatically); or set Settings › Camera › " +
  "Formats › Most Compatible; or on a computer, open the photo and export or save it as JPEG, then add that file.";

function baseName(name: string): string {
  return (name.replace(/\.[^.]+$/, "") || "photo").slice(0, 100);
}

async function decode(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if ("createImageBitmap" in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch { /* fall back to <img>, which some Safari versions decode more formats with */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    // Keep the URL alive until drawn; revoked by the caller via timeout.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

const MAX_EDGE = 3200; // plenty to read a receipt, keeps uploads reasonable on cellular

async function toJpeg(file: Blob, maxEdge = MAX_EDGE): Promise<Blob> {
  const src = await decode(file);
  const w = "naturalWidth" in src ? src.naturalWidth : src.width;
  const h = "naturalHeight" in src ? src.naturalHeight : src.height;
  if (!w || !h) throw new Error("empty image");
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  ctx.fillStyle = "#fff"; // transparent areas become white, not black
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  if ("close" in src) src.close();
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.88));
  if (!blob || blob.type !== "image/jpeg") throw new Error("JPEG encoding not supported");
  return blob;
}

const tooBig = (b: Blob) => b.size > MAX_UPLOAD_BYTES;
const sizeError = () =>
  `This file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB. For a PDF, try saving it with a smaller size or splitting it; for a photo, take it again or reduce its size.`;

export async function prepareFile(file: File, source: "camera" | "files"): Promise<Prepared> {
  const kind = await sniff(file);
  const name = baseName(file.name);

  if (kind === "pdf") {
    return tooBig(file) ? { ok: false, error: sizeError() } : { ok: true, blob: file, filename: `${name}.pdf`, contentType: "application/pdf" };
  }

  if (kind === "jpeg" || kind === "png") {
    // Existing files keep their original bytes. Camera photos are re-encoded so orientation and size are sensible.
    if (source === "camera" || tooBig(file)) {
      try {
        const jpeg = await toJpeg(file);
        if (!tooBig(jpeg)) {
          return { ok: true, blob: jpeg, filename: `${name}.jpg`, contentType: "image/jpeg", note: kind === "png" ? "Converted to JPEG" : undefined };
        }
      } catch { /* fall through to the original */ }
    }
    if (tooBig(file)) return { ok: false, error: sizeError() };
    return kind === "png"
      ? { ok: true, blob: file, filename: `${name}.png`, contentType: "image/png" }
      : { ok: true, blob: file, filename: `${name}.jpg`, contentType: "image/jpeg" };
  }

  if (kind === "heic" || kind === "image-other") {
    try {
      const jpeg = await toJpeg(file);
      if (tooBig(jpeg)) return { ok: false, error: sizeError() };
      const from = kind === "heic" ? "HEIC" : (file.type.split("/")[1] ?? "image").toUpperCase();
      return { ok: true, blob: jpeg, filename: `${name}.jpg`, contentType: "image/jpeg", note: `Converted from ${from} to JPEG` };
    } catch {
      return {
        ok: false,
        error: kind === "heic"
          ? HEIC_HELP
          : `This image type (${file.type || "unknown"}) can’t be converted in this browser. Please save it as JPEG, PNG or PDF and add that file.`,
      };
    }
  }

  return { ok: false, error: `“${file.name}” isn’t a photo or PDF. Only JPEG, PNG and PDF files can be added.` };
}
