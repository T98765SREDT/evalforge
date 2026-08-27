# Changelog

This file records user-visible changes to EvalForge.

## Unreleased

- No user-visible changes yet.

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
