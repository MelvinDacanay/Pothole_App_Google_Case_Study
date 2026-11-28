# Admin Hub

Admin Hub is accessible only to verified accounts on the server-side `PATCHUP_ADMIN_EMAILS` allowlist. See [production identity](PRODUCTION_IDENTITY.md). The current interface has Photo Reviews, Email Drafts, Sent Reports, Confirm Repairs and Activity History. Ordinary users do not see agency reports or repair status.

- **Photo Reviews:** inspect redacted evidence and provide an approval/rejection reason. Duplicate candidates require careful review; pending submissions earn no credit. Older photos without redaction proof cannot be approved until safely replaced or remediated.
- **Email Drafts:** five distinct qualifying approved potholes near each other on a street prepare an internal draft. Drafts contain independently sourced street/location, evidence and warnings. Confirm jurisdiction and all attachments before manually sending to ATL311 or the responsible agency. `PATCHUP_REPORT_FROM_EMAIL` configures the shared reporting mailbox. No Gmail API delivery is implemented.
- **Sent Reports:** track confirmed external submission and agency responses; closing a case is not proof of physical repair.
- **Confirm Repairs:** private administrative action requiring reliable evidence and a reason. Repair tracking is not shown on ordinary community pins or feeds.
- **Activity History:** recent audited actions.

The obsolete standalone reports component is removed; technical maintenance endpoints and stored schema are retained and subject to authorization and historical provenance holds. Google Sheets export is not part of the current UI. Do not remove backend maintenance or stored fields without a separately reviewed migration.

Test ordinary-user denial, stale admin claims, removed allowlist access, redacted evidence, five-pothole threshold, draft warnings, confirmed external reference, independent agency and repair actions, and public privacy. Do not send real city emails in tests.
