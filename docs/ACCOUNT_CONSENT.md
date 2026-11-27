# First-sign-in consent hotfix

Apply all files in this archive together on top of the mandatory-AI hotfix. The app blocks its signed-in UI until the current account has accepted both statements. Existing users without a consent record must accept once as well. Acceptance is versioned and stored under `users/{uid}/private/consent` by authenticated server routes; it is removed during account deletion. No client Firestore reads or writes to this document are allowed. The two photo endpoints enforce stored consent; other existing endpoints and public data rules are unchanged. This is self-attestation, not age verification or a comprehensive access-control or privacy compliance audit.

The Capture screen no longer requests age/consent separately; its Gemini check remains mandatory. Existing appeals after attempted verification are unchanged. Keep automatic acceptance disabled until the accuracy benchmark is approved. Use non-sensitive photos for free-tier testing.

Deploy all server and browser changes together. Deploy firestore.rules to the correct named database (see firebase.json). Keep credentials outside the repository. Run npm ci, npm run lint, npm run lint:rules, npm test and npm run build, then redeploy Render.

Smoke test: use a new or previously unconsented account; press Continue with neither checkbox selected, then with each checkbox selected alone. Only unchecked text should be red. With both checked, Continue should enter the app after the server saves. Reload and sign in again to confirm persistence. Switch accounts to confirm isolation. Verify that failed consent requests leave the app locked and that direct analyze/submit requests without saved consent return 403. Test on desktop and mobile. Ensure the capture check no longer asks for age. Test account deletion in staging.

Validation in authoring environment: TS/TSX syntax transpilation and isolated consent predicate checks only; dependency-backed tests, browser tests, and live Firebase/Render verification remain pending.
