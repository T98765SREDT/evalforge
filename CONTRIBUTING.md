# Contributing

EvalForge keeps UI work separate from scoring and export rules so behavior remains easy to verify.

Use the Node version in `.nvmrc` when possible. The package has no runtime
dependencies, so a fresh clone can run the checks without a build step.

## Local checklist

1. Run `npm test`.
2. Start the local server with `npm start` and check the edited workflow in a browser.
3. For domain or persistence changes, run `npm run --silent benchmark -- --size 1000 --repetitions 3` and record meaningful regressions with the environment.
4. For browser or layout changes, follow `docs/browser-acceptance.md` and record the browser, viewport, commit, and result.
5. Keep scoring, verdict, and serialization logic in pure modules with direct tests.
6. Avoid adding dependencies unless they solve a concrete requirement that browser-native APIs cannot.

## Submitting a change

- Keep each change focused on one feature, fix, or documentation update.
- Explain the user-visible behavior and the checks you ran.
- Add or update tests when scoring or export behavior changes.
- Update `CHANGELOG.md` for changes that affect users.

## Data expectations

Demo evaluations are illustrative only. Do not commit real prompts, proprietary outputs, personal data, or API credentials.
