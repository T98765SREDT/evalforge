# EvalForge architecture

EvalForge is a static, single-page browser application. It has no application API, database, authentication layer, build step, or runtime package dependency.

## Data flow

```text
Prompt + responses + ratings + notes
                  |
                  v
             js/app.js
          /       |       \
         v        v        v
 js/scoring.js  UI state  js/storage.js -> localStorage
         |
         v
 score + completion + winner
                  |
                  v
             js/export.js -> JSON or CSV download
```

The form state is held in memory while an evaluation is edited. A save action creates or replaces one evaluation in the locally stored collection. Export functions receive that collection and return text; only the browser download helper interacts with `Blob` and `URL` APIs.

## Modules

| Path | Responsibility |
| --- | --- |
| `index.html` | Semantic application structure, form controls, dialog, and landmarks |
| `css/styles.css` | Layout, component states, responsive rules, focus styling, and reduced-motion behavior |
| `js/app.js` | Form state, event handling, validation, rendering, history filtering, and downloads |
| `js/scoring.js` | Rubric definition, weighted scoring, completion, score labels, and winner selection |
| `js/export.js` | CSV escaping, flattened CSV serialization, versioned JSON serialization, and browser downloads |
| `js/storage.js` | Defensive reads and writes for the versioned `localStorage` key |
| `js/data.js` | First-run sample reviews and prompt templates |
| `server.mjs` | Small static-file server used for local development |
| `tests/` | Node tests for scoring and serialization rules |

## Evaluation record

Saved records contain:

```text
id, title, createdAt, updatedAt, status
prompt, responseA, responseB
ratings.A, ratings.B
scores.A, scores.B
winner, confidence, tags, notes
```

`ratings` are authoritative. Scores and winner are derived by `normalizeEvaluation()` when a record is loaded. Missing dimension ratings are filled with zero before recalculation.

## Scoring invariants

- Every rubric dimension has a positive weight.
- Only numeric ratings from 1 through 5 contribute to a score; the UI offers the integer values 1, 2, 3, 4, and 5.
- Unrated dimensions contribute zero and reduce the reported completion percentage.
- A review cannot be completed until both responses have ratings for every dimension.
- A score difference of zero, one, or two points produces a tie.
- A completed review requires a prompt, both responses, every rubric rating, and evaluator notes of at least 20 characters.

## Storage boundary

`js/storage.js` stores the evaluation array under `evalforge.evaluations.v1`. Parsing and write failures are caught so the UI can fall back to sample data or continue without crashing.

There is no encryption, synchronization, user account, or multi-user isolation. Browser-profile access implies access to the saved evaluations. The public demo must not be used for confidential or regulated data.

## Testing boundary

The automated tests cover the pure scoring and export modules. They do not claim browser end-to-end coverage, visual-regression coverage, security certification, or a production service-level guarantee.

CI runs JavaScript syntax checks and the Node test suite on supported Node versions. Manual browser review remains necessary for interaction and layout changes.
