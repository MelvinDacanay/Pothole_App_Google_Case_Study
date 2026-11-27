# Admin Hub — community management

## Install and merge safely
This update is based on the user-supplied `patchup-model-testing-main (1).zip` (November 27, 2026), which already contains the Admin Hub and prior consent, automatic capture, and ATLDOT photo classification changes. Apply only this cleanup on top of that version. Do not reapply older Admin Hub hotfixes. The update archive includes a Git patch for the exact supplied baseline; use `git apply --check` before applying it. If live main has changed, reconcile the patch with the current branch rather than overwriting newer source. Preserve local `.env` and Render configuration.

## Administrator experience
- **Photo Reviews:** approve or reject a pending photo using the existing audited submission resolution route. An administrator must see the photograph and provide a reason to approve it. If possible duplicate submissions are flagged, the administrator must check that the pothole is different before approving. The backend's existing duplicate handling and contribution credit remain unchanged.
- **Email Drafts:** review the prepared email, sender, subject, exact coordinates and five photos. Warnings are expressed in everyday language; the existing validation is not bypassed. A report can be marked ready when it has five valid attachments and no draft warnings. An administrator can record a separately submitted report with its actual agency reference and submission method; an explicit confirmation is required. Recording a submission does not send an email. Reports marked unable to submit remain available for review.
- **Sent Reports:** track submitted, acknowledged and resolved reports, recording city responses only after actual confirmation. Closing an agency case does not mark individual potholes repaired. Existing closed records are not shown in this active/recently resolved report list; their recent actions can appear in Activity History.
- **Confirm Repairs:** inspect the original photo and location, confirm reliable evidence of a physical repair, and provide a reason. Uses the existing audited pothole review endpoint.
- **Activity History:** the 30 most recent audit actions with understandable status descriptions and dates. Raw internal record IDs and implementation summaries are not presented to administrators. Older events and the full audit trail remain in Firestore.

The old Community Oversight & Verification Queue and map shortcuts to the street-corridor dashboard have been removed from the application navigation. The legacy component is intentionally left unreferenced for technical maintenance/reference. The normal map, captures, gallery and existing pothole status displays remain. The old standalone public street-corridor/report page is no longer reachable through the app. The existing corridor grouping, report threshold, audit logs, Firestore rules and technical maintenance endpoints are not removed. Merge/split, corridor reassignment and Google Sheets export are no longer part of the administrator-facing experience; technical staff can maintain those facilities separately if required. No new privileges are granted. The existing admin guard applies to all Hub read endpoints, and existing guarded endpoints handle updates.

## Drafts and external reporting
The original five-distinct-pothole threshold and road-area grouping remain unchanged. The same report builder is used; subject/body and attachment logic are unchanged. No Gmail API call, automated delivery, or credentials are introduced. `PATCHUP_REPORT_FROM_EMAIL` is the existing server-side sender setting. No new environment variables or dependencies are needed. Do not send real ATL311 reports during testing. The road owner is a heuristic rather than independently verified jurisdiction, so the interface says "likely" and preserves warnings. The UI blocks marking a draft ready when the current draft has warnings (including missing shared email); it does not add a new server-side report eligibility policy or change the existing status transition rules.

## Verification and release checklist
Run with a clean dependency install using the project's supported Node version:

```sh
npm ci
npm run lint
npm run lint:rules
npm test
node --experimental-strip-types --test tests/admin-draft.test.ts tests/atldot-policy.test.ts tests/admin-hub.test.ts
npm run build
```

Before merging, verify the following in a local or staging environment (use mocked or staging data, not production writes):
- A regular user cannot see the Admin Hub or call any of its endpoints. An admin sees five plain-language sections on desktop and mobile.
- The old corridor dashboard cannot be reached from the map or Admin Hub. Other map, capture, and profile actions still work.
- Approve/reject a pending photo and confirm the correct gallery/contribution changes. Approval requires a visible image and a review reason; flagged duplicates require confirmation.
- Four accepted distinct potholes do not create a report, five do, and a sixth does not create a duplicate draft. Check sender, exact five photos, body, coordinates and warnings. Refresh and pagination work.
- An incomplete draft cannot be marked ready. Marking a complete draft ready does not send it. Record a test agency submission only with a real staging fixture/reference and method; no live email.
- Sent Reports can record agency acknowledgment and resolution independently of physical repairs. A confirmed repair requires reliable evidence and a reason.
- Activity History shows readable recent actions. Non-admin requests receive the existing authorization denial; inspect Firestore emulator/staging for authorization and persistence behavior.

## Validation in this package
All 43 executable tests passed with Node 22.16 and restored dependencies from the previously supplied archive (the dependency lock package versions match this snapshot). The full project typecheck passed with the available global TypeScript 5.8.3 compiler against those dependencies; the project's pinned TypeScript 7 CLI was not used. An offline clean npm install failed because packages were unavailable in the local cache. The Vite build could not run because the restored archive lacks the Linux-native Rolldown binding. No live Firebase/Render or browser smoke test was performed. New structural tests check UI routing and authorization source contracts, not real authorization in a running server. Antigravity must run a fresh installation, the pinned compiler and production build, and staging checks before merge. No repository modifications or deployment were made here.

Static Firestore rules lint also passed with the restored dependencies.

## Administrator access
The runtime `PATCHUP_ADMIN_EMAILS` allowlist is authoritative. Every privileged API request checks the verified current Auth account and rejects revoked tokens. Client Firestore rules no longer grant special privileges from claims or enrollment records. Admin Hub reads and writes use the protected API. See [production identity](PRODUCTION_IDENTITY.md) for enrollment, revocation and coordinated deployment.
