# PatchUp Operations, Deployment & Security Runbook

## 1. Architecture & Runtime Boundary

PatchUp runs as a unified full-stack Node.js/Express application (`server.ts`) serving both the protected `/api/*` backend and the compiled Vite PWA frontend (`dist/`) on a single origin (default port `3000`).

- **Frontend**: React + TypeScript + Tailwind CSS + `vite-plugin-pwa` (Workbox service worker, `manifest.webmanifest`, offline shell fallback).
- **Backend**: Express (`server.ts`) + Firebase Admin SDK (`firebase-admin/app`, `firebase-admin/auth`, `firebase-admin/firestore`) + modular domain engines in `server/`:
  - `server/geo.ts`: Haversine distance, street normalization, ATLDOT/GDOT heuristic jurisdiction classification, 29-day cached reverse geocoding.
  - `server/segments.ts`: Road-aligned corridor grouping, transactional 5-distinct-pothole threshold & report-cycle engine, admin overrides, and audit logging.
  - `server/social.ts`: Friendships, server-maintained leaderboards, 7 civic achievements, and notifications.
  - `server/games.ts`: Isolated entertainment minigame score validation & `/gameStats` persistence.
  - `server/rateLimit.ts`: Bounded in-memory rate limiting for expensive/mutating routes.
  - `server/account.ts`: User-initiated personal account deletion with civic corridor preservation.
- **Database**: Cloud Firestore (`projectId: patchup-fff96`, `databaseId: ai-studio-bca41787-ae3f-4dc1-a851-4fcb17cec913`).
- **Media Storage**: Spark-tier `$0` isolated `/mediaObjects/{mediaId}` binary store (`<= 400KB`, `<= 1280x1280`) streamed via `/api/media/:mediaId`.

---

## 2. Environment Variables & Secrets Management

Never commit `.env`, service account JSON files, or API keys to source control. Reference `.env.example` for variable names:

| Variable | Scope | Storage Recommendation | Purpose |
| --- | --- | --- | --- |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Server only | Cloud Run Secret Manager / AI Studio Secrets | Authenticates Firebase Admin SDK (`patchup-fff96`) |
| `VITE_GOOGLE_MAPS_API_KEY` | Browser bundle | HTTP-referrer restricted Cloud API key | Maps JavaScript API (`MapView`, `PinPickerMap`) |
| `GOOGLE_MAPS_SERVER_API_KEY` | Server only | API-restricted key in Secret Manager | Server-side Reverse Geocoding (`geocode.googleapis.com`) |
| `GEMINI_API_KEY` | Server only | Secret Manager / AI Studio Secrets | Optional road-defect image classification (`@google/genai`) |
| `GEMINI_MODEL` | Server only | Env var (e.g. `gemini-2.5-flash`) | Verifiable Gemini model identifier |
| `PATCHUP_ADMIN_EMAILS` | Server only | Env var | Comma-separated allowlist for `/api/admin/bootstrap` |
| `APP_URL` | Server | Runtime env | Public HTTPS deployment URL |
| `PORT` | Server | Runtime env (`3000`) | Listening HTTP port |

**Google Workspace OAuth (Civic Sheets Export)**: Uses client-side Google Identity Services (`initTokenClient`) with in-memory-only access tokens (`https://www.googleapis.com/auth/spreadsheets`). Zero client secrets are stored on the server or browser storage.

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
3. Attach secrets (`FIREBASE_SERVICE_ACCOUNT_JSON`, `GOOGLE_MAPS_SERVER_API_KEY`, optional `GEMINI_API_KEY`) via Cloud Secret Manager—never inline plaintext values in CI logs.
4. Confirm Firebase Authentication Authorized Domains includes the deployed HTTPS origin.

### Rollback Procedure
- **Application / Server Rollback**: Shift 100% of Cloud Run traffic back to the previous verified revision (`gcloud run services update-traffic <service> --to-revisions=<prev-rev>=100`).
- **Firestore Rules Rollback**: Keep `firestore.rules` committed in Git alongside `firebase-blueprint.json` and `security_spec.md`. To revert rules, check out the last known-good commit and re-run `npm run lint:rules` before deploying rules.
- **PWA Cache Recovery**: `vite-plugin-pwa` uses `registerType: 'autoUpdate'`, allowing newly deployed service workers to supersede stale caches automatically on reload.

---

## 5. Backups, Retention & Quotas

### Firestore Scheduled Backups
Enable managed scheduled exports or Point-in-Time Recovery (PITR) on project `patchup-fff96` for database `ai-studio-bca41787-ae3f-4dc1-a851-4fcb17cec913`:

```bash
gcloud firestore export gs://<your-backup-bucket>/patchup-$(date +%F) \
  --project=patchup-fff96 \
  --database=ai-studio-bca41787-ae3f-4dc1-a851-4fcb17cec913
```

### Cost & Quota Guardrails
- **Geocoding Cache**: Reverse geocoding results are cached in `/geocodeCache` for 29 days (`< 30`-day Maps ToS window) to eliminate duplicate API calls for unchanged coordinates.
- **Gemini Guardrail**: Gemini runs only when explicitly invoked during capture/duplicate review—never on map pan, feed load, or corridor listing.
- **Rate Limiting**: Express rate limits protect `/api/geocode/reverse`, `/api/potholes/analyze`, `/api/potholes/submit`, `/api/games/score`, `/api/friends/*`, and `/api/admin/*`.
- **Spark Tier Media Hygiene**: `/mediaObjects` caps binaries at `<= 400KB` (`<= 1280px` max edge). Monitor total Firestore document storage in the Firebase Console against Spark quotas.

---

## 6. Monitoring, Error Reporting & Honest Civic Reporting Policy

- **Health Endpoint**: Monitor `GET /api/health` for uptime and Admin SDK / Firestore readiness (`adminFirestoreReady: true`).
- **Quota Handling**: Maps `429` / `RESOURCE_EXHAUSTED` responses propagate cleanly to the UI (`gmp-quota-exceeded` banner) without crashing capture or map views.
- **Civic Integrity Policy**: PatchUp is an independent civic-social platform. Never mark a report `submitted` without an administrator's verified external case/reference number and channel confirmation, and never mark a pothole `repaired` or award `Community Champion` badges until repair is credibly verified.
