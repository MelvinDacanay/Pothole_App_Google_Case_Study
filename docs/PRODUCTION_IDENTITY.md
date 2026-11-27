# Production identity and administrator access

## Google Cloud IAM (already provisioned; no automatic IAM mutations)

Project: `patchup-fff96`. Database: `(default)`. Runtime identity:
`patchup-backend@patchup-fff96.iam.gserviceaccount.com`.

| Role | Scope | Reason |
| --- | --- | --- |
| `roles/datastore.user` | Project | Firestore queries, writes, transactions, deletes |
| `roles/firebaseauth.admin` | Project | Auth user lookup, revocation and legacy claims cleanup, account deletion |
| `roles/storage.objectUser` | Specific private photo bucket, later | GCS object read/create/delete when enabled |
| `roles/secretmanager.secretAccessor` | Each required secret, later | Access application API/OAuth secrets if using Secret Manager |

The two initial roles were provisioned separately. The Auth Admin role is broader than the precise runtime operations; a custom role may be evaluated after runtime validation. Do not grant the runtime Owner, Editor, IAM Admin or project-wide Token Creator. The future DLP integration is not implemented by this patch; grant its specific permissions only when its API and implementation are ready. Gmail OAuth and Maps/Gemini keys are separate from Firebase ADC.

In the Cloud Run service's security configuration, select the runtime identity above (equivalent deployment flag `--service-account=patchup-backend@patchup-fff96.iam.gserviceaccount.com`). The human deploying needs permission to act as that account; grant `roles/iam.serviceAccountUser` on this specific account only to approved deployers if necessary. Anyone able to deploy under this identity can indirectly use its privileges. Review deployments and keep billing administration separate. No deployment or IAM changes are performed by application startup.

Cloud Run selects ADC explicitly, rejecting service-account JSON, credential-file environment overrides, known local ADC file locations, metadata-host overrides and emulator overrides. Startup checks the Cloud Run metadata service identity against the expected PatchUp service account; a default compute service account or wrong project fails startup. This also applies to Cloud Run-based previews and jobs. Do not include ADC files, keys or development `.env` files in the container image. Keep the production service account keyless. The app fails startup if Cloud Run cannot initialize Firebase or read Firestore. Outside Cloud Run, the existing explicit JSON credential or ADC development configuration remains supported; the credential project must match the Firebase project. Do not use a production service account key for development. After production tests succeed, disable then revoke retired exported keys separately; retain Google-managed service agents.

## Administrator access

Set `PATCHUP_ADMIN_EMAILS` as a server-only comma-separated list of the approved verified emails. Empty or missing means no admin. A missing variable does not perform destructive legacy cleanup; explicitly setting an empty value means intentional removal of all app admins. Use the same authoritative allowlist on every server that shares the live Firebase project. Do not hardcode names in source or use a `VITE_` variable. A verified Firebase ID token (checked for revocation) and the current, enabled, email-verified Firebase Auth user must match the allowlist. Neither `admin` custom claims nor `admins/{uid}` documents confer authorization. Privileged client Firestore access has been removed; the Admin Hub uses guarded APIs, and user-owned/public access is preserved. Google Cloud IAM is independent and may bypass Firestore Security Rules.

Bootstrap enrolls a verified, currently allowed account in the server-managed notification directory, without issuing new admin claims. Startup reconciles existing directory entries and removes ineligible entries, revokes sessions and removes legacy admin claims while retaining other claims. Claim-only legacy accounts that have no directory entry are reconciled on their next successful bootstrap request. Direct admin authorization does not rely on cleanup success or token expiration. A stale or removed administrator may need to sign in again after session revocation; ordinary user accounts are not deleted. Previously downloaded content cannot be recalled. The client checks admin access on login, focus and every minute while Admin Hub access is active.

## Coordinated release (operator action, not performed by this patch)

1. Test on a local/demo Firestore emulator. Use the existing default-database configuration.
2. Ensure the server-side allowlist is configured correctly before deploying. Do not deploy a revision with stale allowlist values.
3. Deploy the updated Firestore rules to `(default)` from the reviewed branch, then deploy the matching application. Retire old server revisions/endpoints using the old claim-based guard; do not leave traffic or tagged URLs accessible on them. For an urgent revocation, stop serving old revisions before reopening traffic. Allow time for Firestore rule propagation, including existing listeners.
4. Confirm `/api/health` indicates Firebase and Firestore readiness. Verify the service's attached identity through Cloud Run service configuration. Test verified approved users, ordinary users, an account with a stale admin claim/document, removal from the allowlist, Admin Hub reads and actions, private media, and account deletion on a disposable test account. Do not send real city emails or enable paid features during these checks.
5. A rollback to an old claim-authorizing revision would reintroduce the vulnerability. Keep the stricter rules in place and prefer a forward fix. If an emergency rollback is necessary, stop admin traffic until a safe version is restored.

This patch does not enable billing, change cloud IAM, create a key or secret, configure a bucket, implement DLP/Gmail delivery, or deploy any production resources.

References: [Cloud Run service identity](https://docs.cloud.google.com/run/docs/configuring/services/service-identity), [runtime metadata contract](https://docs.cloud.google.com/run/docs/container-contract), and [ADC search order](https://docs.cloud.google.com/docs/authentication/application-default-credentials).
