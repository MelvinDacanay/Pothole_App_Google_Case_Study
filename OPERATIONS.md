# PatchUp production operations

Main is the production source baseline, not proof of deployment. No release is authorized by this runbook. Current infrastructure inventory (operator-verified November 27, 2026; recheck before use):

| Resource | Configuration |
| --- | --- |
| Project / database | patchup-fff96 / (default), us-east1 |
| Runtime | patchup-backend@patchup-fff96.iam.gserviceaccount.com |
| Builder | patchup-build@patchup-fff96.iam.gserviceaccount.com |
| Image repository | us-east1-docker.pkg.dev/patchup-fff96/patchup-production |
| Build source staging | gs://patchup-fff96-build-source-884267611225; private, one-day lifecycle, soft delete disabled |
| Runtime secrets | patchup-gemini-api-key (version 1 enabled); existing Maps Server secret retained but not consumed by current backend |
| Cloud Run | No application deployed at inventory date |

Run, Cloud Build, Artifact Registry, Secret Manager and DLP APIs are enabled; Vertex AI and Cloud Functions remain disabled. Billing is linked. Monthly alert budget $10 is not a hard ceiling; service spending caps $3 Gemini and $2 Cloud Run are configured separately and may have enforcement delays. Other services can incur costs. Verify current settings before release; do not recreate infrastructure blindly.

## Source and build

Use a reviewed main commit, clean checkout, Node 24.22.3, npm ci and full CI checks. Do not use old archives. Prepare or obtain the approved Census dataset per [data/README.md](data/README.md). The Dockerfile requires the pinned checksum and includes the file in the runtime. Generated data stays outside Git; distribute the approved artifact and checksum to authorized builders. Explicitly include the file and tracked checksum in the source archive even though Git ignores the JSON. Exclude .git, .env, credentials and real benchmark photos. Inspect the archive before uploading. For Cloud Build directory uploads, the explicit `.gcloudignore` allowlist includes the dataset and checksum; review actual upload contents before building.

Build using the dedicated builder explicitly (not the default Compute identity); use Cloud Logging-only build logs and the private staging bucket. Provide VITE_FIREBASE_API_KEY and VITE_GOOGLE_MAPS_API_KEY as public restricted build args. Never pass server keys or ADC files to Docker. Approved team members can act as the builder and backend; source upload permissions must be verified separately. Use immutable image digests for releases and configure reviewed registry cleanup policies before accumulating images. Build and runtime permissions are separate; technical deployers can indirectly exercise runtime privileges and incur costs.

## Runtime configuration

Use `deploy/cloud-run.service.yaml` as a reviewable template; replace IMAGE_URI with the reviewed digest and the approved administrator/report mailbox placeholders, not secret values. Cloud Run: us-east1, 1 CPU, 1 GiB, min 0/max 1, concurrency 10, timeout 60s, port 3000, request-based billing. Start private; verify invoker IAM separately. Keep Firebase ADC keyless; startup rejects exported credentials and incorrect identity. Gemini secret is injected only at runtime. Google reverse geocoding uses metadata OAuth, not a server API key. Configure restricted browser referrers and Firebase authorized domains for the real deployment URL. Retain old credentials until dependencies are verified. Do not set development ADC or emulator variables in the runtime.

**Current release limitation:** disabling image AI or paid mode returns HTTP 503 before issuing a verification ID. New Capture submissions require that ID even for manual review. Existing eligible pending reviews may still be processed. The safe initial runtime is for controlled validation, not an operational manual-only launch. Do not bypass authorization to work around this.

The `.env.example` is for local development. The Cloud Run template is the reviewed initial runtime contract. Populate the current approved server-only administrator allowlist and reporting mailbox outside Git. An omitted allowlist denies admin access; explicitly setting an empty/changed list can reconcile existing enrollments and revoke sessions. See [production identity](docs/PRODUCTION_IDENTITY.md).

## Data and cost controls

| Operation | Initial application limits (UTC windows) |
| --- | --- |
| Gemini | 10/min, 100/day, 3000/month, 3/min and 25/day per user; fixed standard model |
| Uploads | 10/user/day, 100/day, 1000/month |
| New Firestore media allocation | 250,000,000 bytes cumulative |
| Submissions | 25/user/day |
| DLP | 10/min, 100/day, 1000/month, 10/user/day, 400,000,000 input bytes/month |
| Optional Google preview | 20/min, 100/day, 3000/month, 5/min and 25/day per user |

Reservations may count failed attempts; these are not dollar ceilings. Provider quota configuration is separate: standard Gemini 10/min and 100/day for approved model; Maps JS 30/min and 150/day; Geocoding v4 reverse 20/min and 100/day; DLP image scans 10/min. Other provider quota classes may remain available. Monitor actual usage, Firestore reads/writes, image storage, network and logs. The per-instance public reads cache is not a global Firestore spending limit. Do not reset counters to circumvent limits.

Default media storage is Firestore; GCS migration and maintenance are opt-in, not performed at merge. Preserve historical evidence, withhold unredacted pothole photos and unknown-origin locations; never invent proof. Review [privacy/storage](docs/PHOTO_PRIVACY_STORAGE.md) and [location provenance](docs/LOCATION_PROVENANCE.md).

## Release gates (all operator actions; deployment paused)

1. Review CI, clean native build, container contents, secrets and identity; verify effective IAM, costs, browser restrictions and domains. Confirm external hosting has no automatic deployment triggered by a main-branch merge.
2. Test matched server/frontend/rules in isolated staging. Production-specific identity and DLP routing need explicit staging adaptation before real uploads. Review existing Firestore indexes rather than replacing blindly. Deploy rules and matching application only after explicit authorization. Retire unsafe legacy endpoints.
3. Verify `/api/health`, signed-in and anonymous access, allowlist revocation, photo and thumbnail redaction including detector failure, GPS/pin changes, independent street lookup, duplicate handling, Home attribution, pending review, leaderboard, arcade, account deletion and private Admin Hub reports. Do not send real ATL311 messages in tests.
4. Review legacy data and legal/support disclosures; leave city lookup and Google preview off until rights and validation are approved. Leave history audit flag false until actual remediation.
5. Enable paid Gemini image processing only after explicit provider/privacy review, then benchmark reviewed pre-redacted fixtures. Automatic acceptance requires exact current approval version and separate sign-off. Never bypass redaction or fabricate benchmark approval. The CLI bypasses application budgets; respect provider quotas and spread evaluation over approved quota windows.
6. Public access is a separate decision. Roll back only to a safe compatible revision; otherwise stop uploads/admin traffic and forward-fix. Never restore client-trusting, claim-authorizing or unredacted media paths.

No deployment, billing, IAM or data changes are triggered by this runbook.
