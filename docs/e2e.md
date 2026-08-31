# Browser workflow evidence

`tests/e2e/evalforge.spec.mjs` is the cross-layer browser check. It starts the
real static server, uses a clean browser context, and exercises the UI rather
than mocking IndexedDB or the download boundary.

## Covered workflow

- import `examples/coding-pairs.jsonl` and show one rejected row before writing;
- apply the accepted rows and audit a queue skip reason;
- initialize the explicit v2-to-v3 migration while retaining the legacy keys;
- create a seeded blind session, start assignments, complete one review, save a
  second draft, reload, and resume it;
- complete the session, reveal metadata as a separate action, export Audit JSON,
  and verify that download with the repository CLI;
- reject a future-schema restore without enabling Apply;
- open the methodology dialog with keyboard input and check the 375px layout.

The blind session assertion checks that source/model identifiers are absent from
the reviewer-facing projection before reveal. Test records are synthetic and
the browser profile is discarded after each test.

## Run locally

From the repository root:

```bash
npm install
npx playwright install chromium
npm start
```

In another terminal:

```bash
EVALFORGE_BROWSER=chromium npm run test:browser
```

Use `EVALFORGE_BROWSER=firefox` or `webkit` for the other engines and set
`EVALFORGE_E2E_URL` when the server uses another address. CI runs Chromium,
Firefox, and WebKit independently after the Node test matrix.

This is workflow evidence, not a claim of complete visual or WCAG conformance.
The manual checklist in [`browser-acceptance.md`](browser-acceptance.md) still
covers focus restoration, reduced motion, clean-profile screenshots, and
additional failure injection that is not practical in a short CI run.
