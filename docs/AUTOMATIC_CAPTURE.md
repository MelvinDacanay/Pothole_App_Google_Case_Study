# Automatic capture hotfix

Replace `src/views/CaptureView.tsx` in the project **after** applying the Account Consent Hotfix. No backend, environment, rules, or secret changes are included.

The photo check starts automatically after successful media upload, using the account's stored consent. Approved photos are automatically submitted after GPS/EXIF/manual location, street resolution and nearby-pothole lookup complete. Negative or uncertain decisions display the server reason and offer manual review. Service errors remain distinct from negative classifications. A failed save can be retried with its original submission payload/ID. Accepted captures show gallery and contribution confirmation only after server confirmation; duplicate evidence counts as a captured photo, not another distinct pothole. Ambiguous nearby matches are routed to review without credit.

The server release gate is unchanged. `PATCHUP_IMAGE_AI_ENABLED=true` permits verification; the existing `PATCHUP_AUTO_ACCEPT` and matching `PATCHUP_BENCHMARK_APPROVED_VERSION` gate must be enabled only after benchmark and release approval. When the gate is off, even detected potholes are returned as requiring review. No benchmark approval is asserted by this patch.

Validation: TypeScript TSX transpilation/syntax check completed. Full type checking, production build, browser and live Firestore/Gemini tests were not run here. Verify on staging: positive, negative, uncertain, provider unavailable, GPS denied, duplicate evidence, repeated responses, lost submit response/retry, and replacement during verification. Check that approved gallery counts increment exactly once and pending appeals do not award credit. Do not share secrets in an export.
