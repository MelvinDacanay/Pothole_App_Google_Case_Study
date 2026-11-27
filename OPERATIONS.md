> **Image verification v2:** Read [README.md](README.md) and [docs/IMAGE_VERIFICATION.md](docs/IMAGE_VERIFICATION.md) for new server-owned records, disabled-by-default acceptance, test limitations, quota settings, and coordinated deployment. They supersede older image-verification instructions below.

# PatchUp Operations, Deployment & Security Runbook

## 1. Architecture & Runtime Boundary

PatchUp runs as a unified full-stack Node.js/Express application (`server.ts`) serving both the protected `/api/*` backend and the compiled Vite PWA frontend (`dist/`) on a single origin (default port `3000`).

- **Frontend**: React + TypeScript + Tailwind CSS + `vite-plugin-pwa` (Workbox service worker, `manifest.webmanifest`, offline shell fallback).
- **Backend**: Express (`server.ts`) + Firebase Admin SDK (`firebase-admin/app`, `firebase-admin/auth`, `firebase-admin/firestore`) + modular domain engines in `server/`:
  - `server/geo.ts`: Haversine distance, street normalization, ATLDOT/GDOT heuristic jurisdiction classification, geographic distance and duplicate candidate scoring.
  - `server/segments.ts`: Road-aligned corridor grouping, transactional 5-distinct-pothole threshold & report-cycle engine, admin overrides, and audit logging.
  - `server/social.ts`: Friendships, server-maintained leaderboards, 7 community achievements, and notifications.
  - `server/games.ts`: Isolated entertainment minigame score validation & `/gameStats` persistence.
  - `server/rateLimit.ts`: Bounded in-memory rate limiting for expensive/mutating routes.
  - `server/account.ts`: User-initiated personal account deletion with community corridor preservation.
- **Database**: Cloud Firestore (`projectId: patchup-fff96`, `databaseId: (default)`).
- **Media Storage**: Spark-tier `$0` isolated `/mediaObjects/{mediaId}` binary store (`<= 400KB`, `<= 1280x1280`) streamed via `/api/media/:mediaId`.

---

## 2. Environment Variables & Secrets Management

Never commit `.env`, service account JSON files, or API keys to source control. Reference `.env.example` for variable names:

| Variable | Scope | Storage Recommendation | Purpose |
| --- | --- | --- | --- |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Server only | Secure development environment only | Optional development Firebase credential; rejected on Cloud Run |
| `VITE_GOOGLE_MAPS_API_KEY` | Browser bundle | HTTP-referrer restricted Cloud API key | Maps JavaScript API (`MapView`, `PinPickerMap`) |
| `GEMINI_API_KEY` | Server only | Secret Manager / AI Studio Secrets | Optional strict pothole observation (`@google/genai`); see `docs/IMAGE_VERIFICATION.md` |
| `GEMINI_MODEL` | Server only | Env var (e.g. `gemini-3.5-flash-lite`) | Verifiable Gemini model identifier |
| `PATCHUP_ADMIN_EMAILS` | Server only | Env var | Authoritative comma-separated allowlist for all application admin operations |
| `APP_URL` | Server | Runtime env | Public HTTPS deployment URL |
| `PORT` | Server | Runtime env (`3000`) | Listening HTTP port |

**Google Workspace OAuth (Community Sheets Export)**: Uses client-side Google Identity Services (`initTokenClient`) with in-memory-only access tokens (`https://www.googleapis.com/auth/spreadsheets`). Zero client secrets are stored on the server or browser storage.

---

## 3. Build, Lint & Automated Verification Commands

Before every release, run the full verification suite:

```bash
# 1. TypeScript typecheck
npm run lint

# 2. Firestore Security Rules static lint
npm run lint:rules

# 3. Automated unit, security-audit, geo edge-case, and game integrity tests
npm test

# 4. Production Vite + PWA Workbox bundle
npm run build

# 5. Production server start
NODE_ENV=production npm start
```

Inspect `GET /api/health` after startup and confirm:
- `"ok": true`
- `"firebaseConfigured": true`
- `"adminAuthVerifyReady": true`
- `"adminFirestoreReady": true`
- `"mapsConfigured": true`

---

## 4. Deployment & Rollback Procedures

### Cloud Run Deployment (Recommended Full-Stack Runtime)
1. Ensure `npm run build` succeeds and `dist/` contains `index.html`, `manifest.webmanifest`, and `sw.js`.
2. Build and deploy container/source to Cloud Run with `--port=3000` and `NODE_ENV=production`.
3. Select `patchup-backend@patchup-fff96.iam.gserviceaccount.com` as the Cloud Run runtime service account. Use ADC, not a downloaded key. Attach only required non-identity secrets (for example the optional `GEMINI_API_KEY`) via Secret Manager. See [production identity and admin access](docs/PRODUCTION_IDENTITY.md).
4. Confirm Firebase Authentication Authorized Domains includes the deployed HTTPS origin.

### Diagnosing HTML returned by an API request

The Vite build contains only the frontend. Publishing `dist/` to a static SPA host
does not deploy `server.ts` or its authenticated API handlers. If
`/api/friends/search?q=&recommendations=true` returns `text/html` and the application
shell, that host is not routing the request to the Express backend. A frontend
JSON guard reports this safely but cannot restore the missing server.

Deploy the full-stack runtime above and serve the app from that origin, or configure
the frontend host's reverse proxy to forward `/api/*` to that runtime. Preserve the
Authorization header and query string. Do not rewrite API requests to `index.html`
or put Firebase Admin credentials in the browser. The Express server already
registers its API handlers and JSON API 404 middleware before the SPA fallback.

After routing is configured, verify `/api/health` returns JSON and the expected
Firebase readiness flags. An unauthenticated `/api/friends/search` request should
return a JSON authentication error, never HTML. Then sign in and verify search
and recommendations. Deploy the matched rules to the correct default database in staging first. See the verification release checklist.

### Rollback Procedure
- **Application / Server Rollback**: Shift 100% of Cloud Run traffic back to the previous verified revision (`gcloud run services update-traffic <service> --to-revisions=<prev-rev>=100`).
- **Firestore Rules Rollback**: Keep `firestore.rules` committed in Git alongside `firebase-blueprint.json` and `security_spec.md`. To revert rules, check out the last known-good commit and re-run `npm run lint:rules` before deploying rules.
- **PWA Cache Recovery**: `vite-plugin-pwa` uses `registerType: 'autoUpdate'`, allowing newly deployed service workers to supersede stale caches automatically on reload.

---

## 5. Backups, Retention & Quotas

### Firestore Scheduled Backups
Enable managed scheduled exports or Point-in-Time Recovery (PITR) on project `patchup-fff96` for database `(default)`:

```bash
gcloud firestore export gs://<your-backup-bucket>/patchup-$(date +%F) \
  --project=patchup-fff96 \
  --database='(default)'
```

### Cost & Quota Guardrails

Google Maps JavaScript remains available for map display and pin selection. Server-side Google Geocoding v4 supports automatic capture location identification; see the activation gates below.
- **Street identification**: Uses approved Google reverse geocoding, independently licensed Atlanta street centerline data where enabled, or reporter-observed street names as fallback.
- **Gemini Guardrail**: Gemini runs only after explicit consent during capture, if `PATCHUP_IMAGE_AI_ENABLED=true`—never on map pan, feed load, or corridor listing.
- **Rate Limiting**: Express rate limits protect `/api/geocode/reverse`, `/api/potholes/analyze`, `/api/potholes/submit`, `/api/games/score`, `/api/friends/*`, and `/api/admin/*`.
- **Spark Tier Media Hygiene**: `/mediaObjects` caps binaries at `<= 400KB` (`<= 1280px` max edge). Monitor total Firestore document storage in the Firebase Console against Spark quotas.

---

## 6. Monitoring, Error Reporting & Honest Community Reporting Policy

- **Health Endpoint**: Monitor `GET /api/health` for uptime and Admin SDK / Firestore readiness (`adminFirestoreReady: true`).
- **Quota Handling**: Maps `429` / `RESOURCE_EXHAUSTED` responses propagate cleanly to the UI (`gmp-quota-exceeded` banner) without crashing capture or map views.
- **Community Integrity Policy**: PatchUp is an independent community-social platform. Never mark a report `submitted` without an administrator's verified external case/reference number and channel confirmation, and never mark a pothole `repaired` or award `Community Champion` badges until repair is credibly verified.

## Automatic location identification (Google Geocoding v4)

Capture continues to extract EXIF locally before photo compression; camera captures without GPS request a single device fix. Older uploads without GPS require a pin rather than silently using the reporter's current location. Pin changes trigger a debounced reverse lookup and invalidate prior street/candidate confirmation. The existing photo privacy review and explicit location confirmation are retained.

The new provider is disabled by default, and runs only on Cloud Run using its attached, startup-verified `patchup-backend` service account via the metadata OAuth token endpoint. No server Maps API key is consumed. Google Maps browser key remains necessary for interactive maps. Geocoding API must be enabled, billing must be linked, and runtime identity must have `serviceusage.services.use` on the intended billing project. Validate permissions before activation; do not grant broad owner/editor roles. Metadata tokens use the general cloud-platform scope. Provider failure, missing results, ambiguity, or exhausted quotas permit independent street entry or the existing optional City centerline fallback. Google results alone do not establish jurisdiction. Google-only results are previews and cannot satisfy the durable street requirement.

`PATCHUP_GOOGLE_GEOCODING_ENABLED=true` AND `PATCHUP_GOOGLE_GEOCODING_PREVIEW_APPROVED=true` allow live, explicitly opted-in, user-specific address previews only. The old STORAGE_APPROVED flag no longer authorizes anything. Google response values never enter `roadLookups`, community submissions, corridor data or server-approved export rows through the new path. Independent street proof must come from locally prepared Census TIGER/Line data, explicitly reuse-approved city data, or independently attested reporter observation. The Google preview may not be used as proof. Attribution and public terms/privacy are required. Review the actual accepted agreement, UI attribution/consent and historical records before activation. See docs/LOCATION_PROVENANCE.md.

Shared Firestore transactions reserve every provider attempt before dispatch: 100/day, 3,000/month, 20/minute globally, 5/minute and 25/day per user (fixed UTC windows). Failed attempts count; no automatic retry. Counters fail closed on database failure. These are application limits, not Google project quotas; configure provider quotas separately to guard other clients and set billing alerts. The merge script does not enable billing, modify IAM/quotas, delete credentials, deploy, or revert PR #5. Live end-to-end validation is required after explicit activation.

## Production hardening (PR #7 candidate)
The existing transactional verificationBudgets reservation now has fixed ceilings: 100/day, 3,000/month, 10/minute globally, 25/day and 3/minute per UID (UTC fixed windows). Lower environment limits remain supported; invalid settings fail closed. Existing deployed values are not raised automatically. The approved model is gemini-3.5-flash-lite; the provider uses standard Gemini Developer API requests, one attempt, the existing 400 KB/1280 pixel input guard and 256 output-token limit. Cached verification and manual review behavior remain unchanged. Provider quota and budget settings are separate from app counters.

Public community list queries retain their current 150/40 result bounds and 30-second cache; simultaneous cache misses now share one query per instance. This is not a Firestore spending cap. Direct client listeners, media reads, admin queries and egress still need monitoring; do not silently truncate completeness-sensitive queries. TTL deletions may incur charges. Review reads/writes/storage and budget alerts before enabling billing.

The Dockerfile and deploy/cloud-run.service.yaml are templates for a later reviewed deployment. Build with restricted public browser keys via VITE_FIREBASE_API_KEY and VITE_GOOGLE_MAPS_API_KEY build args; never supply server secrets at build time. Use a reviewed image digest in the template, us-east1, dedicated runtime identity, 0 minimum / 1 maximum instance, 1 CPU / 1 GiB, concurrency 10 and request timeout 60 seconds. Instance limits are not absolute cost ceilings. Configure browser key referrers, Firebase authorized domains, serviceusage.services.use as needed, and Secret Manager access separately. The template deliberately disables paid providers, automatic acceptance, city lookup and email. Do not apply it until billing, independent dataset provisioning, provenance remediation and staging validation are authorized. Verify the container and live capture separately. No deployment or IAM modifications are part of this patch.
