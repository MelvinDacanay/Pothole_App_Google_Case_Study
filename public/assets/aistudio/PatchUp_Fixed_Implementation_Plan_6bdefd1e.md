# PatchUp --- Fixed Implementation Plan

## Atlanta Crowdsourced Pothole & Civic-Social Progressive Web App

**Document status:** Consolidated implementation specification\
**Product:** PatchUp\
**Initial geography:** Atlanta, Georgia, USA\
**Platform:** Mobile-first Progressive Web App (PWA), installable from
iOS Safari and Android Chrome\
**Primary stack:** React, Vite, TypeScript, Express, Firebase, Google
Maps Platform, optional Gemini

------------------------------------------------------------------------

## 1. Executive Summary

PatchUp is a community-driven social application for documenting,
mapping, and escalating potholes across Atlanta. It turns an everyday
road-safety frustration into a useful, social, and entertaining civic
experience.

Users photograph potholes, attach a location, contribute evidence to a
shared map, connect with friends, compete on leaderboards, earn
achievements, and help produce consolidated street-level reports. The
application also includes two optional minigames: **Pothole Repair** and
**Atlanta Pothole Runner**.

PatchUp is not a government website and must not imply that it is
operated by, endorsed by, or directly integrated with the City of
Atlanta or Georgia Department of Transportation. Municipal reporting
must be honest about what has actually been submitted and acknowledged.

### Product principles

1.  **Useful before gamified:** capture, location, map, and report data
    must be dependable before secondary features are expanded.
2.  **Social, not frivolous:** competition and games make civic
    participation engaging without trivializing road hazards.
3.  **Geographically accurate:** duplicate detection and street grouping
    must not rely on street names or arbitrary map grids alone.
4.  **Privacy by default:** location is requested only when needed; no
    continuous background tracking.
5.  **Live data only:** production community statistics must come from
    real accepted records. Empty states are preferable to fabricated
    activity.
6.  **Honest reporting:** PatchUp must never claim that a report was
    submitted unless the receiving authority or an authorized
    administrator confirms it.
7.  **Progressive delivery:** build and test the platform in phases,
    with acceptance criteria before moving forward.

------------------------------------------------------------------------

## 2. Product Scope and Core Experiences

### 2.1 Primary user journeys

#### First launch and installation

-   Visitors can view the public-facing community map and permitted
    public activity without creating an account.
-   Authentication is required to submit potholes, add friends, compete,
    or access account-specific features.
-   Provide contextual installation instructions:
    -   iOS Safari: Share → Add to Home Screen → Add.
    -   Android Chrome: use the browser's install option when available.
-   Hide installation prompts when the app is already running in
    standalone mode.
-   Do not promise identical installation or browser capabilities across
    platforms.

#### Pothole capture

1.  User taps **Capture**.
2.  User takes a photo or selects an existing image.
3.  Request location permission only at this point if needed.
4.  Obtain coordinates from browser geolocation when available.
5.  If GPS is unavailable, allow a manual map pin. EXIF GPS may be used
    only when genuinely present and successfully parsed.
6.  Reverse-geocode the selected coordinates to obtain a candidate
    street address.
7.  Show the photo, location source, address, and map pin for user
    confirmation.
8.  Search nearby potholes for possible duplicates.
9.  Let the user add evidence to an existing pothole or submit a
    distinct nearby pothole, with uncertain cases held for review.
10. Upload the image to Firebase Storage.
11. Create the submission and, where appropriate, the canonical pothole
    record in Firestore through trusted server-side logic.
12. Update the user's contribution history and relevant map/reporting
    data.

The user must be able to correct an inaccurate address or pin. A
reverse-geocoded address is a suggestion, not proof that the pin is on
the correct road.

#### Map exploration

-   Display accepted community potholes on an interactive Atlanta map.
-   Support clustering, zooming, panning, filters, and marker detail
    panels.
-   Distinguish accepted, provisional, reported, acknowledged, and
    confirmed-repaired records.
-   Never imply that a pothole is repaired merely because a report was
    submitted.
-   Display source/verification context where relevant.

#### Social experience

-   User profiles, friend requests, accepted friendships, activity feed,
    achievements, and leaderboards.
-   Public profile information must be separate from private account
    information.
-   Users can opt out of public leaderboard display where appropriate.
-   Feed entries must not expose private contact details or unnecessary
    precise location history.

#### Civic reporting

-   Group accepted distinct potholes into defensible road
    corridors/segments.
-   When a segment has at least **five distinct accepted potholes**,
    create one consolidated report record for administrative review.
-   Determine the relevant jurisdiction before preparing an external
    report.
-   Use a manual/admin submission workflow unless an official,
    authorized integration is established.
-   Record the external case/reference number and confirmation before
    setting status to `submitted`.

#### Minigames

**Pothole Repair** - Fill a pothole by pouring asphalt/cement mix. -
Smooth and level the surface using a touch interaction. - Provide
progress, score, completion feedback, and replay.

**Atlanta Pothole Runner** - 2D side-scrolling pixel-art runner. -
Player jumps over potholes and other road hazards. - Atlanta-inspired
pixel-art streets and skyline. - Include a recognizable Bank of America
Plaza pencil-shaped tower. - Touch and keyboard controls, increasing
difficulty, score, game-over, and replay.

Games are secondary to the core civic experience and must not delay the
capture/map/report MVP.

------------------------------------------------------------------------

## 3. Brand and Design System

Use the uploaded **PatchUp** logo as the authoritative brand reference.
Preserve its identity; do not invent a separate brand direction.

### Logo-derived palette

  -----------------------------------------------------------------------
  Token                   Color                   Intended use
  ----------------------- ----------------------- -----------------------
  Daylight canvas         `#FFFFFF`               Main background

  Soft road mist          `#F7F7F8`               Secondary background

  Charcoal asphalt        `#3A3535` / `#4B4646`   Primary text and
                                                  structural surfaces

  Slate-plum roadway      `#6E6978`               Secondary surfaces and
                                                  map/road accents

  Deep crater charcoal    `#2D2B35`               High-contrast surfaces
                                                  and game environment

  Warm lane-stripe sand   `#E8DFC5`               Dividers and restrained
                                                  highlights

  Atlanta canopy green    `#4CB729`               Primary actions and
                                                  brand accent

  Caution amber           `#D97706`               Caution states, paired
                                                  with text

  Alert red               `#DC2626`               Errors/destructive
                                                  states, paired with
                                                  text
  -----------------------------------------------------------------------

Use a daylight-first interface with high outdoor legibility. Avoid
generic dashboard styling, excessive gradients, decorative card
overload, and visual elements that do not support the task.

### Typography

-   Display/headings: Bricolage Grotesque, bold weights.
-   Body and controls: Plus Jakarta Sans.
-   Coordinates, counts, ranks, and scores: JetBrains Mono with tabular
    numerals.

Use accessible contrast and readable mobile type sizes. Fonts may use
suitable system fallbacks if external font loading fails.

### Navigation

Mobile bottom navigation: 1. Home 2. Map 3. Capture --- visually
prominent central action 4. Leaderboard 5. Profile

Respect iOS safe areas and use touch targets of at least 44 × 44 CSS
pixels. Desktop navigation should adapt to a wider workspace rather than
simply stretching the mobile layout.

### Brand assets

-   Use the supplied logo for app branding, onboarding, and PWA icon
    derivations.
-   Create appropriate square app icons and maskable variants without
    distorting the logo.
-   Preserve a safe area around the mark.
-   Do not substitute an unrelated generated logo.

------------------------------------------------------------------------

## 4. Technical Architecture

### 4.1 Frontend

-   React
-   Vite
-   TypeScript
-   Component-based architecture
-   Responsive mobile-first styling
-   Accessible controls and keyboard support
-   A consistent icon system
-   PWA support through `vite-plugin-pwa` or an equivalent maintained
    solution

Suggested map libraries: - `@vis.gl/react-google-maps` -
`@googlemaps/markerclusterer` - Google Maps `AdvancedMarkerElement`

Use current supported APIs. Do not introduce deprecated Google Maps
marker classes.

### 4.2 Backend

Use a Node.js/Express server for trusted operations, deployed to Cloud
Run or another supported Google-hosted runtime compatible with the
selected AI Studio project setup.

Backend responsibilities: - Verify Firebase ID tokens. - Enforce admin
authorization. - Perform privileged Firestore transactions. - Validate
and accept submissions. - Perform duplicate candidate
retrieval/scoring. - Reverse-geocode through a protected server-side
integration where appropriate. - Run street-segment and report threshold
logic. - Invoke Gemini only when explicitly needed. - Validate
leaderboard and game-score updates. - Create report records and audit
events.

Never place privileged credentials or server secrets in browser code.

### 4.3 Firebase

**Firebase Authentication** - Google Sign-In. - Persistent sessions. -
Sign-in, sign-out, and account handling.

**Cloud Firestore** - Primary source of truth for users, potholes,
submissions, friendships, achievements, leaderboards, street segments,
reports, notifications, and game statistics.

**Firebase Storage** - Pothole photographs and avatars only. - Firestore
stores metadata and Storage references/URLs, never Base64 image
payloads.

**Firebase Admin SDK** - Server-side authorization and trusted writes. -
Custom claims for administrators. - Transactions and server-maintained
counters.

### 4.4 Google Maps Platform

Use: - Maps JavaScript API for interactive maps. - Geocoding API for
reverse geocoding. - Optional Roads API only if its accuracy benefit
justifies its additional setup and cost.

Restrict browser API keys by HTTP referrer and API. Restrict server keys
by API and server environment. Do not expose unrestricted keys.

### 4.5 Gemini

Gemini is an optional enhancement, not a dependency for core capture or
reporting.

Use it for: - Classifying whether an image appears to show a road
defect. - Providing a rough visual severity label for human review. -
Comparing candidate images as one signal in duplicate review.

Do not use it to: - Infer exact GPS coordinates. - Determine the
authoritative street segment. - Automatically merge uncertain
potholes. - Make final municipal reporting decisions.

**Model configuration:** use a server-side `GEMINI_MODEL` environment
variable. Before implementation, verify the selected model ID against
Google's current official Gemini API model catalog and confirm that the
model is enabled for the project's API key and supports image input. Do
not hardcode an unverified or preview-only identifier as a production
assumption. If no supported model is configured, disable AI analysis
gracefully.

Gemini must never run on map load, map pan, feed browsing, or other
routine read operations. Invoke it only on a submission or an explicit
duplicate-review action.

### 4.6 Google Sheets

Google Sheets is an optional, explicitly initiated civic export
destination. Firestore remains the source of truth.

Only authorized administrators may export. Require confirmation before
creating or modifying a Sheet. No background or automatic Sheet writes.

### 4.7 Hosting and deployment

Choose one coherent deployment architecture: - Firebase Hosting for a
static frontend plus a separately deployed Express backend; or - Cloud
Run serving the full application and backend.

Do not mix deployment assumptions without documenting routing,
environment variables, build commands, and service boundaries. Validate
PWA manifest and service-worker behavior on the final production origin.

------------------------------------------------------------------------

## 5. PWA Requirements

Implement: - Web app manifest with `name: "PatchUp"` and suitable short
name. - `display: "standalone"` where supported. - Correct icon sizes,
including 192×192, 512×512, maskable 512×512, and Apple touch icon. -
Theme and background colors based on the brand. - HTTPS deployment. -
Service worker and Workbox caching. - Offline fallback page. -
Online/offline status messaging. - Safe-area support. - Contextual
install guide. - Feature detection and graceful fallbacks.

Cache the application shell and appropriate static assets. Do not cache
private user data or sensitive API responses in a way that exposes them
on shared devices. Do not promise that submission, GPS, camera, push, or
background operations work offline unless that behavior has been
explicitly implemented and tested.

Test: - iOS Safari in browser mode. - iOS Safari installed standalone
mode. - Android Chrome. - Desktop Chrome/Safari/Firefox as supported.

Camera and geolocation require user permission and secure contexts. iOS
web push is available only under supported installed-web-app conditions
and requires explicit permission; always retain an in-app notification
fallback.

------------------------------------------------------------------------

## 6. Capture, Image Handling, and Location

### 6.1 Image validation and storage

-   Accept a defined image MIME allowlist, initially JPEG, PNG, and
    WebP.
-   Enforce a raw upload size cap, initially 10 MB.
-   Resize/compress client-side to a maximum edge around 1280 px and a
    target size around 1.5 MB where quality permits.
-   Enforce a post-compression Storage rule limit, initially 2 MB.
-   Show upload progress.
-   Provide retry with bounded exponential backoff.
-   Handle offline, cancellation, and failed upload states.
-   Use generated storage paths, not user-supplied paths.
-   Validate file content/type and ownership in Storage rules.
-   Do not store image bytes in Firestore.

### 6.2 Location source

Store an explicit `coordinateSource`: - `gps_verified` --- browser
geolocation obtained during the capture flow. - `exif_extracted` ---
valid GPS metadata extracted from the selected image. - `manual_pin` ---
user selected or corrected the pin manually.

GPS should be requested only when the user initiates Capture or
explicitly selects Locate Me. Do not continuously track users.

Show the user the selected location and allow correction before
submission. Store accuracy metadata where available. Never label a
manual pin as GPS-verified.

### 6.3 Reverse geocoding

Reverse geocoding supplies candidate address information, not definitive
road-segment truth. Preserve: - Raw coordinates. - Returned formatted
address. - Normalized street name. - City/locality. - State. -
ZIP/postal code when available. - Jurisdiction classification and
confidence. - Whether the user corrected the result.

Cache geocoding results where permitted and avoid repeated calls for
unchanged coordinates.

------------------------------------------------------------------------

## 7. Pothole Records, Duplicate Detection, and Attribution

### 7.1 Canonical pothole vs. submission

A **pothole** is one distinct physical road defect represented by a
canonical record.

A **submission** is one user's photograph/evidence report. Multiple
submissions may be attached to one canonical pothole.

This separation is mandatory. Five photos of one pothole are one
pothole, not five.

### 7.2 Candidate retrieval

Use a 25-meter radius as an initial candidate-search window only.
Calculate actual distance server-side (for example, with the Haversine
formula). A nearby candidate is not automatically a duplicate.

### 7.3 Confidence signals

A duplicate score may combine: - Geographic distance. - Normalized
street and road-side alignment. - Time between submissions. - Image
similarity, if available. - Human review/selection.

The scoring weights and thresholds are configurable and must be
calibrated with test cases. Do not treat illustrative weights as proven
accuracy.

### 7.4 Resolution states

-   **Likely same pothole:** show the candidate to the contributor and
    offer "Add Evidence." Do not silently merge.
-   **Uncertain:** create a provisional submission linked to candidate
    pothole IDs and send it to the duplicate-review queue. It does not
    count toward the five-pothole threshold until resolved.
-   **Distinct:** create a new canonical pothole only after the workflow
    establishes it as distinct.
-   **Rejected:** preserve an audit record and reason; exclude it from
    counts.

Admins must be able to merge duplicate canonical records and split
incorrectly merged records. Such corrections must trigger safe
recounting of affected users, segments, and reports.

### 7.5 Leaderboard and contribution attribution

A canonical distinct pothole can contribute **one distinct-pothole
point**, credited to its original accepted primary contributor.

Additional users who provide valid evidence for the same pothole may
receive a separate **evidence contribution** credit or statistic.
Evidence credits must not increase the distinct pothole count or the
five-pothole reporting threshold.

If a record is later merged, rejected, or reassigned, recompute affected
scores and retain an audit trail. Prevent repeated uploads or repeated
evidence on the same pothole from generating unlimited points. Define
evidence-credit caps or eligibility rules before enabling competitive
evidence scoring.

Only accepted, distinct potholes count toward the primary pothole
leaderboard. Pending, rejected, and unresolved duplicate submissions do
not count.

------------------------------------------------------------------------

## 8. Street-Segment Identification and Confidence

Do not group potholes solely by street name. Do not rely on arbitrary
latitude/longitude grid cells as the authoritative street-segment
definition.

### 8.1 MVP strategy

Use a road-aligned corridor strategy based on: - Normalized street name,
including directional suffixes and road type. - Coordinates and distance
along the road where available. - Nearby intersections/cross streets. -
Reverse-geocoded address/block information as supporting evidence. -
Road geometry where a reliable source is available. - Jurisdiction (City
of Atlanta/ATLDOT vs. GDOT or another authority).

A normalized street name plus block range may be a useful MVP candidate
key, but it is not by itself proof that two defects belong to the same
reporting segment.

### 8.2 Confidence states

Every pothole-to-segment assignment must have: - `verified` ---
sufficient geographic and road-context confidence. - `provisional` ---
likely assignment but not reliable enough for automated thresholding. -
`needs_review` --- ambiguous or conflicting assignment.

Only accepted potholes assigned to a **verified** segment may count
toward automatic report threshold evaluation.

A low-confidence assignment must never silently trigger a municipal
report.

### 8.3 Manual correction

Authorized admins must be able to: - Reassign a pothole to another
segment. - Merge segments that were incorrectly split. - Split a segment
that is too broad. - Correct the road name or jurisdiction. - Trigger a
transactional recount of affected segments and report cycles.

All changes must be audited. Recounts must be idempotent and must not
create duplicate reports.

### 8.4 Geographic edge cases

Test: - Parallel streets close together. - Intersections and corner
potholes. - Long streets with distant blocks. - Divided roads and
opposite sides of a road. - Ramps, bridges, frontage roads, and
interstates. - Missing or ambiguous street numbers. - City streets
adjacent to state routes. - Potholes close together but physically
distinct.

Where road geometry or jurisdiction cannot be determined confidently,
send the record for review rather than guessing.

------------------------------------------------------------------------

## 9. Five-Distinct-Pothole Civic Reporting

### 9.1 Threshold

The threshold is **five distinct, accepted potholes on the same verified
street segment**.

The following do not count as five: - Five photographs of one pothole. -
Five submissions awaiting duplicate review. - Five rejected records. -
Five potholes on different street segments. - Five potholes assigned to
a low-confidence/provisional segment.

### 9.2 Transaction-safe evaluation

All canonical pothole acceptance and segment membership changes must be
handled by trusted server-side code.

Use a Firestore transaction or an equivalent reliable transactional
design to: 1. Check whether the pothole is already registered in the
segment's accepted-pothole membership. 2. Add it only once. 3. Update
the authoritative distinct count. 4. Evaluate the threshold. 5. Create
the report-cycle record exactly once when the threshold is first met for
that cycle. 6. Record an idempotency key/event to protect against
retries.

Do not depend on client-side counters. Do not perform external network
calls inside a Firestore transaction. Use an outbox/job pattern if
asynchronous external work is needed.

Test simultaneous fourth and fifth accepted pothole submissions and
retries.

### 9.3 Report lifecycle

Recommended statuses: - `monitoring` - `threshold_reached` -
`report_generated` - `awaiting_admin_review` - `ready_for_submission` -
`submitted` - `acknowledged` - `resolved` - `unable_to_submit` -
`closed`

Only use `submitted` after an authorized person records a successful
submission and the external reference/case number, or a verified partner
integration returns confirmation.

`acknowledged` requires evidence that the authority acknowledged the
report. `resolved` requires credible confirmation that the defect was
repaired, not merely that the report was closed internally.

### 9.4 Subsequent potholes and reporting cycles

Each street segment has a reporting-cycle policy.

-   The first cycle is created when five distinct accepted potholes are
    reached.
-   Additional distinct potholes discovered while a cycle is active are
    attached as supplemental evidence to that cycle, without creating a
    duplicate report.
-   Preserve a snapshot of the pothole IDs and report contents at the
    time the report is generated, while allowing later supplemental
    evidence to be appended with timestamps and audit history.
-   Do not automatically open a new cycle merely because more potholes
    are added.
-   A subsequent cycle may be opened only after the prior cycle is
    closed/resolved or an administrator explicitly closes it as no
    longer active, and at least five new, distinct, accepted potholes
    have accumulated since the prior cycle's cutoff.
-   Define and store `cycleNumber`, `cutoffAt`, `activeReportId`, and
    the pothole membership for each cycle.
-   Never reuse potholes from a previous cycle to satisfy the next
    cycle's five-pothole threshold.
-   If a pothole is later rejected or moved to another segment,
    recalculate the segment and flag any report whose evidence count has
    materially changed. Do not silently erase an already submitted
    report.

This policy must be implemented transactionally and audited.

### 9.5 Municipal jurisdictions and honest submission

The implementation plan's initial research identifies: - City of Atlanta
surface streets as generally routed through ATL311/ATLDOT. - State
routes and interstates as generally falling under GDOT.

Treat this as a routing starting point, not an infallible jurisdiction
determination. Validate current jurisdiction and reporting instructions
against official sources during implementation.

Do not assume a public unauthenticated Open311 endpoint exists. Do not
scrape or automate a portal in a way that violates its terms or bypasses
access controls.

If there is no official authorized API or partner integration: -
Generate an ATL311/GDOT-ready report packet. - Provide an admin review
queue. - Allow an authorized person to submit through the official
channel. - Record the submission date, method, administrator, and
external case/reference number. - Keep the report in
`awaiting_admin_review` or `ready_for_submission` until confirmed.

The UI must distinguish "report generated," "ready for submission,"
"submitted," "acknowledged," and "resolved."

### 9.6 Report contents

Each report packet should include: - Authority/jurisdiction. - Street
name and corridor/segment description. - Nearest cross streets or
address range. - Map coordinates and map link. - Number of distinct
potholes. - Individual pothole IDs and evidence photographs. -
Submission dates. - Hazard notes and optional severity labels. -
Supporting contributor count. - Report-cycle ID and audit history.

Google Sheets export is optional and requires explicit admin
confirmation.

------------------------------------------------------------------------

## 10. Social Features, Achievements, and Notifications

### 10.1 Profiles

Public profile: - Username. - Display name. - Avatar. - Join date. -
Accepted distinct pothole count. - Evidence contribution count, if
enabled. - Achievements. - Privacy settings.

Private account data: - Email and authentication metadata. -
Notification preferences. - Push subscription/token data. - Other
sensitive account settings.

Do not put email, phone, or precise location history in public profile
documents.

### 10.2 Friend system

-   Search users by username.
-   Send, accept, decline, and remove friend requests.
-   View accepted friends' permitted activity.
-   Filter map activity to friends where privacy settings allow.
-   Enforce relationship permissions server-side and through Firestore
    rules.

### 10.3 Leaderboards

Provide: - Overall. - Weekly. - Monthly. - Neighborhood, only where
neighborhood data is reliable and users opt in to sharing it.

Primary ranking is based on accepted distinct potholes attributed to
each user's primary contribution. Evidence contributions may be
displayed separately and must not inflate the primary count.

Server-maintain ranking aggregates. Clients cannot directly write
authoritative leaderboard totals.

### 10.4 Achievements

Initial badge concepts: - First Spot --- first accepted distinct
pothole. - Road Scout --- 10 distinct potholes. - Pothole Hunter ---
25. - Asphalt Detective --- 50. - Atlanta Road Warrior --- 100. -
Neighborhood Watch --- accepted contributions across five eligible
neighborhoods. - Community Champion --- contribution to a credibly
confirmed repair.

Badge thresholds and verification rules must be configurable. Do not
award repair-related achievements solely because a report was submitted.

### 10.5 Notifications

In-app notifications: - Friend requests and acceptance. - Badge
unlocks. - Leaderboard milestones. - Street reporting threshold
reached. - Report status updates. - Confirmed repairs.

Web push is optional and permission-based. Keep an in-app notification
center for browsers that do not support the desired push behavior.

------------------------------------------------------------------------

## 11. Minigames

### 11.1 Pothole Repair

Implement a touch-first interactive sequence: 1. Prepare the repair. 2.
Pour asphalt/cement mix. 3. Fill the pothole. 4. Smooth and level the
surface. 5. Show completion, score, and replay.

Use pointer/touch interactions, accessible controls, and clear progress.
Keep the game lightweight and responsive.

### 11.2 Atlanta Pothole Runner

Implement a 2D side-scrolling canvas game: - Auto-running player. -
Tap/click/keyboard jump. - Potholes and additional obstacles. -
Increasing difficulty. - Distance/obstacle score. - Collision/game-over
and replay. - Pixel-art Atlanta street and skyline. - Recognizable Bank
of America Plaza pencil-shaped tower.

Use requestAnimationFrame with proper pause, cleanup, and restart
handling. Avoid orphaned timers and runaway animation loops.

### 11.3 Game score integrity

Game scores are entertainment statistics, not civic contribution credit.
Validate submitted score bounds and plausible score/time relationships
server-side. Do not allow game scores to affect pothole counts or civic
reporting thresholds.

------------------------------------------------------------------------

## 12. Firestore Data Model

The following is a logical model; collection boundaries and indexes may
be adjusted to fit query patterns. Avoid unbounded arrays and oversized
documents.

  ------------------------------------------------------------------------------------------------
  Collection/path                                              Purpose and key fields
  ------------------------------------------------------------ -----------------------------------
  `/users/{uid}`                                               Public profile: `username`,
                                                               `displayName`, `photoURL`,
                                                               `joinedAt`, public stats, privacy
                                                               preferences

  `/users/{uid}/private/account`                               Private email/settings/notification
                                                               preferences

  `/potholes/{potholeId}`                                      Canonical distinct pothole:
                                                               coordinates, coordinate source,
                                                               address, street, jurisdiction,
                                                               segment ID, status, primary
                                                               contributor, verification

  `/submissions/{submissionId}`                                Individual photo evidence: user,
                                                               image path/URL, coordinates,
                                                               source, timestamp, candidate
                                                               pothole, duplicate status

  `/friendships/{friendshipId}`                                Requester, recipient, status,
                                                               timestamps

  `/streetSegments/{segmentId}`                                Corridor identity, jurisdiction,
                                                               geometry/context, confidence,
                                                               count, active cycle

  `/streetSegments/{segmentId}/acceptedPotholes/{potholeId}`   Idempotent membership for distinct
                                                               accepted potholes

  `/reports/{reportId}`                                        Report-cycle snapshot, segment,
                                                               pothole membership, status,
                                                               external reference, timestamps

  `/reports/{reportId}/supplements/{supplementId}`             Additional evidence attached after
                                                               report creation

  `/leaderboardStats/{uid}`                                    Server-maintained distinct counts
                                                               by period and permitted geography

  `/achievements/{uid}/badges/{badgeType}`                     Progress, target, unlock timestamp

  `/notifications/{uid}/items/{notificationId}`                Per-user notifications

  `/activityFeed/{eventId}`                                    Public-safe activity events

  `/gameStats/{uid}_{gameId}`                                  High score, games played, updated
                                                               timestamp

  `/adminAudit/{eventId}`                                      Administrative changes, actor,
                                                               reason, before/after references,
                                                               timestamp
  ------------------------------------------------------------------------------------------------

### Data integrity requirements

-   Use server-generated IDs and timestamps.
-   Do not store unbounded arrays of pothole IDs in a single document.
-   Keep report snapshots bounded; paginate or use subcollections for
    evidence.
-   Add indexes for map bounds/geospatial strategy, user history,
    segment membership, status, and leaderboards as required.
-   Use deterministic idempotency keys for retries and threshold events.
-   Maintain audit records for merges, splits, reassignment, moderation,
    and report-cycle changes.

------------------------------------------------------------------------

## 13. Security and Privacy

### Authentication and authorization

-   Verify Firebase ID tokens on every privileged Express route.
-   Use Firebase custom claims for admin roles, set only through trusted
    Admin SDK code.
-   Do not trust a client-editable `role` or `isAdmin` field.
-   Apply least-privilege Firestore and Storage rules.
-   Admin APIs must reject non-admin users with 403/permission-denied
    responses.

### Server-authoritative data

Clients must not directly modify: - Canonical distinct-pothole counts. -
Segment counts or membership. - Report records/status transitions. -
Leaderboard aggregates. - Achievement unlock state. - Admin audit
events. - Authoritative game high scores.

Use trusted backend routes and transactions for these operations.

### Privacy

-   No background location polling.
-   Do not publish private account details.
-   Do not expose precise personal movement/location histories.
-   Avoid showing a contributor's exact personal location in feeds.
-   Explain what location data is collected and why.
-   Provide appropriate account and data deletion workflows.
-   Restrict access to uploaded images according to the product's
    public/private evidence policy.
-   Do not assume all uploaded photographs should be publicly accessible
    without a clear product policy.

### Abuse prevention

-   Rate-limit submissions and expensive API calls.
-   Validate image MIME, content, and size.
-   Protect against duplicate spam and repeated evidence farming.
-   Add moderation/rejection states.
-   Log privileged actions.
-   Validate leaderboard and game score submissions.
-   Keep secrets in server environment variables or managed secret
    storage.

------------------------------------------------------------------------

## 14. Google Services, Configuration, and Cost Controls

  ------------------------------------------------------------------------------
  Service           Phase             Configuration         Usage policy
  ----------------- ----------------- --------------------- --------------------
  Firebase          1                 Firebase project,     User sign-in
  Authentication                      Google provider       

  Cloud Firestore   1                 Firebase project,     Primary database;
                                      rules, indexes        bounded queries

  Firebase Storage  1                 Bucket, Storage rules Compressed photos
                                                            and avatars

  Firebase Admin    1                 Server                Trusted server
  SDK                                 credentials/managed   operations
                                      identity              

  Maps JavaScript   2                 Referrer-restricted   Load only
  API                                 browser key           map/location views

  Geocoding API     2                 Restricted server key Capture/manual pin
                                                            reverse geocoding;
                                                            cache appropriately

  Gemini API        Optional 2        `GEMINI_API_KEY`,     Submission/review
                                      `GEMINI_MODEL`        only; graceful
                                                            fallback

  Google Roads API  Optional 4        Restricted server key Use only if
                                                            justified by segment
                                                            accuracy

  Google Sheets API Optional 4        Explicit OAuth        Admin-initiated
                                      authorization         civic export only

  Firebase Cloud    Optional 3/6      VAPID/web push        Contextual opt-in;
  Messaging                           configuration         in-app fallback

  Cloud Run         Deployment        Service config and    Express
                                      secrets               backend/full-stack
                                                            deployment
  ------------------------------------------------------------------------------

Before enabling paid services: - Verify API availability and billing. -
Restrict keys to required APIs and origins. - Set budget alerts and
quotas where available. - Avoid repeated geocoding for unchanged
coordinates. - Do not call Gemini during ordinary map/feed browsing. -
Use bounded Firestore queries and pagination. - Load maps only when the
relevant view is opened. - Monitor storage and image bandwidth.

The implementation must not claim that a service is free or within a
particular quota without checking the current project plan and pricing.

------------------------------------------------------------------------

## 15. Phased Development Roadmap and Acceptance Criteria

### Phase 1 --- Foundation

**Scope** - React/Vite/TypeScript project shell. - Logo-derived design
tokens and responsive navigation. - Express server skeleton. - Firebase
project connection. - Google Sign-In. - Firestore connection and
security rules baseline. - Firebase Storage bucket and Storage rules. -
PWA manifest, icons, service worker, offline fallback, and iOS install
guide. - Environment variable and secret handling.

**Acceptance criteria** 1. App renders at 375px mobile and 1440px
desktop widths. 2. Logo, colors, typography, and navigation match the
approved PatchUp design system. 3. Google Sign-In works; session
persists across reload and standalone launch. 4. Firestore read/write
test succeeds under intended rules. 5. Storage upload test succeeds;
Firestore contains metadata/reference only, never image bytes. 6. PWA
manifest and service worker validate on the deployed HTTPS origin. 7. No
secrets or privileged credentials appear in frontend bundles. 8.
TypeScript and production build pass.

### Phase 2 --- Core Pothole Experience

**Scope** - Camera/file selection. - Image validation, compression,
Storage upload, progress, and retry. - On-demand GPS and manual map
pin. - Optional EXIF GPS parsing. - Reverse geocoding. - Pothole and
submission records. - Duplicate candidate search and review flow. -
Interactive Atlanta map, clusters, filters, detail panel, and personal
collection. - Optional Gemini image classification behind configuration.

**Acceptance criteria** 1. GPS denial does not block submission; manual
pin is available and labeled correctly. 2. User can review and correct
location before submission. 3. Photos upload only to Storage. 4. Nearby
candidates are surfaced without automatic distance-only merging. 5.
Evidence submissions do not inflate distinct pothole counts. 6. Accepted
potholes appear on the live map with correct detail data. 7. Gemini
unavailable/disabled does not block capture. 8. Empty states and
loading/error states are functional.

### Phase 3 --- Social Experience

**Scope** - Public/private profiles. - User search and friend
requests. - Friend activity and map filters. - Activity feed. -
Leaderboards. - Achievements. - In-app notifications; optional push.

**Acceptance criteria** 1. Private profile data is inaccessible to other
users. 2. Friend request lifecycle works and is permission-checked. 3.
Leaderboard primary counts include only accepted distinct potholes. 4.
Evidence credits are separate and cannot be farmed through repeated
uploads. 5. Users can control relevant public visibility settings. 6.
Notifications do not expose private location or account data.

### Phase 4 --- Civic Infrastructure

**Scope** - Street normalization and road corridor/segment assignment. -
Segment confidence states and admin correction. - ATLDOT/GDOT
jurisdiction review. - Transactional five-distinct-pothole threshold. -
Report cycles, supplements, and audit trail. - Admin
duplicate/segment/report review. - Optional Sheets export.

**Acceptance criteria** 1. Five accepted distinct potholes on one
verified segment create exactly one report cycle. 2. Five photos of one
pothole do not trigger the threshold. 3. Five potholes on distant
sections of the same named street do not trigger one combined report. 4.
Provisional/low-confidence segment assignments cannot trigger reports.
5. Concurrent fourth/fifth submissions produce one threshold event and
one report. 6. Retries do not double-count potholes or create duplicate
reports. 7. Additional potholes during an active cycle become
supplements, not duplicate reports. 8. A subsequent cycle requires five
new distinct potholes after the previous cycle's cutoff and closure
policy. 9. Segment merge/split/reassignment causes an audited
transactional recount. 10. Only admins can change report statuses or
export civic reports. 11. No report is labeled submitted without
confirmation and an external reference.

### Phase 5 --- Entertainment

**Scope** - Pothole Repair game. - Atlanta Pothole Runner. - Touch and
keyboard support. - Game shell, pause, replay, scoring, and
server-validated high scores.

**Acceptance criteria** 1. Both games work on mobile and desktop input.
2. Runner includes recognizable Atlanta skyline and Bank of America
Plaza. 3. No runaway timers or animation loops after
pause/restart/navigation. 4. Game scores cannot affect civic counts or
reporting thresholds. 5. High scores persist and pass server-side
plausibility checks.

### Phase 6 --- Production Readiness

**Scope** - Security rules audit and automated tests. - Backend
authorization tests. - Performance and accessibility review. -
Cross-browser/PWA testing. - Monitoring, error reporting, backups, and
operational documentation. - Production deployment verification.

**Acceptance criteria** 1. Firestore and Storage rules tests pass. 2.
Non-admin access to admin endpoints is rejected. 3. PII and private
images are not exposed contrary to policy. 4. `npm run build` and
`tsc --noEmit` pass. 5. iOS Safari browser and standalone modes are
tested on a physical device. 6. Android Chrome and desktop browsers are
tested. 7. Offline, permission-denied, upload-failure, and empty-data
states behave gracefully. 8. Deployment, rollback, secrets, and backup
procedures are documented.

------------------------------------------------------------------------

## 16. Testing Strategy

Create automated tests for: - Authentication and authorization. -
Firestore and Storage rules. - Image validation and upload ownership. -
GPS/manual coordinate-source labeling. - Duplicate candidate
classification. - Distinct pothole attribution. - Evidence-credit
limits. - Street-segment confidence. - Segment merge/split recounts. -
Concurrent threshold crossing. - Idempotent retries. - Report-cycle
cutoff and supplement logic. - External report status transitions. -
Leaderboard recalculation after merge/rejection. - Game score
validation.

Create geographic fixtures for Atlanta edge cases, including parallel
roads, intersections, long streets, divided roads, bridges, and state
routes.

Do not rely only on mocked tests for Firestore transaction behavior.
Include emulator/integration tests and a controlled staging test.

------------------------------------------------------------------------

## 17. Operational and Product Decisions Still Requiring Verification

These items are not reasons to block the initial project scaffold, but
must be resolved before the corresponding feature is enabled:

1.  **Gemini model:** verify the current official model catalog, API
    access, image-input support, and model ID before configuration.
2.  **Firebase Storage and Admin SDK:** confirm bucket provisioning,
    rules, and secure server credentials/managed identity.
3.  **Road geometry:** begin with geocoding plus intersection/block
    corridor parsing; evaluate Roads API only if test accuracy requires
    it.
4.  **Jurisdiction:** validate City of Atlanta vs. GDOT ownership for
    each location against official current sources. Other municipalities
    in the metro area are outside the initial Atlanta scope unless
    explicitly added.
5.  **Municipal submission:** confirm current ATL311/GDOT channels and
    requirements. Do not claim automated submission unless an authorized
    integration exists.
6.  **Public image policy:** decide whether evidence images are public
    by default, visible only to signed-in users, or subject to
    moderation.
7.  **Leaderboard privacy:** define opt-out behavior and neighborhood
    visibility before launching public rankings.
8.  **Evidence scoring:** finalize anti-farming limits before awarding
    competitive points for supporting submissions.
9.  **Reporting cycle closure:** define what qualifies as
    resolved/closed and who can close a cycle.

------------------------------------------------------------------------

## 18. Phase 1 Authorization Boundary

The implementation agent must not attempt to build all features in one
generation.

After this plan is approved, begin **Phase 1 only**.

Before enabling integrations, explain: - Which Firebase project will be
used. - Which Firebase products must be enabled. - What credentials or
managed identity are required. - Which Maps APIs are required now versus
later. - Which secrets must be configured and where. - Which services
may incur billing.

Do not create fake community data, fabricated potholes, fake reports, or
simulated municipal submissions in production. If demo fixtures are
needed for development, isolate them in a clearly identified
test/staging environment.

At the end of Phase 1, report: - Files and components created. -
Services configured. - Build/test results. - Outstanding setup steps. -
Acceptance criteria passed or failed.

Wait for explicit approval before starting Phase 2.

------------------------------------------------------------------------

## Final Definition of Success

PatchUp is successful when an Atlanta resident can open the application
in Safari or Chrome, install it on their home screen, document a real
pothole with a reliable or manually confirmed location, see the accepted
record on a shared map, contribute fairly alongside friends, and help
produce a geographically credible report for the appropriate authority.

The product should feel like a polished social application, but its
civic data must be accurate, secure, auditable, and honest.
