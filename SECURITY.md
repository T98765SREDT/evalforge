# Security policy

EvalForge is an offline-first portfolio application. The current v2 UI stores reviews in the browser's `localStorage`; the v3 persistence work also supports IndexedDB and keeps an exact local recovery copy of legacy strings during migration. There is no authentication, encryption, or shared-workspace control.

Do not enter confidential prompts, production credentials, or sensitive user data into the demo. Recovery records contain the exact legacy payload and are not encrypted; clear them only after independently verifying a successful migration. Report security concerns privately to the repository owner instead of publishing a proof of concept in a public issue.

JSON imports are parsed and normalized before the preview is shown; importing does not execute content from the file. CSV export prefixes cells that begin with spreadsheet formula characters, but exported files should still be opened only in software and environments you trust.
