# EvalForge

[![CI](https://github.com/T98765SREDT/evalforge/actions/workflows/ci.yml/badge.svg)](https://github.com/T98765SREDT/evalforge/actions/workflows/ci.yml)
[![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](package.json)
[![Runtime](https://img.shields.io/badge/runtime-browser%20native-0f766e)](index.html)
[![License](https://img.shields.io/badge/license-MIT-0b6e99)](LICENSE)

EvalForge is an offline-first dashboard for comparing AI responses and code-review answers with a transparent, weighted rubric. It turns subjective review into a repeatable workflow: capture the prompt, compare two responses, score five quality dimensions, document evidence, and export the result.

The application is built with modular vanilla JavaScript, semantic HTML, and responsive CSS. It has no runtime dependencies and does not send evaluation data to a server.

**Open the live demohttps//t98765sredt.github.io/evalforge/**

![EvalForge evaluation dashboard](docs/evalforge-dashboard.png)

## What it does

- Compares two candidate responses in a focused side-by-side workspace.
- Scores **accuracy, relevance, clarity, completeness, and safety** on a 1–5 scale.
- Calculates a weighted 100-point result and a winner with a documented tie threshold.
- Separates score from rubric completion so partial reviews cannot appear final.
- Tracks evaluation notes, tags, confidence, status, timestamps, and readiness checks.
- Persists evaluations in `localStorage`, preloaded with three realistic demo reviews.
- Searches and filters the local evaluation library.
- Exports structured JSON and spreadsheet-friendly CSV.
- Supports keyboard navigation, visible focus states, reduced-motion preferences, and responsive layouts.

## Screenshot-ready demo

Run the application and scroll to **Recent reviews**. On first launch, EvalForge loads three complete sample evaluations covering:

1. JavaScript API retry reliability
2. Shared-password incident response
3. SQL aggregation correctness

Open **API retry strategy** to populate the full evaluation canvas with two code responses, completed ratings, a 94–48 verdict, evaluator notes, tags, and confidence. This is the recommended state for a portfolio screenshot because every visible metric is backed by application data and scoring logic.

![EvalForge weighted verdict](docs/evalforge-verdict.png)

## Run locally

Requirements: Node.js 18 or newer.

```bash
npm start
```

Then open [http://127.0.0.1:4173](http://127.0.0.1:4173).

The included server uses only Node's built-in `http`, `fs`, and `path` modules.

## Live demo

The repository includes a GitHub Pages deployment workflow. Once Pages is enabled for this repository, the current public build is available at:

`https://t98765sredt.github.io/evalforge/`

The deployed site is static and retains EvalForge's local-first model: it does not send evaluation content to an application server.

## Run tests

```bash
npm test
```

The test suite uses Node's built-in test runner and covers weighted scoring, incomplete rubrics, winner/tie decisions, CSV escaping, flattened exports, and versioned JSON output.

## Engineering notes

- The scoring and export modules are pure functions, so the highest-risk logic is testable without a browser.
- GitHub Actions runs the Node test suite on every pull request and change to `main`.
- Evaluation data is intentionally local-only; read [SECURITY.md](SECURITY.md) before treating the browser demo as a shared service.
- [CONTRIBUTING.md](CONTRIBUTING.md) documents the verification and design expectations for changes.

## Architecture

```text
index.html                 Semantic workspace and accessible controls
css/styles.css             Responsive visual system and component states
js/app.js                  UI state, form workflow, history, and event handling
js/scoring.js              Pure weighted-scoring and verdict functions
js/export.js               Pure CSV/JSON serializers plus browser download helper
js/storage.js              Defensive localStorage adapter
js/data.js                 Realistic first-run demo evaluations and prompt templates
server.mjs                 Dependency-free local static server
tests/                     Node unit tests for scoring and export logic
```

The business logic is kept in pure modules so it can be tested without a browser. The UI derives the score and verdict from ratings instead of trusting stored totals. When saved data is loaded, ratings are normalized and scores are recalculated, which prevents stale derived values from drifting out of sync.

## Scoring model

| Dimension | Weight | What it measures |
| --- | ---: | --- |
| Accuracy | 30% | Factual and logical correctness |
| Relevance | 20% | Direct alignment with the request |
| Clarity | 15% | Structure and audience fit |
| Completeness | 15% | Requirements, constraints, and edge cases |
| Safety | 20% | Responsible handling of harmful or sensitive content |

Each rating contributes `rating ÷ 5 × weight` points. The sum is rounded to a 100-point score. A difference of two points or less is treated as a tie.

## LinkedIn-ready project description

**EvalForge — Offline-first AI Response Evaluation Dashboard**  
Built a responsive evaluation workspace for comparing AI and code-review responses across weighted quality and safety criteria. The application calculates explainable scores, persists review history locally, and exports structured JSON/CSV without third-party dependencies.

Achievement bullets:

- Engineered a pure JavaScript scoring model across five weighted dimensions, including completion tracking and deterministic tie handling.
- Built a complete local-first workflow with reusable evaluation templates, searchable history, confidence and evidence capture, and browser persistence.
- Added dependency-free JSON/CSV export and Node unit tests for core scoring and serialization edge cases.

Suggested project skills: `JavaScript`, `HTML5`, `CSS`, `Software Testing`, `Data Validation`, `Accessibility`, `AI Evaluation`.

## Interview questions and honest answers

### 1. Why did you choose vanilla JavaScript instead of a framework?

The project is intentionally small enough that a framework would add more setup than value. Keeping the scoring and export logic in pure ES modules made the data flow easy to inspect and test, while the browser code remains dependency-free. For a larger team product, I would consider a component framework once state and collaboration requirements justified it.

### 2. How do you prevent inconsistent scores?

Ratings are the source of truth. Scores, completion, and the winner are recalculated by pure functions whenever ratings change and again when saved records are loaded. Stored derived values are therefore not trusted, which avoids stale totals after a rubric change or malformed local data.

### 3. How does offline persistence work, and what are its limitations?

The storage adapter serializes evaluations to `localStorage` under a versioned key and handles parsing failures defensively. This works without an account or network connection, but it is limited to one browser profile and localStorage capacity. A production version could add IndexedDB, encryption, cloud sync, and schema migrations.

### 4. What did you test?

The Node test suite covers rubric validation, weighted calculations, partial completion, tie thresholds, score formatting, CSV quoting for commas/newlines/quotes, flattened CSV fields, and versioned JSON structure. UI behavior was separated from those pure functions so the highest-risk logic is testable without browser automation.

### 5. What would you build next?

I would add configurable rubric builders, blinded evaluation order to reduce bias, inter-rater agreement metrics, import validation, and IndexedDB for larger datasets. For team use, I would add authentication, role-based access, a review audit trail, and an API-backed shared workspace.

## Privacy

EvalForge makes no network requests after the static files load. User-entered prompts and responses stay in the current browser unless the user chooses an export action.

## License

[MIT](LICENSE)
