# Joyce’s Home Ledger

A small private web app for keeping home improvement records, with photos and PDFs of the receipts, so they're organized for the tax preparer.

- **Frontend:** Vite + Preact + TypeScript (`src/`), mobile-first.
- **API:** one Cloudflare Worker (`worker/`) that also serves the built frontend.
- **Records:** Cloudflare D1 (`migrations/`).
- **Documents:** a private Cloudflare R2 bucket. Files are only served through the Worker after an auth check.
- **Shared logic:** dates, money, grouping, totals, voice parsing and CSV live in `shared/` and are unit-tested.
- **Auth:** Cloudflare Access in front, with the Worker checking the Access JWT on every request (see below).

Joyce and the helper share **one household dataset**. Data isn't separated per user. Each record notes who created and last changed it.

## Local development

Requires Node 20+.

```sh
npm install                      # .npmrc sets legacy-peer-deps (the Workers test plugin pins a peer range)
cp .dev.vars.example .dev.vars   # local-only auth settings; never commit .dev.vars
npm run db:migrate:local         # create the local D1 tables
npm run dev                      # http://localhost:5173 (frontend + Worker + local D1/R2)
```

Local D1 and R2 data lives in `.wrangler/state/`. Delete that folder to start fresh.

`.dev.vars` sets `AUTH_MODE=dev`, which signs you in as `DEV_USER_EMAIL` **only when the hostname is `localhost`/`127.0.0.1`**. The Worker refuses dev mode on any other hostname. The email still has to be in `ALLOWED_EMAILS`.

To try the phone layout on a real iPhone during development you need HTTPS and a real hostname. Use a deployed preview protected by Access instead of exposing the dev server.

### Checks

```sh
npm test          # 55 tests: unit tests plus Worker integration tests in the Workers runtime (local D1 + R2)
npm run typecheck
npm run build
```

What the tests cover:

- Date precision and impossible dates, including leap years.
- Money parsing and formatting in integer cents.
- Totals by status, with no double counting.
- Decade and century boundaries (1900 / 1901 / 2000 / 2001), and drilling down from century to decade to year to item.
- Search, filters and sorting.
- The voice parser.
- CSV formula-injection protection and safe filenames.
- JWT verification (bad signature, wrong audience or issuer, expired token, unknown key), the allowlist, the cross-site request block, and that dev mode is refused on a real hostname.
- Idempotent create and upload (double-tapped Save), and version conflicts.
- Trash: restore and permanent delete.
- File-type sniffing, HEIC rejection and the size limit.
- Attachments still working after a date edit.
- ZIP export, including reporting a missing file.

## Cloudflare setup (one time)

```sh
npx wrangler login
npx wrangler d1 create joyces-home-ledger          # copy the database_id into wrangler.jsonc
npx wrangler r2 bucket create joyces-home-ledger-docs
npm run db:migrate:remote
```

Keep the R2 bucket **private**. Don't enable a public `r2.dev` URL or a custom domain on the bucket. The app never needs either.

### Bindings and settings

| Name | Kind | Purpose |
|---|---|---|
| `DB` | D1 binding | records and document metadata |
| `DOCS` | R2 binding | document bytes, keys `items/<record id>/<document id>.<ext>` |
| `ASSETS` | static assets | built frontend (`run_worker_first: true`, so the HTML/JS is also behind auth) |
| `ACCESS_TEAM_DOMAIN` | secret | e.g. `yourteam.cloudflareaccess.com` |
| `ACCESS_AUD` | secret | the Access application's Audience (AUD) tag |
| `ALLOWED_EMAILS` | secret | comma-separated allowlist, e.g. `joyce@…,you@…` |
| `AUTH_MODE`, `DEV_USER_EMAIL` | `.dev.vars` only | local development. **Never set these in production.** |

## Authentication for Joyce and you (Cloudflare Access)

1. Deploy once (see below) so the Worker exists. Then attach a custom domain in **Workers & Pages → joyces-home-ledger → Settings → Domains & Routes**, e.g. `ledger.example.com`. You can also use the `workers.dev` URL.
2. In **Zero Trust → Access → Applications**, add a **Self-hosted** application for that hostname, covering the whole site (no path). For `workers.dev`, you can instead turn on **Cloudflare Access** in the Worker's *Domains & Routes* settings.
3. Add a policy: **Action: Allow**, **Include → Emails:** Joyce's address and yours. Add nothing else.
4. Login method: **One-time PIN** (a code is emailed) works with any email. Google login is also fine if both of you use Google.
5. Copy the application's **Audience (AUD) tag** and your team domain, then set the secrets:

   ```sh
   npx wrangler secret put ACCESS_TEAM_DOMAIN   # yourteam.cloudflareaccess.com
   npx wrangler secret put ACCESS_AUD
   npx wrangler secret put ALLOWED_EMAILS       # joyce@example.com,you@example.com
   ```

6. Turn off **Preview URLs** for the Worker, or protect them with Access too. Unprotected URLs are still refused by the Worker (no valid JWT means 401), but turning them off keeps things tidy.

The Worker checks every request on its own. It does not just trust that Access sits in front of it:

- It verifies the `Cf-Access-Jwt-Assertion` header (or the `CF_Authorization` cookie). The token must be RS256-signed with your team's current keys, from the right issuer, for the right AUD, and not expired.
- The token's email must be in `ALLOWED_EMAILS`.
- If any of the three secrets is missing, the app refuses all requests.
- Requests that change data, and export requests, must come from the same origin.

To add or remove a person, update both the Access policy and `ALLOWED_EMAILS`.

## Deploying

```sh
npm run deploy        # builds, then `wrangler deploy` using the generated dist config
```

For future schema changes, add a new numbered file in `migrations/` and run `npm run db:migrate:remote` **before** deploying the code that needs it.

## Backup and restore

The records (D1) and the files (R2) are backed up separately. Object keys depend only on record and document IDs, so restoring both brings the links back intact.

**Records (D1)**

```sh
mkdir -p backups
npx wrangler d1 export joyces-home-ledger --remote --output backups/ledger-$(date +%F).sql
```

D1 also has **Time Travel** (point-in-time restore within the retention window):
`npx wrangler d1 time-travel info joyces-home-ledger` and `npx wrangler d1 time-travel restore joyces-home-ledger --timestamp=<ISO time>`.

To restore an export into a fresh database: create it with `wrangler d1 create`, put its id in `wrangler.jsonc`, then run `npx wrangler d1 execute <name> --remote --file backups/ledger-YYYY-MM-DD.sql`. The export already contains the tables, so don't run the migrations first. Afterwards, check that `d1_migrations` lists `0001_init.sql`.

**Documents (R2)**

Create an R2 API token (R2 → Manage API tokens, *Object Read* for backup, *Object Read & Write* for restore). Then use any S3 tool, for example [rclone](https://rclone.org/s3/#cloudflare-r2) with an `r2` remote:

```sh
rclone sync r2:joyces-home-ledger-docs ./backups/docs        # backup
rclone copy ./backups/docs r2:joyces-home-ledger-docs        # restore
```

**Simple everyday backup:** in the app, choose *Export → Download ZIP with documents* with "All records". It contains every original file, `records.csv`, and a report. It's readable without the app, but it isn't a restore format. For a full restore, use the SQL plus R2 backups.

Deleting things: "Move to Trash" and "Remove document" are soft deletes and can be undone. "Delete forever" (Trash only, double confirmation) removes the database rows first and then the R2 files. If the file deletion fails, you're left with an unreferenced file, never a record pointing at a missing file.

## Known browser limitations

- **Voice input** uses the browser's speech recognition. That works in Safari on iPhone (iOS 14.5+), Chrome and Edge. It's not available in Firefox, so the Speak button is hidden there. On iPhone it needs Siri & Dictation enabled and microphone permission for Safari. Some browsers send the audio to Apple's or Google's servers to transcribe it. The transcript box always works with typing, and the iPhone keyboard's own 🎤 dictation key is a good fallback. Spoken text only fills in a draft; nothing is saved until Save is tapped. The parser handles common phrasings (digits or spelled-out numbers, "$7,200" or "7,200 dollars", "February 2nd", "2/2/1959", "the 21st of June"). Anything unusual is highlighted for a person to check.
- **iPhone photos (HEIC):** The app stores only JPEG, PNG and PDF.
  - With *Take photo* or *Add files* in Safari, iOS normally hands the browser a JPEG automatically.
  - If a HEIC file does arrive (for example dragged in on a Windows computer), the app converts it to a real JPEG when the browser can decode HEIC (Safari can).
  - Otherwise it explains how to get a JPEG: iPhone *Settings › Camera › Formats › Most Compatible*, or export the photo as JPEG.
  - Files are never just renamed, and the server checks each file's actual bytes.
- **Camera photos** are re-encoded as JPEG at up to 3200 px on the long edge, which is plenty to read a receipt. Existing JPEG/PNG/PDF files are uploaded unchanged.
- **Size limit:** 20 MB per file and 60 documents per item.
- **Thumbnails:** shown for photos; PDFs show a PDF card with View and Download links.
- **Private browsing / blocked storage:** only the remembered filters are lost. All records live on the server.

## Project layout

```
shared/      types, dates, money, ledger (filters/sorting/grouping/totals), voice parser, CSV/export naming, validation
worker/      index.ts (routes, headers), auth.ts (Access JWT), db.ts (D1), files.ts (sniffing), exports.ts (CSV/ZIP)
src/         Preact app: ledger, item form, trash, print summary, about/tax info, image conversion, speech
migrations/  D1 schema
test/        unit + Worker integration tests
```

## Tax information

The "Why we keep these" page was checked against IRS Publications 523 and 505 and the IRS pages on extensions and amended returns on **October 27, 2026**. It links to those sources. Re-check them each year and update `REVIEWED_ON` in `src/about.tsx`. The app organizes evidence only. It does not give tax advice, and "Approved for basis" is the household's own review status, not an IRS determination.
