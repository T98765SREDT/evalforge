# Security policy

EvalForge is an offline-first portfolio application. It stores reviews in the current browser's `localStorage` and has no authentication, encryption, or shared-workspace controls.

Do not enter confidential prompts, production credentials, or sensitive user data into the demo. Report security concerns privately to the repository owner instead of publishing a proof of concept in a public issue.

JSON imports are parsed and normalized before the preview is shown; importing does not execute content from the file. CSV export prefixes cells that begin with spreadsheet formula characters, but exported files should still be opened only in software and environments you trust.
