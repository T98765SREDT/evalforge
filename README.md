# EvalForge

[![CI](https://github.com/T98765SREDT/evalforge/actions/workflows/ci.yml/badge.svg)](https://github.com/T98765SREDT/evalforge/actions/workflows/ci.yml)
[![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](package.json)
[![Runtime](https://img.shields.io/badge/runtime-browser%20native-0f766e)](index.html)
[![License](https://img.shields.io/badge/license-MIT-0b6e99)](LICENSE)

EvalForge compares two AI responses against the same prompt, calculates a weighted verdict, and keeps the ratings and evaluator notes as a restorable local record.

**[Open the live demo](https://t98765sredt.github.io/evalforge/)** · [Quick start](#quick-start) · [Architecture](ARCHITECTURE.md) · [Security notes](SECURITY.md)

The public demo stores evaluations in the current browser. It does not send prompt or response content to an application server.

![EvalForge evaluation dashboard](docs/evalforge-dashboard.png)

## Verified behavior

- Three built-in five-dimension rubrics (General, Coding, and Safety) produce a score out of 100. Each saved review records the selected rubric version, weights, tie threshold, and per-dimension score contributions.
- Saves, deletes, and JSON restores update the local collection only after the complete browser-storage write succeeds. A failed write leaves the previous library unchanged.
- Unsaved edits are protected when starting a new review, opening another record, restoring a backup, or deleting the active record; saved reviews can also be duplicated into a fresh draft.
- The first-use sample library is labeled in the interface, and `Cmd/Ctrl+S` saves the current work as a draft without leaving the review canvas.
- Response pairs can be added to a local batch queue, opened in sequence, skipped with a reason, and linked to the evaluation saved from that queue case.
- The repository has 40 Node tests for scoring, rubric presets, migration, storage failures, import planning, sample-data boundaries, batch queue transitions, and export serialization. CI runs them on Node.js 18, 20, and 22.

## Quick start

Requirements: Node.js 18 or newer. There are no runtime package dependencies to install.

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
5. Add the evidence behind the decision, optional tags, and an evaluator-confidence value.
6. Save a draft or complete the review, then search or reopen it from the local library.
7. Duplicate an existing review when you want to compare a revised response or rubric decision.
8. Add unfinished response pairs to the Review queue when you want to work through several cases in one session. Open a case to carry its prompt, responses, and rubric into the review form.
9. Export the library as JSON or CSV. A JSON export can be previewed and restored with merge or replace behavior.

On first use, the app displays three sample reviews covering JavaScript retry handling, account-security guidance, and SQL aggregation.

![EvalForge weighted verdict](docs/evalforge-verdict.png)

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
- JSON exports use schema version 2 and include an export timestamp. First-use sample records are marked with `isSample` and omitted from JSON/CSV exports by default. Import validates and normalizes every record before showing accepted, repaired, and skipped counts.
- Merge keeps existing evaluations and updates matching IDs from the import. Replace builds a new collection from the import. Either result is committed in one storage write.
- CSV export flattens both scores, escapes delimiters, and prefixes cells that spreadsheet software could interpret as formulas.

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

The 40 tests cover:

- rubric validation, built-in rubric presets, weighted scores, completion, and winner/tie decisions;
- rubric snapshots and individual dimension contributions;
- record normalization, duplicate-ID repair, and malformed-entry recovery;
- successful and failed local-storage commits;
- batch queue normalization, duplicate prevention, progress tracking, skip reasons, and evaluation links;
- JSON schema validation plus merge and replace plans;
- CSV escaping, spreadsheet-formula protection, JSON serialization, and sample-record export boundaries.

GitHub Actions also checks JavaScript syntax. No test-coverage percentage is claimed, and browser interactions and visual regression still require manual review.

## Architecture

EvalForge is a static browser application written with ES modules, HTML, and CSS.

| Path | Responsibility |
| --- | --- |
| `js/app.js` | Form state, DOM events, rendering, validation, and library interactions |
| `js/scoring.js` | Rubric definition, weighted scores, completion, and winner rules |
| `js/model.js` | Record normalization, schema migration, IDs, and rubric snapshots |
| `js/storage.js` | Defensive local reads and transactional writes |
| `js/import.js` | Import validation and deterministic merge/replace plans |
| `js/export.js` | JSON and formula-safe CSV serialization |
| `tests/` | Node tests for the domain and persistence rules |

[ARCHITECTURE.md](ARCHITECTURE.md) documents the complete data flow, saved-record shape, and design constraints.

## Deployment

[`.github/workflows/pages.yml`](.github/workflows/pages.yml) publishes the static files to GitHub Pages after a push to `main`. Deployment does not add server-side storage or processing.

## License

[MIT](LICENSE)
