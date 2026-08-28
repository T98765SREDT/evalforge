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
| `js/data.js` | First-run sample reviews and prompt templates |
| `server.mjs` | Small static-file server used for local development |
| `tests/` | Node tests for scoring and serialization rules |

## Evaluation record

Saved records contain:

```text
recordVersion, id, title, createdAt, updatedAt, status
prompt, responseA, responseB
ratings.A, ratings.B
scores.A, scores.B
winner, confidence, tags, notes
rubricSnapshot.rubricVersion, tieThreshold, weights, dimensions, contributions
```

`ratings` hold the values entered by the evaluator. `normalizeEvaluation()` recalculates scores and the winner when a record is loaded. Missing or invalid dimension ratings are filled with zero before recalculation. A saved rubric snapshot records the rules and individual score contributions that produced the result.

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

There is no encryption, synchronization, user account, or multi-user isolation. Browser-profile access implies access to the saved evaluations. The public demo must not be used for confidential or regulated data.

## What the tests cover

The automated tests cover scoring, rubric snapshots, record migration, storage failure behavior, import planning, and export serialization. They do not cover browser interactions, visual regression, or comprehensive security testing.

CI runs JavaScript syntax checks and the Node test suite on supported Node versions. Manual browser review remains necessary for interaction and layout changes.
