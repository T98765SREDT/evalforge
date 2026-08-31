# EvalForge architecture

EvalForge is a static, single-page browser application. It has no application API, database, authentication layer, build step, or runtime package dependency.

## Data flow

```text
Prompt + responses + ratings + notes
                  |
                  v
js/app.js
       /      |       |       \
      v       v       v        v
scoring.js  model.js  UI state  storage.js -> localStorage
              |                    ^
              v                    |
           import.js --------------+
              |
              v
           export.js -> JSON or CSV download

prompt pairs -> js/queue.js -> queue state -> localStorage
                                      |
                                      └── linked evaluation id

CSV / JSON / JSONL -> dataset-import.js -> import preview -> datasets.js ->
  dataset library localStorage + review queue (coordinated writes with rollback)

saved evaluations + queue -> analytics.js -> filtered decision metrics -> analytics UI
```

The form state is held in memory while an evaluation is edited. A save, delete, or restore action first builds a complete candidate collection and writes it to storage. The in-memory library changes only after that write succeeds. Export functions receive the collection and return text; only the browser download helper interacts with `Blob` and `URL` APIs.

## Modules

| Path | Responsibility |
| --- | --- |
| `index.html` | Semantic application structure, form controls, dialog, and landmarks |
| `css/styles.css` | Layout, component states, responsive rules, focus styling, and reduced-motion behavior |
| `js/app.js` | Form state, event handling, validation, rendering, history filtering, and downloads |
| `js/scoring.js` | Rubric definition, weighted scoring, completion, score labels, and winner selection |
| `js/model.js` | Evaluation normalization, schema migration, IDs, and auditable rubric snapshots |
| `js/import.js` | JSON schema validation plus deterministic merge and replace plans |
| `js/export.js` | Formula-safe CSV serialization, versioned JSON serialization, and browser downloads |
| `js/storage.js` | Defensive reads and transactional writes for the versioned `localStorage` key |
| `js/data.js` | Explicit demo reviews and prompt templates |
| `server.mjs` | Small static-file server used for local development |
| `js/domain/ids.js` | Deterministic content hashes, stable IDs, and positional-label guards |
| `js/domain/entities.js` | Pure v3 entities, invariants, constructors, and reference validation |
| `js/domain/migrate-v2.js` | Pure, deterministic v2 export/queue migration with warnings and sample isolation |
| `js/domain/dataset-import.js` | Dependency-free CSV/JSON/JSONL parsing, normalization, duplicate detection, and import plans |
| `js/ui/datasets.js` | Dataset-library normalization, summaries, duplicate-aware apply plans, and storage commits |
| `js/ui/import-dataset-dialog.js` | Import preview/apply/error state machine and rejected-row export helpers |
| `js/domain/blind-session.js` | Seeded persisted assignment ordering and display-safe blind/non-blind projections |
| `js/ui/review-workstation.js` | Review save/session/assignment state transitions, autosave debounce, draft serialization, and navigation helpers |
| `js/ui/session-header.js` | Queue progress and compact review-session header presentation model |
| `schemas/workspace-v3.schema.json` | Public interchange contract for the v3 workspace model |
| `schemas/dataset-import-v1.schema.json` | Public response-pair row contract for dataset imports |
| `schemas/audit-bundle-v1.schema.json` | Public contract for verifiable v3 audit bundles |
| `js/persistence/repository.js` | Repository contract, store names, clone boundaries, and typed conflicts |
| `js/persistence/memory-repository.js` | Transactional test adapter with injected failure points |
| `js/persistence/indexeddb-repository.js` | Native IndexedDB adapter with upgrade-safe object stores and transactions |
| `js/persistence/bootstrap.js` | Legacy localStorage capture, v2 migration bootstrap, retry state, and recovery records |
| `js/persistence/read-v3-document.js` | Read-only v3 workspace assembly, validation, status reporting, and safe counts for analytics/export consumers |
| `js/ui/v3-session.js` | Reviewable dataset options, reproducible blind-session planning, safe assignment projections, refresh recovery, and navigation helpers |
| `js/ui/v3-review.js` | Candidate-id keyed draft normalization, weighted score computation, completion gates, and rubric snapshots for the v3 panel |
| `js/domain/review-usecases.js` | Atomic assignment/review transitions, optimistic revisions, and audit writes for the synchronous adapter |
| `js/domain/indexeddb-review-usecases.js` | Asynchronous IndexedDB assignment/review transitions, optimistic revisions, atomic completion, and rubric-lock audit writes |
| `js/domain/calibration.js` | Confidence anchors, preference-evidence checks, rubric locking/cloning, repeat selection, and calibration metrics |
| `js/domain/audit-export.js` | Verified audit bundles, source-aware analysis rows, formula-safe CSV, and aggregate summaries |
| `js/domain/analytics.js` | Pure, filterable workflow, quality, score-gap, source, dimension, and calibration metrics |
| `js/ui/analytics.js` | Browser analytics view-model and display-format helpers |
| `cli/evalforge.mjs` | Dependency-free validation, migration, verification, and summary commands using domain functions |
| `scripts/benchmark.mjs` | Deterministic, de-identified local measurements for import planning, memory transactions, session creation, analytics, and audit export |
| `tests/` | Node tests for scoring and serialization rules |

## Evaluation record

Saved records contain:

```text
recordVersion, id, title, createdAt, updatedAt, status
prompt, responseA, responseB
ratings.A, ratings.B
scores.A, scores.B
winner, preference, confidence, confidenceScale, preferenceEvidence, tags, notes
rubricSnapshot.rubricVersion, scoringAlgorithmVersion, tieThreshold,
weights, dimensions, contributions, auditStatus, repairReason
```

`ratings` hold the values entered by the evaluator. `normalizeEvaluation()` uses a valid persisted snapshot as the scoring source when a record is loaded; it does not silently replace historical weights, dimensions, or tie thresholds with the current preset. Missing or invalid dimension ratings are filled with zero before recalculation. A saved rubric snapshot records the rules and individual score contributions that produced the result.

### Rubric snapshot integrity

Every new record stores the rubric definition, rubric version, tie threshold, and
scoring algorithm version alongside its ratings. `auditStatus` communicates how
that definition was obtained:

- `verified` means the stored snapshot is complete and includes the algorithm
  version;
- `limited` means a legacy snapshot is structurally valid but predates the
  algorithm-version field; and
- `fallback` means the original snapshot was missing or invalid and the current
  preset was used only to keep the record usable.

Fallback and limited records retain a non-empty `repairReason`. They remain
visible for migration and review, but must not be described as fully auditable
until the missing historical information is restored. Snapshot normalization is
deterministic, so exporting and importing a normalized record does not change its
audit status or scoring meaning.

## Scoring rules

- Every rubric dimension has a positive weight.
- Only numeric ratings from 1 through 5 contribute to a score; the UI offers the integer values 1, 2, 3, 4, and 5.
- Unrated dimensions contribute zero and reduce the reported completion percentage.
- A review cannot be completed until both responses have ratings for every dimension.
- A score difference of zero, one, or two points produces a tie.
- A completed review requires a prompt, both responses, every rubric rating, and evaluator notes of at least 20 characters.

## Saved data

`js/storage.js` stores the evaluation array under `evalforge.evaluations.v1`. Parsing and write failures are caught so the UI can recover without crashing. Loading reports repaired and skipped records. Writes return an explicit result, and `commitEvaluations()` keeps the prior in-memory collection when a browser storage write fails.

The review queue is stored separately under `evalforge.review-queue.v1`. A queue item has a stable ID, prompt/response pair, status (`queued`, `in_progress`, `skipped`, or `completed`), optional skip reason, and an optional linked evaluation ID. Queue transitions are normalized before persistence, duplicate prompt/response pairs are rejected at add time, and the UI only advances the active case after a successful storage write. This keeps a multi-case review session recoverable without coupling queue data to the evaluation record schema.

JSON exports use schema version 2. The restore workflow accepts supported schema versions, normalizes every record, previews the outcome, and then produces either a merge or replace candidate. Matching IDs in merge mode use the imported record. No collection changes occur until the candidate is saved successfully.

There is no encryption, synchronization, user account, or multi-user isolation. Browser-profile access implies access to the saved evaluations. The public demo must not be used for confidential or regulated data. The v3 bootstrap stores exact legacy localStorage strings in a local recovery store before migration; these recovery records are not encrypted and must be treated as sensitive.

The v3 domain foundation is currently defined alongside the v2 browser model;
the browser analytics and audit-export adapters consume a pure migrated view,
while the v3 persistence adapter is not yet the primary UI store. The optional
`read-v3-document.js` bridge can assemble and validate an existing IndexedDB
workspace without writing or changing legacy UI state. Its constructors require
an injected clock and ID factory, and its validators enforce entity references,
stable candidate identities, immutable case content hashes, rubric anchors, and
review completion requirements. This keeps the migration target testable before
the application switches storage implementations. The audit panel can check the
workspace and, when no workspace exists, offers an explicit user-started
`bootstrapV3` action. Bootstrap writes only the new IndexedDB stores, first
capturing exact legacy localStorage strings in the recovery store; it does not
delete or rewrite the v2 keys. After a successful bootstrap, the audit panel can
use the verified document for analytics and audit exports only after an explicit
user opt-in; the editor itself remains on the legacy store for existing v2
records. The verified workspace also exposes a guarded v3 session panel: it
filters to datasets containing cases, creates or resumes a seeded blind session
and one assignment per case, records an explicit assignment-start audit event,
and renders only the prompt plus candidate content with positional labels.
Candidate IDs, source, model, and metadata are never copied into this renderer.
The v3 panel now collects rubric-backed ratings, anchored confidence, a
preference, and rationale, then saves drafts or completes a review through
asynchronous IndexedDB transactions with optimistic revisions. Session
completion and metadata reveal are separate explicit actions: a session cannot
complete while assignments remain unresolved or while a completed assignment
does not point to its own complete review record, and reveal is rejected until
completion has been recorded.
The document validator applies the same assignment-to-review integrity rule
before a v3 workspace becomes readable.

The v2 migrator produces a single aggregate document without writing storage. It
maps response sides to stable candidate IDs, preserves usable historic rubric
weights and tie thresholds, records warnings when algorithm metadata is absent,
reuses linked queue cases, keeps migrated sessions explicitly non-blind, and
separates sample records into a demo dataset. Re-running it with the same input,
clock, and ID factory is deterministic.

Review use cases currently run against a synchronous memory adapter. Each
transaction clones the complete state and publishes it only after all writes
succeed. Completing a review therefore updates the review, assignment, and
completion audit event together; an injected write failure rolls all three back.
Draft saves use optimistic revisions, completed reviews are immutable unless a
new revision is created, and skip/start transitions reject illegal reopening.

The IndexedDB adapter creates separate stores for v3 entities, recovery payloads,
and migration metadata. Bootstrap keeps legacy keys untouched, records a
`running`/`completed`/`failed` marker, and never interprets a running or failed
migration as an empty workspace. A failed publication can be retried after the
exact legacy payload has been retained.

Dataset imports are planned before they are published. `dataset-import.js` accepts
CSV with quoted commas and embedded newlines, JSON arrays or `rows`/`data` envelopes,
and newline-delimited JSON. It normalizes each accepted row into an input plus two
stable candidate identities, keeps optional model/prompt metadata, and reports
duplicate, missing-field, malformed, and unknown-field issues with source lines.
Strict mode reports unknown columns as warnings; lenient mode accepts them without
warnings while still rejecting missing or non-string required fields. The planner
is pure: callers can render the accepted/duplicate/rejected preview and only write
accepted rows after an explicit confirmation. EvalForge backup JSON is intentionally
rejected by this path so restore and dataset ingestion cannot be confused.

The UI stores dataset-library metadata under `evalforge.datasets.v1`. A selected
file first enters a reading and preview state; preview rendering does not touch
storage. On apply, `datasets.js` creates a new named dataset after checking
external IDs and exact content signatures against every existing dataset. The
accepted cases are also offered to the local review queue. The app commits the
dataset and queue candidates in sequence and restores the prior dataset value if
the queue write fails, so a visible success state always represents both writes.
The dataset dialog keeps the filename, fields, plan, and issue table after a
failed save, and can download rejected rows as JSONL for correction. Backup
restore remains a separate dialog and storage key.

Blind sessions use `js/domain/blind-session.js`. A session must explicitly name
its dataset, rubric, reviewer, seed, and blind mode. The seed and case id are
hashed once to create an assignment `displayOrder`, which is then persisted and
used as the only render order after refresh. The blind projection exposes the
prompt and labelled candidate content only; source, model, metadata, candidate
ids, and DOM data attributes are not copied into the reviewer-facing DTO.
Migrated v2 sessions remain explicitly non-blind so historical side meaning is
not rewritten.

The review canvas uses `review-workstation.js` and `session-header.js` for the
legacy high-frequency path. Form edits move through clean → dirty → saving →
saved, with explicit error and conflict states; drafts can be retried or
downloaded without clearing the form. The v3 panel has its own IndexedDB-backed
state path: assignment start, draft save, completion, optimistic revision
checks, rubric locking, and audit writes happen in asynchronous transactions.
An active v3 session is rehydrated from the newest persisted session after a
refresh. Queue progress is rendered from persisted statuses, and the
session-complete action is separate from any candidate reveal. The legacy A/B
editor is not presented as a blind session.

### Preference, confidence, and revisions

Computed rubric scores and the evaluator's human preference are stored as
separate values. A reviewer may disagree with the calculated winner, but a
completed disagreement must include a dedicated preference-evidence note. New
domain reviews use a five-point confidence scale with written anchors; legacy
percentage values remain marked as `legacy-0-100` so they are not mistaken for
new precision. Revising a completed review creates a new immutable revision with
`supersedesReviewId` and an append-only audit event.

Rubrics used by completed reviews can be locked. `calibration.js` creates an
unlocked versioned clone when a rubric needs to change, and can select a
deterministic 5–10% repeat sample with reversed display order. Calibration
metrics report preference agreement, rating mean absolute delta, and position
switch rate. Multi-reviewer statistics are returned only when records contain
more than one explicit reviewer id; the local app never fabricates reviewers.

### Audit export boundary

`audit-export.js` is the shared pure boundary for downstream evidence. A full
bundle verifies the v3 document before and after optional demo-data filtering;
candidate content hashes, rubric checksums, revision references, and audit
entity references are checked before a bundle is considered valid. The analysis
CSV intentionally includes rationale and source metadata for internal analysis,
while summary Markdown is aggregate-only. Spreadsheet formula prefixes are
escaped in exported cells. `cli/evalforge.mjs` and the browser
`js/ui/audit-actions.js` adapter call these same functions, so CLI and UI
exports do not drift into separate rules. Browser exports are generated from
the saved evaluation and queue stores; the active unsaved form is never added
implicitly.

### Performance evidence

`npm run --silent benchmark -- --size 1000 --repetitions 3` generates a deterministic
synthetic v3 document and measures five high-risk paths: dataset import
planning, one atomic `MemoryRepository` transaction, seeded assignment
creation, filtered analytics, and verified audit export. Each operation reports
median and p95 timings along with the environment and input counts. The
benchmark deliberately uses `MemoryRepository` because IndexedDB is a browser
API; it does not claim that these timings are production service-level
objectives. Repeating the command on the same machine provides a useful baseline
for detecting regressions without putting real prompts or candidate content in
the repository.

The first reviewed 1,000-case sample is recorded in
`docs/benchmark-baseline.json`. It is deliberately labeled as a local baseline,
not a release threshold or production SLA; the environment and repetition count
must accompany any later comparison.

## What the tests cover

The automated Node tests cover scoring, rubric snapshots, record migration, storage failure behavior, import planning, blind-session projections, v3 session planning and resume, rubric-backed v3 review building, asynchronous IndexedDB-style draft/completion transactions, resumable workstation state, preference evidence, confidence anchors, revisions, calibration repeats, read-only v3 workspace loading, and export serialization. The Playwright workflow in `tests/e2e/evalforge.spec.mjs` covers the cross-layer browser path in CI, including IndexedDB-backed recovery, keyboard access and the 375px layout check. Visual regression, comprehensive security testing, and a complete manual accessibility audit remain outside the automated claim; the repository does not claim production readiness.

CI runs JavaScript syntax checks across every `js/`, `cli/`, and `scripts/`
module plus the Node test suite on supported Node versions. The Pages workflow
repeats those checks and the test suite before deployment, so a deploy cannot
skip a failing verification job. Manual browser review remains necessary for
interaction and layout changes; benchmark numbers are intentionally not used as
a release gate until a reviewed baseline exists.

The reproducible browser acceptance matrix, including clean-profile recovery,
blind-session non-disclosure, audit verification, keyboard navigation, and the
375px responsive check, lives in `docs/browser-acceptance.md`. It is kept
separate from the Node suite so the repository does not imply browser coverage
that has not actually been run.
