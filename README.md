# PatchUp — image verification v2

Reworked from the latest `PatchUpUIRedesign (2).zip` (the pre-Phase-1 Figma Make export). The existing React/Vite design, Express backend, Firebase project/database identity, map, capture, leaderboard, profiles, achievements, arcade and PWA remain the baseline. The image-verification subsystem has been replaced; see [implementation and release notes](docs/IMAGE_VERIFICATION.md).

**Status:** implementation candidate, not production-certified. AI image calls and automatic acceptance default to disabled. Real Gemini accuracy, Firebase emulator/rules enforcement, a clean native dependency build and browser E2E testing are outstanding.

## Local setup (Antigravity)

1. Extract into a **new directory** and commit the clean source before making changes. Do not overwrite your working directory or copy the old `.env` into the archive. Use Node 24 and npm.
2. Run `npm ci`. If your platform lacks an optional native dependency, resolve the platform install issue locally rather than reusing another OS's `node_modules`.
3. Copy `.env.example` to `.env`. Set your rotated `VITE_FIREBASE_API_KEY` (the public web key), `GEMINI_API_KEY`, Maps browser/server keys, and Firebase Admin credentials using your existing secure setup. The Firebase project and default database remain configured in `firebase-applet-config.json`; the old web key is deliberately blank. For local ADC, set `PATCHUP_USE_ADC=true` after configuring ADC. On Cloud Run attach the dedicated production service account and use ADC (no exported key). Configure `PATCHUP_ADMIN_EMAILS` server-side for every approved administrator; old claims and enrollment documents do not authorize access. See [production identity](docs/PRODUCTION_IDENTITY.md).
4. Restore your originally supplied `public/fonts/coolvetica-rg.otf` locally from your own original project if you have rights to use it. The original font file is not redistributed in this archive; CSS retains its existing reference and fallback. All other original artwork and layout source are preserved.
5. Use a **separate staging Firebase project/database** (update the client config and named database configuration for staging). Do not point a staging runtime at live Firestore with test accounts. Review and deploy the corresponding rules to staging before testing. Preserve existing Firestore indexes; compare the index file with existing configuration before deploying any indexes.
6. Run:

```sh
npm run lint
npm run lint:rules
npm test
npm run build
npm run dev
```

Open the local URL printed by the server. `/api/health` must return JSON; the Firebase admin readiness flags must be true to test submission. Test signed-in upload, pinning, manual review, admin approval, gallery and map. An unavailable backend is not a successful verification.

## Enable AI only in an eligible test/staging environment

```env
GEMINI_MODEL=gemini-3.5-flash-lite
PATCHUP_IMAGE_AI_ENABLED=true
PATCHUP_AUTO_ACCEPT=false
PATCHUP_BENCHMARK_APPROVED_VERSION=""
```

Keep live-user image processing disabled until you have checked current provider eligibility, data use, billing, and privacy disclosures. For free-tier experiments use only approved, non-sensitive test images. Paid production was the earlier recommendation because incidental sensitive information can appear in street photos. Confirm current terms and model availability in your own Google Cloud project; no API call was made while preparing this package.

The user must affirm 18+ and choose either the Gemini check or manual review. With automatic acceptance disabled, even a positive AI observation requires administrator approval. No pending contribution earns credit.

## Evaluate and release

Read [benchmark protocol](docs/BENCHMARK.md) and [release checklist](docs/IMAGE_VERIFICATION.md). Run the included benchmark script on your labeled, compressed, non-sensitive photo set. Do not set the release approval environment variable until the held-out benchmark and security/E2E checks pass and your team approves the evidence. A 500-image benchmark is not included; the tiny test fixtures are generated format-check images, not an accuracy dataset.

## Figma Make

Import the source for design iteration only. Preserve `server/`, `server.ts`, API contracts, Firestore rules and tests when merging design changes. A static Figma Make deployment of `dist/` is not a deployment of the Express/Firebase Admin backend. Deploy the full stack on your own secure runtime and route `/api/*` there. Never paste `.env` or private credentials into Figma or the source archive.
