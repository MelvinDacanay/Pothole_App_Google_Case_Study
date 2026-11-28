# PatchUp Security Specification — current release baseline

## 1. Data Invariants

1. **PII Isolation**: Private account email and notification settings are stored under `/users/{uid}/private/account` and are not directly readable by other authenticated or anonymous clients. Server-side administrative records may also contain restricted identity information.
2. **Server-Authoritative Community Infrastructure, Leaderboards & Canonical Potholes**: Direct client writes to `/potholes`, `/submissions`, `/geocodeCache`, `/friendships`, `/leaderboardStats`, `/achievements`, `/activityFeed`, `/streetSegments`, `/streetSegments/{id}/acceptedPotholes`, `/reports`, `/reports/{id}/supplements`, `/adminAudit`, and `/gameStats` are forbidden (`allow create, update, delete: if false`). All threshold evaluations, report cycles, and recounts run inside Express + Firebase Admin SDK transactions.
3. **No Client-Assigned Roles**: Neither `/users/{uid}` nor `/users/{uid}/private/account` permits `role`, `isAdmin`, or `admin` shadow fields. Admin access requires a current verified, enabled Firebase account matching the server-only `PATCHUP_ADMIN_EMAILS` allowlist. Legacy custom claims and enrollment documents confer no authority.
4. **Admin RBAC & Honest Reporting**: Admin endpoints (`/api/admin/*`) enforce verified ID tokens AND server-verified admin status (`403` otherwise). Reports cannot enter `submitted` status without an explicit external reference/case number and channel confirmation, and every admin override is logged to `/adminAudit`.
5. **Server-managed media store**: Bounded images (up to 400,000 bytes, 1280px; JPEG/PNG/WebP input) are decoded and stored as JPEG evidence and thumbnails after required privacy checks. Firestore `/mediaObjects/{mediaId}` is the default; optional private GCS stores bytes behind server metadata. Owner/admin and eligible public references use `/api/media/:id`. Client deletion and mutation are denied.
6. **Temporal & ID Integrity**: Client-controlled IDs and timestamps are checked by the corresponding rules/routes (including bounded alphanumeric IDs and `request.time` on mutable timestamps). Game statistic IDs have a separate 160-character bound.
7. **Entertainment Score Isolation**: Minigame high scores in `/gameStats/{statId}` are server-written via `POST /api/games/score` with strict score bounds and score-to-duration plausibility checks, and never mutate `distinctPotholeCount`, `evidenceCount`, `leaderboardStats`, `achievements`, `streetSegments`, or `reports`.

## 2. The "Dirty Dozen+" Adversarial Payloads

1. **Identity Spoofing on Public Profile**: User `A` attempts `create` on `/users/B` with `uid: "B"`. -> `PERMISSION_DENIED`
2. **Owner UID Mismatch**: User `A` attempts `create` on `/users/A` with `uid: "B"`. -> `PERMISSION_DENIED`
3. **Shadow Admin Escalation**: User `A` attempts `create` or `update` on `/users/A` including `{ isAdmin: true }` or `{ role: "admin" }`, or writes `/admins/A`. -> `PERMISSION_DENIED`
4. **Score Tampering on Create**: User `A` creates `/users/A` with `distinctPotholeCount: 500`. -> `PERMISSION_DENIED`
5. **Score & Badge Tampering on Update**: User `A` writes directly to `/leaderboardStats/A` or `/achievements/A/badges/road_scout`. -> `PERMISSION_DENIED`
6. **Direct Client Segment / Report Spoof**: User `A` attempts `create` or `update` directly on `/streetSegments/{id}` or `/reports/{id}` via client SDK. -> `PERMISSION_DENIED`
7. **Unauthorized Friendship Read/Write**: User `C` attempts to read `/friendships/A__B` or create/accept a friendship directly via client SDK. -> `PERMISSION_DENIED`
8. **Cross-User Notification Snooping / Tampering**: User `B` attempts `get`/`list`/`update` on `/notifications/A/items/{id}`. -> `PERMISSION_DENIED`
9. **Audit Log Tampering / Reading**: Non-admin User `A` attempts to read or write `/adminAudit/{eventId}`. -> `PERMISSION_DENIED`
10. **Base64 / Data URI Injection in Reference Doc**: User `A` writes `downloadUrl: "data:image/jpeg;base64,/9j/..."` to `/users/A/storageChecks`. -> `PERMISSION_DENIED`
11. **Oversized Binary / Metadata Abuse**: User `A` writes `sizeBytes: 50000000` or `data.size() > 400000` to `/mediaObjects/{mediaId}`. -> `PERMISSION_DENIED`
12. **Blanket Collection Scraping**: Unauthenticated visitor attempts `list` on `/users`, `/leaderboardStats`, `/friendships`, `/adminAudit`, `/mediaObjects`, `/geocodeCache`, `/gameStats`, or `/users/A/private`. -> `PERMISSION_DENIED`
13. **Minigame Score Forgery**: User `A` writes directly to `/gameStats/A_pothole_runner` via client SDK (`PERMISSION_DENIED`) or submits `score: 49000` with `durationMs: 2000` to `/api/games/score` (`400 Bad Request`).

## Image verification and privacy invariants

- Server-owned `/imageVerifications`, `/imageAnalysisCache`, `/verificationBudgets`, `/imageClaims`, `/contributionEffects`, `/mediaRetired` and `/redactionBudgets`, `/mediaBudgets`, `/geocodingBudgets` and `/roadLookups` deny every direct client read/write.
- A verified-email authenticated uploader must own media exactly. The service decodes and re-encodes bounded images, strips metadata and requires successful DLP face/plate processing before pothole storage or verification.
- Server decisions require strict observation validation, current release, expiry, owner, media ID, original byte digest and normalized content digest. Live verification requires paid mode and mandatory redaction; auto-accept additionally requires an explicitly enabled, benchmark-approved release.
- One transaction checks claims, reads all documents first, consumes the verification, claims normalized image content, records contribution, and updates counters/leaderboard/feed. Uncertain, unavailable and negative cases can only enter pending review when a valid server-issued verification exists. Disabled image AI/paid mode returns no verification ID, blocking new submissions.
- No arbitrary second-image or user-note instructions are passed to Gemini. Geographic duplicates are separate from image classification. No AI claim proves capture location or authenticity.
- Pending review requires a verified administrator; approve/reject/merge is audited atomically with contribution credit. Rejection is terminal for that pending claim.
- Owner-scoped cache, durable call and submission budgets, cooldown and provider circuit breaker constrain spend. Exact image hashing is not perceptual deduplication.
- Provisional media and coordinates are not public. Approved photographs with valid server redaction proof may be public; detector completion does not guarantee removal of all identifying pixels. Older unprocessed pothole photos are withheld.
- See `docs/IMAGE_VERIFICATION.md` for test limitations, deployment prerequisites, legacy-data limitations, and retention.
- Google address previews are transient and private; durable street data requires independent provenance. Reports and repair information remain administrative. See `docs/PHOTO_REDACTION.md`, `docs/LOCATION_PROVENANCE.md` and `docs/PRODUCTION_IDENTITY.md`.
