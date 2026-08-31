# Changelog

This file records user-visible changes to EvalForge.

## Unreleased

- Clarified the browser acceptance record so CI coverage and local execution
  are distinguished; no Playwright pass is recorded without an actual browser
  run.
- Hardened CI with read-only repository permissions and cancellation of stale
  runs on the same ref.
- Added a test-only Playwright workflow for import rejection, queue recovery,
  v2-to-v3 migration, blind-session draft resume, explicit reveal, audit
  download, CLI verification, keyboard access, and 375px layout checks; CI runs
  Chromium, Firefox, and WebKit after the Node matrix.

- Fixed v2-to-v3 migration for the browser's plain localStorage array format;
  legacy reviews now populate the v3 document instead of silently producing an
  empty workspace. Serialized v3 mutations are guarded in the browser so rapid
  session actions cannot overwrite a newer assignment snapshot, and the blind
  session controls stay disabled until a session exists.
- Added the v3 review-workflow slice behind the verified-workspace gate:
  dataset selection, reproducible seeded blind-session creation and resume,
  IndexedDB persistence of sessions/assignments/reviews, explicit assignment
  start events, source-safe candidate display, rubric-backed positional rating,
  anchored confidence, rationale, draft save, completion, optimistic revision
  conflicts, atomic async audit writes, cross-store session completion
  integrity checks, document-level assignment/review reference validation,
  explicit session completion guards, and separate metadata-reveal audit
  actions.
- Added pure v3 session planning/display/resume helpers plus async persistence
  tests covering dataset filtering, deterministic assignments, metadata
  redaction, navigation, refresh recovery, draft revisions, atomic completion,
  duplicate completion, and rollback on failure.
- Expanded the automated suite to 156 tests, including browser-array migration
  coverage and cross-action session-control regressions.

- Added a read-only IndexedDB v3 document bridge that assembles entity stores,
  validates references before use, reports explicit storage states, and keeps
  legacy browser UI data untouched. Added coverage for empty, unavailable,
  malformed, ambiguous, and valid workspaces. Read-only repository calls now
  use native IndexedDB `readonly` transactions. The browser now exposes an
  explicit local-storage integrity check and an opt-in v3 source for analytics
  and audit exports without changing the default editor.
- Added an explicit **Initialize v3 workspace** action. It starts the existing
  retryable migration bootstrap only after a user click, preserves exact legacy
  localStorage strings for recovery, and refreshes the verified v3 status without
  making v3 the default editor.

- Made persisted rubric snapshots the source of truth during reload and import,
  preserving historical dimensions, weights, tie thresholds, and scoring
  metadata instead of silently using the current preset.
- Added explicit `verified`, `limited`, and `fallback` snapshot audit states,
  repair reasons, and collection-level repair reporting for legacy or malformed
  rubric metadata.
- Added versioned, de-identified v2 fixtures and a product-boundary ADR before
  the planned domain-model migration.
- Added the v3 domain foundation: pure workspace entities, deterministic IDs and
  content hashes, candidate identity rules, review state invariants, rubric
  anchors, cross-entity reference validation, and a public JSON Schema.
- Added a deterministic v2-to-v3 migrator that preserves historic rubric meaning,
  maps side labels to stable candidate IDs, reuses linked queue cases, isolates
  demo records, and reports every repair or warning without writing storage.
- Added a transactional memory repository and review use cases for start, draft
  save, atomic completion, skip, optimistic stale-revision conflicts, and
  append-only completed-review revisions.
- Added the IndexedDB v3 adapter and migration bootstrap with separate entity,
  recovery, and metadata stores; exact legacy localStorage strings are retained,
  migrations are retryable/idempotent, and failed or running states never appear
  as an empty workspace.
- Added a dependency-free dataset import planner for CSV, JSON, and JSONL response
  pairs. It preserves model and prompt metadata, creates stable candidate IDs,
  identifies exact duplicates, reports line/field issues, and keeps malformed
  rows out of the accepted set without mutating application state.
- Added a local Dataset Library with named datasets, source metadata, case counts,
  cross-import duplicate protection, and a preview/apply/error state machine.
  Dataset writes and queue writes are coordinated with rollback on a failed queue
  save; rejected rows can be downloaded for correction and retry.
- Reworked first-run onboarding to start with an honest empty workspace. Demo
  reviews now load only after an explicit action, remain marked as samples, stay
  out of user metrics/exports, and can be reset without deleting user reviews.
  Added response-pair import, single-case, and CSV/JSONL template entry points.
- Added a local batch review queue with duplicate prevention, pending/in-progress/completed/skipped states, skip reasons, progress summary, and links from completed queue cases to saved evaluations.
- Added queue controls to the workspace so reviewers can move through multiple response pairs without losing the current rubric context.
- Expanded the automated suite to 105 tests.
- Added the first blind-session core: seeded, persisted candidate ordering; a display-safe blind projection with no source/model metadata; stable candidate-id winner calculation; and explicit preservation of non-blind migrated history.
- Added the review workstation state model and session header: bounded autosave scheduling, dirty/saving/saved/error/conflict states, explicit session completion, resumable queue progress, and a compact save/blind/progress indicator in the review canvas.
- Added human-preference evidence, five-point confidence anchors with explicit legacy percentage handling, immutable completed-review revision links, rubric lock/version cloning, deterministic calibration repeats, and consistency metrics that never invent reviewer identities.
- Expanded the automated suite to 111 tests.
- Added a verified v1 audit bundle, analysis CSV, aggregate Markdown summary,
  tamper detection for candidate hashes/rubric checksums/revision chains, and a
  dependency-free CLI for dataset validation, v2 migration, audit verification,
  and summary output.
- Expanded the automated suite to 116 tests.
- Added an in-browser Audit-ready exports section for verified audit JSON,
  source-aware analysis CSV, and aggregate Markdown summaries. Demo samples are
  opt-in, unsaved form changes stay out of exports, and the browser uses the
  same pure audit boundary as the CLI.
- Expanded the automated suite to 119 tests.
- Added decision-oriented evaluation analytics with explicit denominators for
  completion, skips, ties, conflicts, and low confidence; per-dimension
  averages, score-gap buckets, filterable local records, calibration metrics,
  and source win-rate redaction until source metadata is revealed.
- Expanded the automated suite to 125 tests.
- Added a deterministic local performance benchmark for 1,000-case synthetic
  datasets. It measures import planning, transactional memory persistence,
  seeded session creation, analytics, and verified audit export with median and
  p95 timings, environment metadata, and no production performance claims.
- Expanded the automated suite to 128 tests.
- Recorded the first 1,000-case benchmark baseline with environment metadata,
  input counts, and median/p95 timings in `docs/benchmark-baseline.json`.
- Connected the methodology and JSON-restore dialogs to explicit accessible
  titles and descriptions, with HTML contract coverage to prevent regressions.
- Added dependency-free accessibility contract checks for page landmarks,
  fragment links, dialog ARIA references, and hidden file-input names.
- Expanded the automated suite to 132 tests.
- Expanded CI syntax checks to every JavaScript module and made GitHub Pages
  deployment wait for a dedicated test-and-syntax verification job.
- Added a de-identified browser acceptance checklist covering clean-profile
  onboarding, import recovery, queue progress, analytics, audit verification,
  keyboard navigation, and 375px responsive behavior without claiming an
  unexecuted browser run.
- Added repository, homepage, issue tracker, keyword metadata, and a Node 22
  `.nvmrc` so the project is easier to discover and run consistently.

- Added unsaved-change protection for navigation, restore, delete, and reset actions.
- Added duplicate-as-draft for saved evaluations and clearer average score-gap metrics.
- Added accessible confirmation dialogs with focus restoration and browser-exit protection.
- Labeled first-use sample reviews and added a `Cmd/Ctrl+S` draft-save shortcut.
- Marked sample records with `isSample`, labeled them in review history, and omitted them from JSON/CSV exports by default.
- Added General, Coding, and Safety rubric presets with selected-rubric snapshots and per-dimension score recalculation.

## 1.1.0 - 2026-08-27

- Added previewed JSON restore with schema validation and merge or replace behavior.
- Added explicit storage-failure handling so failed saves, deletes, and imports do not change the current library or report success.
- Added rubric-version, weights, tie-threshold, and dimension-contribution snapshots to saved evaluations.
- Added defensive migration with visible repaired and skipped record counts.
- Added spreadsheet formula-injection protection to CSV exports.
- Expanded the automated test suite from 10 to 26 tests.

## 1.0.0 - 2026-08-24

- Added side-by-side evaluation of two AI responses using five weighted criteria.
- Added draft and completed-review states with local browser storage.
- Added searchable sample history and JSON/CSV export.
- Added responsive layouts, keyboard focus styles, and reduced-motion support.
- Added automated tests for scoring, winner selection, and export formatting.
