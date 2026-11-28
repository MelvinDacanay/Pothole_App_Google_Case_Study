# Account consent

The signed-in app requires current versioned adult self-attestation, photo processing consent and terms acceptance. Consent version is `2026-11-27-v4-redaction`; existing users must renew when their saved version is old. Consent is saved by authenticated server routes under `users/{uid}/private/consent` and removed during account deletion. Direct client access is denied. This is not independent age verification or legal certification.

Photo upload, verification and submission enforce current consent requirements. Capture also requires privacy and location confirmation; optional Google address preview has separate revocable consent. Mandatory DLP redaction cannot be bypassed. Gemini processing remains separately gated by paid-mode and feature settings.

Test new and existing accounts, each unchecked confirmation, failed saves, reload, account switching, stale consent, direct API requests, desktop/mobile and disposable account deletion. Deploy matching frontend, server and Firestore rules only after release approval.
