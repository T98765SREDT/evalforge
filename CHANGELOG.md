# Changelog

This file records user-visible changes to EvalForge.

## Unreleased

- Added a local batch review queue with duplicate prevention, pending/in-progress/completed/skipped states, skip reasons, progress summary, and links from completed queue cases to saved evaluations.
- Added queue controls to the workspace so reviewers can move through multiple response pairs without losing the current rubric context.
- Expanded the automated suite to 40 tests.

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
