# ATLDOT-aligned classification hotfix

Replace server/gemini.ts and server/verificationPolicy.ts in your current repository. Add tests/atldot-policy.test.ts and this document. No frontend or Firebase rule change is required. Based on reworked v2 with account consent and automatic capture overlays. No credentials included.

Sources: https://atldot.atlantaga.gov/wp-content/uploads/2025/09/220411_WhatIsAPothole.pdf and https://atldot.atlantaga.gov/wp-content/uploads/2025/09/english-Pothole-Posse-Fact-Sheet87.pdf. The original city URL returned 403; the current official PDFs' extracted text was available but page screenshots were not. The prompt is an operational visual interpretation, not an official city-approved classifier. No minimum size or depth is inferred. Distinguishing structural collapse from potholes can require onsite inspection.

New categories: depression, cave_in, alligator_cracking, utility_defect. Existing categories retained. Ambiguous or limited photos require review. Clearly identified cave-ins and utility defects cannot auto-qualify even if a cavity is visible. Existing UI consumes server-generated summary. No extra model call.

Release: gemini-3.5-flash-lite|atldot-pothole-v3|3 (assuming default model). Old cached verification results and pending verification tokens are version-bound; reanalyze old pending captures as needed. Existing published records are not migrated. Existing benchmark approval does not authorize this new release. Keep PATCHUP_AUTO_ACCEPT=false until a fresh benchmark passes. Include each defect category, mixed cracking+pothole, water, shadows, patches, limited images in the holdout. Manual approval remains possible, so reviewers should follow this same taxonomy.

Run npm run lint, npm test, node --experimental-strip-types --test tests/atldot-policy.test.ts, npm run build. The standalone test passed locally (2 tests, 40 decision combinations plus release gate). No live Gemini, Firebase or full build was performed for this patch. Run your existing benchmark with approved non-sensitive images. Do not set the approval version simply to bypass benchmarking.
