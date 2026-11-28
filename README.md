# PatchUp

PatchUp is an independent Atlanta community pothole reporting PWA. **`main` is the canonical production source baseline.** Develop on feature branches and merge reviewed pull requests; do not restore older exports or overwrite current code. A merge is not a deployment or authorization to enable paid processing. The production Cloud Run application has not been deployed as of November 27, 2026.

## Application

Home contains the Community Activity Feed, Community Gallery, Live Atlanta Street Map and Take a Pothole Photo. Leaderboard, Arcade and Profile are the other ordinary navigation destinations. Map inspection and photo capture are in-app flows. Admin Hub is restricted to verified allowlisted administrators. Five qualifying distinct approved potholes near each other on a street prepare a private report draft. Reports, agency responses and repair confirmations are administrative only; no automatic city email delivery or public repair tracking. Arcade scores do not count as pothole contributions.

Capture extracts photo GPS locally when available, supports a one-time camera location or manual pin, and resolves an independent street name. A pin change invalidates the prior location confirmation. Optional Google address previews are transient, private and never a source of shared street records. Pothole uploads require automatic face/plate redaction on Cloud Run before storage, verification or publication; failure blocks upload. Detection is not guaranteed to catch every sensitive pixel. Older pothole photos lacking proof are withheld. Gemini image processing and automatic acceptance are disabled until their separate release gates pass. With image AI disabled, new Capture submissions are also blocked by the verification-ID requirement; the initial configuration is not a manual-only launch.

## Development

Use Node 24.22.3 and npm. Clone main, create a feature branch, run `npm ci`, copy `.env.example` to `.env` locally, and configure restricted browser keys and isolated development credentials. Never commit secrets or use live Firestore for disposable tests. Use a separate staging project/config or demo emulator; the production Firebase project and default database are configured in `firebase-applet-config.json`. Cloud Run runtime identity and redaction routing are production-specific; a separate staging deployment requires reviewed project-specific configuration, not simply a different Firebase config. Local UI development does not support real pothole uploads: redaction fails closed outside Cloud Run. Do not bypass it.

```sh
npm run lint
npm run lint:rules
npm test
npm run build
npm run dev
```

For Firestore emulator tests, use Firebase CLI and Java 21: `firebase emulators:exec --only firestore --project demo-patchup-verification "npm run test:emulator"`. The CI workflow also scans credentials and audits dependencies. Passing CI does not establish live provider accuracy or production readiness. `npm run preview` is a static frontend preview, not the full-stack runtime. The full server uses `npm start` after the build. The `firebase-blueprint.json` documents stored-record shapes including legacy fields; server code and Firestore rules are authoritative, not that descriptive blueprint. The committed font is already present; do not restore it from an old archive. Review distribution rights before launch.

## Production build

Read [OPERATIONS.md](OPERATIONS.md) before any build or release. Provision the reviewed Census dataset as `data/tiger-roads.json` using [data/README.md](data/README.md). It is a required Docker build input, not a checked-in generated file. Docker verifies its checksum and packages it into `/app/data/tiger-roads.json`. Supply only the restricted public Firebase and Maps browser keys as Docker build arguments. Server secrets are runtime-only.

Production uses Cloud Run in us-east1, Firebase/Firestore `(default)`, dedicated build and backend identities, Artifact Registry and Secret Manager. See [production identity](docs/PRODUCTION_IDENTITY.md) and [Cloud Run template](deploy/cloud-run.service.yaml). The repository CI workflow verifies code and does not deploy. Do not attach automatic external deployments without approval. Do not deploy static `dist` alone. Figma configuration is retained only for design iteration.

## Documentation

- [Operations and release checklist](OPERATIONS.md)
- [Security specification](security_spec.md)
- [Photo redaction](docs/PHOTO_REDACTION.md) and [privacy/storage](docs/PHOTO_PRIVACY_STORAGE.md)
- [Location provenance](docs/LOCATION_PROVENANCE.md) and [automatic capture](docs/AUTOMATIC_CAPTURE.md)
- [Image verification](docs/IMAGE_VERIFICATION.md), [classification](docs/ATLDOT_CLASSIFICATION.md), [benchmark](docs/BENCHMARK.md)
- [Account consent](docs/ACCOUNT_CONSENT.md) and [Admin Hub](docs/ADMIN_HUB.md)

Do not release publicly until live privacy, location, authorization, browser/device and manual review tests pass; activate Gemini and automatic acceptance only under their separate approval gates.
