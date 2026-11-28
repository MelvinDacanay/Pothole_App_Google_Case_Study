# Pothole classifier evaluation

## What to measure

This evaluates the **candidate observation policy**, not geographical authenticity or the truth of a report. A valid pothole is a discrete visible cavity with missing or broken road paving material. Cracks, road patches, manholes, loose gravel, shadows and puddles without visible cavity evidence are negatives. Obscured or low-quality images that a human cannot reliably label are `unclear`. A model's verbal confidence is not a calibrated probability; the adapter uses observable categories, quality, and visible cavity evidence instead.

### Dataset

- Development pilot: at least 50 non-sensitive images, approximately balanced between positives and difficult negatives. Use this split for prompt revisions; update prompt version whenever the prompt or policy changes.
- Held-out set: at least 500 independent, consented/local or appropriately licensed photographs. Aim for at least 200 positives and 200 negatives, and include unclear cases (including night/rain, water, low light, oblique angles, partial views, adjacent road repairs and unrelated objects). A representative target is 200 positives, 250 negatives, 50 unclear; adjust strata without weakening minimums.
- Two human labelers independently assign labels and strata; adjudicate disagreements before running the model. Record provenance/permissions privately; exclude sensitive scenes and review all fixtures after redaction. Avoid capture while driving or standing in traffic.
- Group images from the same pothole/location, session, source or near-duplicate series before splitting. Do not split a parent photo and crops across development and holdout. The script rejects identical normalized content and group leakage; it does not perform perceptual similarity detection. Manually inspect pHash/near-duplicates before locking the holdout.
- Prepare photos the same way as the capture client (JPEG/WebP, <=960px and typically <=300KB; server ceiling 400KB, 1280px). Do not resize just to make difficult samples disappear. Use originals only for human labeling; keep the evaluated input images locked.

## Run

Copy `benchmark/manifest.example.json` into your dataset folder and populate the paths and labels. Keep photo folders/results out of Git. Configure your own local key and model. The CLI performs live provider calls independently of the web app's Firestore budgets; it requires both `--allow-live` and `--confirm-pre-redacted-non-sensitive` plus `PATCHUP_GEMINI_DATA_MODE=paid`; the CLI does not perform DLP. Use reviewed pre-redacted non-sensitive fixtures only and paces calls sequentially. Check provider project limits and billing before running. A quota/unconfigured error stops the run. The CLI does not write to Firestore or enable the release gate.

```sh
npm run benchmark -- --allow-live --confirm-pre-redacted-non-sensitive --manifest benchmark/manifest.json --split dev --limit 50 --output benchmark/results-dev.json
npm run benchmark -- --allow-live --confirm-pre-redacted-non-sensitive --manifest benchmark/manifest.json --split holdout --output benchmark/results-holdout.json
```

The 500-image holdout exceeds a 100/day provider quota: do not raise limits or evade them; plan a separately authorized benchmark schedule or approved evaluation environment before starting. The current CLI does not resume partial runs automatically. Default spacing is 6500 ms between calls; adjust `BENCHMARK_DELAY_MS` for the actual quota (not to evade limits). The script refuses to overwrite an existing results file. It records category, decision, failure, latency and reported token counts without copying photographs into results. Estimate costs from reported token usage and current official pricing; unreported tokens, provider thinking tokens, retries and database costs may add to totals.

## Proposed release gates (team approval required)

- 960px evaluation; all holdout entries tested, at least 500 total, at least 200 positive and 200 negative.
- Auto-accept precision >=95%, positive auto-accept recall >=95%, negative false acceptance <=5%, zero auto-accept of human-unclear images, API availability >=99%. Uncertain and unavailable positive cases count as misses; no hidden exclusions. Report manual-review rate, strata and p50/p95 latency alongside metrics. A failed gate means review prompt/quality policy on development data or stay in manual review; do not tune repeatedly on the holdout.
- These are proposed targets, not claims of achieved accuracy. Review confidence intervals, difficult strata, class imbalance and real beta data before deployment. If sample sizes are inadequate or negatives are weak, collect a new independent holdout.
- A passing script emits `approvalVersionCandidate`. Only after human sign-off, emulator/rules/browser testing, privacy/eligibility review, and staging verification, set `PATCHUP_BENCHMARK_APPROVED_VERSION` to the exact candidate and `PATCHUP_AUTO_ACCEPT=true` on the server. The model/prompt/schema triple must still match. Changing any one invalidates the gate. This is an operator-controlled interlock, not cryptographically enforced proof of evaluation.

**No live accuracy benchmark has been established for the current release.** The small generated fixtures in `tests/fixtures` exist solely for parser and transaction tests.

Current release identifier: `gemini-3.5-flash-lite|atldot-pothole-v3-pixel-redacted-v1|3`. Prior approval is invalid. Do not use actual community photos in the CLI.
