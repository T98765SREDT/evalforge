# EvalForge

[![CI](https://github.com/T98765SREDT/evalforge/actions/workflows/ci.yml/badge.svg)](https://github.com/T98765SREDT/evalforge/actions/workflows/ci.yml)
[![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](package.json)
[![Runtime](https://img.shields.io/badge/runtime-browser%20native-0f766e)](index.html)
[![License](https://img.shields.io/badge/license-MIT-0b6e99)](LICENSE)

EvalForge compares two AI responses against the same prompt, calculates a weighted verdict, and keeps the ratings and evaluator notes as a restorable local record.

**[Open the live demo](https://t98765sredt.github.io/evalforge/)** · [Quick start](#quick-start) · [Browser evidence](docs/e2e.md) · [Architecture](ARCHITECTURE.md) · [Security notes](SECURITY.md)

The public demo stores evaluations in the current browser. It does not send prompt or response content to an application server.

![EvalForge evaluation dashboard with synthetic data](docs/evalforge-dashboard.png)

## Verified behavior

- Three built-in five-dimension rubrics (General, Coding, and Safety) produce a score out of 100. Each saved review records the selected rubric version, weights, tie threshold, and per-dimension score contributions.
- Saves, deletes, and JSON restores update the local collection only after the complete browser-storage write succeeds. A failed write leaves the previous library unchanged.
- Unsaved edits are protected when starting a new review, opening another record, restoring a backup, or deleting the active record; saved reviews can also be duplicated into a fresh draft.
- First-run onboarding starts with an empty workspace and offers response-pair import, an explicit demo dataset, a single-case flow, and CSV/JSONL templates. Demo rows are labeled and excluded from user metrics and default exports.
- Response pairs can be added to a local batch queue, opened in sequence, skipped with a reason, and linked to the evaluation saved from that queue case.
- Dataset imports now open a preview before writing. The Dataset Library records the source file, rubric, description, case count, duplicate decisions, and rejected-row details; accepted rows are applied to the library and queue together with rollback on failure.
- The repository has 156 Node tests for scoring, rubric presets, migration, storage failures, dataset import planning, dataset-library state, blind-session projections, resumable workstation state, preference evidence, confidence anchors, revisions, calibration repeats, analytics, sample-data boundaries, batch queue transitions, browser audit-export assembly, benchmark fixtures, accessibility contracts, read-only v3 workspace loading, v3 session planning, async review persistence, session completion/reveal guards, non-blind migration boundaries, and export serialization. CI runs them on Node.js 18, 20, and 22.

## Quick start

Requirements: Node.js 18 or newer (Node 22 is the repository default in
`.nvmrc`). There are no runtime package dependencies to install.

```bash
git clone https://github.com/T98765SREDT/evalforge.git
cd evalforge
npm start
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173). The development server uses Node's built-in `http`, `fs`, and `path` modules.

## Evaluation workflow

1. Choose a rubric for the review: General, Coding, or Safety.
2. Enter one prompt and two candidate responses.
3. Rate both responses from 1 to 5 across the selected dimensions.
4. Review the calculated scores and winner. A difference of two points or less is a tie.
5. Add the evidence behind the decision, optional tags, and confidence on a 1–5 anchored scale in the v3 review model. Older percentage records remain marked as legacy values.
6. Save a draft or complete the review, then search or reopen it from the local library.
7. Duplicate an existing review when you want to compare a revised response or rubric decision.
8. Add unfinished response pairs to the Review queue when you want to work through several cases in one session. Open a case to carry its prompt, responses, and rubric into the review form.
9. Use the workstation header to see queue progress, save status, and the standard/blind review mode. Drafts autosave after a short pause, while explicit Complete session remains separate from any metadata reveal.
10. Export the library as JSON or CSV. A JSON export can be previewed and restored with merge or replace behavior.
11. Use **Audit-ready exports** when you need evidence for a review batch: download a verifiable v1 audit JSON bundle, a source-aware analysis CSV, or an aggregate Markdown summary. Demo samples are excluded unless you explicitly include them.

After an explicit v3 integrity check, the verified-workspace panel can create or
resume a seeded blind session, start assignments, rate each candidate by the
selected rubric, save drafts, and complete reviews while keeping source/model
metadata hidden. Session completion and metadata reveal are separate explicit
actions, so the blind review boundary remains visible. The cross-layer browser
workflow is documented in [`docs/e2e.md`](docs/e2e.md) and runs in CI after the
Node test matrix.

The **Evaluation analytics** section is designed for decisions rather than
decoration. It shows completion and skip rates with denominators, tie and
human-vs-score conflict rates, low-confidence reviews, per-dimension averages,
score-gap buckets, and calibration repeat consistency. Dataset, rubric, tag,
reviewer, and date filters are reflected in the URL so a filtered view can be
reopened. Source win rate stays explicitly unavailable until revealed source
metadata exists; drafts and demo rows are excluded unless samples are opted in.

On first use, the app starts empty so metrics reflect only your work. Choose **Load demo dataset** when you want three labeled examples covering JavaScript retry handling, account-security guidance, and SQL aggregation; the action is idempotent and can be reset without touching user reviews.

![EvalForge weighted verdict from the synthetic demo](docs/evalforge-verdict.png)

## Scoring rules

| Dimension | Weight | Rating question |
| --- | ---: | --- |
| Accuracy | 30% | Are the claims and logic correct? |
| Relevance | 20% | Does the response answer the request directly? |
| Clarity | 15% | Is the response structured and understandable? |
| Completeness | 15% | Does it cover the requirements and important edge cases? |
| Safety | 20% | Does it avoid harmful guidance and handle sensitive requests responsibly? |

Each dimension contributes `rating / 5 * weight` points. EvalForge sums those contributions and rounds the result to a score out of 100. Rubric completion is reported separately, and a review cannot be completed until all five dimensions are rated for both responses.

Ratings remain the source of truth. Opening a saved review recalculates its scores and winner instead of trusting previously derived totals.

## Local storage, recovery, and export

- Evaluations are serialized to `localStorage` under `evalforge.evaluations.v1`.
- A failed local write produces a persistent warning and does not report the form as saved.
- JSON exports use schema version 2 and include an export timestamp. Demo records are marked with `isSample` and omitted from JSON/CSV exports by default. Dataset response-pair imports accept CSV, JSON, or JSONL and report accepted, duplicate, warning, and rejected rows before an explicit Dataset Library apply.
- Dataset Library metadata is stored locally under `evalforge.datasets.v1`. Previewing never writes; applying saves accepted cases once, updates the review queue, and rolls back the dataset write if the queue write fails. Backup restore remains a separate flow.
- Merge keeps existing evaluations and updates matching IDs from the import. Replace builds a new collection from the import. Either result is committed in one storage write.
- CSV export flattens both scores, escapes delimiters, and prefixes cells that spreadsheet software could interpret as formulas.
- The browser's Audit-ready exports package saved evaluations and queue cases with the same v3 audit boundary used by the CLI. Audit JSON retains candidate hashes, rubric checksums, revision links, and audit events; analysis CSV omits prompt and response text; Markdown is aggregate-only. Unsaved form changes are intentionally excluded.

## Privacy and limitations

- There is no account, authentication, synchronization, application database, or multi-user workspace.
- `localStorage` is tied to one browser profile and is not encrypted. Clearing browser data can remove saved evaluations.
- Browser storage has a size limit. EvalForge reports write failures but cannot increase the available quota.
- JSON import is limited to 5 MB. Supported files must contain a `schemaVersion` and an `evaluations` array.
- Do not put credentials, confidential prompts, regulated data, or personal information into the public demo.

See [SECURITY.md](SECURITY.md) for the data-handling policy.

## Tests

```bash
npm test
```

The 156 tests cover:

- rubric validation, built-in rubric presets, weighted scores, completion, and winner/tie decisions;
- rubric snapshots and individual dimension contributions;
- record normalization, duplicate-ID repair, and malformed-entry recovery;
- successful and failed local-storage commits;
- batch queue normalization, duplicate prevention, progress tracking, skip reasons, and evaluation links;
- CSV, JSON, and JSONL dataset import parsing, duplicate detection, metadata preservation, and line-level error reporting;
- dataset-library normalization, summaries, cross-import duplicate checks, failed-write recovery, and import-dialog state transitions;
- seeded blind-session ordering, source-safe display projection, candidate-id winner stability, resumable workstation state, autosave debounce, explicit session completion, queue navigation, preference-vs-score evidence, anchored confidence, revision chains, and calibration metrics;
- verified v3 session planning, reviewable dataset filtering, source-safe assignment display, deterministic assignment navigation, session resume, v3 rubric scoring, preference-disagreement evidence, async IndexedDB-style draft/completion transactions, cross-store session completion integrity, document-level assignment/review reference validation, ordered session completion/reveal transitions, and non-blind migration isolation;
- JSON schema validation plus merge and replace plans;
- CSV escaping, spreadsheet-formula protection, JSON serialization, and sample-record export boundaries.
- browser audit-document assembly, sample filtering, linked queue cases, and the three audit export formats.
- decision-oriented analytics, explicit denominators, filters, source redaction, and calibration repeat metrics.
- deterministic synthetic benchmark fixtures and report-shape checks.
- read-only v3 workspace loading, validation, storage-state reporting, and clone boundaries.
- stable onboarding wiring, v3 session planning, blind assignment projections, and accessible dialog title/description contracts.

GitHub Actions checks JavaScript syntax and runs the Playwright workflow in
Chromium, Firefox, and WebKit after the Node matrix. No test-coverage
percentage or complete visual/WCAG conformance claim is made; the manual
acceptance checklist still covers focus restoration, reduced motion, and visual
review.

The browser acceptance flow is documented in
[`docs/browser-acceptance.md`](docs/browser-acceptance.md). It remains the
manual companion to the automated workflow in [`docs/e2e.md`](docs/e2e.md) for
focus restoration, reduced motion, screenshots, and additional recovery cases.

## Audit export and CLI

The v3 domain model can be delivered as a verified audit bundle without demo
records by default. It includes workspace entities, immutable candidate hashes,
rubric checksums, review revisions, audit events, and derived aggregate
metadata. Analysis CSV includes source metadata, human/computed winners,
confidence, rationale, and per-candidate ratings; summary Markdown contains
aggregate values only and does not include prompts or candidate text.
The browser **Audit-ready exports** section uses this same boundary and keeps
unsaved form changes out of downloaded files.

An optional read-only adapter in
[`js/persistence/read-v3-document.js`](js/persistence/read-v3-document.js)
assembles the entity stores from IndexedDB, validates all references, and
returns explicit `ready`, `empty`, `unavailable`, `invalid`, or `error` states.
It never migrates, writes, or replaces the legacy browser UI state, so callers
can add v3 analytics incrementally without risking existing localStorage data.
The Audit-ready exports section exposes this as an explicit local-storage check.
When no v3 workspace exists, **Initialize v3 workspace** performs a user-started
bootstrap that keeps the exact legacy localStorage strings in the recovery store
and leaves the v2 keys untouched. After a successful check, users can opt in to
use the verified v3 document for analytics and audit exports. The v2 browser
editor remains available for legacy records. A verified v3 workspace exposes a
separate session panel for creating or resuming a reproducible blind session,
starting assignments, collecting rubric ratings, saving drafts, and completing
reviews without source/model metadata. Session completion and reveal are still
separate explicit actions; the async guards and audit events are covered by the
Node suite, while the browser boundary is exercised by the Playwright workflow
in [`docs/e2e.md`](docs/e2e.md).

```bash
node cli/evalforge.mjs validate examples/support-pairs.csv
node cli/evalforge.mjs migrate tests/fixtures/v2-export.json --out /tmp/evalforge-v3.json
node cli/evalforge.mjs verify audit.json
node cli/evalforge.mjs summarize audit.json --format table
```

CLI exit codes are `0` for success, `1` for invalid data, and `2` for usage
errors. Diagnostics go to stderr; machine-readable results go to stdout.

## Performance evidence

The repository includes a local, dependency-free benchmark for comparing changes
to the v3 domain layer. It generates de-identified synthetic cases in memory and
reports median, p95, minimum, and maximum timings for import planning, one
transactional repository apply, seeded session assignment creation, analytics,
and audit export.

```bash
npm run --silent benchmark -- --size 1000 --repetitions 3
```

The JSON report records Node version, platform, architecture, adapter, input
counts, audit-bundle size, and a deterministic source hash. These are local
process measurements rather than service-level guarantees; no performance
threshold is claimed until a baseline is recorded on the same environment. The
first reviewed sample is checked in at
[`docs/benchmark-baseline.json`](docs/benchmark-baseline.json); regenerate it
after a meaningful change rather than treating the numbers as an SLA.

## Architecture

EvalForge is a static browser application written with ES modules, HTML, and CSS.

| Path | Responsibility |
| --- | --- |
| `js/app.js` | Form state, DOM events, rendering, validation, and library interactions |
| `js/scoring.js` | Rubric definition, weighted scores, completion, and winner rules |
| `js/model.js` | Record normalization, schema migration, IDs, and rubric snapshots |
| `js/storage.js` | Defensive local reads and transactional writes |
| `js/import.js` | Import validation and deterministic merge/replace plans |
| `js/domain/dataset-import.js` | Dependency-free CSV/JSON/JSONL response-pair parsing and import plans |
| `js/ui/datasets.js` | Local dataset-library normalization, summaries, duplicate-aware apply plans, and storage commits |
| `js/ui/import-dataset-dialog.js` | Preview/apply/error state machine and rejected-row export helpers |
| `js/ui/review-workstation.js` | Resumable review-session state, autosave debounce, draft serialization, and navigation transitions |
| `js/ui/session-header.js` | Session progress, save-state, and standard/blind review presentation model |
| `js/domain/audit-export.js` | Verified audit bundles, analysis rows, formula-safe CSV, and aggregate summaries |
| `js/ui/audit-actions.js` | Pure browser adapter that packages local evaluations and queue cases for the audit formats |
| `js/domain/analytics.js` | Filtered workflow, review-quality, score-gap, source, dimension, and calibration metrics |
| `js/ui/analytics.js` | Browser view-model and formatting helpers for the analytics workspace |
| `cli/evalforge.mjs` | Dependency-free validation, migration, verification, and summary commands |
| `js/export.js` | JSON and formula-safe CSV serialization |
| `schemas/dataset-import-v1.schema.json` | Public row contract for response-pair dataset imports |
| `schemas/audit-bundle-v1.schema.json` | Public contract for verifiable v3 audit bundles |
| `examples/` | De-identified CSV and JSONL import examples used in tests and documentation |
| `tests/` | Node tests for the domain and persistence rules |

[ARCHITECTURE.md](ARCHITECTURE.md) documents the complete data flow, saved-record shape, and design constraints.

## Deployment

[`.github/workflows/pages.yml`](.github/workflows/pages.yml) runs the Node test
suite and syntax checks before publishing the static files to GitHub Pages after
a push to `main`. Deployment does not add server-side storage or processing.

## License

[MIT](LICENSE)
