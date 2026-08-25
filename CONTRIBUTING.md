# Contributing

EvalForge keeps UI work separate from scoring and export rules so behavior remains easy to verify.

## Local checklist

1. Run `npm test`.
2. Start the local server with `npm start` and check the edited workflow in a browser.
3. Keep scoring, verdict, and serialization logic in pure modules with direct tests.
4. Avoid adding dependencies unless they solve a concrete requirement that browser-native APIs cannot.

## Data expectations

Demo evaluations are illustrative only. Do not commit real prompts, proprietary outputs, personal data, or API credentials.
